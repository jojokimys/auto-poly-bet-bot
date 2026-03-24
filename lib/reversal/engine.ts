/**
 * BTC 5M Reversal Engine — Contrarian Orderbook-Informed Strategy
 *
 * Strategy:
 *   1. Monitor BTC 5M markets on Polymarket where odds are heavily skewed (>85% one side)
 *   2. Use Binance orderbook depth to detect OBI (Order Book Imbalance) sign-flips
 *   3. When OBI flips against the skewed direction + BTC price is near the strike:
 *      → Buy the cheap side (contrarian bet)
 *   4. Exit on time-based expiry or profit target
 *
 * Signal hierarchy:
 *   - Primary: OBI sign-flip (recent 2s vs older 2-4s window)
 *   - Secondary: Trade flow imbalance + acceleration (taker buy vs sell volume)
 *   - Confirming: Depth ratio shift, wall detection
 *   - Filter: Polymarket odds must be >85% skewed, BTC price near strike
 *
 * Key insight: Near-expiry 5M markets with skewed odds have cheap tokens (3-15c).
 *   If BTC reverses direction, a 5c token can become 50-95c → massive payoff.
 *   The orderbook signals give us early warning of reversals.
 */

import 'server-only';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { BinanceDirectWS, type RawTradeHandler } from '@/lib/binance-ws';
import { BinanceDepthWS } from '@/lib/binance-depth-ws';
import { PolymarketWS } from '@/lib/polymarket-ws';
import {
  loadProfile,
  getProfileBalance,
  placeProfileOrder,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';
import { scanCurrentWindow, extractStrikePrice, type MarketWindow, type ActiveMarket } from '@/lib/arb/market-scanner';
import { fairValueUp, estimateVolatility, kellySizing } from '@/lib/arb/math';
import { takerFeePerShare } from '@/lib/fees';
import { fetchClaimablePositions, redeemPositionsRPC, type RedeemProfile } from '@/lib/polymarket/redeem';
import type { BookSnapshot } from '@/lib/trading-types';

// ─── Configuration ───────────────────────────────────────

const CONFIG = {
  // Market targeting
  MARKET_DURATION: '5m' as const,
  SCAN_INTERVAL_MS: 10_000,

  // Skew threshold: only trade when one side is > this (e.g., 0.88 = 88%)
  MIN_SKEW: 0.88,

  // OBI reversal detection
  OBI_FLIP_THRESHOLD: 0.15,    // minimum OBI delta to count as "flip"
  MIN_OBI_DELTA: 0.30,         // hard filter: |OBI delta| must be >= 0.3 (rapid change)
  OBI_RECENT_WINDOW_MS: 2000,  // recent OBI averaging window
  OBI_OLDER_WINDOW_MS: 4000,   // older OBI averaging window
  MIN_OBI_MAGNITUDE: 0.20,     // minimum |recentOBI| to confirm reversal pressure

  // Depth ratio: confirms directional shift
  DEPTH_RATIO_BULL_THRESHOLD: 1.3,   // bid/ask > 1.3 = bullish pressure
  DEPTH_RATIO_BEAR_THRESHOLD: 0.77,  // bid/ask < 0.77 = bearish pressure

  // Trade flow (체결강도): taker buy/sell volume analysis
  FLOW_WINDOW_MS: 5000,              // 5-second rolling window for flow stats
  MIN_FLOW_IMBALANCE: 0.25,          // minimum |imbalance| to count as signal
  MIN_FLOW_ACCELERATION: 0.15,       // minimum acceleration to count as "increasing"
  MIN_FLOW_TRADES: 10,               // need at least N trades in window for signal
  MIN_VOLUME_SPIKE: 2.5,             // current vol >= 2.5x baseline average = spike

  // Price distance: current BTC vs window open price, hard block if beyond this
  MAX_PRICE_DISTANCE_PCT: 0.002, // 0.2% — block entry if BTC moved too far from open
  // Directional distance: BTC must be within this % of strike on the "wrong" side to bet reversal
  // Tightened from 0.1% → 0.03%: only trade when BTC is nearly at the crossing point
  MAX_CROSS_DISTANCE_PCT: 0.0008, // 0.08% (~$56 at BTC=$70k) — $3.36/hr in 403-window backtest

  // Strike crossing: oscillation-based entry
  MIN_STRIKE_CROSSINGS: 3,        // need ≥3 crossings (100% reversal rate in data)
  CROSSING_MIN_HOLD_MS: 500,      // side must hold ≥500ms to count as real crossing (filter noise)

  // Time window: enter after oscillation is confirmed, before settlement
  MIN_SECONDS_TO_EXPIRY: 5,     // no trades in last 5s
  MAX_SECONDS_TO_EXPIRY: 30,    // last 30s (crossing ≥3 usually happens by T-30s)

  // Sizing: dynamic based on confidence score (Kelly-informed)
  MAX_BET_DOLLARS: 1,      // max $1 per trade
  MIN_BET_DOLLARS: 1,      // min $1 per trade (threshold confidence)
  MIN_SHARES: 10,
  KELLY_FRACTION: 0.25,    // fractional Kelly (quarter Kelly for safety)

  // Token price bounds: 30-40¢ range = best WR (86% in actual trades)
  MIN_TOKEN_PRICE: 0.02,
  MAX_TOKEN_PRICE: 0.39,   // cap at 39¢: $0.40+ tokens have 14% WR in actual trades

  // Risk limits
  MAX_POSITIONS: 2,
  HOURLY_LOSS_LIMIT: -15,
  WINDOW_LOSS_LIMIT: -5,

  // Slippage: add to ask price for taker orders to improve fill rate
  TAKER_SLIPPAGE: 0.10,   // +10¢ above ask for reversal (25-50¢ tokens, must fill immediately)
  TREND_SLIPPAGE: 0.04,   // +4¢ above ask for expensive tokens (trend) — must fill

  // Cooldowns
  TRADE_COOLDOWN_MS: 5_000,
  FAILED_COOLDOWN_MS: 15_000,

  // Hold & exit: hold to settlement for full $1 payout
  // No take profit — we only enter on high-conviction reversals

  // Check intervals
  EXIT_CHECK_INTERVAL_MS: 500,

  // Auto-claim
  CLAIM_CHECK_INTERVAL_MS: 60_000,

  // ─── Trend Continuation Strategy ───────────────────────
  // Buy the dominant (expensive) side when BTC is trending away from strike.
  // High win-rate, low payout per trade.

  TREND_ENABLED: true,

  // Trend: cross=0 + consistency≥95% + dist>0.03% — 100% WR, 65% entry in 573-window backtest
  TREND_MAX_SECONDS: 45,
  TREND_MIN_SECONDS: 10,

  // BTC must be far enough from strike
  TREND_MIN_DISTANCE_PCT: 0.0003,  // 0.03% (~$21 at BTC=$70k)

  // Must NOT have crossed strike
  TREND_MAX_CROSSINGS: 0,

  // BTC must have been on the same side ≥95% of the window
  TREND_MIN_CONSISTENCY: 0.95,

  // Token price bounds for the dominant (expensive) side
  TREND_MIN_TOKEN_PRICE: 0.70,     // lowered: 0.70-0.85 range has better risk/reward
  TREND_MAX_TOKEN_PRICE: 0.99,

  // Sizing: fixed dollar RISK (max loss per trade)
  TREND_MAX_RISK_DOLLARS: 3,       // max $3 at risk per trade (1sh at $0.90 won't fill)

  // Risk: 1 trend trade per window
  TREND_MAX_POSITIONS: 1,
};

// ─── Types ───────────────────────────────────────────────

export interface TradeLog {
  id: string;
  timestamp: number;
  strategy: 'reversal' | 'trend';
  side: 'BUY' | 'SELL';
  direction: 'Up' | 'Down';
  tokenPrice: number;
  fairValue: number;
  size: number;
  conditionId: string;
  tokenId: string;
  secondsToExpiry: number;
  binancePrice: number;
  strikePrice: number;
  obi: number;
  obiDelta: number;
  depthRatio: number;
  result?: 'pending' | 'win' | 'loss' | 'exit-profit' | 'exit-expiry';
  pnl?: number;
  orderResponse?: unknown;
  error?: string;
}

/** Raw data dump for a single 5M window (last 60 seconds). */
export interface WindowDataDump {
  slug: string;
  strikePrice: number;
  windowOpenPrice: number;
  startTime: number;       // collection start timestamp
  endTime: number;         // window end timestamp
  // Raw Binance trades (every single trade from @trade stream)
  trades: { t: number; p: number; q: number; b: boolean }[];  // timestamp, price, qty, isBuyerTaker
  // Raw depth snapshots (every ~100ms from @depth20@100ms)
  depths: { t: number; bids: [number, number][]; asks: [number, number][]; obi: number }[];
  // Polymarket CLOB book updates (every book change)
  books: { t: number; tokenId: string; bid: number; ask: number; bidSize: number; askSize: number }[];
  // Crossing events
  crossings: { t: number; from: string; to: string; price: number }[];
}

export interface ReversalEngineStatus {
  running: boolean;
  profileId?: string;
  balance?: number;
  binanceConnected: boolean;
  depthConnected: boolean;
  clobConnected: boolean;
  binancePingMs: number | null;
  depthPingMs: number | null;
  clobPingMs: number | null;
  activeMarket?: {
    slug: string;
    endTime: number;
    strikePrice: number;
    secondsToExpiry: number;
  };
  currentOBI: number;
  depthRatio: number;
  positions: number;
  tradesTotal: number;
  hourlyPnl: number;
  windowPnl: number;
  signalState: string;
  strikeCrossings: number;
  trendUsed: boolean;
  toggles: { collect: boolean; trend: boolean; reversal: boolean };
}

interface Position {
  direction: 'Up' | 'Down';
  conditionId: string;
  tokenId: string;
  entryPrice: number;
  size: number;
  entryTime: number;
  tradeId: string;
}

type LogLevel = 'info' | 'trade' | 'error' | 'eval';

interface LogEntry {
  text: string;
  type: LogLevel;
  timestamp: number;
}

// ─── Singleton Engine ────────────────────────────────────

class ReversalEngine {
  private running = false;
  private profile: ProfileCredentials | null = null;
  private balance = 0;

  // WebSocket feeds
  private binanceWS = new BinanceDirectWS();
  private depthWS = new BinanceDepthWS();
  private clobWS = new PolymarketWS();

  // Market state
  private currentWindow: MarketWindow | null = null;
  private strikePrice = 0;
  private windowOpenPrice = 0;  // Binance price captured at window start
  private books = new Map<string, { bestBid: number; bestAsk: number; bidSize: number; askSize: number; timestamp: number }>();

  // Strike crossing tracker: count how many times BTC crossed the strike during this window
  private strikeCrossings = 0;
  private lastSideOfStrike: 'above' | 'below' | null = null;
  private lastSideChangedAt = 0;  // timestamp when BTC last crossed strike
  private lastCrossingDir: 'Up' | 'Down' | null = null; // direction of last crossing (below→above = Up)
  // Pending crossing: side changed but not yet confirmed (needs to hold for CROSSING_MIN_HOLD_MS)
  private pendingSide: 'above' | 'below' | null = null;
  private pendingSideAt = 0;
  // BTC price samples during the window (for oscillation detection)
  private windowPriceHistory: { price: number; timestamp: number }[] = [];
  // Last BTC price seen before window end (for accurate settlement)
  private lastPriceBeforeExpiry = 0;

  // Positions & risk
  private positions: Position[] = [];
  private trades: TradeLog[] = [];
  // Track which directions we've already bet on this window (Up/Down each once max)
  private usedDirections = new Set<string>();
  private hourlyPnl = 0;
  private hourlyPnlResetAt = 0;
  private windowPnl = 0;

  // Cooldowns
  private lastTradeAt = 0;
  private failedCooldowns = new Map<string, number>();

  // Execution locks
  private executing = new Set<string>();

  // Signal tracking
  private signalState = 'idle';
  private snapshotLogged = false; // log confidence snapshot once per window at 45s mark

  // Trend continuation state
  private trendUsed = false;       // only 1 trend trade per window
  private trendFilled = false;     // trend actually filled → block reversal to avoid self-hedge

  // Reversal: only 1 entry per window (prevent opposite-direction self-hedge)
  private reversalUsed = false;

  // Feature toggles (controllable from UI)
  private collectEnabled = true;    // default ON
  private trendEnabled = false;     // default OFF
  private reversalEnabled = true;   // default ON

  // Data collector: raw WS data during last 60s of each window
  private dataDump: WindowDataDump | null = null;
  private collecting = false;  // true when inside the 60s collection window

  // Timers
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private exitTimer: ReturnType<typeof setInterval> | null = null;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private claiming = false;

  // Logs
  private logBuffer: LogEntry[] = [];
  private maxLogs = 500;

  // Persistence
  private static readonly PERSIST_DIR = join(process.cwd(), '.data', 'reversal');
  private static readonly POSITIONS_FILE = join(ReversalEngine.PERSIST_DIR, 'positions.json');
  private static readonly TRADES_FILE = join(ReversalEngine.PERSIST_DIR, 'trades.json');

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
    this.loadPersistedState();
    this.hourlyPnl = 0;
    this.hourlyPnlResetAt = Date.now() + 3600_000;
    this.windowPnl = 0;

    this.log('info', `Starting reversal engine with profile: ${profile.name}`);

    try {
      this.balance = await getProfileBalance(profile);
      this.log('info', `Balance: $${this.balance.toFixed(2)}`);
    } catch (err) {
      this.log('error', `Failed to fetch balance: ${err}`);
    }

    // Connect Binance trade + depth streams
    // Depth WS triggers eval on every update (~100ms) — fast enough for reversal detection
    this.binanceWS.connect();
    this.depthWS.connect(() => {
      this.collectDepth(); // raw depth recording (before any eval)
      if (this.trendEnabled) this.evaluateTrend();
      if (this.reversalEnabled) this.evaluateSignals();
      // crossing tracking + data collection even if reversal is off
      if (!this.reversalEnabled) this.evaluateSignalsPassive();
    });

    await this.scanAndSubscribe();

    this.scanTimer = setInterval(() => this.scanAndSubscribe(), CONFIG.SCAN_INTERVAL_MS);
    this.exitTimer = setInterval(() => this.checkExits(), CONFIG.EXIT_CHECK_INTERVAL_MS);
    this.claimTimer = setInterval(() => this.autoClaim(), CONFIG.CLAIM_CHECK_INTERVAL_MS);

    this.log('info', 'Engine started — monitoring BTC 5M markets for reversals');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.binanceWS.disconnect();
    this.depthWS.disconnect();
    this.clobWS.disconnect();

    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.exitTimer) { clearInterval(this.exitTimer); this.exitTimer = null; }
    if (this.claimTimer) { clearInterval(this.claimTimer); this.claimTimer = null; }

    this.currentWindow = null;
    this.books.clear();
    this.executing.clear();
    this.failedCooldowns.clear();
    this.signalState = 'idle';

    this.log('info', 'Engine stopped');
  }

  getStatus(): ReversalEngineStatus {
    const now = Date.now();
    let activeMarket: ReversalEngineStatus['activeMarket'];

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
      depthConnected: this.depthWS.isConnected(),
      clobConnected: this.clobWS.isConnected(),
      binancePingMs: this.binanceWS.getPingMs(),
      depthPingMs: this.depthWS.getPingMs(),
      clobPingMs: this.clobWS.getPingMs(),
      activeMarket,
      currentOBI: this.depthWS.getCurrentOBI(),
      depthRatio: this.depthWS.getDepthRatio(),
      positions: this.positions.length,
      tradesTotal: this.trades.length,
      hourlyPnl: this.hourlyPnl,
      windowPnl: this.windowPnl,
      signalState: this.signalState,
      strikeCrossings: this.strikeCrossings,
      trendUsed: this.trendUsed,
      toggles: {
        collect: this.collectEnabled,
        trend: this.trendEnabled,
        reversal: this.reversalEnabled,
      },
    };
  }

  getTrades(limit = 50): TradeLog[] {
    return this.trades.slice(-limit).reverse();
  }

  getLogs(limit = 200): LogEntry[] {
    return this.logBuffer.slice(-limit);
  }

  setToggles(toggles: { collect?: boolean; trend?: boolean; reversal?: boolean }): void {
    if (toggles.collect !== undefined) this.collectEnabled = toggles.collect;
    if (toggles.trend !== undefined) this.trendEnabled = toggles.trend;
    if (toggles.reversal !== undefined) this.reversalEnabled = toggles.reversal;
    this.log('info', `Toggles: collect=${this.collectEnabled} trend=${this.trendEnabled} reversal=${this.reversalEnabled}`);
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Calculate reversal vs no-reversal confidence.
   * Returns { reversalPct, noReversalPct, factors }
   * Based on all available signals weighted by historical importance.
   */
  getConfidence(): {
    reversalPct: number;
    noReversalPct: number;
    direction: 'Up' | 'Down' | null;
    factors: { name: string; value: number; signal: 'reversal' | 'no-reversal' | 'neutral' }[];
  } {
    const binancePrice = this.binanceWS.getPrice();
    const obi = this.depthWS.getCurrentOBI();
    const obiFlip = this.depthWS.getOBIFlip(CONFIG.OBI_RECENT_WINDOW_MS, CONFIG.OBI_OLDER_WINDOW_MS);
    const depthRatio = this.depthWS.getDepthRatio();
    const flow = this.binanceWS.getTradeFlow(CONFIG.FLOW_WINDOW_MS);
    const momentum = this.binanceWS.getMicroMomentum();

    if (!binancePrice || this.strikePrice <= 0) {
      return { reversalPct: 0, noReversalPct: 0, direction: null, factors: [] };
    }

    // Determine which direction would be a "reversal"
    const aboveStrike = binancePrice > this.strikePrice;
    const reversalDir: 'Up' | 'Down' = aboveStrike ? 'Down' : 'Up'; // reversal = opposite of current trend

    const factors: { name: string; value: number; signal: 'reversal' | 'no-reversal' | 'neutral' }[] = [];
    let reversalWeight = 0;
    let noReversalWeight = 0;

    // 1. OBI delta magnitude (weight: 3) — most predictive from backtest
    const obiDeltaAbs = Math.abs(obiFlip.delta);
    if (obiDeltaAbs >= 0.5) {
      // Check if OBI delta direction matches reversal
      const obiDeltaMatchesReversal = (reversalDir === 'Down' && obiFlip.delta < 0) ||
                                       (reversalDir === 'Up' && obiFlip.delta > 0);
      if (obiDeltaMatchesReversal) {
        reversalWeight += 3;
        factors.push({ name: `OBI Δ ${obiFlip.delta > 0 ? '+' : ''}${obiFlip.delta.toFixed(3)}`, value: obiDeltaAbs, signal: 'reversal' });
      } else {
        noReversalWeight += 3;
        factors.push({ name: `OBI Δ ${obiFlip.delta > 0 ? '+' : ''}${obiFlip.delta.toFixed(3)}`, value: obiDeltaAbs, signal: 'no-reversal' });
      }
    } else if (obiDeltaAbs >= 0.3) {
      const obiDeltaMatchesReversal = (reversalDir === 'Down' && obiFlip.delta < 0) ||
                                       (reversalDir === 'Up' && obiFlip.delta > 0);
      if (obiDeltaMatchesReversal) {
        reversalWeight += 2;
        factors.push({ name: `OBI Δ ${obiFlip.delta > 0 ? '+' : ''}${obiFlip.delta.toFixed(3)}`, value: obiDeltaAbs, signal: 'reversal' });
      } else {
        noReversalWeight += 2;
        factors.push({ name: `OBI Δ ${obiFlip.delta > 0 ? '+' : ''}${obiFlip.delta.toFixed(3)}`, value: obiDeltaAbs, signal: 'no-reversal' });
      }
    } else {
      noReversalWeight += 1;
      factors.push({ name: `OBI Δ weak (${obiDeltaAbs.toFixed(3)})`, value: obiDeltaAbs, signal: 'no-reversal' });
    }

    // 2. Flow imbalance (weight: 2)
    if (flow.tradeCount >= 10) {
      const flowMatchesReversal = (reversalDir === 'Down' && flow.imbalance < -0.15) ||
                                   (reversalDir === 'Up' && flow.imbalance > 0.15);
      const flowAgainstReversal = (reversalDir === 'Down' && flow.imbalance > 0.15) ||
                                   (reversalDir === 'Up' && flow.imbalance < -0.15);
      if (flowMatchesReversal) {
        reversalWeight += 2;
        factors.push({ name: `Flow ${flow.imbalance > 0 ? '+' : ''}${(flow.imbalance * 100).toFixed(0)}%`, value: Math.abs(flow.imbalance), signal: 'reversal' });
      } else if (flowAgainstReversal) {
        noReversalWeight += 2;
        factors.push({ name: `Flow ${flow.imbalance > 0 ? '+' : ''}${(flow.imbalance * 100).toFixed(0)}%`, value: Math.abs(flow.imbalance), signal: 'no-reversal' });
      } else {
        factors.push({ name: `Flow neutral (${(flow.imbalance * 100).toFixed(0)}%)`, value: Math.abs(flow.imbalance), signal: 'neutral' });
      }
    }

    // 3. Volume spike (weight: 2)
    if (flow.volumeSpike >= 2.5) {
      reversalWeight += 2; // High volume = volatility = reversal more likely
      factors.push({ name: `Vol spike ${flow.volumeSpike.toFixed(1)}x`, value: flow.volumeSpike, signal: 'reversal' });
    } else if (flow.volumeSpike < 1.0) {
      noReversalWeight += 1; // Low volume = stable = no reversal
      factors.push({ name: `Vol quiet ${flow.volumeSpike.toFixed(1)}x`, value: flow.volumeSpike, signal: 'no-reversal' });
    }

    // 4. Momentum (weight: 2)
    if (momentum !== null) {
      const momTowardStrike = (reversalDir === 'Down' && momentum < 0) ||
                               (reversalDir === 'Up' && momentum > 0);
      if (momTowardStrike && Math.abs(momentum) > 0.0001) {
        reversalWeight += 2;
        factors.push({ name: `Mom ${(momentum * 100).toFixed(3)}%`, value: Math.abs(momentum), signal: 'reversal' });
      } else if (!momTowardStrike && Math.abs(momentum) > 0.0001) {
        noReversalWeight += 2;
        factors.push({ name: `Mom ${(momentum * 100).toFixed(3)}%`, value: Math.abs(momentum), signal: 'no-reversal' });
      }
    }

    // 5. Price distance from strike (weight: 1)
    const crossDist = Math.abs(binancePrice - this.strikePrice) / this.strikePrice;
    if (crossDist < 0.0005) {
      reversalWeight += 1; // Very close = could go either way
      factors.push({ name: `Near strike ${(crossDist * 100).toFixed(3)}%`, value: crossDist, signal: 'reversal' });
    } else if (crossDist > 0.002) {
      noReversalWeight += 2; // Far from strike = unlikely to cross
      factors.push({ name: `Far from strike ${(crossDist * 100).toFixed(3)}%`, value: crossDist, signal: 'no-reversal' });
    }

    const total = reversalWeight + noReversalWeight;
    const reversalPct = total > 0 ? Math.round((reversalWeight / total) * 100) : 0;
    const noReversalPct = total > 0 ? Math.round((noReversalWeight / total) * 100) : 0;

    return { reversalPct, noReversalPct, direction: reversalDir, factors };
  }

  /** Expose Binance orderbook depth + trade flow + OBI + confidence for frontend */
  getDepthData() {
    const depth = this.depthWS.getLatestDepth();
    const now = Date.now();
    const secondsToExpiry = this.currentWindow
      ? Math.max(0, (this.currentWindow.endTime - now) / 1000)
      : 0;
    const flow = this.binanceWS.getTradeFlow(CONFIG.FLOW_WINDOW_MS);
    const confidence = this.getConfidence();

    return {
      bids: depth?.bids.slice(0, 15) ?? [],
      asks: depth?.asks.slice(0, 15) ?? [],
      obi: this.depthWS.getCurrentOBI(),
      obiHistory: this.depthWS.getOBIHistory(),
      depthRatio: this.depthWS.getDepthRatio(),
      obiFlip: this.depthWS.getOBIFlip(CONFIG.OBI_RECENT_WINDOW_MS, CONFIG.OBI_OLDER_WINDOW_MS),
      walls: this.depthWS.detectWalls(),
      spread: this.depthWS.getSpread(),
      strikePrice: this.strikePrice,
      binancePrice: this.binanceWS.getPrice(),
      windowOpenPrice: this.windowOpenPrice,
      secondsToExpiry,
      flow,
      confidence,
    };
  }

  /** Passive eval: only crossing tracking + data collection (when reversal is off) */
  private evaluateSignalsPassive(): void {
    if (!this.running || !this.currentWindow) return;
    const now = Date.now();
    if (now >= this.currentWindow.endTime) { this.scanAndSubscribe(); return; }
    const secondsToExpiry = (this.currentWindow.endTime - now) / 1000;
    const bp = this.binanceWS.getPrice();
    if (bp) {
      this.updateStrikeCrossing(bp);
      this.lastPriceBeforeExpiry = bp;
    }
    this.updateCollection(secondsToExpiry);
  }

  // ─── Data Collector (raw WS data) ─────────────────────

  /** Start/stop collection based on time to expiry. */
  private updateCollection(secondsToExpiry: number): void {
    if (!this.collectEnabled || !this.currentWindow) {
      if (this.collecting) this.stopCollecting();
      return;
    }
    if (secondsToExpiry <= 60 && !this.collecting) {
      this.startCollecting();
    }
  }

  private startCollecting(): void {
    if (this.collecting || !this.currentWindow) return;
    this.collecting = true;
    this.dataDump = {
      slug: this.currentWindow.event.slug,
      strikePrice: this.strikePrice,
      windowOpenPrice: this.windowOpenPrice,
      startTime: Date.now(),
      endTime: this.currentWindow.endTime,
      trades: [],
      depths: [],
      books: [],
      crossings: [],
    };
    // Attach raw trade handler
    this.binanceWS.setRawTradeHandler((trade) => {
      this.dataDump?.trades.push({
        t: trade.timestamp,
        p: trade.price,
        q: trade.qty,
        b: trade.isBuyerTaker,
      });
    });
    this.log('info', `Data collection started (${this.currentWindow.event.slug})`);
  }

  private stopCollecting(): void {
    if (!this.collecting) return;
    this.collecting = false;
    this.binanceWS.setRawTradeHandler(null);
  }

  /** Called from depth WS callback to record raw depth snapshots. */
  private collectDepth(): void {
    if (!this.collecting || !this.dataDump) return;
    const depth = this.depthWS.getLatestDepth();
    if (!depth) return;
    this.dataDump.depths.push({
      t: depth.timestamp,
      bids: depth.bids.slice(0, 20).map(b => [b.price, b.qty]),
      asks: depth.asks.slice(0, 20).map(a => [a.price, a.qty]),
      obi: this.depthWS.getCurrentOBI(),
    });
  }

  /** Called from CLOB book update to record token price changes. */
  private collectBook(assetId: string, bid: number, ask: number, bidSize: number, askSize: number): void {
    if (!this.collecting || !this.dataDump) return;
    this.dataDump.books.push({
      t: Date.now(),
      tokenId: assetId,
      bid, ask, bidSize, askSize,
    });
  }

  /** Record a crossing event. */
  private collectCrossing(from: string, to: string, price: number): void {
    if (!this.collecting || !this.dataDump) return;
    this.dataDump.crossings.push({ t: Date.now(), from, to, price });
  }

  /** Flush raw data dump to disk when window changes. */
  private flushDataDump(): void {
    this.stopCollecting();
    if (!this.dataDump || (this.dataDump.trades.length === 0 && this.dataDump.depths.length === 0)) return;
    try {
      const dir = join(ReversalEngine.PERSIST_DIR, 'snapshots');
      mkdirSync(dir, { recursive: true });
      const slug = this.dataDump.slug.replace(/[^a-zA-Z0-9_-]/g, '_');
      const ts = this.dataDump.startTime;
      const filename = `${slug}_${ts}.json`;
      writeFileSync(join(dir, filename), JSON.stringify(this.dataDump));
      const tradeCount = this.dataDump.trades.length;
      const depthCount = this.dataDump.depths.length;
      const bookCount = this.dataDump.books.length;
      this.log('info', `Data saved → ${filename} (${tradeCount} trades, ${depthCount} depths, ${bookCount} books)`);
    } catch (err: any) {
      this.log('error', `Failed to save data dump: ${err.message}`);
    }
    this.dataDump = null;
  }

  // ─── Strike Crossing Tracker ────────────────────────────

  /** Call on every Binance price update to track strike crossings. */
  private updateStrikeCrossing(binancePrice: number): void {
    if (this.strikePrice <= 0) return;

    // Record price sample (throttled to ~1/sec to keep array small)
    const now = Date.now();
    const lastSample = this.windowPriceHistory[this.windowPriceHistory.length - 1];
    if (!lastSample || now - lastSample.timestamp >= 1000) {
      this.windowPriceHistory.push({ price: binancePrice, timestamp: now });
    }

    const currentSide: 'above' | 'below' = binancePrice >= this.strikePrice ? 'above' : 'below';

    if (this.lastSideOfStrike === null) {
      // First price — initialize
      this.lastSideOfStrike = currentSide;
      this.lastSideChangedAt = now;
      return;
    }

    if (currentSide !== this.lastSideOfStrike) {
      // Side changed — start pending or confirm
      if (this.pendingSide === currentSide) {
        // Already pending in this direction — check if held long enough
        if (now - this.pendingSideAt >= CONFIG.CROSSING_MIN_HOLD_MS) {
          // Confirmed crossing!
          this.strikeCrossings++;
          this.lastSideChangedAt = this.pendingSideAt;
          this.lastCrossingDir = currentSide === 'above' ? 'Up' : 'Down';
          this.lastSideOfStrike = currentSide;
          this.pendingSide = null;
          this.collectCrossing(currentSide === 'above' ? 'below' : 'above', currentSide, binancePrice);
          this.log('info',
            `STRIKE CROSS #${this.strikeCrossings} | BTC=$${binancePrice.toFixed(1)} →${currentSide} (${this.lastCrossingDir}) held ${((now - this.pendingSideAt)/1000).toFixed(1)}s | STK=$${this.strikePrice.toFixed(1)}`
          );
        }
        // else: still pending, keep waiting
      } else {
        // New pending crossing
        this.pendingSide = currentSide;
        this.pendingSideAt = now;
      }
    } else {
      // Same side as confirmed — reset pending if it was the other side
      if (this.pendingSide !== null && this.pendingSide !== currentSide) {
        this.pendingSide = null; // noise crossing reverted
      }
    }
  }

  // ─── Volatility Estimation ──────────────────────────────

  /** Estimate annualized vol from recent Binance trade prices. */
  private estimateVol(): number {
    const history = this.binanceWS.getPriceHistory();
    if (history.length < 5) return 0.5; // default 50%
    const prices = history.map(h => h.price);
    // Average interval between samples
    const totalMs = history[history.length - 1].timestamp - history[0].timestamp;
    const avgIntervalSec = Math.max(0.05, (totalMs / (history.length - 1)) / 1000);
    return estimateVolatility(prices, avgIntervalSec);
  }

  // ─── Trend Continuation (driven by Binance depth WS ~100ms) ─────────
  // Buy the dominant (expensive) side when BTC is trending away from strike.

  private evaluateTrend(): void {
    if (!this.running || !this.currentWindow) return;

    const now = Date.now();
    const window = this.currentWindow;
    if (now >= window.endTime) return;

    const secondsToExpiry = (window.endTime - now) / 1000;

    // Only evaluate in the 40-20s window
    if (secondsToExpiry > CONFIG.TREND_MAX_SECONDS || secondsToExpiry < CONFIG.TREND_MIN_SECONDS) return;

    // One trend trade per window
    if (this.trendUsed) return;

    // Shared risk checks
    if (now >= this.hourlyPnlResetAt) { this.hourlyPnl = 0; this.hourlyPnlResetAt = now + 3600_000; }
    if (this.hourlyPnl <= CONFIG.HOURLY_LOSS_LIMIT) return;
    if (this.windowPnl <= CONFIG.WINDOW_LOSS_LIMIT) return;
    if (now - this.lastTradeAt < CONFIG.TRADE_COOLDOWN_MS) return;

    // Trend positions count separately
    const trendPositions = this.positions.filter(p => p.tradeId.startsWith('trd-'));
    if (trendPositions.length >= CONFIG.TREND_MAX_POSITIONS) return;

    const binancePrice = this.binanceWS.getPrice();
    if (!binancePrice || this.strikePrice <= 0) return;

    // Must NOT have crossed strike — pure trend
    if (this.strikeCrossings > CONFIG.TREND_MAX_CROSSINGS) return;

    // Consistency check: BTC must have been on the same side ≥95% of price samples
    if (this.windowPriceHistory.length >= 5) {
      const currentSide = this.lastSideOfStrike;
      if (currentSide) {
        const sameSide = this.windowPriceHistory.filter(
          h => (h.price >= this.strikePrice ? 'above' : 'below') === currentSide
        ).length;
        const consistency = sameSide / this.windowPriceHistory.length;
        if (consistency < CONFIG.TREND_MIN_CONSISTENCY) return;
      }
    }

    // Determine trend direction: which side of strike is BTC?
    const aboveStrike = binancePrice > this.strikePrice;
    const trendDir: 'Up' | 'Down' = aboveStrike ? 'Up' : 'Down';
    // Distance from strike (always positive)
    const distance = Math.abs(binancePrice - this.strikePrice) / this.strikePrice;

    // Must be far enough from strike
    if (distance < CONFIG.TREND_MIN_DISTANCE_PCT) return;

    // Find the dominant (expensive) token
    const upMarket = window.markets.find(m => m.direction === 'Up');
    const downMarket = window.markets.find(m => m.direction === 'Down');
    if (!upMarket || !downMarket) return;

    const dominantMarket = trendDir === 'Up' ? upMarket : downMarket;
    const dominantBook = this.books.get(dominantMarket.tokenId);
    if (!dominantBook) return;

    const askPrice = dominantBook.bestAsk;

    // Token price filter: must be in the expensive range
    if (askPrice < CONFIG.TREND_MIN_TOKEN_PRICE || askPrice > CONFIG.TREND_MAX_TOKEN_PRICE) return;

    if (this.executing.has(dominantMarket.tokenId)) return;
    if (this.executing.size > 0) return; // any pending execution blocks new trend orders
    if (this.positions.some(p => p.tokenId === dominantMarket.tokenId)) return;

    const failedAt = this.failedCooldowns.get(dominantMarket.tokenId) ?? 0;
    if (now - failedAt < CONFIG.FAILED_COOLDOWN_MS) return;

    // ─── Simple entry: all filters passed, go ─────────

    // Re-read fresh ask right before ordering
    const freshBook = this.books.get(dominantMarket.tokenId);
    const freshAsk = freshBook?.bestAsk ?? askPrice;
    if (freshAsk < CONFIG.TREND_MIN_TOKEN_PRICE || freshAsk > CONFIG.TREND_MAX_TOKEN_PRICE) return;

    // Fixed risk: shares = maxRisk / tokenPrice
    const shares = Math.max(1, Math.floor(CONFIG.TREND_MAX_RISK_DOLLARS / freshAsk));
    if (shares < 1) return;

    const obi = this.depthWS.getCurrentOBI();
    const depthRatio = this.depthWS.getDepthRatio();

    this.trendUsed = true;
    this.lastTradeAt = Date.now();  // set synchronously to prevent race with next tick

    this.log('trade',
      `TREND SIGNAL ${trendDir} | cross=${this.strikeCrossings} dist=${(distance * 100).toFixed(3)}% | ` +
      `ask=$${freshAsk.toFixed(2)} ${shares}sh (risk=$${(shares * freshAsk).toFixed(2)}) | ` +
      `BTC=$${binancePrice.toFixed(1)} STK=$${this.strikePrice.toFixed(1)} | ttx=${Math.round(secondsToExpiry)}s`
    );

    this.executeBuy(dominantMarket, freshAsk, shares, secondsToExpiry, binancePrice, obi, 0, depthRatio, 'trend')
      .catch(err => this.log('error', `trend executeBuy error: ${err}`));
  }

  // ─── Signal Evaluation (driven by Binance depth WS ~100ms) ─────────

  private evaluateSignals(): void {
    if (!this.running || !this.currentWindow) return;

    const now = Date.now();
    const window = this.currentWindow;

    if (now >= window.endTime) {
      this.scanAndSubscribe();
      return;
    }

    const secondsToExpiry = (window.endTime - now) / 1000;

    // Track strike crossings on every tick (runs even outside eval window)
    const binPriceForCross = this.binanceWS.getPrice();
    if (binPriceForCross) {
      this.updateStrikeCrossing(binPriceForCross);
      this.lastPriceBeforeExpiry = binPriceForCross; // continuously updated, used for settlement
    }

    // Start/stop raw data collection (last 60s)
    this.updateCollection(secondsToExpiry);

    // ─── 45-second snapshot: log token prices + confidence for future analysis ───
    if (!this.snapshotLogged && secondsToExpiry <= 45) {
      this.snapshotLogged = true;
      const binPrice = this.binanceWS.getPrice();
      const conf = this.getConfidence();
      const upMarket = window.markets.find(m => m.direction === 'Up');
      const downMarket = window.markets.find(m => m.direction === 'Down');
      const upBook = upMarket ? this.books.get(upMarket.tokenId) : null;
      const downBook = downMarket ? this.books.get(downMarket.tokenId) : null;
      const upAsk = upBook?.bestAsk ?? 0;
      const downAsk = downBook?.bestAsk ?? 0;
      const upBid = upBook?.bestBid ?? 0;
      const downBid = downBook?.bestBid ?? 0;

      this.log('info',
        `SNAPSHOT@30s | slug=${window.event.slug} | BTC=$${binPrice?.toFixed(1) ?? '?'} STK=$${this.strikePrice.toFixed(1)} open=$${this.windowOpenPrice.toFixed(1)} | ` +
        `UP bid=${upBid.toFixed(2)} ask=${upAsk.toFixed(2)} | DN bid=${downBid.toFixed(2)} ask=${downAsk.toFixed(2)} | ` +
        `crossings=${this.strikeCrossings} | ` +
        `reversal=${conf.reversalPct}% noReversal=${conf.noReversalPct}% dir=${conf.direction ?? '?'} | ` +
        `factors=[${conf.factors.map(f => `${f.signal === 'reversal' ? '+' : f.signal === 'no-reversal' ? '-' : '~'}${f.name}`).join(', ')}]`
      );
    }

    // Only evaluate in the final 30 seconds
    // This saves CPU for the first ~4 minutes and focuses on the high-signal window
    if (secondsToExpiry > CONFIG.MAX_SECONDS_TO_EXPIRY) {
      // Throttled idle log every 10s
      if (now - this.lastDebugLogAt >= 10_000) {
        this.signalState = `waiting ${Math.round(secondsToExpiry - CONFIG.MAX_SECONDS_TO_EXPIRY)}s`;
        this.lastDebugLogAt = now;
      }
      return;
    }
    if (secondsToExpiry < CONFIG.MIN_SECONDS_TO_EXPIRY) {
      this.signalState = 'too-close-to-expiry';
      return;
    }

    this.evalCount++;

    // Basic risk checks
    if (now >= this.hourlyPnlResetAt) { this.hourlyPnl = 0; this.hourlyPnlResetAt = now + 3600_000; }
    if (this.hourlyPnl <= CONFIG.HOURLY_LOSS_LIMIT) { this.signalState = 'hourly-limit'; return; }
    if (this.windowPnl <= CONFIG.WINDOW_LOSS_LIMIT) { this.signalState = 'window-limit'; return; }
    if (this.positions.length >= CONFIG.MAX_POSITIONS) { this.signalState = 'max-positions'; return; }
    if (now - this.lastTradeAt < CONFIG.TRADE_COOLDOWN_MS) { this.signalState = 'cooldown'; return; }

    const binancePrice = this.binanceWS.getPrice();
    if (!binancePrice || this.strikePrice <= 0) { this.signalState = 'no-price'; return; }
    if (this.windowOpenPrice <= 0) { this.signalState = 'no-open-price'; return; }

    // Price distance: current BTC vs window open price (Binance-to-Binance comparison)
    const priceDist = Math.abs(binancePrice - this.windowOpenPrice) / this.windowOpenPrice;

    // Hard block: if BTC moved too far from open, reversal is unlikely
    if (priceDist > CONFIG.MAX_PRICE_DISTANCE_PCT) {
      this.signalState = `too-far ${(priceDist * 100).toFixed(3)}%>${(CONFIG.MAX_PRICE_DISTANCE_PCT * 100).toFixed(1)}%`;
      return;
    }

    // Get orderbook signals (for logging)
    const obi = this.depthWS.getCurrentOBI();
    const depthRatio = this.depthWS.getDepthRatio();

    // Get markets
    const upMarket = window.markets.find(m => m.direction === 'Up');
    const downMarket = window.markets.find(m => m.direction === 'Down');
    if (!upMarket || !downMarket) { this.signalState = 'no-markets'; return; }

    const upBook = this.books.get(upMarket.tokenId);
    const downBook = this.books.get(downMarket.tokenId);
    if (!upBook || !downBook) { this.signalState = 'no-book'; return; }

    // ─── Crossing-Based Reversal Detection ─────────────────
    // Data shows: crossing ≥ 3 → 100% reversal rate.
    // Direction = last crossing direction (below→above = Up token wins).

    // Only 1 reversal per window (prevent any double entry)
    if (this.reversalUsed) { this.signalState = 'reversal-used'; return; }
    if (this.executing.size > 0) { this.signalState = 'executing'; return; }

    // Must have enough crossings (oscillation confirmed)
    if (this.strikeCrossings < CONFIG.MIN_STRIKE_CROSSINGS) {
      this.signalState = `cross=${this.strikeCrossings}<${CONFIG.MIN_STRIKE_CROSSINGS}`;
      return;
    }

    // Must have a last crossing direction
    if (!this.lastCrossingDir) {
      this.signalState = 'no-crossing-dir';
      return;
    }

    // Bet in the direction of the last crossing
    const betDir = this.lastCrossingDir;
    const betMarket = betDir === 'Up' ? upMarket : downMarket;
    const betBook = betDir === 'Up' ? upBook : downBook;
    const betAsk = betBook.bestAsk;

    // Distance from strike
    const crossDist = Math.abs(binancePrice - this.strikePrice) / this.strikePrice;
    if (crossDist > CONFIG.MAX_CROSS_DISTANCE_PCT) {
      this.signalState = `cross-far ${betDir} ${(crossDist * 100).toFixed(3)}%`;
      return;
    }

    // Token price filter
    if (betAsk < CONFIG.MIN_TOKEN_PRICE || betAsk > CONFIG.MAX_TOKEN_PRICE) {
      this.signalState = `price-filter ${betDir} ask=${betAsk.toFixed(2)}`;
      return;
    }

    if (this.executing.has(betMarket.tokenId)) { this.signalState = 'executing'; return; }
    if (this.executing.size > 0) return;
    if (this.positions.some(p => p.tokenId === betMarket.tokenId)) { this.signalState = 'already-positioned'; return; }
    if (this.usedDirections.has(betDir)) { this.signalState = `already-bet-${betDir}`; return; }

    const failedAt = this.failedCooldowns.get(betMarket.tokenId) ?? 0;
    if (now - failedAt < CONFIG.FAILED_COOLDOWN_MS) { this.signalState = 'failed-cooldown'; return; }

    // Debug log every 3s
    if (now - this.lastDebugLogAt >= 3000) {
      this.log('eval',
        `#${this.evalCount} REVERSAL | BTC=$${binancePrice.toFixed(1)} STK=$${this.strikePrice.toFixed(1)} dist=${(crossDist * 100).toFixed(3)}% | ` +
        `cross=${this.strikeCrossings} lastDir=${betDir} | ask=$${betAsk.toFixed(2)} | ` +
        `OBI=${obi.toFixed(3)} ratio=${depthRatio.toFixed(2)} | ttx=${Math.round(secondsToExpiry)}s`
      );
      this.lastDebugLogAt = now;
    }

    this.signalState = `cross=${this.strikeCrossings} ${betDir} dist=${(crossDist * 100).toFixed(3)}%`;

    // ─── Entry: bet on last crossing direction ───────────

    // Re-read fresh ask right before ordering
    const freshBook = this.books.get(betMarket.tokenId);
    const freshAsk = freshBook?.bestAsk ?? betAsk;
    if (freshAsk < CONFIG.MIN_TOKEN_PRICE || freshAsk > CONFIG.MAX_TOKEN_PRICE) return;

    // Fixed sizing: $3 max bet
    const shares = Math.max(CONFIG.MIN_SHARES, Math.floor(CONFIG.MAX_BET_DOLLARS / freshAsk));
    if (shares < CONFIG.MIN_SHARES) return;

    this.reversalUsed = true;
    this.lastTradeAt = Date.now(); // prevent race

    this.log('trade',
      `REVERSAL SIGNAL ${betDir} | cross=${this.strikeCrossings} | ` +
      `ask=$${freshAsk.toFixed(2)} ${shares}sh ($${(shares * freshAsk).toFixed(2)}) | ` +
      `BTC=$${binancePrice.toFixed(1)} STK=$${this.strikePrice.toFixed(1)} dist=${(crossDist * 100).toFixed(3)}% | ttx=${Math.round(secondsToExpiry)}s`
    );

    this.executeBuy(betMarket, freshAsk, shares, secondsToExpiry, binancePrice, obi, 0, depthRatio, 'reversal')
      .catch(err => this.log('error', `executeBuy error: ${err}`));
  }

  // ─── Exit Check ────────────────────────────────────────
  // Hold to settlement — binary payout ($0 or $1 per share).
  // No take profit: if our reversal signal is correct, settlement pays $1.
  // Selling early caps upside and taker fee eats into profit.

  private checkExits(): void {
    // No early exits — positions settle automatically at window end.
    // Just log current position status for monitoring.
    if (!this.running || this.positions.length === 0) return;

    const now = Date.now();
    const window = this.currentWindow;
    if (!window) return;

    const secondsToExpiry = (window.endTime - now) / 1000;

    for (const pos of [...this.positions]) {
      const book = this.books.get(pos.tokenId);
      const bid = book?.bestBid ?? 0;

      // Log position status every 5s
      const holdTime = (now - pos.entryTime) / 1000;
      if (Math.round(holdTime) % 5 === 0 && Math.round(holdTime) > 0) {
        this.log('eval',
          `HOLD ${pos.direction} | entry=$${pos.entryPrice.toFixed(2)} bid=$${bid.toFixed(2)} | ` +
          `hold=${holdTime.toFixed(0)}s ttx=${Math.round(secondsToExpiry)}s`
        );
      }
    }
  }

  // ─── Trade Execution ───────────────────────────────────

  private async executeBuy(
    market: ActiveMarket,
    askPrice: number,
    size: number,
    secondsToExpiry: number,
    binancePrice: number,
    obi: number,
    obiDelta: number,
    depthRatio: number,
    strategy: 'reversal' | 'trend' = 'reversal',
  ): Promise<void> {
    if (!this.profile) return;

    const prefix = strategy === 'trend' ? 'trd' : 'rev';
    const tradeId = `${prefix}-${market.tokenId}-${Date.now()}`;
    this.executing.add(market.tokenId);
    this.lastTradeAt = Date.now();

    const isUp = market.direction === 'Up';
    const vol = this.estimateVol();
    const fvUp = fairValueUp(binancePrice, this.strikePrice, vol, secondsToExpiry);
    const fv = isUp ? fvUp : 1 - fvUp;

    const tradeLog: TradeLog = {
      id: tradeId,
      timestamp: Date.now(),
      strategy,
      side: 'BUY',
      direction: market.direction,
      tokenPrice: askPrice,
      fairValue: fv,
      size,
      conditionId: market.conditionId,
      tokenId: market.tokenId,
      secondsToExpiry,
      binancePrice,
      strikePrice: this.strikePrice,
      obi,
      obiDelta,
      depthRatio,
      result: 'pending',
    };

    try {
      // Reversal: market price (0.99) for guaranteed fill. Trend: ask + slippage.
      const fillPrice = strategy === 'reversal'
        ? 0.99  // market buy — fill at whatever ask is available
        : Math.min(0.99, askPrice + CONFIG.TREND_SLIPPAGE);

      const result = await placeProfileOrder(this.profile, {
        tokenId: market.tokenId,
        side: 'BUY',
        price: fillPrice,
        size,
        taker: true,
      });

      tradeLog.orderResponse = result;

      // Check if actually filled (status=matched) vs resting (status=live)
      const status = (result as any)?.status;
      const filled = status === 'matched';

      if (!filled) {
        // Order didn't fill — cancel it and skip position tracking
        this.log('trade', `BUY UNFILLED ${market.direction} (${strategy}) | status=${status} | ask=$${askPrice.toFixed(2)}+slip=$${fillPrice.toFixed(2)}`);
        tradeLog.result = 'loss';
        tradeLog.pnl = 0;
        // Try to cancel the resting order
        try {
          const orderId = (result as any)?.orderID;
          if (orderId) {
            const { cancelProfileOrders } = await import('@/lib/bot/profile-client');
            await cancelProfileOrders(this.profile!, [orderId]);
            this.log('info', `Cancelled unfilled order ${orderId.slice(0, 10)}`);
          }
        } catch { /* ignore cancel errors */ }
      } else {
        this.positions.push({
          direction: market.direction,
          conditionId: market.conditionId,
          tokenId: market.tokenId,
          entryPrice: askPrice,
          size,
          entryTime: Date.now(),
          tradeId,
        });

        this.usedDirections.add(market.direction);
        if (strategy === 'trend') this.trendFilled = true;
        this.persistPositions();
        this.log('trade', `BUY OK ${market.direction} (${strategy}) | ${size}×$${askPrice.toFixed(2)} ($${(size * askPrice).toFixed(2)})`);
      }
    } catch (err: any) {
      tradeLog.error = err.message ?? String(err);
      tradeLog.result = 'loss';
      this.failedCooldowns.set(market.tokenId, Date.now());
      this.log('error', `BUY FAILED ${market.direction}: ${err.message}`);
    }

    this.trades.push(tradeLog);
    this.persistTrades();
    this.executing.delete(market.tokenId);
  }

  private async executeSell(
    pos: Position,
    bidPrice: number,
    reason: string,
    secondsToExpiry: number,
  ): Promise<void> {
    if (!this.profile) return;

    this.executing.add(pos.tokenId);

    const pnl = (bidPrice - pos.entryPrice) * pos.size;
    const fee = takerFeePerShare(bidPrice) * pos.size;
    const netPnl = pnl - fee;

    const obi = this.depthWS.getCurrentOBI();
    const depthRatio = this.depthWS.getDepthRatio();

    const tradeLog: TradeLog = {
      id: `${pos.tokenId}-sell-${Date.now()}`,
      timestamp: Date.now(),
      strategy: pos.tradeId.startsWith('trd-') ? 'trend' : 'reversal',
      side: 'SELL',
      direction: pos.direction,
      tokenPrice: bidPrice,
      fairValue: 0,
      size: pos.size,
      conditionId: pos.conditionId,
      tokenId: pos.tokenId,
      secondsToExpiry,
      binancePrice: this.binanceWS.getPrice() ?? 0,
      strikePrice: this.strikePrice,
      obi,
      obiDelta: 0,
      depthRatio,
      result: reason === 'profit' || reason === 'expiry-profit' ? 'exit-profit' : 'exit-expiry',
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
      this.persistPositions();

      this.log('trade',
        `SELL OK ${pos.direction} (${reason}) | ${pos.size}×$${bidPrice.toFixed(2)} | ` +
        `entry=$${pos.entryPrice.toFixed(2)} pnl=$${netPnl.toFixed(2)}`
      );

      const buyTrade = this.trades.find(t => t.id === pos.tradeId);
      if (buyTrade) {
        buyTrade.result = tradeLog.result;
        buyTrade.pnl = netPnl;
      }
    } catch (err: any) {
      tradeLog.error = err.message ?? String(err);
      this.log('error', `SELL FAILED ${pos.direction} (${reason}): ${err.message}`);

      const msg = (err.message ?? '').toLowerCase();
      if (msg.includes('not enough balance') || msg.includes('not enough allowance')) {
        this.log('info', `No tokens held for ${pos.direction} — removing phantom position`);
        this.positions = this.positions.filter(p => p.tradeId !== pos.tradeId);
      }
    }

    this.trades.push(tradeLog);
    this.persistTrades();
    this.executing.delete(pos.tokenId);

    if (this.profile) {
      getProfileBalance(this.profile).then(b => { this.balance = b; }).catch(() => {});
    }
  }

  // ─── CLOB Book Handler ─────────────────────────────────

  private onBookUpdate(book: BookSnapshot): void {
    const bestBid = book.buys.length > 0 ? parseFloat(book.buys[0].price) : 0;
    const bestAsk = book.sells.length > 0 ? parseFloat(book.sells[0].price) : 0;
    const bidSize = book.buys.length > 0 ? parseFloat(book.buys[0].size) : 0;
    const askSize = book.sells.length > 0 ? parseFloat(book.sells[0].size) : 0;
    if (bestBid > 0 || bestAsk > 0) {
      this.books.set(book.assetId, { bestBid, bestAsk, bidSize, askSize, timestamp: book.timestamp });
      this.collectBook(book.assetId, bestBid, bestAsk, bidSize, askSize);
    }
  }

  // ─── Market Scanning ───────────────────────────────────

  private async scanAndSubscribe(): Promise<void> {
    try {
      const window = await scanCurrentWindow(CONFIG.MARKET_DURATION);
      if (!window) {
        this.log('info', 'No active 5M market window found');
        this.currentWindow = null;
        return;
      }

      const windowChanged = this.currentWindow?.event.slug !== window.event.slug;

      if (windowChanged) {
        // Flush raw data dump from previous window
        this.flushDataDump();

        // Settle positions from previous window: determine win/loss based on BTC vs strike
        if (this.positions.length > 0) {
          this.settlePositions();
        }
        // Also settle any pending trades that had no position (unfilled but result still pending)
        this.settlePendingTrades();

        this.currentWindow = window;
        this.windowPnl = 0;
        this.usedDirections.clear();
        this.snapshotLogged = false;
        this.strikeCrossings = 0;
        this.lastSideOfStrike = null;
        this.lastSideChangedAt = 0;
        this.lastCrossingDir = null;
        this.pendingSide = null;
        this.pendingSideAt = 0;
        this.windowPriceHistory = [];
        this.lastPriceBeforeExpiry = 0;
        this.trendUsed = false;
        this.trendFilled = false;
        this.reversalUsed = false;

        const tokenIds = window.markets.map(m => m.tokenId);
        this.clobWS.disconnect();
        this.clobWS.connect(tokenIds, (book) => this.onBookUpdate(book));

        this.strikePrice = 0;
        this.windowOpenPrice = 0;
        const eventStrike = extractStrikePrice(window.event);
        if (eventStrike) this.strikePrice = eventStrike;

        if (this.strikePrice <= 0) {
          const bp = this.binanceWS.getPrice();
          if (bp) this.strikePrice = bp;
        }

        // Capture Binance price at window start for distance comparison
        const bp = this.binanceWS.getPrice();
        if (bp) this.windowOpenPrice = bp;

        const secsLeft = Math.round((window.endTime - Date.now()) / 1000);
        this.log('info',
          `New 5M window: ${window.event.slug} | ${secsLeft}s left | ` +
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

  // ─── Auto-Claim ────────────────────────────────────────

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

  // ─── Settlement (win/loss tracking) ─────────────────────

  /** Determine win/loss for all held positions at window end. */
  private settlePositions(): void {
    // Use the last price captured BEFORE window ended, not current price (which is already in next window)
    const btcPrice = this.lastPriceBeforeExpiry > 0 ? this.lastPriceBeforeExpiry : this.binanceWS.getPrice();
    if (!btcPrice || this.strikePrice <= 0) {
      this.log('info', `Window ended — ${this.positions.length} position(s) settled (no price for result)`);
      this.positions = [];
      this.persistPositions();
      return;
    }

    const btcAboveStrike = btcPrice >= this.strikePrice;

    for (const pos of this.positions) {
      const won = (pos.direction === 'Up' && btcAboveStrike) ||
                  (pos.direction === 'Down' && !btcAboveStrike);
      const payout = won ? (1 - pos.entryPrice) * pos.size : -(pos.entryPrice * pos.size);
      const fee = won ? takerFeePerShare(1) * pos.size : 0; // fee only on winning payout
      const netPnl = payout - fee;

      this.hourlyPnl += netPnl;
      this.windowPnl += netPnl;

      // Update the original buy trade
      const buyTrade = this.trades.find(t => t.id === pos.tradeId);
      if (buyTrade) {
        buyTrade.result = won ? 'win' : 'loss';
        buyTrade.pnl = netPnl;
      }

      const strategy = pos.tradeId.startsWith('trd-') ? 'trend' : 'reversal';
      this.log('trade',
        `SETTLE ${won ? 'WIN' : 'LOSS'} ${pos.direction} (${strategy}) | ` +
        `entry=$${pos.entryPrice.toFixed(2)} ${pos.size}sh | ` +
        `BTC=$${btcPrice.toFixed(1)} ${btcAboveStrike ? '>' : '<'} STK=$${this.strikePrice.toFixed(1)} | ` +
        `pnl=$${netPnl.toFixed(2)}`
      );
    }

    this.positions = [];
    this.persistPositions();
    this.persistTrades();
  }

  /** Mark unfilled pending trades (no position created) as 'loss' with pnl=0. */
  private settlePendingTrades(): void {
    let updated = 0;
    for (const trade of this.trades) {
      if (trade.result !== 'pending') continue;
      // If there's no matching position, this trade was either unfilled or already settled
      const hasPosition = this.positions.some(p => p.tradeId === trade.id);
      if (!hasPosition) {
        const status = (trade.orderResponse as any)?.status;
        if (status === 'live') {
          // Unfilled order
          trade.result = 'loss';
          trade.pnl = 0;
          updated++;
        }
      }
    }
    if (updated > 0) {
      this.log('info', `Marked ${updated} unfilled order(s) as loss (pnl=$0)`);
      this.persistTrades();
    }
  }

  // ─── Persistence ─────────────────────────────────────────

  private persistPositions(): void {
    try {
      mkdirSync(ReversalEngine.PERSIST_DIR, { recursive: true });
      writeFileSync(ReversalEngine.POSITIONS_FILE, JSON.stringify(this.positions, null, 2));
    } catch { /* ignore */ }
  }

  private persistTrades(): void {
    try {
      mkdirSync(ReversalEngine.PERSIST_DIR, { recursive: true });
      // Only persist last 200 trades to keep file size reasonable
      const recent = this.trades.slice(-200);
      writeFileSync(ReversalEngine.TRADES_FILE, JSON.stringify(recent, null, 2));
    } catch { /* ignore */ }
  }

  private loadPersistedState(): void {
    try {
      const posData = readFileSync(ReversalEngine.POSITIONS_FILE, 'utf-8');
      const positions: Position[] = JSON.parse(posData);
      if (Array.isArray(positions) && positions.length > 0) {
        this.positions = positions;
        this.log('info', `Recovered ${positions.length} position(s) from disk`);
      }
    } catch { /* no persisted positions */ }

    try {
      const tradeData = readFileSync(ReversalEngine.TRADES_FILE, 'utf-8');
      const trades: TradeLog[] = JSON.parse(tradeData);
      if (Array.isArray(trades) && trades.length > 0) {
        this.trades = trades;
        this.log('info', `Loaded ${trades.length} trade(s) from disk`);
      }
    } catch { /* no persisted trades */ }
  }

  // ─── Helpers ───────────────────────────────────────────

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

    const prefix = level === 'error' ? '[reversal:ERROR]' : `[reversal:${level}]`;
    console.log(`${prefix} ${text}`);
  }
}

// ─── Singleton Export ────────────────────────────────────

let engine: ReversalEngine | null = null;

export function getReversalEngine(): ReversalEngine {
  if (!engine) engine = new ReversalEngine();
  return engine;
}
