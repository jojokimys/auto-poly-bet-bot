/**
 * CEX-Polymarket Latency Arbitrage Engine (Gap-Based, v2)
 *
 * Strategy:
 *   1. Binance WS updates BTC price in ~50ms
 *   2. RTDS relays in ~500ms, CLOB MMs requote in ~2-5s
 *   3. Compute fair value from fast CEX price → detect gap vs stale CLOB price
 *   4. BUY when gap > entry threshold + momentum confirmed + z-score filter
 *   5. SELL via trailing stop, time-decay exit, or gap closure
 *   6. SELL when fair value reverses below entry → stop loss
 *
 * Signal flow (fastest to slowest):
 *   Binance WS (~50ms) → RTDS relay (~500ms)
 *     → Chainlink oracle (~1-2s) → CLOB market maker requote (~2-5s)
 *
 * v2 improvements:
 *   - 15m market (more opportunities, gap closes more reliably)
 *   - Momentum filter (3-tick directional consistency)
 *   - Z-score entry filter (statistical significance)
 *   - Spread/depth guard (skip illiquid books)
 *   - Trailing stop (lock in profits)
 *   - Time-decay exit (don't hold too long)
 *   - EMA vol smoothing + vol ceiling
 *   - Per-window loss limit
 */

import 'server-only';
import { BinanceDirectWS } from '@/lib/binance-ws';
import { RtdsWS } from '@/lib/rtds-ws';
import { PolymarketWS } from '@/lib/polymarket-ws';
import {
  loadProfile,
  getProfileBalance,
  placeProfileOrder,
  getProfileOpenOrders,
  cancelProfileOrders,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';
import { scanCurrentWindow, extractStrikePrice, type MarketWindow, type ActiveMarket } from './market-scanner';
import { fairValueUp, estimateVolatility, zScore } from './math';
import { takerFeePerShare } from '@/lib/fees';
import { fetchClaimablePositions, redeemPositionsRPC, type RedeemProfile } from '@/lib/polymarket/redeem';
import type { BookSnapshot } from '@/lib/trading-types';

// ─── Configuration ───────────────────────────────────────

const CONFIG = {
  // Gap thresholds (in probability units, e.g. 0.01 = 1 cent)
  ENTRY_GAP: 0.01,         // FV - ask >= 1c → buy (limit buy = 0 fee, 1c profit is enough)
  TAKE_PROFIT_GAP: 0.003,  // FV - bid <= 0.3c → gap closed, sell
  STOP_LOSS_CENTS: 0.025,  // bid < entry - 2.5c → cut loss

  // Sizing
  BASE_SHARES: 15,
  MIN_SHARES: 5,           // Polymarket minimum order size is 5

  // Token price bounds
  MIN_TOKEN_PRICE: 0.04,
  MAX_TOKEN_PRICE: 0.92,

  // Risk limits
  MAX_POSITIONS: 3,
  HOURLY_LOSS_LIMIT: -20,   // dollars
  WINDOW_LOSS_LIMIT: -5,    // dollars — stop trading this window after $5 loss

  // Cooldowns
  TRADE_COOLDOWN_MS: 5_000,       // 5s between any trade
  FAILED_COOLDOWN_MS: 15_000,     // 15s after failed order
  SELL_RETRY_COOLDOWN_MS: 3_000,  // 3s between sell retries on same position
  MAX_SELL_RETRIES: 3,            // max sell attempts before force-removing position

  // Momentum filter
  MOMENTUM_TICKS: 3,        // require last N Binance ticks in same direction
  MIN_MOMENTUM_PCT: 0.0001, // minimum 0.01% move over N ticks

  // Z-score filter
  MIN_Z_SCORE: 0.3,         // low threshold — 1c profit target, rely on gap+momentum filters

  // Spread/depth guard
  MAX_SPREAD_CENTS: 3,      // skip if bid-ask spread > 3c

  // Trailing stop
  TRAILING_STOP_CENTS: 0.01, // exit if bid drops 1c below peak bid since entry

  // Time-decay exit (seconds after entry)
  TIME_DECAY_STAGE_1_SEC: 15,  // after 15s: exit if gap < 2c
  TIME_DECAY_STAGE_2_SEC: 30,  // after 30s: exit unconditionally
  TIME_DECAY_GAP_CENTS: 0.02,  // gap threshold for stage 1

  // Limit order (BUY)
  LIMIT_BUY_OFFSET: 0.01,       // place limit at mid + 1c (between mid and ask)
  LIMIT_FILL_TIMEOUT_MS: 2_000, // wait 2s for fill
  LIMIT_FILL_CHECK_MS: 300,     // poll fill status every 300ms

  // Market scanning
  SCAN_INTERVAL_MS: 15_000,
  MARKET_DURATION: '15m' as const,

  // Price bias tracking (Binance vs Chainlink settlement oracle)
  BIAS_EMA_ALPHA: 0.05,        // slow EMA (0.05) — bias is structural, not noisy
  BIAS_LOG_INTERVAL_MS: 30_000, // log bias every 30s

  // Vol estimation
  PRICE_SAMPLE_INTERVAL_SEC: 1,
  PRICE_HISTORY_SIZE: 120,    // 2 min of samples (more data for 15m windows)
  VOL_EMA_ALPHA: 0.1,         // EMA smoothing factor (0.1 = slow, 0.3 = fast)
  VOL_CEILING: 2.0,           // cap annualized vol at 200%
  VOL_FLOOR: 0.10,            // floor annualized vol at 10%

  // Position exit check interval
  EXIT_CHECK_INTERVAL_MS: 500,

  // Auto-claim: check for redeemable positions after each window settles
  CLAIM_DELAY_MS: 30_000,
  CLAIM_CHECK_INTERVAL_MS: 60_000,
};

// ─── Types ───────────────────────────────────────────────

export interface TradeLog {
  id: string;
  timestamp: number;
  side: 'BUY' | 'SELL';
  direction: 'Up' | 'Down';
  tokenPrice: number;
  fairValue: number;
  gap: number;         // gap at time of trade (cents)
  size: number;
  conditionId: string;
  tokenId: string;
  secondsToExpiry: number;
  binancePrice: number;
  strikePrice: number;
  result?: 'pending' | 'win' | 'loss' | 'exit-profit' | 'exit-stop' | 'exit-expiry';
  pnl?: number;
  orderResponse?: unknown;
  error?: string;
}

export interface EngineStatus {
  running: boolean;
  profileId?: string;
  balance?: number;
  binanceConnected: boolean;
  rtdsConnected: boolean;
  clobConnected: boolean;
  binancePingMs: number | null;
  rtdsPingMs: number | null;
  clobPingMs: number | null;
  activeMarket?: {
    slug: string;
    endTime: number;
    strikePrice: number;
    secondsToExpiry: number;
  };
  positions: number;
  tradesTotal: number;
  hourlyPnl: number;
  windowPnl: number;
  vol?: number;
}

interface Position {
  direction: 'Up' | 'Down';
  conditionId: string;
  tokenId: string;
  entryPrice: number;   // price we bought at
  entryFV: number;      // fair value at entry
  size: number;
  entryTime: number;
  tradeId: string;
  sellRetries: number;
  lastSellAttemptAt: number;
  peakBid: number;      // highest bid seen since entry (for trailing stop)
}

type LogLevel = 'info' | 'trade' | 'error' | 'eval';

interface LogEntry {
  text: string;
  type: LogLevel;
  timestamp: number;
}

// ─── Singleton Engine ────────────────────────────────────

class ArbEngine {
  private running = false;
  private profile: ProfileCredentials | null = null;
  private balance = 0;

  // WebSocket feeds
  private binanceWS = new BinanceDirectWS();
  private rtdsWS = new RtdsWS();
  private clobWS = new PolymarketWS();

  // Market state
  private currentWindow: MarketWindow | null = null;
  private strikePrice = 0;
  private books = new Map<string, { bestBid: number; bestAsk: number; timestamp: number }>();

  // Positions & risk
  private positions: Position[] = [];
  private trades: TradeLog[] = [];
  private hourlyPnl = 0;
  private hourlyPnlResetAt = 0;
  private windowPnl = 0;

  // Cooldowns
  private lastTradeAt = 0;
  private failedCooldowns = new Map<string, number>();

  // Vol estimation (EMA-smoothed)
  private priceHistory: number[] = [];
  private lastPriceSampleAt = 0;
  private emaVol: number | null = null;        // smoothed vol
  private prevWindowVol: number | null = null;  // carry over to new window

  // Price bias: Binance - Chainlink (EMA-smoothed)
  // Positive = Binance trades higher than settlement oracle
  private priceBias: number | null = null;
  private lastBiasLogAt = 0;
  private biasSampleCount = 0;

  // Execution locks
  private executing = new Set<string>();

  // Timers
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private exitTimer: ReturnType<typeof setInterval> | null = null;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private claiming = false;

  // Logs
  private logBuffer: LogEntry[] = [];
  private maxLogs = 500;

  // Debug
  private lastDebugLogAt = 0;
  private evalCount = 0;

  // ─── Public API ──────────────────────────────────────

  async start(profileId: string): Promise<void> {
    if (this.running) return;

    const profile = await loadProfile(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);

    this.profile = profile;
    this.running = true;
    this.trades = [];
    this.positions = [];
    this.hourlyPnl = 0;
    this.hourlyPnlResetAt = Date.now() + 3600_000;
    this.windowPnl = 0;
    this.priceHistory = [];
    this.emaVol = null;
    this.priceBias = null;
    this.biasSampleCount = 0;
    this.lastBiasLogAt = 0;

    this.log('info', `Starting gap-arb engine v2 with profile: ${profile.name}`);

    try {
      this.balance = await getProfileBalance(profile);
      this.log('info', `Balance: $${this.balance.toFixed(2)}`);
    } catch (err) {
      this.log('error', `Failed to fetch balance: ${err}`);
    }

    this.binanceWS.connect((price, ts) => this.onCEXTick(price, ts));
    this.rtdsWS.connect();

    await this.scanAndSubscribe();

    this.scanTimer = setInterval(() => this.scanAndSubscribe(), CONFIG.SCAN_INTERVAL_MS);
    this.exitTimer = setInterval(() => this.checkExits(), CONFIG.EXIT_CHECK_INTERVAL_MS);
    this.claimTimer = setInterval(() => this.autoClaim(), CONFIG.CLAIM_CHECK_INTERVAL_MS);

    this.log('info', 'Engine started — waiting for market data...');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.binanceWS.disconnect();
    this.rtdsWS.disconnect();
    this.clobWS.disconnect();

    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.exitTimer) { clearInterval(this.exitTimer); this.exitTimer = null; }
    if (this.claimTimer) { clearInterval(this.claimTimer); this.claimTimer = null; }

    this.currentWindow = null;
    this.books.clear();
    this.executing.clear();
    this.failedCooldowns.clear();

    this.log('info', 'Engine stopped');
  }

  getStatus(): EngineStatus {
    const now = Date.now();
    let activeMarket: EngineStatus['activeMarket'];

    if (this.currentWindow) {
      const secsLeft = Math.max(0, (this.currentWindow.endTime - now) / 1000);
      activeMarket = {
        slug: this.currentWindow.event.slug,
        endTime: this.currentWindow.endTime,
        strikePrice: this.strikePrice,
        secondsToExpiry: Math.round(secsLeft),
      };
    }

    return {
      running: this.running,
      profileId: this.profile?.id,
      balance: this.balance,
      binanceConnected: this.binanceWS.isConnected(),
      rtdsConnected: this.rtdsWS.isConnected(),
      clobConnected: this.clobWS.isConnected(),
      binancePingMs: this.binanceWS.getPingMs(),
      rtdsPingMs: this.rtdsWS.getPingMs(),
      clobPingMs: this.clobWS.getPingMs(),
      activeMarket,
      positions: this.positions.length,
      tradesTotal: this.trades.length,
      hourlyPnl: this.hourlyPnl,
      windowPnl: this.windowPnl,
      vol: this.getCurrentVol() ?? undefined,
    };
  }

  getTrades(limit = 50): TradeLog[] {
    return this.trades.slice(-limit).reverse();
  }

  getLogs(limit = 200): LogEntry[] {
    return this.logBuffer.slice(-limit);
  }

  /** Get latest prices from all sources for charting */
  getPrices(): {
    binance: number | null;
    rtdsBinance: number | null;
    chainlink: number | null;
    strike: number | null;
    upMid: number | null;
    downMid: number | null;
    debug: string;
    timestamp: number;
  } {
    const binance = this.binanceWS.getPrice();
    const rtdsBinance = this.rtdsWS.getSpotPrice('BTC');
    const chainlink = this.rtdsWS.getChainlinkPrice('BTC');
    const strike = this.strikePrice > 0 ? this.strikePrice : null;

    let upMid: number | null = null;
    let downMid: number | null = null;
    let debug = '';

    if (!this.running) {
      debug = 'engine-stopped';
    } else if (!this.currentWindow) {
      debug = 'no-window';
    } else {
      for (const m of this.currentWindow.markets) {
        const book = this.books.get(m.tokenId);
        if (book && book.bestBid > 0 && book.bestAsk > 0) {
          const mid = (book.bestBid + book.bestAsk) / 2;
          if (m.direction === 'Up') upMid = mid;
          else downMid = mid;
        }
      }
      const biasStr = this.priceBias !== null ? ` bias=$${this.priceBias.toFixed(1)}` : '';
      debug = upMid !== null || downMid !== null
        ? `ok pos=${this.positions.length}${biasStr}`
        : `no-book (books=${this.books.size})`;
    }

    return { binance, rtdsBinance, chainlink, strike, upMid, downMid, debug, timestamp: Date.now() };
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── CEX Tick Handler ──────────────────────────────────

  private onCEXTick(price: number, _ts: number): void {
    if (!this.running) return;

    const now = Date.now();
    if (now - this.lastPriceSampleAt >= CONFIG.PRICE_SAMPLE_INTERVAL_SEC * 1000) {
      this.priceHistory.push(price);
      if (this.priceHistory.length > CONFIG.PRICE_HISTORY_SIZE) this.priceHistory.shift();
      this.lastPriceSampleAt = now;

      this.updateEmaVol();
      this.updatePriceBias(price, now);
    }

    this.evaluateEntry(price);
  }

  /** Update EMA of Binance - Chainlink price bias */
  private updatePriceBias(binancePrice: number, now: number): void {
    const chainlink = this.rtdsWS.getChainlinkPrice('BTC');
    if (!chainlink) return;

    const rawBias = binancePrice - chainlink;

    if (this.priceBias === null) {
      this.priceBias = rawBias;
    } else {
      this.priceBias = CONFIG.BIAS_EMA_ALPHA * rawBias + (1 - CONFIG.BIAS_EMA_ALPHA) * this.priceBias;
    }
    this.biasSampleCount++;

    // Periodic bias log
    if (now - this.lastBiasLogAt >= CONFIG.BIAS_LOG_INTERVAL_MS) {
      this.log('eval',
        `BIAS | BN=$${binancePrice.toFixed(1)} CL=$${chainlink.toFixed(1)} ` +
        `raw=$${rawBias.toFixed(2)} ema=$${this.priceBias.toFixed(2)} samples=${this.biasSampleCount}`
      );
      this.lastBiasLogAt = now;
    }
  }

  private onBookUpdate(book: BookSnapshot): void {
    const bestBid = book.buys.length > 0 ? parseFloat(book.buys[0].price) : 0;
    const bestAsk = book.sells.length > 0 ? parseFloat(book.sells[0].price) : 0;
    if (bestBid > 0 || bestAsk > 0) {
      this.books.set(book.assetId, { bestBid, bestAsk, timestamp: book.timestamp });
    }

    // Update trailing stop peak for open positions
    for (const pos of this.positions) {
      if (pos.tokenId === book.assetId && bestBid > pos.peakBid) {
        pos.peakBid = bestBid;
      }
    }
  }

  // ─── Entry Evaluation (on each CEX tick) ───────────────

  private evaluateEntry(spotPrice: number): void {
    this.evalCount++;
    const now = Date.now();

    if (!this.currentWindow || !this.running) return;

    const window = this.currentWindow;
    if (now >= window.endTime) {
      this.scanAndSubscribe();
      return;
    }

    const secondsToExpiry = (window.endTime - now) / 1000;
    // Don't enter new positions too close to expiry
    if (secondsToExpiry < 30) return;

    // Basic risk checks
    if (now >= this.hourlyPnlResetAt) { this.hourlyPnl = 0; this.hourlyPnlResetAt = now + 3600_000; }
    if (this.hourlyPnl <= CONFIG.HOURLY_LOSS_LIMIT) return;
    if (this.windowPnl <= CONFIG.WINDOW_LOSS_LIMIT) return;
    if (this.positions.length >= CONFIG.MAX_POSITIONS) return;
    if (now - this.lastTradeAt < CONFIG.TRADE_COOLDOWN_MS) return;

    const binancePrice = this.binanceWS.getPrice();
    if (!binancePrice) return;
    if (this.strikePrice <= 0) return;

    // Bias-corrected spot: approximate settlement-oracle price from Binance
    const bias = this.priceBias ?? 0;
    const correctedSpot = binancePrice - bias;

    const vol = this.getCurrentVol();
    if (!vol) return;

    // Momentum filter: check last N ticks are directionally consistent
    const momentum = this.binanceWS.getMicroMomentum();

    for (const market of window.markets) {
      if (this.executing.has(market.tokenId)) continue;
      if (this.positions.some(p => p.tokenId === market.tokenId)) continue;

      const failedAt = this.failedCooldowns.get(market.tokenId) ?? 0;
      if (now - failedAt < CONFIG.FAILED_COOLDOWN_MS) continue;

      const isUp = market.direction === 'Up';

      // Fair value from bias-corrected spot (approximates settlement oracle price)
      const fvUp = fairValueUp(correctedSpot, this.strikePrice, vol, secondsToExpiry);
      const fv = isUp ? fvUp : 1 - fvUp;

      // CLOB book
      const book = this.books.get(market.tokenId);
      if (!book || book.bestAsk <= 0 || book.bestBid <= 0) continue;

      const ask = book.bestAsk;
      const bid = book.bestBid;
      const spread = (ask - bid) * 100; // in cents

      // Token price bounds
      if (ask < CONFIG.MIN_TOKEN_PRICE || ask > CONFIG.MAX_TOKEN_PRICE) continue;

      // Spread guard: skip illiquid books
      if (spread > CONFIG.MAX_SPREAD_CENTS) continue;

      // Fee calculation: BUY is maker (0 fee), SELL is taker
      const mid = (bid + ask) / 2;
      const limitBuyPrice = Math.min(mid + CONFIG.LIMIT_BUY_OFFSET, ask - 0.01);

      // GAP = how much the CLOB is lagging behind fair value (use limit price, not ask)
      const gap = fv - limitBuyPrice;
      const gapCents = gap * 100;
      const estSellPrice = Math.max(bid, limitBuyPrice - 0.01);
      const sellFee = takerFeePerShare(estSellPrice);
      const roundTripFee = sellFee * 100; // only sell-side taker fee

      const netGap = gapCents - roundTripFee;

      // Z-score: statistical significance of price move (bias-corrected)
      const z = zScore(correctedSpot, this.strikePrice, vol, secondsToExpiry);
      // For Up tokens z should be positive, for Down tokens negative
      const zDirectional = isUp ? z : -z;

      // Periodic debug log — every 3 seconds (show both Up and Down)
      if (now - this.lastDebugLogAt >= 3000) {
        this.log('eval',
          `#${this.evalCount} | BN=$${binancePrice.toFixed(1)} adj=$${correctedSpot.toFixed(1)} bias=$${bias.toFixed(1)} ` +
          `STK=$${this.strikePrice.toFixed(1)} Δ$${(correctedSpot - this.strikePrice).toFixed(2)} | ` +
          `vol=${(vol * 100).toFixed(1)}% z=${z.toFixed(2)} zDir=${zDirectional.toFixed(2)} | ` +
          `${market.direction}: fv=${fv.toFixed(3)} bid=${bid.toFixed(2)} ask=${ask.toFixed(2)} spd=${spread.toFixed(1)}c ` +
          `gap=${gapCents.toFixed(1)}c net=${netGap.toFixed(1)}c | ` +
          `mom=${momentum?.toFixed(5) ?? '—'} | ttx=${Math.round(secondsToExpiry)}s | ` +
          `pos=${this.positions.length} wPnl=$${this.windowPnl.toFixed(2)}`
        );
        if (market.direction === 'Down') this.lastDebugLogAt = now;
      }

      // ─── Entry filters ────────────────────────────────

      // 1. Net gap after round-trip fees > threshold
      const entryThresholdCents = CONFIG.ENTRY_GAP * 100;
      if (netGap < entryThresholdCents) continue;

      // 2. Z-score filter: move must be statistically significant
      if (zDirectional < CONFIG.MIN_Z_SCORE) {
        if (netGap >= entryThresholdCents) {
          this.log('eval', `GAP ${market.direction} net=${netGap.toFixed(1)}c — SKIP: z=${zDirectional.toFixed(2)} < ${CONFIG.MIN_Z_SCORE}`);
        }
        continue;
      }

      // 3. Momentum filter: last N ticks must agree with direction
      if (momentum !== null) {
        const momentumAgrees = isUp ? momentum > CONFIG.MIN_MOMENTUM_PCT : momentum < -CONFIG.MIN_MOMENTUM_PCT;
        if (!momentumAgrees) {
          this.log('eval', `GAP ${market.direction} net=${netGap.toFixed(1)}c — SKIP: momentum disagrees (${(momentum * 100).toFixed(3)}%)`);
          continue;
        }
      }

      // ─── All filters passed → execute ─────────────────

      const shares = Math.min(
        CONFIG.BASE_SHARES,
        Math.max(CONFIG.MIN_SHARES, Math.round(netGap / 2 * CONFIG.BASE_SHARES / 10))
      );

      this.log('trade',
        `ENTRY ${market.direction} | gap=${gapCents.toFixed(1)}c net=${netGap.toFixed(1)}c fee=${roundTripFee.toFixed(1)}c ` +
        `z=${zDirectional.toFixed(2)} mom=${momentum?.toFixed(5) ?? '—'} spd=${spread.toFixed(1)}c | ` +
        `limit=$${limitBuyPrice.toFixed(2)} ask=$${ask.toFixed(2)} fv=$${fv.toFixed(3)} | ${shares} shares | ttx=${Math.round(secondsToExpiry)}s`
      );

      this.executeBuy(market, limitBuyPrice, ask, fv, gap, shares, secondsToExpiry, binancePrice)
        .catch(err => this.log('error', `executeBuy error: ${err}`));
    }
  }

  // ─── Exit Check (periodic, for open positions) ─────────

  private checkExits(): void {
    if (!this.running || this.positions.length === 0) return;

    const now = Date.now();
    const binancePrice = this.binanceWS.getPrice();
    if (!binancePrice || this.strikePrice <= 0) return;

    const bias = this.priceBias ?? 0;
    const correctedSpot = binancePrice - bias;

    const vol = this.getCurrentVol();
    if (!vol) return;

    const window = this.currentWindow;
    if (!window) return;

    const secondsToExpiry = (window.endTime - now) / 1000;

    const positionsToCheck = [...this.positions];

    for (const pos of positionsToCheck) {
      if (this.executing.has(pos.tokenId)) continue;
      if (now - pos.lastSellAttemptAt < CONFIG.SELL_RETRY_COOLDOWN_MS) continue;

      if (pos.sellRetries >= CONFIG.MAX_SELL_RETRIES) {
        this.log('error', `ABANDON ${pos.direction} after ${pos.sellRetries} failed sells — removing position`);
        this.positions = this.positions.filter(p => p.tradeId !== pos.tradeId);
        continue;
      }

      const book = this.books.get(pos.tokenId);
      if (!book || book.bestBid <= 0) continue;

      const bid = book.bestBid;
      const isUp = pos.direction === 'Up';

      // Update peak bid for trailing stop
      if (bid > pos.peakBid) pos.peakBid = bid;

      const fvUp = fairValueUp(correctedSpot, this.strikePrice, vol, secondsToExpiry);
      const fv = isUp ? fvUp : 1 - fvUp;
      const currentGap = fv - bid;

      const sellPnl = (bid - pos.entryPrice) * pos.size;
      const sellFee = takerFeePerShare(bid) * pos.size;
      const netPnl = sellPnl - sellFee;

      const holdTimeSec = (now - pos.entryTime) / 1000;

      let exitReason: string | null = null;

      // 1. Take profit: gap has closed
      if (currentGap <= CONFIG.TAKE_PROFIT_GAP && bid > pos.entryPrice) {
        exitReason = 'profit';
      }

      // 2. Trailing stop: bid dropped from peak
      if (pos.peakBid > pos.entryPrice && bid <= pos.peakBid - CONFIG.TRAILING_STOP_CENTS) {
        exitReason = 'trailing';
      }

      // 3. Fixed stop loss: bid dropped significantly below entry
      if (bid <= pos.entryPrice - CONFIG.STOP_LOSS_CENTS) {
        exitReason = 'stop';
      }

      // 4. Fair value reversed
      if (fv < pos.entryPrice - 0.01) {
        exitReason = 'fv-reversed';
      }

      // 5. Time-decay stage 2: unconditional exit after 30s
      if (holdTimeSec >= CONFIG.TIME_DECAY_STAGE_2_SEC) {
        exitReason = 'time-decay';
      }

      // 6. Time-decay stage 1: exit if gap still open after 15s
      if (!exitReason && holdTimeSec >= CONFIG.TIME_DECAY_STAGE_1_SEC && currentGap > CONFIG.TIME_DECAY_GAP_CENTS) {
        exitReason = 'time-decay';
      }

      // 7. Near expiry: force exit with 20s left (more buffer for 15m)
      if (secondsToExpiry <= 20) {
        exitReason = 'expiry';
      }

      if (exitReason) {
        this.log('trade',
          `EXIT ${pos.direction} (${exitReason}) | bid=$${bid.toFixed(2)} entry=$${pos.entryPrice.toFixed(2)} ` +
          `peak=$${pos.peakBid.toFixed(2)} fv=$${fv.toFixed(3)} gap=${(currentGap * 100).toFixed(1)}c | ` +
          `pnl=$${netPnl.toFixed(2)} hold=${holdTimeSec.toFixed(0)}s | ttx=${Math.round(secondsToExpiry)}s`
        );

        pos.lastSellAttemptAt = now;
        this.executeSell(pos, bid, fv, currentGap, exitReason, secondsToExpiry)
          .catch(err => this.log('error', `executeSell error: ${err}`));
      }
    }
  }

  // ─── Trade Execution ─────────────────────────────────

  /**
   * Execute BUY with limit order (postOnly) → wait for fill → fallback to taker if unfilled.
   * Limit buy saves the taker fee (~1.5-2c per share).
   */
  private async executeBuy(
    market: ActiveMarket,
    limitPrice: number,
    askPrice: number,
    fairValue: number,
    gap: number,
    size: number,
    secondsToExpiry: number,
    binancePrice: number,
  ): Promise<void> {
    if (!this.profile) return;

    const tradeId = `${market.tokenId}-${Date.now()}`;
    this.executing.add(market.tokenId);
    this.lastTradeAt = Date.now();

    const tradeLog: TradeLog = {
      id: tradeId,
      timestamp: Date.now(),
      side: 'BUY',
      direction: market.direction,
      tokenPrice: limitPrice,
      fairValue,
      gap: gap * 100,
      size,
      conditionId: market.conditionId,
      tokenId: market.tokenId,
      secondsToExpiry,
      binancePrice,
      strikePrice: this.strikePrice,
      result: 'pending',
    };

    let filled = false;
    let fillPrice = limitPrice;

    try {
      // Step 1: Place postOnly limit order (0 taker fee)
      const limitResult = await placeProfileOrder(this.profile, {
        tokenId: market.tokenId,
        side: 'BUY',
        price: limitPrice,
        size,
        postOnly: true,
      });

      const orderId = (limitResult as any)?.orderID ?? (limitResult as any)?.id;
      this.log('trade', `LIMIT BUY placed ${market.direction} — ${size}×$${limitPrice.toFixed(2)} order=${orderId?.slice(0, 8) ?? '?'}`);

      // Step 2: Poll for fill
      if (orderId) {
        const deadline = Date.now() + CONFIG.LIMIT_FILL_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, CONFIG.LIMIT_FILL_CHECK_MS));

          try {
            const openOrders = await getProfileOpenOrders(this.profile!);
            const stillOpen = openOrders.some((o: any) => o.id === orderId || o.orderID === orderId);
            if (!stillOpen) {
              // Order no longer open → filled (or rejected)
              filled = true;
              fillPrice = limitPrice;
              break;
            }
          } catch {
            // If we can't check, assume still open
          }
        }

        // Step 3: If not filled, cancel and fallback to taker
        if (!filled) {
          try {
            await cancelProfileOrders(this.profile!, [orderId]);
            this.log('trade', `LIMIT BUY unfilled — cancelled, falling back to taker at ask=$${askPrice.toFixed(2)}`);
          } catch {
            // Cancel failed — check if it filled in the meantime
            try {
              const openOrders = await getProfileOpenOrders(this.profile!);
              const stillOpen = openOrders.some((o: any) => o.id === orderId || o.orderID === orderId);
              if (!stillOpen) {
                filled = true;
                fillPrice = limitPrice;
              }
            } catch { /* assume not filled */ }
          }

          // Taker fallback: re-check if gap still exists
          if (!filled) {
            const currentBinance = this.binanceWS.getPrice();
            const currentBook = this.books.get(market.tokenId);
            if (currentBinance && currentBook && currentBook.bestAsk > 0) {
              const vol = this.getCurrentVol();
              if (vol) {
                const ttx = (this.currentWindow ? this.currentWindow.endTime - Date.now() : 0) / 1000;
                const isUp = market.direction === 'Up';
                const fallbackSpot = currentBinance - (this.priceBias ?? 0);
                const fvUp = fairValueUp(fallbackSpot, this.strikePrice, vol, ttx);
                const currentFV = isUp ? fvUp : 1 - fvUp;
                const currentAsk = currentBook.bestAsk;
                const currentGap = (currentFV - currentAsk) * 100;
                const currentFee = takerFeePerShare(currentAsk) * 100;
                const currentNet = currentGap - currentFee;

                if (currentNet >= CONFIG.ENTRY_GAP * 100) {
                  // Gap still exists → taker buy
                  const takerResult = await placeProfileOrder(this.profile!, {
                    tokenId: market.tokenId,
                    side: 'BUY',
                    price: currentAsk,
                    size,
                    taker: true,
                  });
                  filled = true;
                  fillPrice = currentAsk;
                  tradeLog.orderResponse = takerResult;
                  this.log('trade', `TAKER BUY fallback ${market.direction} — ${size}×$${currentAsk.toFixed(2)} net=${currentNet.toFixed(1)}c`);
                } else {
                  this.log('trade', `TAKER BUY skipped — gap closed (net=${currentNet.toFixed(1)}c)`);
                }
              }
            }
          }
        }
      }

      if (filled) {
        tradeLog.tokenPrice = fillPrice;
        tradeLog.orderResponse = tradeLog.orderResponse ?? limitResult;

        this.positions.push({
          direction: market.direction,
          conditionId: market.conditionId,
          tokenId: market.tokenId,
          entryPrice: fillPrice,
          entryFV: fairValue,
          size,
          entryTime: Date.now(),
          tradeId,
          sellRetries: 0,
          lastSellAttemptAt: 0,
          peakBid: fillPrice,
        });

        this.log('trade', `BUY OK ${market.direction} — ${size}×$${fillPrice.toFixed(2)} gap=${(gap * 100).toFixed(1)}c`);
      } else {
        tradeLog.result = 'loss';
        tradeLog.error = 'unfilled-no-fallback';
        this.log('trade', `BUY ABANDONED ${market.direction} — limit unfilled, gap gone`);
      }
    } catch (err: any) {
      tradeLog.error = err.message ?? String(err);
      tradeLog.result = 'loss';
      this.failedCooldowns.set(market.tokenId, Date.now());
      this.log('error', `BUY FAILED ${market.direction}: ${err.message}`);
    }

    this.trades.push(tradeLog);
    this.executing.delete(market.tokenId);
  }

  private async executeSell(
    pos: Position,
    bidPrice: number,
    fairValue: number,
    gap: number,
    reason: string,
    secondsToExpiry: number,
  ): Promise<void> {
    if (!this.profile) return;

    this.executing.add(pos.tokenId);

    const pnl = (bidPrice - pos.entryPrice) * pos.size;
    const fee = takerFeePerShare(bidPrice) * pos.size;
    const netPnl = pnl - fee;

    const tradeLog: TradeLog = {
      id: `${pos.tokenId}-sell-${Date.now()}`,
      timestamp: Date.now(),
      side: 'SELL',
      direction: pos.direction,
      tokenPrice: bidPrice,
      fairValue,
      gap: gap * 100,
      size: pos.size,
      conditionId: pos.conditionId,
      tokenId: pos.tokenId,
      secondsToExpiry,
      binancePrice: this.binanceWS.getPrice() ?? 0,
      strikePrice: this.strikePrice,
      result: reason === 'profit' || reason === 'trailing' ? 'exit-profit' : reason === 'expiry' ? 'exit-expiry' : 'exit-stop',
      pnl: netPnl,
    };

    try {
      const result = await placeProfileOrder(this.profile, {
        tokenId: pos.tokenId,
        side: 'SELL',
        price: bidPrice,
        size: pos.size,
        taker: true,
      });

      tradeLog.orderResponse = result;
      this.hourlyPnl += netPnl;
      this.windowPnl += netPnl;

      this.positions = this.positions.filter(p => p.tradeId !== pos.tradeId);

      this.log('trade',
        `SELL OK ${pos.direction} (${reason}) — ${pos.size}×$${bidPrice.toFixed(2)} | ` +
        `entry=$${pos.entryPrice.toFixed(2)} peak=$${pos.peakBid.toFixed(2)} pnl=$${netPnl.toFixed(2)}`
      );

      const buyTrade = this.trades.find(t => t.id === pos.tradeId);
      if (buyTrade) {
        buyTrade.result = tradeLog.result;
        buyTrade.pnl = netPnl;
      }
    } catch (err: any) {
      tradeLog.error = err.message ?? String(err);
      pos.sellRetries++;
      this.log('error', `SELL FAILED ${pos.direction} (${reason}) retry=${pos.sellRetries}/${CONFIG.MAX_SELL_RETRIES}: ${err.message}`);

      const msg = (err.message ?? '').toLowerCase();
      if (msg.includes('not enough balance') || msg.includes('not enough allowance')) {
        this.log('info', `No tokens held for ${pos.direction} — removing phantom position`);
        this.positions = this.positions.filter(p => p.tradeId !== pos.tradeId);
      }
    }

    this.trades.push(tradeLog);
    this.executing.delete(pos.tokenId);

    if (this.profile) {
      getProfileBalance(this.profile).then(b => { this.balance = b; }).catch(() => {});
    }
  }

  // ─── Market Scanning ─────────────────────────────────

  private async scanAndSubscribe(): Promise<void> {
    try {
      const window = await scanCurrentWindow(CONFIG.MARKET_DURATION);
      if (!window) {
        this.log('info', 'No active market window found');
        this.currentWindow = null;
        return;
      }

      const windowChanged = this.currentWindow?.event.slug !== window.event.slug;

      if (windowChanged) {
        await this.forceExitAll('expiry');

        // Save vol for carryover before resetting
        const currentVol = this.getCurrentVol();
        if (currentVol) this.prevWindowVol = currentVol;

        this.currentWindow = window;

        const tokenIds = window.markets.map(m => m.tokenId);
        this.clobWS.disconnect();
        this.clobWS.connect(tokenIds, (book) => this.onBookUpdate(book));

        this.positions = [];
        this.windowPnl = 0; // reset per-window PnL

        this.strikePrice = 0;

        const eventStrike = extractStrikePrice(window.event);
        if (eventStrike) {
          this.strikePrice = eventStrike;
        }

        if (this.strikePrice <= 0) {
          const bp = this.binanceWS.getPrice();
          if (bp) this.strikePrice = bp;
        }

        // Seed EMA vol from previous window if we have no data yet
        if (this.priceHistory.length < 5 && this.prevWindowVol) {
          this.emaVol = this.prevWindowVol;
          this.log('info', `Vol seeded from prev window: ${(this.prevWindowVol * 100).toFixed(1)}%`);
        }

        const secsLeft = Math.round((window.endTime - Date.now()) / 1000);
        this.log('info',
          `New window: ${window.event.slug} | ${secsLeft}s left | ` +
          `strike=$${this.strikePrice > 0 ? this.strikePrice.toFixed(1) : 'pending'} | ` +
          `tokens=[${tokenIds.map(t => t.slice(0, 8)).join(',')}]`
        );
      }

      if (this.strikePrice <= 0) {
        const bp = this.binanceWS.getPrice();
        if (bp) {
          this.strikePrice = bp;
          this.log('info', `Strike set from Binance: $${bp.toFixed(1)}`);
        }
      }
    } catch (err: any) {
      this.log('error', `Scan failed: ${err.message}`);
    }
  }

  private async forceExitAll(reason: string): Promise<void> {
    for (const pos of [...this.positions]) {
      const book = this.books.get(pos.tokenId);
      const bid = book?.bestBid ?? pos.entryPrice * 0.9;
      const vol = this.getCurrentVol() ?? 0.5;
      const rawSpot = this.binanceWS.getPrice() ?? this.strikePrice;
      const fvUp = fairValueUp(
        rawSpot - (this.priceBias ?? 0),
        this.strikePrice, vol, 0
      );
      const fv = pos.direction === 'Up' ? fvUp : 1 - fvUp;

      try {
        await this.executeSell(pos, bid, fv, 0, reason, 0);
      } catch (err) {
        this.log('error', `Force exit failed for ${pos.direction}: ${err}`);
      }
    }
  }

  // ─── Auto-Claim ─────────────────────────────────────

  private async autoClaim(): Promise<void> {
    if (!this.profile || this.claiming) return;
    this.claiming = true;

    try {
      const walletAddress = this.profile.funderAddress;
      const claimable = await fetchClaimablePositions(walletAddress);

      if (claimable.length === 0) {
        this.claiming = false;
        return;
      }

      this.log('info', `Auto-claim: found ${claimable.length} redeemable position(s)`);

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
          const result = await redeemPositionsRPC(
            redeemProfile,
            pos.conditionId,
            pos.negativeRisk,
            pos.asset,
            pos.oppositeAsset,
          );

          if (result.success) {
            this.log('trade',
              `CLAIMED "${pos.title}" ${pos.outcome} | ${pos.size} shares | ` +
              `won=${result.winningSide ?? '?'} | tx=${result.txHash?.slice(0, 10) ?? 'none'}`
            );
          } else {
            this.log('error', `CLAIM FAILED "${pos.title}": ${result.error}`);
          }
        } catch (err: any) {
          this.log('error', `CLAIM ERROR "${pos.title}": ${err.message}`);
        }
      }

      try {
        this.balance = await getProfileBalance(this.profile);
        this.log('info', `Balance after claims: $${this.balance.toFixed(2)}`);
      } catch { /* ignore */ }
    } catch (err: any) {
      this.log('error', `Auto-claim check failed: ${err.message}`);
    }

    this.claiming = false;
  }

  // ─── Helpers ─────────────────────────────────────────

  /** Update EMA-smoothed volatility from raw price history */
  private updateEmaVol(): void {
    if (this.priceHistory.length < 5) return;

    const rawVol = estimateVolatility(this.priceHistory, CONFIG.PRICE_SAMPLE_INTERVAL_SEC);

    // Clamp raw vol to floor/ceiling
    const clamped = Math.max(CONFIG.VOL_FLOOR, Math.min(CONFIG.VOL_CEILING, rawVol));

    if (this.emaVol === null) {
      this.emaVol = clamped;
    } else {
      this.emaVol = CONFIG.VOL_EMA_ALPHA * clamped + (1 - CONFIG.VOL_EMA_ALPHA) * this.emaVol;
    }
  }

  private getCurrentVol(): number | null {
    if (this.emaVol !== null) return this.emaVol;
    // Fallback: use previous window vol
    if (this.prevWindowVol !== null) return this.prevWindowVol;
    // Fallback: raw calculation
    if (this.priceHistory.length < 5) return null;
    const raw = estimateVolatility(this.priceHistory, CONFIG.PRICE_SAMPLE_INTERVAL_SEC);
    return Math.max(CONFIG.VOL_FLOOR, Math.min(CONFIG.VOL_CEILING, raw));
  }

  private log(level: LogLevel, text: string): void {
    const entry: LogEntry = {
      text: `[${new Date().toISOString().slice(11, 19)}] ${text}`,
      type: level,
      timestamp: Date.now(),
    };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxLogs) {
      this.logBuffer = this.logBuffer.slice(-this.maxLogs);
    }

    const prefix = level === 'error' ? '[arb:ERROR]' : `[arb:${level}]`;
    console.log(`${prefix} ${text}`);
  }
}

// ─── Singleton Export ────────────────────────────────────

let engine: ArbEngine | null = null;

export function getEngine(): ArbEngine {
  if (!engine) engine = new ArbEngine();
  return engine;
}
