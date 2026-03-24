/**
 * Bonding Strategy Engine (Two-Phase)
 *
 * Exploits the lag between UMA oracle resolution confirmation
 * and Polymarket CLOB price adjustment.
 *
 * Phase 1 — Passive Scan (30s interval):
 *   Scans for markets near expiry. If already resolved → buy immediately.
 *   If within 4h of expiry but not yet resolved → promote to Phase 2.
 *
 * Phase 2 — Active Watch (real-time):
 *   Connects PolymarketWS for live order book data.
 *   Polls on-chain resolution every 3s.
 *   The moment UMA confirms → checks book → buys winning token if < $1.
 *   Catches the seconds-long window that the 30s scanner would miss.
 */

import 'server-only';

import {
  loadProfile,
  getProfileBalance,
  placeProfileOrder,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';
import { redeemPositionsRPC, fetchClaimablePositions, type RedeemProfile } from '@/lib/polymarket/redeem';
import { scanBondingOpportunities, type BondingOpportunity, type ScanResult } from './scanner';
import { BondingWatcher, type WatcherSignal, type WatchedMarket } from './watcher';
import { isFeeProfitable } from '@/lib/fees';

// ─── Types ──────────────────────────────────────────────

export interface BondingTrade {
  conditionId: string;
  question: string;
  winningSide: 'YES' | 'NO';
  tokenId: string;
  buyPrice: number;
  size: number;
  netProfitCents: number;
  roi: number;
  timestamp: number;
  status: 'pending' | 'filled' | 'redeemed' | 'failed';
  redeemTxHash?: string;
  /** 'scan' = Phase 1, 'watch' = Phase 2 taker, 'limit' = Phase 2 post-only */
  source: 'scan' | 'watch' | 'limit';
}

export interface BondingEngineStatus {
  running: boolean;
  profileId?: string;
  balance?: number;
  lastScan?: ScanResult;
  trades: BondingTrade[];
  totalPnl: number;
  scanCount: number;
  lastScanTime?: number;
  /** Phase 2 active watches */
  watchedMarkets: WatchedMarket[];
}

export type BondingLogType = 'info' | 'scan' | 'trade' | 'redeem' | 'error' | 'watch';

export interface BondingLogLine {
  text: string;
  type: BondingLogType;
  timestamp: number;
}

// ─── Config ─────────────────────────────────────────────

const CONFIG = {
  /** Scan interval (ms) */
  SCAN_INTERVAL_MS: 30_000,
  /** Max $ per trade */
  MAX_BET_AMOUNT: 50,
  /** Min shares per trade */
  MIN_SHARES: 5,
  /** Min balance to keep trading */
  MIN_BALANCE: 5,
  /** Max concurrent positions */
  MAX_POSITIONS: 5,
  /** Redeem check interval (ms) */
  REDEEM_INTERVAL_MS: 60_000,
  /** Max log entries */
  MAX_LOGS: 500,
};

// ─── Engine Singleton ───────────────────────────────────

let instance: BondingEngine | null = null;

export function getEngine(): BondingEngine {
  if (!instance) instance = new BondingEngine();
  return instance;
}

class BondingEngine {
  private running = false;
  private profileId: string | null = null;
  private profile: ProfileCredentials | null = null;
  private balance = 0;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private redeemTimer: ReturnType<typeof setInterval> | null = null;
  private trades: BondingTrade[] = [];
  private logs: BondingLogLine[] = [];
  private lastScan: ScanResult | null = null;
  private scanCount = 0;
  private boughtConditions = new Set<string>();

  // Phase 2: Active watcher
  private watcher: BondingWatcher | null = null;

  // ─── Public API ─────────────────────────────────────

  async start(profileId: string): Promise<void> {
    if (this.running) return;

    const profile = await loadProfile(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);

    this.profileId = profileId;
    this.profile = profile;
    this.running = true;
    this.scanCount = 0;
    this.log('info', `Bonding engine started (profile: ${profile.name})`);

    // Initial balance
    try {
      this.balance = await getProfileBalance(profile);
      this.log('info', `Balance: $${this.balance.toFixed(2)}`);
    } catch (err) {
      this.log('error', `Failed to fetch balance: ${err instanceof Error ? err.message : err}`);
    }

    // Start Phase 2 watcher
    this.watcher = new BondingWatcher((type, text) => this.log(type as BondingLogType, text));
    this.watcher.start((signal) => this.handleWatcherSignal(signal));
    this.log('info', 'Phase 2 watcher started (WS + 3s resolution poll)');

    // Run first scan immediately
    this.runScanCycle();

    // Set up recurring scans & redeem checks
    this.scanTimer = setInterval(() => this.runScanCycle(), CONFIG.SCAN_INTERVAL_MS);
    this.redeemTimer = setInterval(() => this.runRedeemCycle(), CONFIG.REDEEM_INTERVAL_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.redeemTimer) clearInterval(this.redeemTimer);
    this.scanTimer = null;
    this.redeemTimer = null;
    this.watcher?.stop();
    this.watcher = null;
    this.log('info', 'Bonding engine stopped');
  }

  getStatus(): BondingEngineStatus {
    const filledTrades = this.trades.filter((t) => t.status === 'filled' || t.status === 'redeemed');
    const totalPnl = filledTrades.reduce((sum, t) => {
      if (t.status === 'redeemed') return sum + (t.size * (1 - t.buyPrice));
      return sum;
    }, 0);

    return {
      running: this.running,
      profileId: this.profileId ?? undefined,
      balance: this.balance,
      lastScan: this.lastScan ?? undefined,
      trades: [...this.trades].reverse().slice(0, 50),
      totalPnl,
      scanCount: this.scanCount,
      lastScanTime: this.lastScan?.timestamp,
      watchedMarkets: this.watcher?.getWatched() ?? [],
    };
  }

  getLogs(limit = 200): BondingLogLine[] {
    return this.logs.slice(-limit);
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── Phase 1: Passive Scan ──────────────────────────

  private async runScanCycle(): Promise<void> {
    if (!this.running || !this.profile) return;

    try {
      this.scanCount++;
      const result = await scanBondingOpportunities();
      this.lastScan = result;

      // Phase 2: Promote near-expiry unresolved markets to active watching
      if (this.watcher && result.watchCandidates.length > 0) {
        let newWatches = 0;
        for (const market of result.watchCandidates) {
          if (!this.watcher.isWatching(market.conditionId) && !this.boughtConditions.has(market.conditionId)) {
            this.watcher.addMarket(market);
            newWatches++;
          }
        }
        if (newWatches > 0) {
          this.log('watch', `Promoted ${newWatches} markets to active watch (total: ${this.watcher.watchCount()})`);
        }
      }

      if (result.opportunities.length > 0) {
        this.log(
          'scan',
          `Scan #${this.scanCount}: ${result.scannedCount} mkt, ${result.resolvedCount} resolved, ${result.opportunities.length} opps`,
        );

        for (const opp of result.opportunities) {
          this.log(
            'scan',
            `  ${opp.winningSide} ${opp.question.slice(0, 60)}... @ ${(opp.winningPrice * 100).toFixed(1)}c → +${opp.netProfitCents.toFixed(1)}c (${opp.roi.toFixed(1)}%)`,
          );
        }

        await this.executeTrades(result.opportunities, 'scan');
      } else if (this.scanCount % 10 === 0) {
        this.log('info', `Scan #${this.scanCount}: ${result.scannedCount} markets, ${result.watchCandidates.length} watching, no opps`);
      }
    } catch (err) {
      this.log('error', `Scan error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ─── Phase 2: Watcher Signal ────────────────────────

  private async handleWatcherSignal(signal: WatcherSignal): Promise<void> {
    if (!this.running || !this.profile) return;
    if (this.boughtConditions.has(signal.conditionId)) return;

    const modeTag = signal.mode === 'limit' ? 'LIMIT' : 'TAKER';
    this.log(
      'watch',
      `SIGNAL [${modeTag}]: ${signal.winningSide} ${signal.question.slice(0, 50)}... @ ${(signal.askPrice * 100).toFixed(1)}c net=+${signal.netProfitCents.toFixed(1)}c`,
    );

    // Convert watcher signal to opportunity format for executeTrades
    const opp: BondingOpportunity = {
      conditionId: signal.conditionId,
      question: signal.question,
      slug: '',
      endDate: '',
      hoursToExpiry: 0,
      winningSide: signal.winningSide,
      winningTokenId: signal.winningTokenId,
      winningPrice: signal.askPrice,
      discountCents: signal.discountCents,
      netProfitCents: signal.netProfitCents,
      roi: (signal.netProfitCents / (signal.askPrice * 100)) * 100,
      negRisk: signal.negRisk,
      yesTokenId: signal.yesTokenId,
      noTokenId: signal.noTokenId,
      liquidity: 0,
      volume: 0,
    };

    await this.executeTrades([opp], signal.mode === 'limit' ? 'limit' : 'watch');

    // Remove from watcher after buying
    if (this.boughtConditions.has(signal.conditionId)) {
      this.watcher?.removeMarket(signal.conditionId);
    }
  }

  // ─── Trade Execution (shared by Phase 1 & 2) ───────

  private async executeTrades(opportunities: BondingOpportunity[], source: 'scan' | 'watch' | 'limit'): Promise<void> {
    if (!this.profile) return;

    const activePositions = this.trades.filter((t) => t.status === 'filled').length;
    if (activePositions >= CONFIG.MAX_POSITIONS) {
      this.log('info', `Max positions (${CONFIG.MAX_POSITIONS}) reached, skipping`);
      return;
    }

    // Refresh balance
    try {
      this.balance = await getProfileBalance(this.profile);
    } catch {
      return;
    }

    if (this.balance < CONFIG.MIN_BALANCE) {
      this.log('info', `Balance too low ($${this.balance.toFixed(2)}), skipping`);
      return;
    }

    for (const opp of opportunities) {
      if (!this.running) break;
      if (this.trades.filter((t) => t.status === 'filled').length >= CONFIG.MAX_POSITIONS) break;
      if (this.boughtConditions.has(opp.conditionId)) continue;

      const isMaker = source === 'limit';
      if (!isFeeProfitable(opp.winningPrice, opp.discountCents, isMaker)) {
        this.log('scan', `  Skip ${opp.conditionId.slice(0, 10)}... — not profitable after fees`);
        continue;
      }

      const maxShares = Math.floor(Math.min(CONFIG.MAX_BET_AMOUNT, this.balance * 0.8) / opp.winningPrice);
      if (maxShares < CONFIG.MIN_SHARES) continue;

      try {
        const tag = source === 'limit' ? '[LIMIT]' : source === 'watch' ? '[WS]' : '[SCAN]';
        const modeLabel = source === 'limit' ? 'post-only' : 'taker';
        this.log('trade', `${tag} BUY ${opp.winningSide} ${opp.question.slice(0, 50)}... | ${maxShares}× @ ${(opp.winningPrice * 100).toFixed(1)}c (${modeLabel})`);

        await placeProfileOrder(this.profile, {
          tokenId: opp.winningTokenId,
          side: 'BUY',
          price: opp.winningPrice,
          size: maxShares,
          ...(source === 'limit'
            ? { postOnly: true }
            : { taker: true }),
        });

        // Post-only orders are resting — mark as 'pending' until filled
        const initialStatus = source === 'limit' ? 'pending' : 'filled';

        const trade: BondingTrade = {
          conditionId: opp.conditionId,
          question: opp.question,
          winningSide: opp.winningSide,
          tokenId: opp.winningTokenId,
          buyPrice: opp.winningPrice,
          size: maxShares,
          netProfitCents: opp.netProfitCents,
          roi: opp.roi,
          timestamp: Date.now(),
          status: initialStatus,
          source,
        };

        this.trades.push(trade);
        this.boughtConditions.add(opp.conditionId);
        if (initialStatus === 'filled') {
          this.balance -= maxShares * opp.winningPrice;
        }

        this.log(
          'trade',
          initialStatus === 'pending'
            ? `  POSTED — resting limit @ ${(opp.winningPrice * 100).toFixed(1)}c, expected +$${((maxShares * opp.netProfitCents) / 100).toFixed(2)}`
            : `  FILLED — expected +$${((maxShares * opp.netProfitCents) / 100).toFixed(2)} (${opp.roi.toFixed(1)}% ROI)`,
        );
      } catch (err) {
        this.log('error', `Order failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ─── Redeem Cycle ───────────────────────────────────

  private async runRedeemCycle(): Promise<void> {
    if (!this.running || !this.profile) return;

    const filledTrades = this.trades.filter((t) => t.status === 'filled');
    if (filledTrades.length === 0) return;

    const ownerAddress = this.profile.funderAddress || this.profile.privateKey;
    try {
      const claimable = await fetchClaimablePositions(ownerAddress);
      if (claimable.length === 0) return;

      const redeemProfile: RedeemProfile = {
        privateKey: this.profile.privateKey,
        funderAddress: this.profile.funderAddress,
        signatureType: this.profile.signatureType,
        apiKey: this.profile.apiKey,
        apiSecret: this.profile.apiSecret,
        apiPassphrase: this.profile.apiPassphrase,
        builderApiKey: this.profile.builderApiKey,
        builderApiSecret: this.profile.builderApiSecret,
        builderApiPassphrase: this.profile.builderApiPassphrase,
      };

      for (const pos of claimable) {
        const trade = filledTrades.find((t) => t.conditionId === pos.conditionId);
        if (!trade) continue;

        this.log('redeem', `Redeeming ${pos.title} (${pos.outcome}) — ${pos.size} shares`);

        try {
          const yesTokenId = pos.asset;
          const noTokenId = pos.oppositeAsset;

          const result = await redeemPositionsRPC(
            redeemProfile,
            pos.conditionId,
            pos.negativeRisk,
            yesTokenId,
            noTokenId,
          );

          if (result.success) {
            trade.status = 'redeemed';
            trade.redeemTxHash = result.txHash ?? undefined;
            const profit = trade.size * (1 - trade.buyPrice);
            this.log('redeem', `  Redeemed! +$${profit.toFixed(2)} | TX: ${result.txHash?.slice(0, 16)}...`);
          } else {
            this.log('error', `  Redeem failed: ${result.error}`);
          }
        } catch (err) {
          this.log('error', `Redeem error: ${err instanceof Error ? err.message : err}`);
        }
      }

      this.balance = await getProfileBalance(this.profile);
    } catch (err) {
      this.log('error', `Redeem cycle error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ─── Logging ────────────────────────────────────────

  private log(type: BondingLogType, text: string): void {
    const ts = new Date();
    const timeStr = ts.toLocaleTimeString('en-US', { hour12: false });
    const entry: BondingLogLine = {
      text: `[${timeStr}] ${text}`,
      type,
      timestamp: ts.getTime(),
    };
    this.logs.push(entry);
    if (this.logs.length > CONFIG.MAX_LOGS) {
      this.logs = this.logs.slice(-CONFIG.MAX_LOGS);
    }
    console.log(`[bonding:${type}] ${text}`);
  }
}
