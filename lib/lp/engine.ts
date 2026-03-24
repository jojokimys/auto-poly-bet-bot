import 'server-only';
import { appendFile, stat, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { scanRewardMarkets, type RewardMarket } from './scanner';
import { calculateQScore, rankMarketsByEfficiency, type LpOrder, type RewardEfficiency } from './scoring';

// ─── File Logger ─────────────────────────────────────────

const LOG_DIR = join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'lp-rewards.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

async function ensureLogDir() {
  const { mkdir } = await import('fs/promises');
  await mkdir(LOG_DIR, { recursive: true });
}

async function appendLog(line: string) {
  try {
    await ensureLogDir();
    await appendFile(LOG_FILE, line + '\n');
    const s = await stat(LOG_FILE);
    if (s.size > MAX_LOG_BYTES) {
      const content = await readFile(LOG_FILE, 'utf-8');
      const lines = content.split('\n');
      const keep = lines.slice(Math.floor(lines.length * 0.4));
      await writeFile(LOG_FILE, keep.join('\n'));
    }
  } catch { /* silent */ }
}

import {
  loadProfile,
  getClientForProfile,
  placeProfileOrder,
  cancelAllProfileOrders,
  getProfileOpenOrders,
  getProfileBalance,
  getProfileTokenBalance,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';
import { getReadClient } from '@/lib/polymarket/client';
import { PolymarketWS } from '@/lib/polymarket-ws';
import { PolymarketUserWS, type UserTrade } from '@/lib/polymarket-user-ws';
import type { BookSnapshot, BookLevel } from '@/lib/trading-types';
import { prisma } from '@/lib/db/prisma';

// ─── Types ───────────────────────────────────────────────

interface ActiveOrder {
  orderId: string;
  tokenId: string;
  tokenIndex: number;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  marketId: string;
  originalSize: number;
  /** 'lp' = reward-earning resting order, 'hedge' = exit order for filled position */
  purpose: 'lp' | 'hedge';
}

interface HeldPosition {
  tokenId: string;
  tokenIndex: number;
  fillPrice: number;
  size: number;
  marketId: string;
  hedgeOrderId?: string;
  hedgePrice: number;
  timestamp: number;
}

interface ManagedMarket {
  market: RewardMarket;
  efficiency: RewardEfficiency;
  orders: ActiveOrder[];
  positions: HeldPosition[];
  lastUpdate: number;
  allocatedCapital: number;
  /** Net inventory: positive = long Yes, negative = long No */
  inventoryYes: number;
  inventoryNo: number;
}

export interface LpLogLine {
  text: string;
  type: 'info' | 'trade' | 'error' | 'reward';
  timestamp: number;
}

export interface LpEngineStatus {
  running: boolean;
  profileId?: string;
  profileName?: string;
  balance?: number;
  managedMarkets: number;
  totalAllocatedCapital: number;
  totalActiveOrders: number;
  totalPositions: number;
  totalLpDeployed: number;
  totalEstDailyReward: number;
  lastScanTime?: number;
  markets: ManagedMarketStatus[];
}

export interface ManagedMarketStatus {
  id: string;
  question: string;
  slug: string;
  midpoint: number;
  spread: number;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  qScore: number;
  qScorePerDollar: number;
  rewardRatio: number;
  allocatedCapital: number;
  activeOrders: number;
  heldPositions: number;
  lpDeployed: number;
  liquidity: number;
  rewardsDailyRate: number;
  estDailyReward: number;
  spreadPct: number;
  /** Days until market resolves */
  daysToExpiry: number;
  /** Net inventory skew: 0 = neutral, positive = long Yes */
  inventorySkew: number;
  /** Minimum capital to qualify for rewards */
  minCapital: number;
  /** Daily ROI % at minimum capital */
  roiAtMin: number;
  /** Daily ROI % at configured capital */
  roiAtConfig: number;
  /** Live best bid prices from orderbook */
  liveBidYes: number;
  liveBidNo: number;
  /** Our LP order prices */
  myBidYes: number;
  myBidNo: number;
  /** Wall size ($) above our order */
  wallYes: number;
  wallNo: number;
}

// ─── Constants ───────────────────────────────────────────

const MAX_LOGS = 500;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const REQUOTE_INTERVAL_MS = 30 * 1000;
const TIGHT_REQUOTE_INTERVAL_MS = 60 * 1000; // 1min refresh for tight-spread markets
const FILL_CHECK_INTERVAL_MS = 10 * 1000;

// ─── Risk Management Constants (from research) ──────────
const MIN_DAYS_TO_EXPIRY = 2 / 24;  // Skip markets resolving within 2h
const EXPIRY_WIDEN_DAYS = 7;        // Start widening spread 7 days before expiry
const MAX_SINGLE_MARKET_PCT = 0.90; // Each market can use up to 90% of balance
const CASH_RESERVE_PCT = 0.05;      // Keep 5% cash reserve
const CAPITAL_PER_SIDE = 0.47;      // 47% of balance per side (~$100 at $212 balance)
const INVENTORY_WARN_PCT = 0.30;    // Start skewing at 30% inventory imbalance
const INVENTORY_MAX_PCT = 0.50;     // Pull quotes at 50% inventory imbalance
const MIN_MIDPOINT = 0.10;          // Skip extreme probability markets
const MAX_MIDPOINT = 0.90;
const DEFAULT_MIN_WALL_SIZE = 300;  // Absolute minimum $ wall (fallback)
const WALL_MULTIPLIER = 3;          // Wall must be >= 3x our order size per side
const MIN_LIQUIDITY = 10_000;       // Skip markets with < $10K liquidity
const HEDGE_TIMEOUT_MS = 60_000;    // Force market-sell hedge after 60s
// Wall-protected price must be within this fraction of the market's rewardsMaxSpread
// e.g., 0.8 = must be within 80% of maxSpread (outer 20% is too low Q-score)
const MAX_SPREAD_RATIO = 0.80;

class LpRewardsEngine {
  private running = false;
  private profile: ProfileCredentials | null = null;
  private balance = 0;
  private managedMarkets = new Map<string, ManagedMarket>();
  private logs: LpLogLine[] = [];
  /** Blacklisted conditionIds — markets with 2+ fill rounds (volatile) */
  private blacklist = new Set<string>();
  /** Fill rounds per conditionId — blacklist after 2 rounds. Each round = one requote cycle with fills. */
  private fillRounds = new Map<string, { count: number; lastRoundAt: number }>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private requoteTimer: ReturnType<typeof setInterval> | null = null;
  private tightRequoteTimer: ReturnType<typeof setInterval> | null = null;
  private fillCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastScanTime = 0;

  // ── Real-time WebSockets ──
  private ws: PolymarketWS | null = null;
  private userWs: PolymarketUserWS | null = null;
  /** assetId → { bids (sorted high→low), asks (sorted low→high), updated } */
  private liveBooks = new Map<string, {
    bids: BookLevel[];
    asks: BookLevel[];
    updated: number;
  }>();

  private config = {
    maxMarkets: 50,
    capitalPerMarket: 50,
    /** 0-100: where to place orders as % of maxSpread.
     *  70 = sweet spot: low fill risk, decent Q score */
    spreadPct: 70,
    twoSided: true,
    hedgeOffsetCents: 1,
    /** Minimum absolute distance from midpoint (in cents).
     *  Even if spreadPct × maxSpread < this, we use this floor.
     *  Prevents fills on markets with small maxSpread. */
    minSpreadCents: 2,
    /** Minimum $ of existing orders that must sit in front of ours (the "wall").
     *  Higher = safer from fills. */
    minWallSize: DEFAULT_MIN_WALL_SIZE,
    /** Minimum daily rate ($) to consider a market worth entering */
    minDailyRate: 50,
    /** Allow tight-spread markets (<=2¢, e.g. sports). Uses edge strategy with 1min refresh */
    allowTightSpread: false,
  };

  isRunning() { return this.running; }

  getStatus(): LpEngineStatus {
    const markets: ManagedMarketStatus[] = [];
    for (const [, mm] of this.managedMarkets) {
      const lpDeployed = mm.orders
        .filter((o) => o.purpose === 'lp')
        .reduce((sum, o) => sum + o.price * o.size, 0);
      const totalPool = lpDeployed + mm.market.liquidity;
      const ourShare = totalPool > 0 ? lpDeployed / totalPool : 0;
      const estDailyReward = ourShare * mm.market.rewardsDailyRate;
      const daysToExpiry = Math.max(0, (new Date(mm.market.endDate).getTime() - Date.now()) / 86400000);
      const totalInv = mm.inventoryYes + mm.inventoryNo;
      const inventorySkew = totalInv > 0
        ? (mm.inventoryYes - mm.inventoryNo) / totalInv
        : 0;

      markets.push({
        id: mm.market.id,
        question: mm.market.question,
        slug: mm.market.slug,
        midpoint: mm.market.midpoint,
        spread: mm.market.spread,
        rewardsMaxSpread: mm.market.rewardsMaxSpread,
        rewardsMinSize: mm.market.rewardsMinSize,
        qScore: mm.efficiency.qScore.qMin,
        qScorePerDollar: mm.efficiency.qScorePerDollar,
        rewardRatio: mm.efficiency.rewardRatio,
        allocatedCapital: mm.allocatedCapital,
        activeOrders: mm.orders.length,
        heldPositions: mm.positions.length,
        lpDeployed,
        liquidity: mm.market.liquidity,
        rewardsDailyRate: mm.market.rewardsDailyRate,
        estDailyReward,
        spreadPct: this.config.spreadPct,
        daysToExpiry,
        inventorySkew,
        minCapital: mm.efficiency.minCapital,
        roiAtMin: mm.efficiency.roiAtMin,
        roiAtConfig: mm.efficiency.roiAtConfig,
        liveBidYes: (() => {
          const book = this.liveBooks.get(mm.market.clobTokenIds[0]);
          if (!book?.bids?.length) return 0;
          return Math.max(...book.bids.map((b) => parseFloat(b.price)));
        })(),
        liveBidNo: (() => {
          const book = this.liveBooks.get(mm.market.clobTokenIds[1]);
          if (!book?.bids?.length) return 0;
          return Math.max(...book.bids.map((b) => parseFloat(b.price)));
        })(),
        myBidYes: mm.orders.find((o) => o.purpose === 'lp' && o.tokenIndex === 0)?.price ?? 0,
        myBidNo: mm.orders.find((o) => o.purpose === 'lp' && o.tokenIndex === 1)?.price ?? 0,
        wallYes: (() => {
          const myPrice = mm.orders.find((o) => o.purpose === 'lp' && o.tokenIndex === 0)?.price ?? 0;
          if (!myPrice) return 0;
          const book = this.liveBooks.get(mm.market.clobTokenIds[0]);
          if (!book?.bids) return 0;
          return book.bids.reduce((sum, b) => {
            const p = parseFloat(b.price); const s = parseFloat(b.size);
            return p > myPrice ? sum + p * s : sum;
          }, 0);
        })(),
        wallNo: (() => {
          const myPrice = mm.orders.find((o) => o.purpose === 'lp' && o.tokenIndex === 1)?.price ?? 0;
          if (!myPrice) return 0;
          const book = this.liveBooks.get(mm.market.clobTokenIds[1]);
          if (!book?.bids) return 0;
          return book.bids.reduce((sum, b) => {
            const p = parseFloat(b.price); const s = parseFloat(b.size);
            return p > myPrice ? sum + p * s : sum;
          }, 0);
        })(),
      });
    }

    return {
      running: this.running,
      profileId: this.profile?.id,
      profileName: this.profile?.name,
      balance: this.balance,
      managedMarkets: this.managedMarkets.size,
      totalAllocatedCapital: markets.reduce((s, m) => s + m.allocatedCapital, 0),
      totalActiveOrders: markets.reduce((s, m) => s + m.activeOrders, 0),
      totalPositions: markets.reduce((s, m) => s + m.heldPositions, 0),
      totalLpDeployed: markets.reduce((s, m) => s + m.lpDeployed, 0),
      totalEstDailyReward: markets.reduce((s, m) => s + m.estDailyReward, 0),
      lastScanTime: this.lastScanTime,
      markets: markets.sort((a, b) => b.roiAtMin - a.roiAtMin),
    };
  }

  getLogs(limit = 200) { return this.logs.slice(-limit); }
  getConfig() { return { ...this.config }; }

  updateConfig(updates: Partial<typeof this.config>) {
    Object.assign(this.config, updates);
    this.log('info', `Config updated: ${JSON.stringify(this.config)}`);
  }

  async start(profileId: string) {
    if (this.running) throw new Error('LP engine already running');

    const profile = await loadProfile(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);

    this.profile = profile;
    this.running = true;
    this.log('info', `LP engine started for ${profile.name}`);
    this.log('info', `wall=$${this.config.minWallSize} minGap=${this.config.minSpreadCents}¢ hedge=${this.config.hedgeOffsetCents}¢ reserve=${(CASH_RESERVE_PCT * 100).toFixed(0)}%`);

    // Load blacklist from DB
    try {
      const blacklisted = await prisma.lpBlacklist.findMany();
      this.blacklist = new Set(blacklisted.map((b) => b.conditionId));
      if (this.blacklist.size > 0) {
        this.log('info', `Loaded ${this.blacklist.size} blacklisted markets`);
      }
    } catch { /* ignore */ }

    try {
      this.balance = await getProfileBalance(profile);
      this.log('info', `Balance: $${this.balance.toFixed(2)} (available: $${(this.balance * (1 - CASH_RESERVE_PCT)).toFixed(2)})`);
    } catch (err: any) {
      this.log('error', `Balance fetch failed: ${err.message}`);
    }

    // 0. Approve COLLATERAL (USDC for BUY) — CONDITIONAL approved per-token at sell time
    try {
      const client = getClientForProfile(profile);
      await client.updateBalanceAllowance({ asset_type: 'COLLATERAL' as any });
      this.log('info', 'COLLATERAL allowance approved');
    } catch (err: any) {
      this.log('error', `Allowance approval failed: ${err.message}`);
    }

    // 0b. Connect user WS for real-time fill detection
    if (profile.apiKey && profile.apiSecret && profile.apiPassphrase) {
      this.userWs = new PolymarketUserWS(profile.apiKey, profile.apiSecret, profile.apiPassphrase);
      this.userWs.connect([], (trade) => this.onUserTrade(trade));
      this.log('info', 'User WS connected (real-time fill detection)');
    } else {
      this.log('info', 'No API keys — fill detection via REST polling only');
    }

    // 1. Scan markets first (populates managedMarkets but skips requote)
    await this.scanAndAllocate(true);
    // 2. Connect WS for real-time orderbooks
    this.connectWS();
    // 3. Sync existing orders (now managedMarkets exist to match against)
    await this.syncExistingOrders();
    // 4. Sync existing positions (token balances → inventory + hedge orders)
    await this.syncExistingPositions();
    // 5. Wait briefly for WS books to populate, then place orders
    await new Promise((r) => setTimeout(r, 2000));
    await this.requoteAll();

    this.scanTimer = setInterval(() => this.scanAndAllocate(), SCAN_INTERVAL_MS);
    this.requoteTimer = setInterval(() => this.requoteAll(), REQUOTE_INTERVAL_MS);
    this.tightRequoteTimer = setInterval(() => this.requoteTightMarkets(), TIGHT_REQUOTE_INTERVAL_MS);
    this.fillCheckTimer = setInterval(() => this.checkFills(), FILL_CHECK_INTERVAL_MS);
  }

  async stop() {
    this.running = false;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.requoteTimer) clearInterval(this.requoteTimer);
    if (this.tightRequoteTimer) clearInterval(this.tightRequoteTimer);
    if (this.fillCheckTimer) clearInterval(this.fillCheckTimer);
    this.scanTimer = null;
    this.requoteTimer = null;
    this.tightRequoteTimer = null;
    this.fillCheckTimer = null;

    // Clear urgent timers
    for (const timer of this.wsUrgentTimers.values()) clearTimeout(timer);
    this.wsUrgentTimers.clear();
    for (const timer of this.priceCheckTimers.values()) clearTimeout(timer);
    this.priceCheckTimers.clear();

    // Disconnect WS
    if (this.userWs) {
      this.userWs.disconnect();
      this.userWs = null;
    }
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }
    this.liveBooks.clear();

    if (this.profile) {
      try {
        await cancelAllProfileOrders(this.profile);
        this.log('info', 'All orders cancelled');
      } catch (err: any) {
        this.log('error', `Cancel failed: ${err.message}`);
      }
    }

    this.managedMarkets.clear();
    this.log('info', 'LP engine stopped');
  }

  // ── Pending Sells (failed hedge retries) ───────────────

  private pendingSells: Array<{
    tokenId: string;
    size: number;
    fillPrice: number;
    marketSlug: string;
    side: string;
    addedAt: number;
  }> = [];

  // ── WebSocket Orderbook ────────────────────────────────

  private wsRequoteInFlight = false;
  private wsUrgentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Track asset IDs already fully hedged by WS to avoid double-selling in checkFills */
  private wsHedgedAssets = new Map<string, number>(); // assetId → cumulative hedged size

  private connectWS() {
    if (this.ws) {
      this.ws.disconnect();
    }

    this.ws = new PolymarketWS();
    this.ws.connect([], (book: BookSnapshot) => {
      if (book.isFullBook) {
        // Full orderbook snapshot — update depth cache + wall monitoring
        this.liveBooks.set(book.assetId, {
          bids: book.buys,
          asks: book.sells,
          updated: book.timestamp,
        });

        // Real-time wall monitoring: only on full book (has depth data)
        if (this.running && !this.wsRequoteInFlight) {
          this.onWsBookUpdate(book.assetId, book.buys);
        }
      } else {
        // price_change — only best bid/ask, no depth for wall checks
        // Detect if best bid moved near/below our LP order → fetch full book for wall check
        const existing = this.liveBooks.get(book.assetId);
        if (existing) {
          existing.updated = book.timestamp;
        }

        if (this.running && !this.wsRequoteInFlight && book.buys.length > 0) {
          const newBestBid = parseFloat(book.buys[0].price);
          this.checkPriceChangeWall(book.assetId, newBestBid);
        }
      }
    });

    this.log('info', 'WS connected (real-time wall monitoring active)');
  }

  /**
   * Called instantly when our order gets filled via User WS channel.
   * Immediately places a sell order at the fill price — no 10s polling delay.
   */
  private async onUserTrade(trade: UserTrade) {
    if (!this.running || !this.profile) return;

    // Only care about BUY fills where we are MAKER (our LP order got hit)
    if (trade.side !== 'BUY' || trade.status !== 'MATCHED') return;

    const size = parseFloat(trade.size);
    const price = parseFloat(trade.price);
    if (size <= 0 || price <= 0) return;

    // Find the managed market
    let targetMm: ManagedMarket | null = null;
    let tokenIndex = -1;
    for (const [, mm] of this.managedMarkets) {
      const idx = mm.market.clobTokenIds.indexOf(trade.asset_id);
      if (idx >= 0) {
        targetMm = mm;
        tokenIndex = idx;
        break;
      }
    }

    const side = tokenIndex === 0 ? 'Yes' : tokenIndex === 1 ? 'No' : '?';
    const slug = targetMm?.market.slug ?? trade.market.slice(0, 20);

    this.log('reward', `WS FILL: ${slug} BUY ${side} @${price.toFixed(2)} x${size} (instant)`);

    // Immediately sell at fill price
    const sellPrice = roundPrice(price);
    if (sellPrice <= 0.01 || sellPrice >= 0.99) return;

    const doSell = async () => {
      await placeProfileOrder(this.profile!, {
        tokenId: trade.asset_id,
        side: 'SELL',
        price: sellPrice,
        size,
        postOnly: false,
      });
    };

    try {
      // Retry with delays: CLOB balance may not reflect new tokens immediately
      const delays = [0, 2000, 5000, 10000];
      let sold = false;
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt] > 0) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
        try {
          if (attempt > 0) {
            const client = getClientForProfile(this.profile!);
            await client.updateBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: trade.asset_id } as any);
          }
          await doSell();
          sold = true;
          break;
        } catch (err: any) {
          if (attempt < delays.length - 1 && /balance.*allowance|allowance/i.test(err.message)) {
            this.log('info', `WS SELL ${slug} ${side}: balance not ready, retry #${attempt + 1} in ${delays[attempt + 1] / 1000}s...`);
            continue;
          }
          throw err;
        }
      }
      if (!sold) return;
      this.log('trade', `WS SELL: ${slug} ${side} @${sellPrice.toFixed(2)} x${size} (instant)`);

      // Track cumulative hedged size per asset so checkFills skips already-hedged fills
      const prev = this.wsHedgedAssets.get(trade.asset_id) ?? 0;
      this.wsHedgedAssets.set(trade.asset_id, prev + size);

      // Update inventory if we know the market (net zero: buy then sell)
      if (targetMm && tokenIndex >= 0) {
        this.updateInventory(targetMm, tokenIndex, size);   // add from buy
        this.updateInventory(targetMm, tokenIndex, -size);  // remove from sell
      }

      // Mark LP order as WS-hedged so checkFills won't double-sell
      if (targetMm) {
        const lpOrder = targetMm.orders.find(
          (o) => o.purpose === 'lp' && o.tokenId === trade.asset_id,
        );
        if (lpOrder) {
          const prevHedged = (lpOrder as any)._wsHedgedSize ?? 0;
          (lpOrder as any)._wsHedgedSize = prevHedged + size;
        }
      }
    } catch (err: any) {
      this.log('error', `WS SELL failed ${slug} ${side}: ${err.message}`);
      // checkFills will retry on next cycle as fallback
    }

    // Blacklist this market — fills indicate volatility
    if (targetMm) {
      this.blacklistMarket(targetMm.market.conditionId, targetMm.market.slug);
    }
  }

  /** Debounce map for price_change → REST wall check (prevent spamming REST) */
  private priceCheckTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Called on price_change events. If best bid moved near our LP order,
   * fetch full orderbook via REST and run wall check.
   */
  private checkPriceChangeWall(assetId: string, newBestBid: number) {
    // Find managed market + check if we have LP orders on this side
    let targetMm: ManagedMarket | null = null;
    let tokenIndex = -1;
    for (const [, mm] of this.managedMarkets) {
      const idx = mm.market.clobTokenIds.indexOf(assetId);
      if (idx >= 0) { targetMm = mm; tokenIndex = idx; break; }
    }
    if (!targetMm || tokenIndex < 0) return;

    const lpOrders = targetMm.orders.filter((o) => o.purpose === 'lp' && o.tokenIndex === tokenIndex);
    if (lpOrders.length === 0) return;

    // Check if best bid is near or below our highest LP order (danger zone)
    const highestLpPrice = Math.max(...lpOrders.map((o) => o.price));
    const buffer = 0.03; // 3¢ buffer — trigger when best bid within 3¢ of our order
    if (newBestBid > highestLpPrice + buffer) return; // Still safe, wall intact

    // Debounce: 500ms per asset to avoid hammering REST
    const timerKey = `pc-${assetId}`;
    if (this.priceCheckTimers.has(timerKey)) return;

    this.priceCheckTimers.set(timerKey, setTimeout(async () => {
      this.priceCheckTimers.delete(timerKey);
      if (!this.running) return;

      try {
        const client = getReadClient();
        const book = await client.getOrderBook(assetId);
        const bids = (book.bids ?? [])
          .map((b: any) => ({ price: b.price, size: b.size }))
          .sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));

        // Update liveBooks with fresh depth
        this.liveBooks.set(assetId, { bids, asks: book.asks ?? [], updated: Date.now() });

        // Run wall check with full depth
        this.onWsBookUpdate(assetId, bids);
      } catch {
        // REST failed — skip this cycle
      }
    }, 500));
  }

  /**
   * Called on every WS book update. Checks if the wall protecting our LP order
   * has collapsed. If so, immediately cancels the LP order to avoid getting filled.
   */
  private onWsBookUpdate(assetId: string, bids: BookLevel[]) {
    // Find which managed market this asset belongs to
    let targetMm: ManagedMarket | null = null;
    let tokenIndex = -1;
    for (const [, mm] of this.managedMarkets) {
      const idx = mm.market.clobTokenIds.indexOf(assetId);
      if (idx >= 0) {
        targetMm = mm;
        tokenIndex = idx;
        break;
      }
    }
    if (!targetMm || tokenIndex < 0) return;

    // Check if we have LP orders on this side
    const lpOrders = targetMm.orders.filter((o) => o.purpose === 'lp' && o.tokenIndex === tokenIndex);
    if (lpOrders.length === 0) {
      // No orders on this side — check if a wall appeared so we can enter
      this.checkNewEntry(targetMm, tokenIndex, bids);
      return;
    }

    // Calculate wall above our highest LP order
    const highestLpPrice = Math.max(...lpOrders.map((o) => o.price));
    let wallAbove = 0;
    for (const bid of bids) {
      const bidPrice = parseFloat(bid.price);
      const bidSize = parseFloat(bid.size);
      if (bidPrice > highestLpPrice && bidSize > 0) {
        wallAbove += bidPrice * bidSize;
      }
    }

    const myOrderCost = lpOrders.reduce((s, o) => s + o.price * o.size, 0);
    const dangerThreshold = Math.max(this.config.minWallSize, myOrderCost * WALL_MULTIPLIER) * 0.5;
    if (wallAbove < dangerThreshold) {
      const timerKey = `${targetMm.market.id}-${tokenIndex}`;
      if (!this.wsUrgentTimers.has(timerKey)) {
        this.wsUrgentTimers.set(timerKey, setTimeout(async () => {
          this.wsUrgentTimers.delete(timerKey);
          if (!this.running || !this.profile) return;

          const side = tokenIndex === 0 ? 'Yes' : 'No';
          this.log('info', `WALL ALERT: ${targetMm!.market.slug} ${side} wall=$${wallAbove.toFixed(0)} < $${dangerThreshold.toFixed(0)} — pulling LP`);

          // Cancel LP orders on this side only
          const idsToCancel = targetMm!.orders
            .filter((o) => o.purpose === 'lp' && o.tokenIndex === tokenIndex && o.orderId !== 'unknown')
            .map((o) => o.orderId);

          if (idsToCancel.length > 0) {
            try {
              const { cancelProfileOrders } = await import('@/lib/bot/profile-client');
              await cancelProfileOrders(this.profile!, idsToCancel);
              targetMm!.orders = targetMm!.orders.filter(
                (o) => !(o.purpose === 'lp' && o.tokenIndex === tokenIndex),
              );
              this.log('trade', `PULLED ${idsToCancel.length} ${side} LP orders (wall collapsed)`);
            } catch (err: any) {
              this.log('error', `Pull ${side}: ${err.message}`);
            }
          }
        }, 300)); // 300ms debounce
      }
    } else {
      // Wall recovered — cancel any pending pull timer
      const timerKey = `${targetMm.market.id}-${tokenIndex}`;
      const timer = this.wsUrgentTimers.get(timerKey);
      if (timer) {
        clearTimeout(timer);
        this.wsUrgentTimers.delete(timerKey);
      }

      // Check if we can move closer to midpoint (better Q-score)
      this.checkBetterPlacement(targetMm, tokenIndex, bids);
    }
  }

  /**
   * No LP orders on this side — check if a wall just appeared so we can enter.
   */
  private checkNewEntry(mm: ManagedMarket, tokenIndex: number, bids: BookLevel[]) {
    const mid = tokenIndex === 0 ? mm.market.midpoint : 1 - mm.market.midpoint;
    const maxSpread = mm.market.rewardsMaxSpread;

    const parsedBids = bids
      .map((b) => ({ price: parseFloat(b.price), value: parseFloat(b.price) * parseFloat(b.size) }))
      .filter((b) => b.value > 0);

    const minPrice = roundPrice(mid - maxSpread / 100 + 0.01);
    for (let candidate = roundPrice(mid - 0.01); candidate >= minPrice; candidate = roundPrice(candidate - 0.01)) {
      if (candidate <= 0.01) break;
      const dist = (mid - candidate) * 100;
      if (dist > maxSpread * MAX_SPREAD_RATIO) continue;

      let wallAbove = 0;
      for (const bid of parsedBids) {
        if (bid.price > candidate) wallAbove += bid.value;
      }

      if (wallAbove >= this.config.minWallSize) {
        const timerKey = `entry-${mm.market.id}-${tokenIndex}`;
        if (this.wsUrgentTimers.has(timerKey)) return;

        const side = tokenIndex === 0 ? 'Yes' : 'No';
        this.wsUrgentTimers.set(timerKey, setTimeout(async () => {
          this.wsUrgentTimers.delete(timerKey);
          if (!this.running || !this.profile) return;

          this.log('info', `NEW WALL: ${mm.market.slug} ${side} wall=$${wallAbove.toFixed(0)} @${candidate.toFixed(2)} — entering`);
          try {
            this.wsRequoteInFlight = true;
            await this.requoteMarket(mm);
          } catch (err: any) {
            this.log('error', `New entry ${mm.market.slug}: ${err.message}`);
          } finally {
            this.wsRequoteInFlight = false;
          }
        }, 1000));
        return;
      }
    }
  }

  /**
   * Check if a better (closer to mid) wall-protected price is now available.
   * If so, trigger a requote for this side. Debounced to avoid excessive requotes.
   */
  private checkBetterPlacement(mm: ManagedMarket, tokenIndex: number, bids: BookLevel[]) {
    const lpOrders = mm.orders.filter((o) => o.purpose === 'lp' && o.tokenIndex === tokenIndex);
    if (lpOrders.length === 0) return;

    const currentBestPrice = Math.max(...lpOrders.map((o) => o.price));
    const mid = tokenIndex === 0 ? mm.market.midpoint : 1 - mm.market.midpoint;
    const maxSpread = mm.market.rewardsMaxSpread;

    // Parse bids
    const parsedBids = bids
      .map((b) => ({ price: parseFloat(b.price), value: parseFloat(b.price) * parseFloat(b.size) }))
      .filter((b) => b.value > 0)
      .sort((a, b) => b.price - a.price);

    // Find best wall-protected price (same logic as findWallPrice)
    const minPrice = roundPrice(mid - maxSpread / 100 + 0.01);
    let bestPrice = 0;

    for (let candidate = roundPrice(mid - 0.01); candidate >= minPrice; candidate = roundPrice(candidate - 0.01)) {
      if (candidate <= 0.01) break;
      let wallAbove = 0;
      for (const bid of parsedBids) {
        if (bid.price > candidate) wallAbove += bid.value;
      }
      if (wallAbove >= this.config.minWallSize) {
        bestPrice = candidate;
        break;
      }
    }

    if (bestPrice <= 0) return;

    // Only trigger if we can move at least 1¢ closer to mid
    const improvement = bestPrice - currentBestPrice;
    if (improvement < 0.01) return;

    const distImprovement = improvement * 100;
    const timerKey = `improve-${mm.market.id}-${tokenIndex}`;
    if (this.wsUrgentTimers.has(timerKey)) return; // Already scheduled

    this.wsUrgentTimers.set(timerKey, setTimeout(async () => {
      this.wsUrgentTimers.delete(timerKey);
      if (!this.running || !this.profile) return;

      const side = tokenIndex === 0 ? 'Yes' : 'No';
      this.log('info', `UPGRADE: ${mm.market.slug} ${side} can move ${currentBestPrice.toFixed(2)}→${bestPrice.toFixed(2)} (+${distImprovement.toFixed(1)}¢ closer)`);

      // Requote this market (will recalculate both sides)
      try {
        this.wsRequoteInFlight = true;
        await this.requoteMarket(mm);
      } catch (err: any) {
        this.log('error', `Upgrade requote ${mm.market.slug}: ${err.message}`);
      } finally {
        this.wsRequoteInFlight = false;
      }
    }, 1000)); // 1s debounce — don't thrash on rapid book updates
  }

  /** Subscribe new assets when markets are added */
  private subscribeNewAssets(tokenIds: string[]) {
    if (!this.ws) return;
    const newIds = tokenIds.filter((id) => !this.liveBooks.has(id));
    if (newIds.length > 0) {
      this.ws.subscribe(newIds);
    }
  }

  /** Get live orderbook for an asset, fallback to REST if WS not ready */
  private async getOrderBook(tokenId: string): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
    const live = this.liveBooks.get(tokenId);
    // Use WS data only if it has real depth (price_change events send size='0')
    if (live && (Date.now() - live.updated) < 60_000) {
      const realBids = live.bids.filter((b) => parseFloat(b.size) > 0);
      if (realBids.length >= 2) {
        const bids = [...live.bids].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
        const asks = [...live.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        return { bids, asks };
      }
    }
    // Fallback to REST for full depth — sort bids desc, asks asc
    try {
      const client = getReadClient();
      const book = await client.getOrderBook(tokenId);
      const bids = (book.bids ?? []).sort((a: BookLevel, b: BookLevel) => parseFloat(b.price) - parseFloat(a.price));
      const asks = (book.asks ?? []).sort((a: BookLevel, b: BookLevel) => parseFloat(a.price) - parseFloat(b.price));
      return { bids, asks };
    } catch {
      return { bids: [], asks: [] };
    }
  }

  // ── Sync Existing Orders ─────────────────────────────────

  private async syncExistingOrders() {
    if (!this.profile) return;

    let openOrders: any[];
    try {
      openOrders = await getProfileOpenOrders(this.profile);
    } catch (err: any) {
      this.log('error', `Sync failed: ${err.message}`);
      return;
    }

    if (openOrders.length === 0) {
      this.log('info', 'No existing open orders to sync');
      return;
    }

    this.log('info', `Syncing ${openOrders.length} existing open orders...`);

    const ordersByMarket = new Map<string, any[]>();
    for (const o of openOrders) {
      const market = o.market ?? o.condition_id ?? '';
      if (!market) continue;
      const list = ordersByMarket.get(market) ?? [];
      list.push(o);
      ordersByMarket.set(market, list);
    }

    let synced = 0;
    for (const [conditionId, orders] of ordersByMarket) {
      const mm = Array.from(this.managedMarkets.values()).find(
        (m) => m.market.conditionId === conditionId,
      );
      if (!mm) continue;

      for (const o of orders) {
        const tokenId = o.asset_id ?? '';
        const tokenIndex = mm.market.clobTokenIds.indexOf(tokenId);
        if (tokenIndex < 0) continue;

        const side = o.side as 'BUY' | 'SELL';
        const price = parseFloat(o.price ?? '0');
        const size = parseFloat(o.original_size ?? '0') - parseFloat(o.size_matched ?? '0');
        const orderId = o.id ?? 'unknown';
        if (size <= 0) continue;
        if (mm.orders.some((t) => t.orderId === orderId)) continue;

        mm.orders.push({
          orderId, tokenId, tokenIndex, side, price, size,
          originalSize: parseFloat(o.original_size ?? '0'),
          marketId: mm.market.id,
          purpose: side === 'BUY' ? 'lp' : 'hedge',
        });
        synced++;
      }
    }

    this.log('info', `Synced ${synced} orders across ${ordersByMarket.size} markets`);
  }

  // ── Sync Existing Positions ────────────────────────────

  /**
   * Query on-chain token balances for each managed market's clobTokenIds.
   * If we hold tokens, register them as inventory so spread skew + circuit breakers work.
   * Also place hedge (exit) orders for any un-hedged positions.
   */
  private async syncExistingPositions() {
    if (!this.profile) return;

    const proxyAddr = this.profile.funderAddress;
    if (!proxyAddr) {
      this.log('info', 'No funderAddress — skipping position sync');
      return;
    }

    // Fetch ALL positions from Data API
    let positions: any[];
    try {
      const res = await fetch(
        `https://data-api.polymarket.com/positions?user=${proxyAddr}&sizeThreshold=0&limit=500`,
        { cache: 'no-store' },
      );
      if (!res.ok) { this.log('error', `Data API ${res.status}`); return; }
      positions = await res.json();
      if (!Array.isArray(positions)) return;
    } catch (err: any) {
      this.log('error', `Position fetch failed: ${err.message}`);
      return;
    }

    const withBalance = positions.filter((p) => parseFloat(p.size ?? '0') > 0);
    if (withBalance.length === 0) {
      this.log('info', 'No existing positions to sync');
      return;
    }

    this.log('info', `Found ${withBalance.length} existing positions — selling at best bid`);

    for (const pos of withBalance) {
      const size = parseFloat(pos.size ?? '0');
      const tokenId = pos.asset ?? '';
      const title = (pos.title ?? '?').slice(0, 40);
      const outcome = pos.outcome ?? '?';
      if (size <= 0 || !tokenId) continue;

      // Get actual best bid from orderbook
      let bestBid = 0;
      try {
        const client = getReadClient();
        const book = await client.getOrderBook(tokenId);
        const bids = (book.bids ?? [])
          .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
          .filter((b: any) => b.size > 0)
          .sort((a: any, b: any) => b.price - a.price);
        if (bids.length > 0) bestBid = bids[0].price;
      } catch { /* use fallback */ }

      if (bestBid < 0.02) {
        this.log('info', `SYNC SKIP: ${title} ${outcome} x${size.toFixed(0)} — best bid $${bestBid.toFixed(2)} too low`);
        continue;
      }

      const sellPrice = roundPrice(bestBid);
      try {
        const result = await placeProfileOrder(this.profile, {
          tokenId,
          side: 'SELL',
          price: sellPrice,
          size,
          postOnly: false,
        });
        const received = parseFloat((result as any)?.takingAmount ?? '0');
        this.log('trade', `SYNC SELL: ${title} ${outcome} x${size.toFixed(0)} @${sellPrice.toFixed(2)} → $${received.toFixed(2)}`);
      } catch (err: any) {
        this.log('error', `Sync sell ${title}: ${err.message}`);
      }
    }
  }

  // ── Market Filtering (Research-based) ───────────────────

  /**
   * Filter markets based on research best practices:
   * 1. Skip markets resolving within 48 hours (adverse selection risk)
   * 2. Skip extreme probability markets (<10% or >90%)
   * 3. Prefer long-lived, stable markets
   */
  private filterMarkets(markets: RewardMarket[]): RewardMarket[] {
    const now = Date.now();
    return markets.filter((m) => {
      const endTime = new Date(m.endDate).getTime();
      const daysLeft = (endTime - now) / 86400000;

      // Skip markets resolving within 48h
      if (daysLeft < MIN_DAYS_TO_EXPIRY) return false;

      // Skip blacklisted markets (filled = volatile)
      if (this.blacklist.has(m.conditionId)) return false;

      // Skip extreme probability (high adverse selection risk)
      if (m.midpoint < MIN_MIDPOINT || m.midpoint > MAX_MIDPOINT) return false;

      // Skip low-liquidity markets (capital gets trapped, hard to exit)
      if (m.liquidity < MIN_LIQUIDITY) return false;

      // Skip markets with no reward rate (if min configured)
      if (this.config.minDailyRate > 0 && m.rewardsDailyRate < this.config.minDailyRate) return false;

      return true;
    });
  }

  // ── Dynamic Spread Calculation ──────────────────────────

  /**
   * Calculate spread based on:
   * 1. Base spreadPct config
   * 2. Time-to-expiry: widen as market approaches resolution
   * 3. Inventory skew: widen on overweight side
   */
  private getDynamicSpread(
    maxSpread: number,
    daysToExpiry: number,
    inventorySkew: number,
    tokenIndex: number,
  ): { spreadCents: number; reason: string } {
    let basePct = this.config.spreadPct;
    let reason = '';

    // 1. Time decay: widen spread as expiry approaches
    if (daysToExpiry < EXPIRY_WIDEN_DAYS) {
      // Linear ramp: 7 days → normal, 2 days → +20%
      const expiryMultiplier = 1 + 0.20 * (1 - (daysToExpiry - MIN_DAYS_TO_EXPIRY) / (EXPIRY_WIDEN_DAYS - MIN_DAYS_TO_EXPIRY));
      basePct = Math.min(95, basePct * expiryMultiplier);
      reason += `expiry(${daysToExpiry.toFixed(0)}d) `;
    }

    // 2. Inventory skew: widen the overweight side to discourage more fills
    //    If inventorySkew > 0 (long Yes), widen Yes bid (make it harder to buy more Yes)
    //    If inventorySkew < 0 (long No), widen No bid
    const absSkew = Math.abs(inventorySkew);
    if (absSkew > 0.1) {
      const skewWiden = absSkew * 15; // Max +15% at full skew
      const isOverweightSide = (inventorySkew > 0 && tokenIndex === 0) ||
                                (inventorySkew < 0 && tokenIndex === 1);
      if (isOverweightSide) {
        basePct = Math.min(95, basePct + skewWiden);
        reason += `skew(${(inventorySkew * 100).toFixed(0)}%) `;
      }
    }

    const raw = (basePct / 100) * maxSpread;
    // Floor: never go closer than minSpreadCents to midpoint
    const spreadCents = Math.max(this.config.minSpreadCents, Math.min(raw, maxSpread - 0.5));
    return { spreadCents, reason };
  }

  // ── Capital Allocation ──────────────────────────────────

  private calculateCapitalPerMarket(numMarkets: number): number {
    // Available = balance × (1 - cash reserve)
    const available = this.balance * (1 - CASH_RESERVE_PCT);
    // Per market cap: min of config and 15% of total balance
    const perMarketCap = Math.min(
      this.config.capitalPerMarket,
      this.balance * MAX_SINGLE_MARKET_PCT,
    );
    // Divided evenly, but capped
    return Math.min(
      perMarketCap,
      available / Math.max(1, numMarkets),
    );
  }

  // ── Core Logic ──────────────────────────────────────────

  private async scanAndAllocate(skipRequote = false) {
    if (!this.running || !this.profile) return;

    try {
      this.log('info', 'Scanning for reward markets...');
      const allMarkets = await scanRewardMarkets();

      // Apply research-based filters
      const filtered = this.filterMarkets(allMarkets);
      this.log('info', `Found ${allMarkets.length} reward markets → ${filtered.length} after filtering (skip <${MIN_DAYS_TO_EXPIRY}d, <${MIN_MIDPOINT * 100}%/${MAX_MIDPOINT * 100}%)`);

      this.lastScanTime = Date.now();

      try {
        this.balance = await getProfileBalance(this.profile);
      } catch { /* keep last */ }

      // Rank candidates: union of top by ROI + top by absolute reward rate
      // This ensures high-reward markets (sports) are included even if ROI is low
      const roiCandidates = rankMarketsByEfficiency(
        filtered,
        this.config.capitalPerMarket,
        this.config.maxMarkets * 2,
        this.config.spreadPct,
      );
      const roiIds = new Set(roiCandidates.map((r) => r.market.id));

      // Add top markets by daily rate that weren't in ROI list
      const byRate = [...filtered]
        .sort((a, b) => b.rewardsDailyRate - a.rewardsDailyRate)
        .slice(0, this.config.maxMarkets * 2);

      const rateCandidates = rankMarketsByEfficiency(
        byRate.filter((m) => !roiIds.has(m.id)),
        this.config.capitalPerMarket,
        this.config.maxMarkets,
        this.config.spreadPct,
      );

      const candidates = [...roiCandidates, ...rateCandidates];

      // Dynamic wall size: max(fixed minimum, 3x our order size per side)
      const capitalPerSide = this.balance * CAPITAL_PER_SIDE;
      const dynamicWallSize = Math.max(this.config.minWallSize, capitalPerSide * WALL_MULTIPLIER);

      this.log('info', `${candidates.length} candidates (${roiCandidates.length} ROI + ${rateCandidates.length} top rate) → walls ($${dynamicWallSize.toFixed(0)} = ${WALL_MULTIPLIER}x $${capitalPerSide.toFixed(0)})...`);

      // ── Wall check via REST (one-time per scan) ──
      const client = getReadClient();
      const wallChecked: RewardEfficiency[] = [];

      for (const eff of candidates) {
        if (wallChecked.length >= this.config.maxMarkets) break;

        // Check Yes side wall
        try {
          const yesBook = await client.getOrderBook(eff.market.clobTokenIds[0]);
          const yesWall = this.findWallPrice(
            yesBook.bids ?? [],
            eff.market.midpoint,
            eff.market.rewardsMaxSpread,
            dynamicWallSize,
          );

          // Tight-spread markets (<=2¢): skip wall check, use edge strategy instead
          const isTightSpread = this.config.allowTightSpread && eff.market.rewardsMaxSpread <= 2;
          if (!yesWall && !isTightSpread) continue;

          if (yesWall) {
            // Check distance from mid — skip if wall is in the outer low-Q zone
            const yesDistCents = (eff.market.midpoint - yesWall.price) * 100;
            const yesMaxDist = eff.market.rewardsMaxSpread * MAX_SPREAD_RATIO;
            if (yesDistCents > yesMaxDist && !isTightSpread) {
              this.log('info', `${eff.market.slug}: Yes wall too far (${yesDistCents.toFixed(1)}¢ > ${yesMaxDist.toFixed(1)}¢) — skipping`);
              continue;
            }
          }

          // Check No side too
          if (this.config.twoSided) {
            const noBook = await client.getOrderBook(eff.market.clobTokenIds[1]);
            const noMid = 1 - eff.market.midpoint;
            const noWall = this.findWallPrice(
              noBook.bids ?? [],
              noMid,
              eff.market.rewardsMaxSpread,
              dynamicWallSize,
            );
            if (!noWall && !isTightSpread) continue;

            if (noWall) {
              const noDistCents = (noMid - noWall.price) * 100;
              const noMaxDist = eff.market.rewardsMaxSpread * MAX_SPREAD_RATIO;
              if (noDistCents > noMaxDist && !isTightSpread) {
                this.log('info', `${eff.market.slug}: No wall too far (${noDistCents.toFixed(1)}¢ > ${noMaxDist.toFixed(1)}¢) — skipping`);
                continue;
              }
            }
          }

          if (isTightSpread) {
            this.log('info', `${eff.market.slug}: tight spread (${eff.market.rewardsMaxSpread}¢) — edge strategy`);
          }
          wallChecked.push(eff);
        } catch {
          continue;
        }
      }

      // ── Capital allocation: each market gets full balance ──
      // Limit orders don't lock balance on Polymarket CLOB,
      // so we can deploy the same capital across ALL markets simultaneously.
      const perMarketCap = this.balance * MAX_SINGLE_MARKET_PCT;
      for (const eff of wallChecked) {
        (eff as any)._allocatedCapital = perMarketCap;
      }

      this.log('info', `${wallChecked.length} markets passed wall check | $${perMarketCap.toFixed(0)} per market (balance=$${this.balance.toFixed(0)})`);

      // Remove markets no longer in top list (keep if has positions)
      const selectedIds = new Set(wallChecked.map((r) => r.market.id));
      for (const [id, mm] of this.managedMarkets) {
        if (!selectedIds.has(id) && mm.positions.length === 0) {
          const daysLeft = (new Date(mm.market.endDate).getTime() - Date.now()) / 86400000;
          if (daysLeft < MIN_DAYS_TO_EXPIRY || !selectedIds.has(id)) {
            this.log('info', `Removing ${mm.market.slug}${daysLeft < MIN_DAYS_TO_EXPIRY ? ' (expiring)' : ' (not optimal)'}`);
            await this.cancelMarketOrders(id);
            // Unsubscribe WS
            if (this.ws) this.ws.unsubscribe(mm.market.clobTokenIds);
            if (this.userWs) this.userWs.unsubscribe([mm.market.conditionId]);
            this.managedMarkets.delete(id);
          }
        }
      }

      // Also check existing markets for expiry
      for (const [, mm] of this.managedMarkets) {
        const daysLeft = (new Date(mm.market.endDate).getTime() - Date.now()) / 86400000;
        if (daysLeft < MIN_DAYS_TO_EXPIRY) {
          this.log('reward', `EXPIRY EXIT: ${mm.market.slug} (${daysLeft.toFixed(1)}d left) — cancelling LP orders`);
          await this.cancelLpOrders(mm);
        }
      }

      // Add/update markets that passed wall check
      for (const eff of wallChecked) {
        if (!this.running) break;
        const alloc = (eff as any)._allocatedCapital ?? perMarketCap;

        const existing = this.managedMarkets.get(eff.market.id);
        if (existing) {
          existing.market = eff.market;
          existing.efficiency = eff;
          existing.allocatedCapital = alloc;
        } else {
          this.managedMarkets.set(eff.market.id, {
            market: eff.market,
            efficiency: eff,
            orders: [],
            positions: [],
            lastUpdate: 0,
            allocatedCapital: alloc,
            inventoryYes: 0,
            inventoryNo: 0,
          });
          // Subscribe to orderbook WS + user WS for this market
          this.subscribeNewAssets(eff.market.clobTokenIds);
          if (this.userWs) this.userWs.subscribe([eff.market.conditionId]);
          const daysLeft = (new Date(eff.market.endDate).getTime() - Date.now()) / 86400000;
          const comp = eff.market.competitiveness > 0 ? eff.market.competitiveness.toFixed(0) : '?';
          this.log('reward', `+${eff.market.question.slice(0, 40)} | $${eff.market.rewardsDailyRate.toFixed(0)}/day | comp=${comp} | $${alloc.toFixed(0)} | ${daysLeft.toFixed(0)}d`);
        }
      }

      if (!skipRequote) await this.requoteAll();

      // Sweep orphan positions: sell any tokens still held (failed sells from previous cycles)
      await this.sweepOrphanPositions();
    } catch (err: any) {
      this.log('error', `Scan failed: ${err.message}`);
    }
  }

  /**
   * Sweep orphan positions: fetch real positions from Data API and sell
   * any that weren't already sold by the hedge flow.
   */
  private async sweepOrphanPositions() {
    if (!this.profile?.funderAddress) return;

    let positions: any[];
    try {
      const res = await fetch(
        `https://data-api.polymarket.com/positions?user=${this.profile.funderAddress}&sizeThreshold=0&limit=500`,
        { cache: 'no-store' },
      );
      if (!res.ok) return;
      positions = await res.json();
      if (!Array.isArray(positions)) return;
    } catch { return; }

    const sellable = positions.filter((p) => {
      const size = parseFloat(p.size ?? '0');
      return size > 0.5 && !p.redeemable; // Skip dust and redeemable
    });

    if (sellable.length === 0) return;

    this.log('info', `Sweep: found ${sellable.length} orphan position(s) to sell`);
    const client = getReadClient();

    for (const pos of sellable) {
      const size = parseFloat(pos.size);
      const tokenId = pos.asset;
      const title = (pos.title ?? '?').slice(0, 40);
      const outcome = pos.outcome ?? '?';

      try {
        const book = await client.getOrderBook(tokenId);
        const bids = (book.bids ?? [])
          .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
          .filter((b: any) => b.size > 0)
          .sort((a: any, b: any) => b.price - a.price);

        if (bids.length === 0 || bids[0].price < 0.02) {
          this.log('info', `Sweep skip: ${title} ${outcome} — no bids`);
          continue;
        }

        const sellPrice = roundPrice(bids[0].price);

        // Ensure allowance for this specific token
        const profileClient = getClientForProfile(this.profile);
        await profileClient.updateBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId } as any);

        const result = await placeProfileOrder(this.profile, {
          tokenId,
          side: 'SELL',
          price: sellPrice,
          size,
          postOnly: false,
        });
        const received = parseFloat((result as any)?.takingAmount ?? '0');
        this.log('trade', `SWEEP SELL: ${title} ${outcome} x${size.toFixed(0)} @${sellPrice.toFixed(2)} → $${received.toFixed(2)}`);
      } catch (err: any) {
        this.log('error', `Sweep sell ${title}: ${err.message}`);
      }
    }
  }

  /**
   * Tight-spread markets (<=2¢): cancel and re-place orders every 1 min.
   * Always place at maxSpread edge to avoid fills while still earning Q-score.
   * The cancel+re-place ensures our orders stay at the back of the queue.
   */
  private async requoteTightMarkets() {
    if (!this.running || !this.profile) return;

    for (const [, mm] of this.managedMarkets) {
      if (!this.running) break;
      if (mm.market.rewardsMaxSpread > 2) continue; // Only tight-spread

      const lpOrders = mm.orders.filter((o) => o.purpose === 'lp');
      if (lpOrders.length === 0) continue;

      // Cancel all LP orders
      await this.cancelLpOrders(mm);

      // Re-place at edge
      try {
        await this.requoteMarket(mm);
        this.log('info', `TIGHT REFRESH: ${mm.market.slug} (${mm.market.rewardsMaxSpread}¢ spread)`);
      } catch (err: any) {
        this.log('error', `Tight refresh ${mm.market.slug}: ${err.message}`);
      }
    }
  }

  private async requoteAll() {
    if (!this.running || !this.profile) return;

    // Refresh balance
    try {
      this.balance = await getProfileBalance(this.profile);
    } catch { /* keep last */ }

    // Update allocated capital for all markets (balance may have changed)
    const perMarketCap = this.balance * MAX_SINGLE_MARKET_PCT;
    for (const [, mm] of this.managedMarkets) {
      mm.allocatedCapital = perMarketCap;
    }

    for (const [, mm] of this.managedMarkets) {
      if (!this.running) break;

      try {
        await this.requoteMarket(mm);
      } catch (err: any) {
        this.log('error', `Requote ${mm.market.slug}: ${err.message}`);
      }
    }
  }

  // ── Orderbook Wall Detection ────────────────────────────

  /**
   * Find the best price to place our order: as CLOSE to midpoint as possible
   * while still having sufficient wall protection in front of us.
   *
   * Scans from midpoint downward, 1¢ at a time. At each candidate price,
   * counts the $ of bids above us (= wall). Places at the first price
   * where wall >= minWall.
   *
   * This maximizes Q-score (quadratic: closer to mid = exponentially more reward)
   * while staying safe behind other orders.
   *
   * @returns placement price + wall info, or null if no safe price exists
   */
  private findWallPrice(
    bids: Array<{ price: string; size: string }>,
    midpoint: number,
    maxSpreadCents: number,
    minWall: number,
  ): { price: number; wallSize: number; wallPrice: number } | null {
    if (!bids || bids.length === 0) return null;

    const maxDistance = maxSpreadCents / 100;
    const minPrice = roundPrice(midpoint - maxDistance + 0.01);
    if (minPrice <= 0.01) return null;

    // Parse and sort bids by price descending
    const parsedBids = bids
      .map((b) => ({ price: parseFloat(b.price), value: parseFloat(b.price) * parseFloat(b.size) }))
      .filter((b) => b.value > 0)
      .sort((a, b) => b.price - a.price);

    // Scan from 1¢ below midpoint down to reward zone edge
    // Find the closest-to-mid price that has enough wall above it
    const startPrice = Math.max(roundPrice(midpoint - 0.01), minPrice);

    for (let candidate = startPrice; candidate >= minPrice; candidate = roundPrice(candidate - 0.01)) {
      if (candidate <= 0.01) break;

      // Sum bids strictly above our candidate price = our wall
      let wallAbove = 0;
      let highestWallPrice = 0;
      for (const bid of parsedBids) {
        if (bid.price > candidate) {
          wallAbove += bid.value;
          if (bid.price > highestWallPrice) highestWallPrice = bid.price;
        }
      }

      if (wallAbove >= minWall) {
        return { price: candidate, wallSize: wallAbove, wallPrice: highestWallPrice };
      }
    }

    // No price with sufficient wall protection
    return null;
  }

  private async requoteMarket(mm: ManagedMarket) {
    if (!this.profile) return;

    const market = mm.market;
    const daysToExpiry = (new Date(market.endDate).getTime() - Date.now()) / 86400000;

    // Don't place new LP orders on expiring markets
    if (daysToExpiry < MIN_DAYS_TO_EXPIRY) return;

    // Check inventory — pull LP quotes if too much exposure
    const totalInventory = mm.inventoryYes + mm.inventoryNo;
    const inventoryRatio = mm.allocatedCapital > 0 ? totalInventory / mm.allocatedCapital : 0;
    if (inventoryRatio > INVENTORY_MAX_PCT) {
      this.log('info', `${market.slug}: inventory ${(inventoryRatio * 100).toFixed(0)}% > ${(INVENTORY_MAX_PCT * 100).toFixed(0)}% cap — pulling LP quotes`);
      await this.cancelLpOrders(mm);
      return;
    }

    const maxSpread = market.rewardsMaxSpread;

    // Fetch orderbooks (WS real-time with REST fallback)
    const yesBook = await this.getOrderBook(market.clobTokenIds[0]);
    const noBook = this.config.twoSided
      ? await this.getOrderBook(market.clobTokenIds[1])
      : { bids: [], asks: [] };

    // Live midpoint from Yes book
    let liveMid = market.midpoint;
    if (yesBook.bids?.length && yesBook.asks?.length) {
      const bestBid = Math.max(...yesBook.bids.map((b) => parseFloat(b.price)));
      const bestAsk = Math.min(...yesBook.asks.map((a) => parseFloat(a.price)));
      if (bestBid > 0 && bestAsk > bestBid) {
        liveMid = (bestBid + bestAsk) / 2;
      }
    }

    // Skip extreme midpoints
    if (liveMid < MIN_MIDPOINT || liveMid > MAX_MIDPOINT) return;

    // Skip markets where maxSpread is too small
    if (maxSpread <= this.config.minSpreadCents) return;

    const noMid = 1 - liveMid;

    // ── Wall Detection: find safe price behind thick orderbook wall ──

    const isTightSpread = this.config.allowTightSpread && market.rewardsMaxSpread <= 2;
    const reqWallSize = Math.max(this.config.minWallSize, (this.balance * CAPITAL_PER_SIDE) * WALL_MULTIPLIER);
    const yesWall = this.findWallPrice(yesBook.bids, liveMid, maxSpread, reqWallSize);
    const noWall = this.config.twoSided
      ? this.findWallPrice(noBook.bids, noMid, maxSpread, reqWallSize)
      : null;

    // #1: No wall = no order, unless tight-spread market (edge strategy)
    if (!yesWall && !isTightSpread) {
      this.log('info', `${market.slug}: no Yes wall — skipping`);
      await this.cancelLpOrders(mm);
      return;
    }
    if (this.config.twoSided && !noWall && !isTightSpread) {
      this.log('info', `${market.slug}: no No wall — skipping`);
      await this.cancelLpOrders(mm);
      return;
    }

    // For tight-spread markets: place at maxSpread edge (furthest from mid but still in reward zone)
    // This minimizes fill risk while still earning rewards
    const yesBidPrice = isTightSpread
      ? roundPrice(liveMid - maxSpread / 100 + 0.01)  // edge of reward zone
      : yesWall!.price;
    const noBidPrice = isTightSpread
      ? roundPrice(noMid - maxSpread / 100 + 0.01)
      : noWall?.price ?? 0;

    // Validate within reward zone
    const yesDistCents = (liveMid - yesBidPrice) * 100;
    const noDistCents = (noMid - noBidPrice) * 100;
    if (yesDistCents > maxSpread || yesDistCents < 0) return;

    // ── Single order at closest wall-protected price ──
    // No ladder needed — fills are immediately market-sold.
    // Maximize Q-score by placing at the closest possible price to mid.
    const minSize = Math.max(market.rewardsMinSize || 1, 1);
    const capitalPerSide = this.balance * CAPITAL_PER_SIDE;
    const yesSize = Math.max(minSize, Math.floor(capitalPerSide / yesBidPrice));
    const noSize = noBidPrice > 0 ? Math.max(minSize, Math.floor(capitalPerSide / noBidPrice)) : 0;

    // Only requote if price changed meaningfully
    const lpOrders = mm.orders.filter((o) => o.purpose === 'lp');
    const needsRequote = lpOrders.length === 0 ||
      lpOrders.some((o) => {
        const expected = o.tokenIndex === 0 ? yesBidPrice : noBidPrice;
        return Math.abs(o.price - expected) > 0.005;
      });

    if (!needsRequote) return;

    await this.cancelLpOrders(mm);

    const newOrders: ActiveOrder[] = [...mm.orders]; // Keep hedge orders

    // BUY Yes — at closest wall-protected price
    if (yesBidPrice > 0.01 && yesBidPrice < 0.99) {
      try {
        const result = await placeProfileOrder(this.profile, {
          tokenId: market.clobTokenIds[0],
          side: 'BUY',
          price: yesBidPrice,
          size: yesSize,
          postOnly: true,
        });
        const orderId = (result as any)?.orderID ?? (result as any)?.id ?? 'unknown';
        newOrders.push({
          orderId, tokenId: market.clobTokenIds[0], tokenIndex: 0,
          side: 'BUY', price: yesBidPrice, size: yesSize,
          originalSize: yesSize, marketId: market.id, purpose: 'lp',
        });
        this.log('trade', `${market.slug} BUY Yes @${yesBidPrice.toFixed(2)} x${yesSize} ($${(yesBidPrice * yesSize).toFixed(0)}) (${yesDistCents.toFixed(1)}¢) [wall=$${yesWall?.wallSize.toFixed(0) ?? '?'}]`);
      } catch (err: any) {
        this.log('error', `${market.slug} BUY Yes: ${err.message}`);
      }
    }

    // BUY No — at closest wall-protected price
    if (this.config.twoSided && noBidPrice > 0.01 && noBidPrice < 0.99 && noDistCents <= maxSpread) {
      try {
        const result = await placeProfileOrder(this.profile, {
          tokenId: market.clobTokenIds[1],
          side: 'BUY',
          price: noBidPrice,
          size: noSize,
          postOnly: true,
        });
        const orderId = (result as any)?.orderID ?? (result as any)?.id ?? 'unknown';
        newOrders.push({
          orderId, tokenId: market.clobTokenIds[1], tokenIndex: 1,
          side: 'BUY', price: noBidPrice, size: noSize,
          originalSize: noSize, marketId: market.id, purpose: 'lp',
        });
        this.log('trade', `${market.slug} BUY No @${noBidPrice.toFixed(2)} x${noSize} ($${(noBidPrice * noSize).toFixed(0)}) (${noDistCents.toFixed(1)}¢) [wall=$${noWall!.wallSize.toFixed(0)}]`);
      } catch (err: any) {
        this.log('error', `${market.slug} BUY No: ${err.message}`);
      }
    }

    mm.orders = newOrders;
    mm.lastUpdate = Date.now();

    // Recalculate Q score
    const lpOrdersForScore: LpOrder[] = newOrders
      .filter((o) => o.purpose === 'lp')
      .map((o) => ({ side: o.side, price: o.price, size: o.size, tokenIndex: o.tokenIndex }));
    mm.efficiency.qScore = calculateQScore({ ...market, midpoint: liveMid }, lpOrdersForScore);
  }

  // ── Fill Detection & Hedging ────────────────────────────

  private async checkFills() {
    if (!this.running || !this.profile) return;

    let openOrders: any[];
    try {
      openOrders = await getProfileOpenOrders(this.profile);
    } catch { return; }

    const openOrderIds = new Set(openOrders.map((o: any) => o.id));

    for (const [, mm] of this.managedMarkets) {
      const filledOrders: ActiveOrder[] = [];
      const stillActive: ActiveOrder[] = [];

      for (const order of mm.orders) {
        if (order.orderId === 'unknown') {
          stillActive.push(order);
          continue;
        }

        if (openOrderIds.has(order.orderId)) {
          // Check for partial fill — only sell the NEW portion not already hedged by WS
          if (order.purpose === 'lp') {
            const openOrder = openOrders.find((o: any) => o.id === order.orderId);
            if (openOrder) {
              const sizeMatched = parseFloat(openOrder.size_matched ?? '0');
              const alreadyHedged = (order as any)._hedgedSize ?? 0;
              const wsHedged = (order as any)._wsHedgedSize ?? 0;
              const totalHedged = Math.max(alreadyHedged, wsHedged);
              const newFill = sizeMatched - totalHedged;
              if (newFill > 0.5) { // Min 0.5 shares to avoid dust
                this.log('reward', `PARTIAL: ${mm.market.slug} ${order.tokenIndex === 0 ? 'Yes' : 'No'} @${order.price} filled ${newFill.toFixed(1)} (total ${sizeMatched.toFixed(1)}, wsHedged ${wsHedged.toFixed(1)})`);
                this.updateInventory(mm, order.tokenIndex, newFill);
                await this.placeHedge(mm, order, newFill);
                (order as any)._hedgedSize = sizeMatched; // Track what we've hedged
              }
            }
          }
          stillActive.push(order);
        } else if (order.purpose === 'lp') {
          // LP order gone from open list — could be filled OR cancelled
          // Check actual token balance to confirm it was filled
          const wsHedged = (order as any)._wsHedgedSize ?? 0;
          let actualFilled = wsHedged; // WS already confirmed this amount
          if (wsHedged < order.originalSize) {
            // Check real token balance to verify fill
            try {
              const tokenBalance = await getProfileTokenBalance(this.profile!, order.tokenId);
              if (tokenBalance > 0.5) {
                actualFilled = Math.max(wsHedged, tokenBalance);
              }
            } catch { /* assume cancelled if can't check */ }
          }
          const remaining = actualFilled - wsHedged;
          if (remaining > 0.5) {
            filledOrders.push({ ...order, originalSize: remaining });
          } else if (wsHedged > 0.5) {
            // Already fully hedged by WS, just clean up
            this.log('info', `${mm.market.slug} ${order.tokenIndex === 0 ? 'Yes' : 'No'} already hedged by WS (${wsHedged.toFixed(1)}), skipping`);
          } else {
            // No fill detected — order was cancelled (wall collapse, requote, etc.)
            this.log('info', `${mm.market.slug} ${order.tokenIndex === 0 ? 'Yes' : 'No'} order gone — cancelled (no fill detected)`);
          }
        }
        // Hedge orders that disappear = position exited
      }

      for (const filled of filledOrders) {
        this.log('reward', `FILLED: ${mm.market.slug} BUY ${filled.tokenIndex === 0 ? 'Yes' : 'No'} @${filled.price.toFixed(2)} x${filled.originalSize}`);
        this.updateInventory(mm, filled.tokenIndex, filled.originalSize);
        await this.placeHedge(mm, filled, filled.originalSize);
        // Blacklist this market — fills indicate volatility
        this.blacklistMarket(mm.market.conditionId, mm.market.slug);
      }

      mm.orders = stillActive;

      // Clean up exited positions
      mm.positions = mm.positions.filter((pos) => {
        if (!pos.hedgeOrderId) return true;
        if (openOrderIds.has(pos.hedgeOrderId)) return true;
        const pnl = (pos.hedgePrice - pos.fillPrice) * pos.size;
        this.log('reward', `HEDGE EXIT: ${mm.market.slug} ${pos.tokenIndex === 0 ? 'Yes' : 'No'} entry=${pos.fillPrice.toFixed(2)} exit=${pos.hedgePrice.toFixed(2)} pnl=$${pnl.toFixed(2)}`);
        // Reduce inventory
        this.updateInventory(mm, pos.tokenIndex, -pos.size);
        return false;
      });

      // Force market-sell stale hedges that haven't filled within timeout
      await this.forceExitStaleHedges(mm, openOrderIds);

      // Clean up wsHedgedAssets for this market's tokens (orders are gone)
      for (const tokenId of mm.market.clobTokenIds) {
        this.wsHedgedAssets.delete(tokenId);
      }
    }

    // Retry pending sells (failed hedges from previous cycles)
    await this.retryPendingSells();
  }

  private async retryPendingSells() {
    if (!this.profile || this.pendingSells.length === 0) return;

    const remaining: typeof this.pendingSells = [];

    for (const ps of this.pendingSells) {
      // Give up after 5 minutes
      if (Date.now() - ps.addedAt > 5 * 60 * 1000) {
        this.log('error', `Pending sell expired: ${ps.marketSlug} ${ps.side} x${ps.size} — will be caught by sweep`);
        continue;
      }

      try {
        // Refresh allowance before retry
        const client = getClientForProfile(this.profile);
        await client.updateBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: ps.tokenId } as any);

        // Get best bid
        const readClient = getReadClient();
        const book = await readClient.getOrderBook(ps.tokenId);
        const bids = (book.bids ?? [])
          .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
          .filter((b: any) => b.size > 0)
          .sort((a: any, b: any) => b.price - a.price);

        const sellPrice = bids.length > 0 ? roundPrice(bids[0].price) : roundPrice(ps.fillPrice);
        if (sellPrice < 0.02) { remaining.push(ps); continue; }

        const result = await placeProfileOrder(this.profile, {
          tokenId: ps.tokenId,
          side: 'SELL',
          price: sellPrice,
          size: ps.size,
          postOnly: false,
        });
        const received = parseFloat((result as any)?.takingAmount ?? '0');
        this.log('trade', `PENDING SELL OK: ${ps.marketSlug} ${ps.side} x${ps.size} @${sellPrice.toFixed(2)} → $${received.toFixed(2)} (waited ${((Date.now() - ps.addedAt) / 1000).toFixed(0)}s)`);
      } catch (err: any) {
        this.log('error', `Pending sell retry ${ps.marketSlug} ${ps.side}: ${err.message}`);
        remaining.push(ps);
      }
    }

    this.pendingSells = remaining;
  }

  /**
   * If a post-only hedge hasn't filled within HEDGE_TIMEOUT_MS,
   * cancel it and market-sell at fillPrice - 1¢ to free up capital.
   */
  private async forceExitStaleHedges(mm: ManagedMarket, openOrderIds: Set<string>) {
    if (!this.profile) return;
    const { cancelProfileOrders } = await import('@/lib/bot/profile-client');

    const stale = mm.positions.filter(
      (pos) => pos.hedgeOrderId &&
        openOrderIds.has(pos.hedgeOrderId) &&
        Date.now() - pos.timestamp > HEDGE_TIMEOUT_MS,
    );

    for (const pos of stale) {
      const side = pos.tokenIndex === 0 ? 'Yes' : 'No';
      try {
        // Cancel the stale post-only hedge
        await cancelProfileOrders(this.profile, [pos.hedgeOrderId!]);
        mm.orders = mm.orders.filter((o) => o.orderId !== pos.hedgeOrderId);

        // Market sell: use taker order at fillPrice - 1¢ for immediate exit
        const exitPrice = roundPrice(pos.fillPrice - 0.01);
        if (exitPrice <= 0.01) continue;

        await placeProfileOrder(this.profile, {
          tokenId: pos.tokenId,
          side: 'SELL',
          price: exitPrice,
          size: pos.size,
          postOnly: false,
        });

        const loss = (pos.fillPrice - exitPrice) * pos.size;
        this.log('trade', `FORCE EXIT: ${mm.market.slug} SELL ${side} @${exitPrice.toFixed(2)} x${pos.size} (hedge stale ${((Date.now() - pos.timestamp) / 1000).toFixed(0)}s, loss=$${loss.toFixed(2)})`);

        this.updateInventory(mm, pos.tokenIndex, -pos.size);
        mm.positions = mm.positions.filter((p) => p !== pos);
      } catch (err: any) {
        this.log('error', `Force exit ${mm.market.slug} ${side}: ${err.message}`);
      }
    }
  }

  private async blacklistMarket(conditionId: string, slug: string) {
    if (this.blacklist.has(conditionId)) return;

    // Dedupe: YES+NO fills in the same cycle count as 1 round (60s window)
    const ROUND_WINDOW_MS = 60_000;
    const existing = this.fillRounds.get(conditionId) ?? { count: 0, lastRoundAt: 0 };
    const now = Date.now();

    if (now - existing.lastRoundAt > ROUND_WINDOW_MS) {
      // New round
      existing.count += 1;
      existing.lastRoundAt = now;
      this.fillRounds.set(conditionId, existing);
    }
    // else: same round (within 60s) — don't increment

    if (existing.count < 1) {
      this.log('info', `FILL ROUND #${existing.count}: ${slug} — ${1 - existing.count} more round(s) to blacklist`);
      return;
    }

    this.blacklist.add(conditionId);
    this.log('info', `BLACKLIST: ${slug} (${existing.count} fill rounds — volatile market)`);

    // Cancel LP orders for this market and remove from managed
    const mm = [...this.managedMarkets.values()].find((m) => m.market.conditionId === conditionId);
    if (mm) {
      await this.cancelMarketOrders(mm.market.id);
      if (this.ws) this.ws.unsubscribe(mm.market.clobTokenIds);
      if (this.userWs) this.userWs.unsubscribe([mm.market.conditionId]);
      this.managedMarkets.delete(mm.market.id);
    }

    // Persist to DB
    try {
      await prisma.lpBlacklist.upsert({
        where: { conditionId },
        create: { conditionId, slug, reason: `filled_${existing.count}x` },
        update: { reason: `filled_${existing.count}x` },
      });
    } catch (err: any) {
      this.log('error', `Blacklist DB write: ${err.message}`);
    }
  }

  private updateInventory(mm: ManagedMarket, tokenIndex: number, delta: number) {
    if (tokenIndex === 0) mm.inventoryYes += delta;
    else mm.inventoryNo += delta;
  }

  private async placeHedge(mm: ManagedMarket, filled: ActiveOrder, filledSize: number) {
    if (!this.profile) return;

    const side = filled.tokenIndex === 0 ? 'Yes' : 'No';

    // Immediate market sell — sell at exact fillPrice
    const sellPrice = roundPrice(filled.price);
    if (sellPrice <= 0.01 || sellPrice >= 0.99) return;

    // Retry with delays: CLOB balance may not reflect new tokens immediately after fill
    const delays = [0, 2000, 5000, 10000]; // instant, 1s, 3s
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
      try {
        if (attempt > 0) {
          // Refresh allowance on retries
          const client = getClientForProfile(this.profile);
          await client.updateBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: filled.tokenId } as any);
        }
        await placeProfileOrder(this.profile, {
          tokenId: filled.tokenId,
          side: 'SELL',
          price: sellPrice,
          size: filledSize,
          postOnly: false,
        });

        this.log('trade', `SELL NOW: ${mm.market.slug} ${side} @${sellPrice.toFixed(2)} x${filledSize} (filled @${filled.price.toFixed(2)})${attempt > 0 ? ` [retry #${attempt}]` : ''}`);
        this.updateInventory(mm, filled.tokenIndex, -filledSize);
        return; // Success — exit
      } catch (err: any) {
        if (attempt < delays.length - 1 && /balance.*allowance|allowance/i.test(err.message)) {
          this.log('info', `Sell ${mm.market.slug} ${side}: balance not ready, retry #${attempt + 1} in ${delays[attempt + 1] / 1000}s...`);
          continue;
        }
        // Final attempt failed — fall through to post-only fallback
        this.log('error', `Instant sell failed ${mm.market.slug} ${side} (${attempt + 1} attempts): ${err.message} — trying post-only`);
      }
    }

    // Post-only fallback at +1¢
    const hedgePrice = roundPrice(filled.price + this.config.hedgeOffsetCents / 100);
    try {
      const result = await placeProfileOrder(this.profile, {
        tokenId: filled.tokenId,
        side: 'SELL',
        price: hedgePrice,
        size: filledSize,
        postOnly: true,
      });
      const hedgeOrderId = (result as any)?.orderID ?? (result as any)?.id ?? 'unknown';

      mm.positions.push({
        tokenId: filled.tokenId,
        tokenIndex: filled.tokenIndex,
        fillPrice: filled.price,
        size: filledSize,
        marketId: filled.marketId,
        hedgeOrderId,
        hedgePrice,
        timestamp: Date.now(),
      });
      mm.orders.push({
        orderId: hedgeOrderId, tokenId: filled.tokenId, tokenIndex: filled.tokenIndex,
        side: 'SELL', price: hedgePrice, size: filledSize,
        originalSize: filledSize, marketId: filled.marketId, purpose: 'hedge',
      });
      this.log('trade', `HEDGE FALLBACK: ${mm.market.slug} ${side} @${hedgePrice.toFixed(2)} x${filledSize}`);
    } catch (err2: any) {
      this.log('error', `Hedge fallback also failed ${mm.market.slug}: ${err2.message}`);
      // Add to pending sells queue — will be retried every checkFills cycle
      this.pendingSells.push({
        tokenId: filled.tokenId,
        size: filledSize,
        fillPrice: filled.price,
        marketSlug: mm.market.slug,
        side,
        addedAt: Date.now(),
      });
      this.log('info', `Added to pending sells: ${mm.market.slug} ${side} x${filledSize}`);
    }
  }

  // ── Order Management ────────────────────────────────────

  private async cancelLpOrders(mm: ManagedMarket) {
    if (!this.profile) return;
    const lpOrderIds = mm.orders
      .filter((o) => o.purpose === 'lp' && o.orderId !== 'unknown')
      .map((o) => o.orderId);

    if (lpOrderIds.length > 0) {
      try {
        const { cancelProfileOrders } = await import('@/lib/bot/profile-client');
        await cancelProfileOrders(this.profile, lpOrderIds);
      } catch (err: any) {
        this.log('error', `Cancel LP orders: ${err.message}`);
      }
    }
    mm.orders = mm.orders.filter((o) => o.purpose === 'hedge');
  }

  private async cancelMarketOrders(marketId: string) {
    const mm = this.managedMarkets.get(marketId);
    if (!mm || !this.profile || mm.orders.length === 0) return;

    try {
      const orderIds = mm.orders.map((o) => o.orderId).filter((id) => id !== 'unknown');
      if (orderIds.length > 0) {
        const { cancelProfileOrders } = await import('@/lib/bot/profile-client');
        await cancelProfileOrders(this.profile, orderIds);
      }
    } catch (err: any) {
      this.log('error', `Cancel orders for ${marketId}: ${err.message}`);
    }
    mm.orders = [];
  }

  private log(type: LpLogLine['type'], text: string) {
    const ts = Date.now();
    const time = new Date(ts).toISOString().slice(11, 19);
    const formatted = `[${time}] ${text}`;
    this.logs.push({ text: formatted, type, timestamp: ts });
    if (this.logs.length > MAX_LOGS) this.logs = this.logs.slice(-MAX_LOGS);
    const tag = type.toUpperCase().padEnd(6);
    appendLog(`${new Date(ts).toISOString()} [${tag}] ${text}`);
  }
}

// ── Singleton ──────────────────────────────────────────────

let engine: LpRewardsEngine | null = null;

export function getLpEngine(): LpRewardsEngine {
  if (!engine) engine = new LpRewardsEngine();
  return engine;
}

function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

// ── Exported Wall Check (used by scan API) ─────────────

export interface WallCheckResult {
  price: number;
  wallSize: number;
  wallPrice: number;
}

/**
 * Standalone wall check for use outside the engine (e.g. scan API).
 * Same logic as engine's findWallPrice: scan from midpoint downward,
 * find the closest-to-mid price with sufficient wall protection.
 */
export function checkWall(
  bids: Array<{ price: string; size: string }>,
  midpoint: number,
  maxSpreadCents: number,
  minWall: number,
): WallCheckResult | null {
  if (!bids || bids.length === 0) return null;

  const maxDistance = maxSpreadCents / 100;
  const minPrice = roundPrice(midpoint - maxDistance + 0.01);
  if (minPrice <= 0.01) return null;

  const parsedBids = bids
    .map((b) => ({ price: parseFloat(b.price), value: parseFloat(b.price) * parseFloat(b.size) }))
    .filter((b) => b.value > 0)
    .sort((a, b) => b.price - a.price);

  const startPrice = roundPrice(midpoint - 0.01);

  for (let candidate = startPrice; candidate >= minPrice; candidate = roundPrice(candidate - 0.01)) {
    if (candidate <= 0.01) break;

    let wallAbove = 0;
    let highestWallPrice = 0;
    for (const bid of parsedBids) {
      if (bid.price > candidate) {
        wallAbove += bid.value;
        if (bid.price > highestWallPrice) highestWallPrice = bid.price;
      }
    }

    if (wallAbove >= minWall) {
      return { price: candidate, wallSize: wallAbove, wallPrice: highestWallPrice };
    }
  }

  return null;
}
