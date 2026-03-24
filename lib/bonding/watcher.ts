/**
 * Bonding Strategy — Active Market Watcher (Phase 2)
 *
 * Three detection paths:
 *   A. CTF Resolution Poll (3s) — checks on-chain if condition resolved → taker buy
 *   B. UMA ProposePrice listener (5s) — detects bonding proposal → limit buy
 *   C. Expired + predicted winner — orderbook best ask < 99.9c → limit buy
 *
 * Path A fires when the market is fully settled (taker, immediate).
 * Paths B & C fire earlier — place post-only limit orders at the best ask (0% fee).
 */

import 'server-only';

import { PolymarketWS } from '@/lib/polymarket-ws';
import { isConditionResolved, getWinningSide } from '@/lib/polymarket/redeem';
import { takerFeePerShare } from '@/lib/fees';
import { UmaProposalListener, type UmaProposal } from './uma-listener';
import type { BookSnapshot } from '@/lib/trading-types';
import type { GammaMarket } from '@/lib/types/polymarket';

// ─── Types ──────────────────────────────────────────────

export interface WatchedMarket {
  conditionId: string;
  question: string;
  slug: string;
  endDate: string;
  negRisk: boolean;
  yesTokenId: string;
  noTokenId: string;
  yesBestAsk: number | null;
  yesBestBid: number | null;
  noBestAsk: number | null;
  noBestBid: number | null;
  /** On-chain CTF resolution */
  resolved: boolean;
  winningSide: 'YES' | 'NO' | null;
  /** Predicted winner from price or UMA proposal */
  predictedWinner: 'YES' | 'NO' | null;
  /** Source of prediction */
  predictionSource: 'price' | 'uma_proposal' | null;
  /** Whether a limit order signal has been emitted */
  limitSignalSent: boolean;
  addedAt: number;
}

export interface WatcherSignal {
  conditionId: string;
  question: string;
  winningSide: 'YES' | 'NO';
  winningTokenId: string;
  /** Price to use for the order */
  askPrice: number;
  discountCents: number;
  netProfitCents: number;
  negRisk: boolean;
  yesTokenId: string;
  noTokenId: string;
  /** 'taker' = resolved, buy immediately | 'limit' = post-only at best ask */
  mode: 'taker' | 'limit';
}

export type WatcherLogFn = (type: string, text: string) => void;

// ─── Config ─────────────────────────────────────────────

const WATCHER_CONFIG = {
  RESOLUTION_POLL_MS: 10_000,
  MAX_WATCH_DURATION_MS: 10 * 60 * 1000,
  MIN_NET_PROFIT_CENTS: 1,
  /** Max price for taker buy (resolved market) */
  MAX_TAKER_PRICE: 0.97,
  /** Max price for limit buy — anything under 99.9c has at least 0.1c profit with 0 fee */
  MAX_LIMIT_PRICE: 0.999,
  /** Price threshold to predict likely winner */
  LIKELY_WINNER_PRICE: 0.90,
  LIMIT_CHECK_MS: 5_000,
};

// ─── Watcher ────────────────────────────────────────────

export class BondingWatcher {
  private ws: PolymarketWS | null = null;
  private watched = new Map<string, WatchedMarket>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private limitCheckTimer: ReturnType<typeof setInterval> | null = null;
  private umaListener: UmaProposalListener | null = null;
  private onSignal: ((signal: WatcherSignal) => void) | null = null;
  private logFn: WatcherLogFn;
  private tokenToCondition = new Map<string, string>();

  constructor(logFn: WatcherLogFn) {
    this.logFn = logFn;
  }

  start(onSignal: (signal: WatcherSignal) => void): void {
    this.onSignal = onSignal;
    this.ws = new PolymarketWS();

    // Path A: CTF resolution poll
    this.pollTimer = setInterval(() => this.pollResolutions(), WATCHER_CONFIG.RESOLUTION_POLL_MS);

    // Path B: UMA ProposePrice listener
    this.umaListener = new UmaProposalListener(this.logFn);
    this.umaListener.start((proposal) => this.handleUmaProposal(proposal));

    // Path C: Expired market limit check
    this.limitCheckTimer = setInterval(() => this.checkLimitOpportunities(), WATCHER_CONFIG.LIMIT_CHECK_MS);

    this.cleanupTimer = setInterval(() => this.cleanupStale(), 30_000);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.limitCheckTimer) clearInterval(this.limitCheckTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.pollTimer = null;
    this.limitCheckTimer = null;
    this.cleanupTimer = null;
    this.umaListener?.stop();
    this.umaListener = null;
    this.ws?.disconnect();
    this.ws = null;
    this.watched.clear();
    this.tokenToCondition.clear();
  }

  addMarket(market: GammaMarket): void {
    if (this.watched.has(market.conditionId)) return;

    let tokenIds: string[];
    try {
      tokenIds = JSON.parse(market.clobTokenIds);
    } catch {
      return;
    }
    if (tokenIds.length < 2) return;

    const yesTokenId = tokenIds[0];
    const noTokenId = tokenIds[1];

    const entry: WatchedMarket = {
      conditionId: market.conditionId,
      question: market.question,
      slug: market.slug,
      endDate: market.endDate,
      negRisk: market.negRisk ?? false,
      yesTokenId,
      noTokenId,
      yesBestAsk: null,
      yesBestBid: null,
      noBestAsk: null,
      noBestBid: null,
      resolved: false,
      winningSide: null,
      predictedWinner: null,
      predictionSource: null,
      limitSignalSent: false,
      addedAt: Date.now(),
    };

    this.watched.set(market.conditionId, entry);
    this.tokenToCondition.set(yesTokenId, market.conditionId);
    this.tokenToCondition.set(noTokenId, market.conditionId);

    if (this.ws) {
      if (!this.ws.isConnected()) {
        this.ws.connect([yesTokenId, noTokenId], (book) => this.handleBook(book));
      } else {
        this.ws.subscribe([yesTokenId, noTokenId]);
      }
    }

    this.logFn('watch', `Watching: ${market.question.slice(0, 60)}... (${market.conditionId.slice(0, 10)})`);
  }

  removeMarket(conditionId: string): void {
    const entry = this.watched.get(conditionId);
    if (!entry) return;
    if (this.ws?.isConnected()) {
      this.ws.unsubscribe([entry.yesTokenId, entry.noTokenId]);
    }
    this.tokenToCondition.delete(entry.yesTokenId);
    this.tokenToCondition.delete(entry.noTokenId);
    this.watched.delete(conditionId);
  }

  getWatched(): WatchedMarket[] {
    return [...this.watched.values()];
  }

  isWatching(conditionId: string): boolean {
    return this.watched.has(conditionId);
  }

  watchCount(): number {
    return this.watched.size;
  }

  // ─── Book Handler ─────────────────────────────────

  private handleBook(book: BookSnapshot): void {
    const conditionId = this.tokenToCondition.get(book.assetId);
    if (!conditionId) return;

    const entry = this.watched.get(conditionId);
    if (!entry) return;

    const bestAsk = book.sells.length > 0
      ? Math.min(...book.sells.map((s) => parseFloat(s.price)))
      : null;
    const bestBid = book.buys.length > 0
      ? Math.max(...book.buys.map((b) => parseFloat(b.price)))
      : null;

    if (book.assetId === entry.yesTokenId) {
      entry.yesBestAsk = bestAsk;
      entry.yesBestBid = bestBid;
    } else if (book.assetId === entry.noTokenId) {
      entry.noBestAsk = bestAsk;
      entry.noBestBid = bestBid;
    }

    // Path A: resolved → taker signal on every book update
    if (entry.resolved && entry.winningSide) {
      this.emitTakerSignal(entry);
      return;
    }

    // Update predicted winner from price
    if (!entry.predictedWinner || entry.predictionSource === 'price') {
      if (entry.yesBestBid != null && entry.yesBestBid >= WATCHER_CONFIG.LIKELY_WINNER_PRICE) {
        entry.predictedWinner = 'YES';
        entry.predictionSource = 'price';
      } else if (entry.noBestBid != null && entry.noBestBid >= WATCHER_CONFIG.LIKELY_WINNER_PRICE) {
        entry.predictedWinner = 'NO';
        entry.predictionSource = 'price';
      }
    }
  }

  // ─── Path A: CTF Resolution Poll ──────────────────

  private async pollResolutions(): Promise<void> {
    const entries = [...this.watched.values()].filter((e) => !e.resolved);
    if (entries.length === 0) return;

    const batch = entries.slice(0, 10);
    const results = await Promise.allSettled(
      batch.map(async (entry) => {
        const resolved = await isConditionResolved(entry.conditionId);
        if (!resolved) return;

        const winningSide = await getWinningSide(entry.conditionId);
        if (!winningSide) return;

        entry.resolved = true;
        entry.winningSide = winningSide;

        this.logFn('watch', `RESOLVED: ${entry.question.slice(0, 50)}... → ${winningSide}`);
        this.emitTakerSignal(entry);
      }),
    );

    for (const r of results) {
      if (r.status === 'rejected') {
        const msg = String(r.reason);
        // Suppress noisy RPC errors — will retry next poll
        if (!msg.includes('NETWORK_ERROR') && !msg.includes('rate') && !msg.includes('429')) {
          this.logFn('error', `Resolution poll error: ${msg.slice(0, 100)}`);
        }
      }
    }
  }

  // ─── Path B: UMA ProposePrice Handler ─────────────

  private handleUmaProposal(proposal: UmaProposal): void {
    if (proposal.proposedOutcome === 'UNKNOWN') return;

    // Try to match proposal to a watched market by ancillary data
    // The ancillary data contains the question text which we can fuzzy match
    // For now, log all Polymarket proposals for visibility
    this.logFn(
      'watch',
      `UMA proposal: ${proposal.proposedOutcome} | requester=${proposal.requester.slice(0, 10)}... | expires=${new Date(Number(proposal.expirationTimestamp) * 1000).toLocaleTimeString()}`,
    );

    // Update any watched market whose predicted winner isn't set yet
    // UMA proposal is stronger signal than price-based prediction
    for (const entry of this.watched.values()) {
      if (entry.resolved) continue;

      // UMA proposal overrides price-based prediction
      if (!entry.predictedWinner || entry.predictionSource === 'price') {
        entry.predictedWinner = proposal.proposedOutcome as 'YES' | 'NO';
        entry.predictionSource = 'uma_proposal';

        this.logFn(
          'watch',
          `UMA override: ${entry.question.slice(0, 40)}... → predicted ${proposal.proposedOutcome}`,
        );
      }
    }
  }

  // ─── Path C: Limit Order on Expired Markets ───────

  /**
   * For markets with a predicted winner (from price or UMA proposal):
   * Place a post-only limit order at the ACTUAL best ask from the orderbook,
   * as long as it's below 99.9c (any discount = profit with 0% maker fee).
   */
  private checkLimitOpportunities(): void {
    if (!this.onSignal) return;
    const now = Date.now();

    for (const entry of this.watched.values()) {
      if (entry.resolved || entry.limitSignalSent) continue;

      // For price-based prediction: only after expiry
      // For UMA proposal: can act immediately (bonding confirmed)
      if (entry.predictionSource === 'price') {
        const endTime = new Date(entry.endDate).getTime();
        if (now <= endTime) continue;
      } else if (entry.predictionSource !== 'uma_proposal') {
        continue;
      }

      if (!entry.predictedWinner) continue;

      const isYes = entry.predictedWinner === 'YES';
      const winningTokenId = isYes ? entry.yesTokenId : entry.noTokenId;
      const bestAsk = isYes ? entry.yesBestAsk : entry.noBestAsk;

      // Need orderbook data — skip if no ask available
      if (bestAsk == null) continue;

      // Only if best ask is below our max limit price (any discount = profit at 0% fee)
      if (bestAsk >= WATCHER_CONFIG.MAX_LIMIT_PRICE) continue;

      // Use actual best ask as our limit order price
      const limitPrice = bestAsk;
      const discountCents = (1.0 - limitPrice) * 100;
      // Post-only = 0 fee
      const netProfitCents = discountCents;

      if (netProfitCents < WATCHER_CONFIG.MIN_NET_PROFIT_CENTS) continue;

      entry.limitSignalSent = true;

      const src = entry.predictionSource === 'uma_proposal' ? 'UMA' : 'PRICE';
      this.logFn(
        'watch',
        `LIMIT [${src}]: ${entry.predictedWinner} ${entry.question.slice(0, 45)}... @ ${(limitPrice * 100).toFixed(1)}c (best ask, post-only)`,
      );

      this.onSignal({
        conditionId: entry.conditionId,
        question: entry.question,
        winningSide: entry.predictedWinner,
        winningTokenId,
        askPrice: limitPrice,
        discountCents,
        netProfitCents,
        negRisk: entry.negRisk,
        yesTokenId: entry.yesTokenId,
        noTokenId: entry.noTokenId,
        mode: 'limit',
      });
    }
  }

  // ─── Signal Emitters ──────────────────────────────

  private emitTakerSignal(entry: WatchedMarket): void {
    if (!entry.winningSide || !this.onSignal) return;

    const isYes = entry.winningSide === 'YES';
    const askPrice = isYes ? entry.yesBestAsk : entry.noBestAsk;
    const winningTokenId = isYes ? entry.yesTokenId : entry.noTokenId;

    if (askPrice == null || askPrice >= WATCHER_CONFIG.MAX_TAKER_PRICE) return;

    const discountCents = (1.0 - askPrice) * 100;
    const feeCents = takerFeePerShare(askPrice) * 100;
    const netProfitCents = discountCents - feeCents;

    if (netProfitCents < WATCHER_CONFIG.MIN_NET_PROFIT_CENTS) return;

    this.onSignal({
      conditionId: entry.conditionId,
      question: entry.question,
      winningSide: entry.winningSide,
      winningTokenId,
      askPrice,
      discountCents,
      netProfitCents,
      negRisk: entry.negRisk,
      yesTokenId: entry.yesTokenId,
      noTokenId: entry.noTokenId,
      mode: 'taker',
    });
  }

  // ─── Cleanup ──────────────────────────────────────

  private cleanupStale(): void {
    const now = Date.now();
    for (const [conditionId, entry] of this.watched) {
      const endTime = new Date(entry.endDate).getTime();
      const expired = now > endTime;
      const age = now - entry.addedAt;

      let shouldRemove = false;
      let reason = '';

      if (age > WATCHER_CONFIG.MAX_WATCH_DURATION_MS) {
        // Hard timeout — always remove
        shouldRemove = true;
        reason = 'timeout';
      } else if (expired && !entry.resolved) {
        if (!entry.predictedWinner) {
          // Expired, no prediction — nothing to do
          shouldRemove = true;
          reason = 'expired, no prediction';
        } else if (entry.limitSignalSent) {
          // Expired, limit order already sent — done watching
          shouldRemove = true;
          reason = 'expired, limit placed';
        }
      }

      if (shouldRemove) {
        this.logFn('watch', `Removed: ${entry.question.slice(0, 40)}... (${reason})`);
        this.removeMarket(conditionId);
      }
    }
  }
}
