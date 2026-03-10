/**
 * Edge Engine — 5-Minute Crypto Up/Down Bot
 *
 * Trades Polymarket's rolling 5-minute binary options:
 *   "Will BTC go Up or Down in the next 5 minutes?"
 *   Resolves via Chainlink BTC/USD data stream.
 *
 * Edge sources:
 *   1. Latency arb: Binance WS (~50ms) leads Chainlink (~1-2s lag)
 *      → If Binance shows strong momentum, buy Up/Down before CLOB reprices
 *   2. Momentum sniper: In final 30-60s, if price has moved decisively,
 *      the outcome is near-certain but tokens may still be mispriced
 *
 * Connects to:
 *   - Binance WS (direct BTC trades, ~50ms)
 *   - RTDS WS (Polymarket relay: Binance + Chainlink prices)
 *   - CLOB WS (orderbook per Up/Down token)
 */

import 'server-only';

import { BinanceDirectWS } from '../binance-ws';
import { RtdsWS } from '../rtds-ws';
import { PolymarketWS } from '../polymarket-ws';
import type { BookSnapshot, CryptoAsset } from '../trading-types';
import { takerFeePerShare } from '../fees';
import {
  calculateEdge,
  kellySize,
  estimateVolatility,
  normalCDF,
  MIN_TOKEN_PRICE,
  MAX_TOKEN_PRICE,
} from './math';
import {
  logTradeSignal,
  logTradeResult,
  logOrderPlaced,
  logSkip,
  logTradeError,
  getAdaptiveThresholds,
  type TradeLogEntry,
  type TradeStrategy,
} from './trade-logger';
import {
  loadProfile,
  placeProfileOrder,
  getProfileBalance,
  type ProfileCredentials,
} from '../bot/profile-client';
import { fetchClaimablePositions, redeemPositionsRPC, type RedeemProfile } from '../polymarket/redeem';
import { scanUpDownMarkets, type UpDownMarket } from './market-scanner';

// ─── Types ─────────────────────────────────────────────

export type { UpDownMarket } from './market-scanner';

export interface EngineConfig {
  profileId: string;
  /** Enable latency arb (react to Binance moves before CLOB reprices) */
  enableLatencyArb: boolean;
  /** Enable momentum sniper (trade in final 30-60s of window) */
  enableMomentumSniper: boolean;
  /** Use post-only (maker) orders — zero fee but may not fill */
  preferMaker: boolean;
  /** Minimum confidence to trade (0-100) */
  minConfidence: number;
  /** Maximum concurrent positions */
  maxPositions: number;
  /** Cooldown between trades on same market (ms) */
  tradeCooldownMs: number;
  /** Use adaptive thresholds from trade history */
  adaptiveMode: boolean;
  /** Which assets to trade */
  assets: CryptoAsset[];
  /** Market rescan interval (ms) — how often to find new 5m markets */
  rescanIntervalMs: number;
}

interface ActivePosition {
  logId: string;
  conditionId: string;
  tokenId: string;
  direction: 'UP' | 'DOWN';
  entryPrice: number;
  size: number;
  entryTime: number;
  /** Reference price at window start (for settlement calc) */
  refPrice: number;
}

// ─── Engine ────────────────────────────────────────────

const DEFAULT_CONFIG: Partial<EngineConfig> = {
  enableLatencyArb: true,
  enableMomentumSniper: true,
  preferMaker: false, // taker for speed
  minConfidence: 60,
  maxPositions: 2,
  tradeCooldownMs: 15_000, // 15s cooldown (markets only last 5min)
  adaptiveMode: true,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  rescanIntervalMs: 60_000, // rescan every 60s for new markets
};

export class EdgeEngine {
  private binanceWS: BinanceDirectWS;
  private rtdsWS: RtdsWS;
  private clobWS: PolymarketWS;
  private config: EngineConfig;
  private profile: ProfileCredentials | null = null;
  private balance = 0;

  // State
  private running = false;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private sniperTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private books: Map<string, BookSnapshot> = new Map();
  private positions: Map<string, ActivePosition> = new Map();
  private lastTradeTime: Map<string, number> = new Map();
  private priceHistory: Map<CryptoAsset, number[]> = new Map();
  private evaluating = false;

  // Active markets (refreshed periodically)
  private activeMarkets: UpDownMarket[] = [];
  /** Reference prices at window start — key: conditionId */
  private refPrices: Map<string, number> = new Map();

  // Adaptive thresholds
  private adaptiveMinConfidence = 50;
  private adaptiveMinEdgeCents = 1.5;
  private adaptiveKellyFraction = 0.25;
  private _lastDebugLog: Map<string, number> | null = null;

  constructor(config: Partial<EngineConfig> & { profileId: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config } as EngineConfig;
    this.binanceWS = new BinanceDirectWS();
    this.rtdsWS = new RtdsWS();
    this.clobWS = new PolymarketWS();
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.profile = await loadProfile(this.config.profileId);
    if (!this.profile) throw new Error(`Profile ${this.config.profileId} not found`);

    this.balance = await getProfileBalance(this.profile);
    console.log(`[edge] Starting engine ($${this.balance.toFixed(2)} balance)`);

    if (this.config.adaptiveMode) {
      await this.refreshAdaptiveThresholds();
    }

    this.running = true;

    // Connect Binance WS — event-driven latency arb
    this.binanceWS.connect((price) => {
      if (this.config.enableLatencyArb) {
        this.onBinanceTrade(price);
      }
    });

    // Connect RTDS for Chainlink + Binance relay prices
    this.rtdsWS.connect((asset, price) => {
      let history = this.priceHistory.get(asset);
      if (!history) { history = []; this.priceHistory.set(asset, history); }
      history.push(price);
      if (history.length > 120) history.shift();
    });

    // Initial market scan + connect CLOB WS with discovered tokens
    await this.initialScan();

    // Rescan for new 5m markets periodically
    this.rescanTimer = setInterval(() => this.refreshMarkets(), this.config.rescanIntervalMs);

    // Momentum sniper: check every 2s (trades in final 30-60s)
    if (this.config.enableMomentumSniper) {
      this.sniperTimer = setInterval(() => this.tickMomentumSniper(), 2000);
    }

    // Balance + adaptive refresh + auto-redeem every 5 min
    this.refreshTimer = setInterval(async () => {
      if (!this.profile || !this.running) return;
      try {
        // Auto-redeem settled positions
        await this.autoRedeem();
        this.balance = await getProfileBalance(this.profile);
        if (this.config.adaptiveMode) await this.refreshAdaptiveThresholds();
      } catch (e) {
        console.error('[edge] Refresh error:', (e as Error).message);
      }
    }, 5 * 60 * 1000);

    console.log(`[edge] Engine started (event-driven). Assets: ${this.config.assets.join(', ')}`);
  }

  stop(): void {
    this.running = false;
    for (const timer of [this.rescanTimer, this.sniperTimer, this.refreshTimer]) {
      if (timer) clearInterval(timer);
    }
    this.rescanTimer = this.sniperTimer = this.refreshTimer = null;
    this.binanceWS.disconnect();
    this.rtdsWS.disconnect();
    this.clobWS.disconnect();
    this.books.clear();
    this.priceHistory.clear();
    this.activeMarkets = [];
    console.log('[edge] Engine stopped.');
  }

  isRunning(): boolean { return this.running; }

  getStatus() {
    return {
      running: this.running,
      profile: this.profile?.name ?? null,
      balance: this.balance,
      binanceConnected: this.binanceWS.isConnected(),
      rtdsConnected: this.rtdsWS.isConnected(),
      clobConnected: this.clobWS.isConnected(),
      activePositions: this.positions.size,
      activeMarkets: this.activeMarkets.length,
      assets: this.config.assets,
      adaptive: {
        minConfidence: this.adaptiveMinConfidence,
        minEdgeCents: this.adaptiveMinEdgeCents,
        kellyFraction: this.adaptiveKellyFraction,
      },
    };
  }

  getActiveMarkets(): UpDownMarket[] { return this.activeMarkets; }

  // ─── Market Refresh ─────────────────────────────────

  /** First scan: discover markets then connect CLOB WS with their tokens */
  private async initialScan(): Promise<void> {
    const markets = await scanUpDownMarkets(this.config.assets);
    const now = Date.now();
    this.activeMarkets = markets.filter(m => m.endMs > now);

    const allTokenIds = this.activeMarkets.flatMap(m => [m.upTokenId, m.downTokenId]);
    if (allTokenIds.length > 0) {
      // Connect CLOB WS with initial token list
      this.clobWS.connect(allTokenIds, (book) => {
        this.books.set(book.assetId, book);
      });
    }

    // Record reference prices — use asset-specific price source
    for (const m of this.activeMarkets) {
      const spot = m.asset === 'BTC'
        ? (this.binanceWS.getPrice() ?? this.rtdsWS.getSpotPrice('BTC'))
        : this.rtdsWS.getSpotPrice(m.asset);
      if (spot) this.refPrices.set(m.conditionId, spot);
    }
  }

  private async refreshMarkets(): Promise<void> {
    if (!this.running) return;

    try {
      const markets = await scanUpDownMarkets(this.config.assets);
      const now = Date.now();

      // Filter to only markets that are still open
      this.activeMarkets = markets.filter(m => m.endMs > now);

      // Subscribe to new token orderbooks
      const allTokenIds = this.activeMarkets.flatMap(m => [m.upTokenId, m.downTokenId]);
      if (allTokenIds.length > 0) {
        this.clobWS.subscribe(allTokenIds);
      }

      // Record reference prices for markets that just started — asset-specific
      for (const m of this.activeMarkets) {
        if (!this.refPrices.has(m.conditionId)) {
          const spot = m.asset === 'BTC'
            ? (this.binanceWS.getPrice() ?? this.rtdsWS.getSpotPrice('BTC'))
            : this.rtdsWS.getSpotPrice(m.asset);
          if (spot) {
            this.refPrices.set(m.conditionId, spot);
          }
        }
      }

      // Clean up expired reference prices
      const activeIds = new Set(this.activeMarkets.map(m => m.conditionId));
      for (const [cid] of this.refPrices) {
        if (!activeIds.has(cid)) this.refPrices.delete(cid);
      }
    } catch (err) {
      console.error('[edge] Market scan error:', (err as Error).message);
    }
  }

  // ─── Latency Arb (Event-Driven) ─────────────────────

  /**
   * Fired on every Binance trade.
   * Edge: Binance moves first → Chainlink (settlement) lags 1-2s
   * → CLOB tokens haven't repriced → buy the correct direction.
   */
  private onBinanceTrade(binancePrice: number): void {
    if (!this.running || !this.profile || this.evaluating) return;
    this.evaluating = true;

    const evalPromises: Promise<void>[] = [];
    const now = Date.now();

    for (const market of this.activeMarkets) {
      // Skip if not in trading window (only trade when >60s remain)
      const secsLeft = (market.endMs - now) / 1000;
      if (secsLeft < 30 || secsLeft > 300) continue; // momentum sniper handles <30s

      // Cooldown check — per market AND per asset (prevent SOL spam across windows)
      const lastTrade = this.lastTradeTime.get(market.conditionId) ?? 0;
      if (now - lastTrade < this.config.tradeCooldownMs) continue;
      const lastAssetTrade = this.lastTradeTime.get(`asset:${market.asset}`) ?? 0;
      if (now - lastAssetTrade < 120_000) continue; // 2-min cooldown per asset
      if (this.positions.size >= this.config.maxPositions) continue;
      if (this.positions.has(market.conditionId)) continue;

      // Only BTC has direct Binance WS — other assets use RTDS
      const spotPrice = market.asset === 'BTC'
        ? binancePrice
        : this.rtdsWS.getSpotPrice(market.asset);
      if (!spotPrice) continue;

      const refPrice = this.refPrices.get(market.conditionId);
      if (!refPrice) continue;

      evalPromises.push(
        this.evaluateLatencyArb(market, spotPrice, refPrice, secsLeft)
          .catch(err => {
            const msg = (err as Error).message;
            if (!msg.includes('rate') && !msg.includes('429')) {
              console.error(`[edge] Arb error:`, msg);
            }
          })
      );
    }

    if (evalPromises.length > 0) {
      Promise.all(evalPromises).finally(() => { this.evaluating = false; });
    } else {
      this.evaluating = false;
    }
  }

  private async evaluateLatencyArb(
    market: UpDownMarket,
    spotPrice: number,
    refPrice: number,
    secsLeft: number,
  ): Promise<void> {
    const microMomentum = this.binanceWS.getMicroMomentum() ?? 0;
    const history = this.priceHistory.get(market.asset);
    const rawVol = history ? estimateVolatility(history.slice(-20)) : 0.001;
    // Floor vol at 0.20% — compromise: 0.15% caused phantom edge, 0.30% killed all signals.
    // BTC 5-min vol ≈ 0.15% average, but RTDS is sparse so floor slightly above.
    const microVol = Math.max(rawVol, 0.0020);

    // Direction: price moved up or down from reference?
    const priceDelta = (spotPrice - refPrice) / refPrice;
    const isUp = priceDelta > 0;

    // Log evaluation periodically (every ~30s per market) for debugging
    if (!this._lastDebugLog) this._lastDebugLog = new Map();
    const lastLog = this._lastDebugLog.get(market.conditionId) ?? 0;
    if (Date.now() - lastLog > 30_000) {
      this._lastDebugLog.set(market.conditionId, Date.now());
      console.log(`[edge:eval] ${market.asset} delta=${(priceDelta*100).toFixed(3)}% vol=${(microVol*100).toFixed(3)}% mom=${(microMomentum*100).toFixed(4)}% ${secsLeft.toFixed(0)}s left`);
    }

    // Skip if price hasn't moved enough (within noise)
    if (Math.abs(priceDelta) < microVol * 0.3) return;

    // Momentum check: soft — bonus confidence if momentum agrees, but don't block.
    // Previous hard block was filtering out valid signals where microMomentum ≈ 0.
    const momentumAligned = market.asset === 'BTC'
      ? (isUp ? microMomentum > 0 : microMomentum < 0)
      : true;

    // Fair value estimation:
    // z = delta / (vol × √(T/60)) — how many σ away from flat
    const zScore = priceDelta / Math.max(microVol * Math.sqrt(secsLeft / 60), 0.00001);

    // z-threshold scales with time remaining:
    // At 300s (start): z≥2.5 required — need strong move to overcome 5min uncertainty
    // At 120s: z≥2.0 — moderate conviction
    // At 60s: z≥1.5 — reasonable certainty with less time for reversal
    const minZ = secsLeft > 200 ? 2.5 : secsLeft > 100 ? 2.0 : 1.5;
    if (Math.abs(zScore) < minZ) return;

    const fairUpProb = normalCDF(zScore);

    // Token selection
    const direction: 'UP' | 'DOWN' = isUp ? 'UP' : 'DOWN';
    const primaryTokenId = isUp ? market.upTokenId : market.downTokenId;
    const primaryBook = this.books.get(primaryTokenId);
    if (!primaryBook || primaryBook.buys.length === 0 || primaryBook.sells.length === 0) return;

    const bestBid = parseFloat(primaryBook.buys[0].price);
    const bestAsk = parseFloat(primaryBook.sells[0].price);
    const tokenPrice = (bestBid + bestAsk) / 2;
    const tokenId = primaryTokenId;

    if (tokenPrice < MIN_TOKEN_PRICE || tokenPrice > MAX_TOKEN_PRICE) return;

    // Risk/reward gate: avoid expensive tokens where risk/reward is terrible
    // At 0.85: risk $4.25, win $0.75 → ratio 5.7:1 (marginal)
    // At 0.80: risk $4.00, win $1.00 → ratio 4:1 (acceptable with high z)
    if (tokenPrice > 0.90) return; // hard block — ratio >9:1 is never worth it
    if (tokenPrice > 0.85 && Math.abs(zScore) < 2.5) return;
    if (tokenPrice > 0.80 && Math.abs(zScore) < 2.0) return;

    // Edge calc — use taker for latency arb (speed matters), maker only near 50c
    const useMaker = tokenPrice > 0.3 && tokenPrice < 0.7;
    const fairValue = isUp ? fairUpProb : (1 - fairUpProb);

    // Divergence cap: if our model disagrees with CLOB by more than 25c,
    // trust the market — our vol/z-score estimate is probably wrong.
    // Cap fair value halfway between our estimate and market price.
    let adjustedFairValue = fairValue;
    const modelDivergence = Math.abs(fairValue - tokenPrice) * 100;
    if (modelDivergence > 25) {
      adjustedFairValue = (fairValue + tokenPrice) / 2;
    }
    const edge = calculateEdge(adjustedFairValue, tokenPrice, useMaker);

    if (!edge.isProfitable) return;

    // Confidence scoring (recalibrated — 65 threshold)
    let confidence = 0;
    confidence += Math.min(edge.netEdgeCents / 0.5, 30);             // edge magnitude (30 pts max)
    confidence += Math.min(Math.abs(zScore) * 15, 30);               // z-score (30 pts max)
    confidence += momentumAligned ? 10 : 0;                           // momentum agrees (10 pts)
    confidence += Math.min((300 - secsLeft) / 12, 15);               // time pressure (15 pts)
    confidence += Math.min(Math.abs(tokenPrice - 0.5) * 30, 15);    // away from 50c (15 pts)
    confidence = Math.min(Math.round(confidence), 100);

    // Dual oracle check — Chainlink confirmation adds confidence, disagreement blocks
    const chainlinkPrice = this.rtdsWS.getChainlinkPrice(market.asset);
    if (chainlinkPrice) {
      const chainlinkAgrees = this.rtdsWS.oraclesAgree(market.asset, refPrice, spotPrice);
      if (!chainlinkAgrees) return; // Chainlink actively disagrees — hard block
      confidence += 10; // Chainlink confirms — bonus confidence
    }
    confidence = Math.min(Math.round(confidence), 100);

    const minConf = this.config.adaptiveMode ? this.adaptiveMinConfidence : this.config.minConfidence;
    if (confidence < minConf) {
      // Log near-misses for debugging (within 10 of threshold)
      if (confidence >= minConf - 10) {
        console.log(`[edge:skip] ${market.asset} conf=${confidence}<${minConf} z=${zScore.toFixed(2)} edge=${edge.netEdgeCents.toFixed(1)}c ${secsLeft.toFixed(0)}s`);
      }
      return;
    }

    await this.executeTrade(market, direction, tokenId, tokenPrice, edge, confidence, 'latency-arb', {
      spotPrice, refPrice, priceDelta, microMomentum, zScore, secsLeft, bestBid, bestAsk, useMaker,
    });
  }

  // ─── Momentum Sniper (Timer-Based) ──────────────────

  /**
   * Runs every 2s. Trades in the final 30-60s when outcome is near-certain.
   */
  private async tickMomentumSniper(): Promise<void> {
    if (!this.running || !this.profile) return;

    const now = Date.now();

    for (const market of this.activeMarkets) {
      const secsLeft = (market.endMs - now) / 1000;
      if (secsLeft < 10 || secsLeft > 60) continue; // sweet spot: 10-60s before end

      const lastTrade = this.lastTradeTime.get(market.conditionId) ?? 0;
      if (now - lastTrade < this.config.tradeCooldownMs) continue;
      if (this.positions.size >= this.config.maxPositions) continue;
      if (this.positions.has(market.conditionId)) continue;

      try {
        // Use asset-specific price — BTC from Binance, others from RTDS
        const spotPrice = market.asset === 'BTC'
          ? (this.binanceWS.getPrice() ?? this.rtdsWS.getSpotPrice('BTC'))
          : this.rtdsWS.getSpotPrice(market.asset);
        if (!spotPrice) continue;

        const refPrice = this.refPrices.get(market.conditionId);
        if (!refPrice) continue;

        const chainlinkPrice = this.rtdsWS.getChainlinkPrice(market.asset);

        // Price displacement
        const priceDelta = (spotPrice - refPrice) / refPrice;
        const isUp = priceDelta > 0;

        // Volatility estimation — floor at 0.20% (0.15% too low, 0.30% too conservative)
        const history = this.priceHistory.get(market.asset);
        const recentVol = Math.max(
          history ? estimateVolatility(history.slice(-60)) : 0.001,
          0.0020,
        );

        // How many σ away from flat?
        const sigmaRemaining = recentVol * Math.sqrt(secsLeft / 60);
        const zScore = priceDelta / Math.max(sigmaRemaining, 0.00001);

        // Need strong z-score (>2.0σ) for conviction — 1.5 was too loose
        if (Math.abs(zScore) < 2.0) continue;

        // Chainlink MUST agree (it's the settlement oracle)
        if (chainlinkPrice) {
          const chainlinkDelta = (chainlinkPrice - refPrice) / refPrice;
          const chainlinkAgrees = (chainlinkDelta > 0) === isUp;
          if (!chainlinkAgrees) {
            await logSkip(this.config.profileId, 'expiry-sniper', 'Chainlink disagrees', {
              spotPrice, chainlinkPrice, refPrice, priceDelta, conditionId: market.conditionId,
            });
            continue;
          }
        }

        // Token selection
        const direction: 'UP' | 'DOWN' = isUp ? 'UP' : 'DOWN';
        const tokenId = isUp ? market.upTokenId : market.downTokenId;
        const tokenBook = this.books.get(tokenId);
        if (!tokenBook || tokenBook.buys.length === 0 || tokenBook.sells.length === 0) continue;

        const bestBid = parseFloat(tokenBook.buys[0].price);
        const bestAsk = parseFloat(tokenBook.sells[0].price);
        const tokenPrice = (bestBid + bestAsk) / 2;

        if (tokenPrice < MIN_TOKEN_PRICE || tokenPrice > MAX_TOKEN_PRICE) continue;

        // Risk/reward gate for sniper too — but sniper has higher z-scores
        if (tokenPrice > 0.90 && Math.abs(zScore) < 2.5) continue;
        if (tokenPrice > 0.85 && Math.abs(zScore) < 2.0) continue;

        // Win probability from z-score (proper normal CDF)
        const winProb = normalCDF(Math.abs(zScore));
        const fairValue = winProb; // our token should be worth this much
        // Sniper: use maker near 50c (fee zone), taker at extremes for speed
        const useMaker = tokenPrice > 0.3 && tokenPrice < 0.7;
        const edge = calculateEdge(fairValue, tokenPrice, useMaker);

        if (!edge.isProfitable) continue;

        // Confidence scoring
        let confidence = 0;
        confidence += Math.min(Math.abs(zScore) * 12, 30);           // z-score (main driver)
        confidence += Math.min(edge.netEdgeCents / 0.3, 20);         // edge
        confidence += chainlinkPrice ? 20 : 0;                        // chainlink confirms
        confidence += Math.min((60 - secsLeft) / 2, 20);             // closer to end = better
        confidence += Math.min(Math.abs(tokenPrice - 0.5) * 20, 10); // fee zone
        confidence = Math.min(Math.round(confidence), 100);

        const minConf = this.config.adaptiveMode ? this.adaptiveMinConfidence : this.config.minConfidence;
        if (confidence < minConf) continue;

        await this.executeTrade(market, direction, tokenId, tokenPrice, edge, confidence, 'expiry-sniper', {
          spotPrice, refPrice, priceDelta, chainlinkPrice, zScore, winProbability: winProb,
          secsLeft, bestBid, bestAsk, chainlinkConfirms: !!chainlinkPrice, useMaker,
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (!msg.includes('rate') && !msg.includes('429')) {
          console.error(`[edge] Sniper error:`, msg);
        }
      }
    }
  }

  // ─── Trade Execution ────────────────────────────────

  private async executeTrade(
    market: UpDownMarket,
    direction: 'UP' | 'DOWN',
    tokenId: string,
    tokenPrice: number,
    edge: { fairValue: number; netEdgeCents: number; rawEdgeCents: number; feeCents: number; edgeRatio: number },
    confidence: number,
    strategy: TradeStrategy,
    context: Record<string, unknown>,
  ): Promise<void> {
    if (!this.profile) return;

    // Payoff ratio check: potential_loss / potential_win
    // At 0.95: risk $0.95, win $0.05 → ratio 19:1 (terrible)
    // At 0.80: risk $0.80, win $0.20 → ratio 4:1 (ok)
    // At 0.50: risk $0.50, win $0.50 → ratio 1:1 (great)
    const riskPerShare = tokenPrice;
    const rewardPerShare = 1 - tokenPrice;
    const payoffRatio = riskPerShare / rewardPerShare;
    if (payoffRatio > 5) return; // never risk >5x the potential reward (was 8, too loose)

    // Size using Kelly — enforce Polymarket minimums ($1 value + 5 shares)
    // maxShares must never drop below minShares (cheap tokens need more shares to meet $1 min)
    const kellyFraction = this.config.adaptiveMode ? this.adaptiveKellyFraction : 0.25;
    const rawSize = kellySize(edge.fairValue, tokenPrice, this.balance) * (kellyFraction / 0.25);
    const minShares = Math.max(5, Math.ceil(1.05 / tokenPrice));
    const baseMax = strategy === 'latency-arb' ? 5 : 20;
    const maxShares = Math.max(baseMax, minShares); // never cap below minimum
    const size = Math.min(Math.max(Math.floor(rawSize), minShares), maxShares);

    // Don't trade if position would exceed 10% of balance (conservative with small balance)
    if (size * tokenPrice > this.balance * 0.10) return;
    if (this.balance < 5) return; // stop trading if too low

    const bestAsk = context.bestAsk as number;
    const bestBid = context.bestBid as number;
    const isMaker = (context.useMaker as boolean) ?? this.config.preferMaker;
    const orderPrice = isMaker ? bestBid : bestAsk;

    // Log signal
    const logEntry: TradeLogEntry = {
      profileId: this.config.profileId,
      strategy,
      conditionId: market.conditionId,
      tokenId,
      outcome: direction === 'UP' ? 'Up' : 'Down',
      strike: context.refPrice as number, // reference price acts as "strike"
      spotPrice: context.spotPrice as number,
      chainlinkPrice: (context.chainlinkPrice as number | null) ?? null,
      yesTokenPrice: market.upPrice,
      bestBid,
      bestAsk,
      fairValue: edge.fairValue,
      rawEdgeCents: edge.rawEdgeCents,
      netEdgeCents: edge.netEdgeCents,
      feeCents: edge.feeCents,
      edgeRatio: edge.edgeRatio,
      direction: direction === 'UP' ? 'BUY_YES' : 'BUY_NO',
      confidence,
      microMomentum: context.microMomentum as number | undefined,
      strikeDistancePct: context.priceDelta as number | undefined,
      secondsToExpiry: context.secsLeft as number | undefined,
      zScore: context.zScore as number | undefined,
      winProbability: context.winProbability as number | undefined,
      chainlinkConfirms: context.chainlinkConfirms as boolean | undefined,
      orderPrice,
      orderSize: size,
      isMaker,
      signalTimestamp: Date.now(),
    };

    const logId = await logTradeSignal(logEntry);

    try {
      const orderResult = await placeProfileOrder(this.profile, {
        tokenId,
        side: 'BUY',
        price: orderPrice,
        size,
        taker: !isMaker,
        postOnly: isMaker,
      });

      await logOrderPlaced(this.config.profileId, strategy, {
        tokenId, side: 'BUY', price: orderPrice, size,
        orderId: orderResult?.orderID, isMaker,
      });

      this.positions.set(market.conditionId, {
        logId,
        conditionId: market.conditionId,
        tokenId,
        direction,
        entryPrice: orderPrice,
        size,
        entryTime: Date.now(),
        refPrice: context.refPrice as number,
      });

      this.lastTradeTime.set(market.conditionId, Date.now());
      this.lastTradeTime.set(`asset:${market.asset}`, Date.now());

      const secsLeft = context.secsLeft as number;
      console.log(`[edge:${strategy}] ${direction} ${market.asset} ${size} shares @ ${orderPrice.toFixed(3)} | edge=${edge.netEdgeCents.toFixed(1)}c conf=${confidence} | ${secsLeft.toFixed(0)}s left`);

      // Auto-clear position after market ends
      const clearDelay = Math.max(market.endMs - Date.now() + 5000, 5000);
      setTimeout(() => { this.positions.delete(market.conditionId); }, clearDelay);

    } catch (err) {
      const errMsg = (err as Error).message;
      await logTradeError(this.config.profileId, strategy, errMsg, {
        tokenId, price: orderPrice, size, direction,
      });
      console.error(`[edge:${strategy}] Order failed: ${errMsg}`);
      // Cooldown on failure too — prevent rapid-fire retries on the same market
      this.lastTradeTime.set(market.conditionId, Date.now());
      this.lastTradeTime.set(`asset:${market.asset}`, Date.now());
    }
  }

  // ─── Adaptive Thresholds ────────────────────────────

  private async refreshAdaptiveThresholds(): Promise<void> {
    try {
      const [arbT, sniperT] = await Promise.all([
        getAdaptiveThresholds(this.config.profileId, 'latency-arb'),
        getAdaptiveThresholds(this.config.profileId, 'expiry-sniper'),
      ]);
      this.adaptiveMinConfidence = Math.max(arbT.minConfidence, sniperT.minConfidence, this.config.minConfidence);
      this.adaptiveMinEdgeCents = Math.max(arbT.minEdgeCents, sniperT.minEdgeCents);
      this.adaptiveKellyFraction = Math.min(arbT.suggestedKellyFraction, sniperT.suggestedKellyFraction);
      console.log(`[edge] Adaptive: conf≥${this.adaptiveMinConfidence} edge≥${this.adaptiveMinEdgeCents.toFixed(1)}c kelly=${this.adaptiveKellyFraction.toFixed(2)}`);
    } catch {
      this.adaptiveMinConfidence = this.config.minConfidence;
      this.adaptiveMinEdgeCents = 3.0; // match MIN_EDGE_CENTS
      this.adaptiveKellyFraction = 0.25;
    }
  }

  // ─── Auto Redeem ────────────────────────────────────

  private async autoRedeem(): Promise<void> {
    if (!this.profile) return;
    try {
      const claimable = await fetchClaimablePositions(this.profile.funderAddress);
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
        try {
          const r = await redeemPositionsRPC(
            redeemProfile,
            pos.conditionId,
            pos.negativeRisk,
            pos.asset,
            pos.oppositeAsset,
          );
          if (r.success) console.log(`[edge:redeem] ${pos.title} — $${pos.size.toFixed(2)} redeemed`);
        } catch {
          // Skip failed redemptions
        }
      }
    } catch (err) {
      console.error('[edge] Auto-redeem error:', (err as Error).message);
    }
  }

  // ─── Settlement Tracking ────────────────────────────

  async recordSettlement(conditionId: string, finalPrice: number, refPrice: number): Promise<void> {
    const position = this.positions.get(conditionId);
    if (!position) return;

    const priceWentUp = finalPrice >= refPrice;
    const won = (position.direction === 'UP' && priceWentUp) || (position.direction === 'DOWN' && !priceWentUp);
    const payout = won ? position.size * (1 - position.entryPrice) : -position.size * position.entryPrice;
    const entryIsMaker = position.entryPrice <= 0.3 || position.entryPrice >= 0.7 ? this.config.preferMaker : true;
    const fee = entryIsMaker ? 0 : takerFeePerShare(position.entryPrice) * position.size;
    const pnl = payout - fee;

    await logTradeResult(position.logId, {
      tradeOutcome: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven',
      pnl,
      settlementPrice: finalPrice,
      settlementTimestamp: Date.now(),
    });

    this.positions.delete(conditionId);
    console.log(`[edge] Settlement: ${pnl > 0 ? 'WIN' : 'LOSS'} $${pnl.toFixed(2)} | ${position.direction} ${conditionId.slice(0, 12)}`);
  }
}

// ─── Singleton ─────────────────────────────────────────

let activeEngine: EdgeEngine | null = null;

export function getActiveEngine(): EdgeEngine | null { return activeEngine; }

export function setActiveEngine(engine: EdgeEngine | null): void {
  if (activeEngine?.isRunning()) activeEngine.stop();
  activeEngine = engine;
}
