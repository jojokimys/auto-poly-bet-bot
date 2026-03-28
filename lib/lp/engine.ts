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
import { PolymarketUserWS, type UserTrade } from '@/lib/polymarket-user-ws';
import type { BookLevel } from '@/lib/trading-types';
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
  /** Cached daily earnings from CLOB API */
  dailyEarnings?: { earnings: any; totalEarnings: any; marketsConfig: any; fetchedAt: number };
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
  /** Depth data per price level for visualization: { price, size$ } from mid outward */
  depthYes: Array<{ price: number; size: number; isMyOrder: boolean }>;
  depthNo: Array<{ price: number; size: number; isMyOrder: boolean }>;
  /** Current adaptive wall poll interval in ms */
  pollIntervalMs: number;
}

// ─── Constants ───────────────────────────────────────────

const MAX_LOGS = 500;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const REQUOTE_INTERVAL_MS = 30 * 1000;
const TIGHT_REQUOTE_INTERVAL_MS = 60 * 1000; // 1min refresh for tight-spread markets
const CLOB_SYNC_INTERVAL_MS = 30 * 1000;

// ─── Risk Management Constants (from research) ──────────
const MIN_DAYS_TO_EXPIRY = 2 / 24;  // Skip markets resolving within 2h
const EXPIRY_WIDEN_DAYS = 7;        // Start widening spread 7 days before expiry
const MAX_SINGLE_MARKET_PCT = 0.90; // Each market can use up to 90% of balance
const CASH_RESERVE_PCT = 0.05;      // Keep 5% cash reserve
const CAPITAL_PER_SIDE = 0.47;      // 47% of balance per side (~$100 at $212 balance)
const INVENTORY_WARN_PCT = 0.30;    // Start skewing at 30% inventory imbalance
const INVENTORY_MAX_PCT = 0.50;     // Pull quotes at 50% inventory imbalance
const MIN_MIDPOINT = 0.05;          // Skip extreme probability markets
const MAX_MIDPOINT = 0.95;
const DEFAULT_MIN_WALL_SIZE = 3000; // Absolute minimum $ wall
const WALL_MULTIPLIER = 3;          // Wall must be >= 3x our order size per side
const MIN_LIQUIDITY = 10_000;       // Skip markets with < $10K liquidity
const HEDGE_TIMEOUT_MS = 60_000;    // Force market-sell hedge after 60s
// Wall-protected price must be within this fraction of the market's rewardsMaxSpread
// e.g., 0.8 = must be within 80% of maxSpread (outer 20% is too low Q-score)
const MAX_SPREAD_RATIO = 1.00;

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
  private fillCheckTimer: ReturnType<typeof setInterval> | null = null;
  private wallPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastScanTime = 0;

  // ── Real-time WebSockets (User WS only — orderbook via REST polling) ──
  private userWs: PolymarketUserWS | null = null;
  /** assetId → { bids (sorted high→low), asks (sorted low→high), updated } */
  private liveBooks = new Map<string, {
    bids: BookLevel[];
    asks: BookLevel[];
    updated: number;
  }>();
  /** Cached CLOB open orders — refreshed by syncWithClob */
  private clobOpenOrders: Map<string, any[]> = new Map(); // tokenId → orders[]
  /** Last time each market's wall was checked — for cooldown */
  private lastWallCheck = new Map<string, number>(); // marketId → timestamp
  private lastRequoteTime = 0;
  private lastBalanceRefresh = 0;
  /** Cached daily earnings data */
  private cachedEarnings: { earnings: any; totalEarnings: any; marketsConfig: any; fetchedAt: number } | null = null;

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

  /** Fetch daily earnings from CLOB API and cache */
  async fetchEarnings() {
    if (!this.profile) return;
    try {
      const client = getClientForProfile(this.profile);
      const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
      const [earnings, totalEarnings, marketsConfig] = await Promise.all([
        client.getEarningsForUserForDay(today),
        client.getTotalEarningsForUserForDay(today),
        client.getUserEarningsAndMarketsConfig(today),
      ]);
      this.cachedEarnings = { earnings, totalEarnings, marketsConfig, fetchedAt: Date.now() };
      this.log('reward', `Daily earnings fetched: ${JSON.stringify(totalEarnings)}`);
    } catch (err: any) {
      this.log('error', `Failed to fetch earnings: ${err.message}`);
    }
  }

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
        depthYes: this.getDepthLevels(mm, 0),
        depthNo: this.getDepthLevels(mm, 1),
        pollIntervalMs: (() => {
          const s0 = this.prevWallState.get(`${mm.market.id}-0`)?.pollMs ?? LpRewardsEngine.WALL_POLL_DEFAULT_MS;
          const s1 = this.prevWallState.get(`${mm.market.id}-1`)?.pollMs ?? LpRewardsEngine.WALL_POLL_DEFAULT_MS;
          return Math.min(s0, s1);
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
      dailyEarnings: this.cachedEarnings ?? undefined,
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
    // 2. Sync with CLOB: cancel orphan orders, reconcile state
    await this.syncWithClob();
    // 3. Sync existing positions (token balances → sell orphans)
    await this.syncExistingPositions();

    this.scanTimer = setInterval(() => this.scanAndAllocate(), SCAN_INTERVAL_MS);
    this.fillCheckTimer = setInterval(() => this.clobSync(), CLOB_SYNC_INTERVAL_MS);
    // P2: REST polling for wall monitoring (replaces WS orderbook)
    this.wallPollLoop();
    this.log('info', 'REST wall polling started (replaces WS orderbook)');
  }

  async stop() {
    this.running = false;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.fillCheckTimer) clearInterval(this.fillCheckTimer);
    if (this.wallPollTimer) clearInterval(this.wallPollTimer);
    this.scanTimer = null;
    this.fillCheckTimer = null;
    this.wallPollTimer = null;

    // Disconnect User WS
    if (this.userWs) {
      this.userWs.disconnect();
      this.userWs = null;
    }
    this.liveBooks.clear();
    this.clobOpenOrders.clear();
    this.lastWallCheck.clear();

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

  /** Track asset IDs already fully hedged by WS to avoid double-selling in checkFills */
  private wsHedgedAssets = new Map<string, number>(); // assetId → cumulative hedged size

  // ── P2: REST Polling for Wall Monitoring ───────────────

  private static readonly WALL_POLL_ACTIVE_MS = 3_000;   // 3s for markets with LP orders
  private static readonly WALL_POLL_IDLE_MS = 30_000;    // 30s for markets without orders
  private static readonly BATCH_SIZE = 10;                // parallel REST fetch batch size

  private marketProcessing = new Set<string>(); // per-market lock

  /**
   * Main REST polling loop — replaces WS orderbook monitoring.
   * Fetches orderbooks in parallel batches, checks walls, cancels if unsafe.
   */
  private wallPollLoop() {
    const poll = async () => {
      if (!this.running || !this.profile) return;
      const start = Date.now();

      // Refresh balance every 30s
      if (Date.now() - this.lastBalanceRefresh > 30_000) {
        this.lastBalanceRefresh = Date.now();
        try { this.balance = await getProfileBalance(this.profile); } catch { /* keep last */ }
      }

      try {
        // Separate markets by priority
        const active: ManagedMarket[] = [];
        const idle: ManagedMarket[] = [];
        const now = Date.now();

        for (const [, mm] of this.managedMarkets) {
          const hasOrders = mm.orders.some((o) => o.purpose === 'lp');
          const lastCheck = this.lastWallCheck.get(mm.market.id) ?? 0;
          if (hasOrders) {
            // Adaptive poll: use per-market interval from wall stability tracking
            const stateKey0 = `${mm.market.id}-0`;
            const stateKey1 = `${mm.market.id}-1`;
            const poll0 = this.prevWallState.get(stateKey0)?.pollMs ?? LpRewardsEngine.WALL_POLL_DEFAULT_MS;
            const poll1 = this.prevWallState.get(stateKey1)?.pollMs ?? LpRewardsEngine.WALL_POLL_DEFAULT_MS;
            const cooldown = Math.min(poll0, poll1); // use fastest of the two sides
            if (now - lastCheck >= cooldown) active.push(mm);
          } else {
            if (now - lastCheck >= LpRewardsEngine.WALL_POLL_IDLE_MS) idle.push(mm);
          }
        }

        // Active markets first (wall monitoring), then idle (opportunity scan)
        const toCheck = [...active, ...idle.slice(0, 5)]; // limit idle per cycle
        if (toCheck.length === 0) return;

        // Batch fetch all orderbooks in parallel
        const tokenIds = toCheck.flatMap((mm) => mm.market.clobTokenIds);
        const books = new Map<string, { bids: BookLevel[]; asks: BookLevel[] }>();
        const client = getReadClient();

        for (let i = 0; i < tokenIds.length; i += LpRewardsEngine.BATCH_SIZE) {
          const batch = tokenIds.slice(i, i + LpRewardsEngine.BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map(async (tid) => {
              const book = await client.getOrderBook(tid);
              const bids = (book.bids ?? []).sort((a: BookLevel, b: BookLevel) => parseFloat(b.price) - parseFloat(a.price));
              const asks = (book.asks ?? []).sort((a: BookLevel, b: BookLevel) => parseFloat(a.price) - parseFloat(b.price));
              return { tid, bids, asks };
            }),
          );
          for (const r of results) {
            if (r.status === 'fulfilled') {
              books.set(r.value.tid, { bids: r.value.bids, asks: r.value.asks });
              this.liveBooks.set(r.value.tid, { bids: r.value.bids, asks: r.value.asks, updated: Date.now() });
            }
          }
        }

        // Check walls + price for active markets — parallel batches
        const processMarket = async (mm: ManagedMarket) => {
          if (this.marketProcessing.has(mm.market.id)) return; // skip if still processing
          this.marketProcessing.add(mm.market.id);
          try {
            this.lastWallCheck.set(mm.market.id, Date.now());
            const yesBook = books.get(mm.market.clobTokenIds[0]);
            const noBook = books.get(mm.market.clobTokenIds[1]);

            let needsRequote = false;
            if (yesBook) {
              const result = await this.checkWallAndAct(mm, 0, yesBook.bids);
              if (result === 'requote') needsRequote = true;
            }
            if (noBook) {
              const result = await this.checkWallAndAct(mm, 1, noBook.bids);
              if (result === 'requote') needsRequote = true;
            }
            if (needsRequote) {
              await this.requoteMarket(mm);
            }
          } finally {
            this.marketProcessing.delete(mm.market.id);
          }
        };

        // Active markets: fire-and-forget with stagger, per-market lock prevents overlap
        active.forEach((mm, idx) => {
          setTimeout(() => processMarket(mm), idx * 50);
        });

        // Idle markets: fire-and-forget with stagger
        const idleDue = idle.filter((mm) => Date.now() - mm.lastUpdate > REQUOTE_INTERVAL_MS).slice(0, 5);
        if (idleDue.length > 0) {
          idleDue.forEach((mm, idx) => {
            this.lastWallCheck.set(mm.market.id, Date.now());
            setTimeout(() => {
              this.requoteMarket(mm).catch(() => {});
            }, idx * 50);
          });
        }

      } catch (err: any) {
        this.log('error', `Wall poll error: ${err.message}`);
      }

      // Schedule next cycle — fixed interval, pollInProgress prevents overlap
      if (this.running) {
        this.wallPollTimer = setTimeout(() => poll(), LpRewardsEngine.WALL_POLL_ACTIVE_MS) as any;
      }
    };

    poll();
  }

  /**
   * Check if the wall protecting our LP order on a given side has collapsed.
   * If so, immediately cancel the LP order.
   */
  /** Track previous wall state for change logging + adaptive poll interval */
  private prevWallState = new Map<string, { wall: number; price: number; stableCount: number; pollMs: number }>();

  private static readonly WALL_POLL_MIN_MS = 1_000;     // fastest: 1s (wall changing)
  private static readonly WALL_POLL_DEFAULT_MS = 3_000; // default: 3s
  private static readonly WALL_POLL_MAX_MS = 10_000;    // slowest: 10s (wall stable)

  /**
   * Check wall health + price position for a given side.
   * Returns 'collapsed' if wall gone, 'requote' if price shifted, 'ok' if unchanged.
   */
  private async checkWallAndAct(mm: ManagedMarket, tokenIndex: number, bids: BookLevel[]): Promise<'collapsed' | 'requote' | 'ok'> {
    const lpOrders = mm.orders.filter((o) => o.purpose === 'lp' && o.tokenIndex === tokenIndex);
    if (lpOrders.length === 0) return 'ok';

    const side = tokenIndex === 0 ? 'Yes' : 'No';
    const highestLpPrice = Math.max(...lpOrders.map((o) => o.price));

    // Calculate wall above our order
    let wallAbove = 0;
    let wallTopPrice = 0;
    for (const bid of bids) {
      const bidPrice = parseFloat(bid.price);
      const bidSize = parseFloat(bid.size);
      if (bidPrice > highestLpPrice && bidSize > 0) {
        wallAbove += bidPrice * bidSize;
        if (bidPrice > wallTopPrice) wallTopPrice = bidPrice;
      }
    }

    const myOrderCost = lpOrders.reduce((s, o) => s + o.price * o.size, 0);
    const isTight = this.config.allowTightSpread && mm.market.rewardsMaxSpread <= 2;
    const dangerThreshold = isTight
      ? Math.max(3, myOrderCost * 0.3) // Tight: relaxed — $3 or 30% of order cost
      : Math.max(this.config.minWallSize, myOrderCost * WALL_MULTIPLIER) * 0.5;

    // Log wall changes + adaptive poll interval
    const stateKey = `${mm.market.id}-${tokenIndex}`;
    const prev = this.prevWallState.get(stateKey);
    const changeThreshold = prev ? prev.wall / 10 : 0; // wallSize/10 = significant change
    const wallChanged = prev && (
      Math.abs(prev.wall - wallAbove) > changeThreshold ||
      Math.abs(prev.price - wallTopPrice) >= 0.01
    );

    // Adaptive poll: speed up on change (500ms steps), slow down on stability (1s steps after 3 stable)
    const prevPollMs = prev?.pollMs ?? LpRewardsEngine.WALL_POLL_DEFAULT_MS;
    let newPollMs = prevPollMs;
    let newStableCount = prev?.stableCount ?? 0;
    if (wallChanged) {
      newStableCount = 0;
      newPollMs = Math.max(prevPollMs - 500, LpRewardsEngine.WALL_POLL_MIN_MS); // step down 500ms
    } else {
      newStableCount = (prev?.stableCount ?? 0) + 1;
      if (newStableCount >= 3) {
        // 3 consecutive stable checks → slow down by 1s, up to max
        newPollMs = Math.min(prevPollMs + 1_000, LpRewardsEngine.WALL_POLL_MAX_MS);
      }
    }

    if (wallChanged) {
      const dir = wallAbove > prev!.wall ? '↑' : '↓';
      this.log('info', `WALL ${dir}: ${mm.market.slug} ${side} $${prev!.wall.toFixed(0)}→$${wallAbove.toFixed(0)} (order@${highestLpPrice.toFixed(2)}, threshold=$${dangerThreshold.toFixed(0)}) [poll=${(prevPollMs / 1000).toFixed(1)}s→${(newPollMs / 1000).toFixed(1)}s]`);
    }
    if (newPollMs !== prevPollMs && !wallChanged) {
      this.log('info', `POLL ${newPollMs > prevPollMs ? '▲' : '▼'}: ${mm.market.slug} ${side} ${(prevPollMs / 1000).toFixed(1)}s→${(newPollMs / 1000).toFixed(1)}s (stable×${newStableCount})`);
    }
    this.prevWallState.set(stateKey, { wall: wallAbove, price: wallTopPrice, stableCount: newStableCount, pollMs: newPollMs });

    // 1. Wall collapsed → cancel immediately
    if (wallAbove < dangerThreshold) {
      this.log('trade', `WALL COLLAPSE: ${mm.market.slug} ${side} wall=$${wallAbove.toFixed(0)} < $${dangerThreshold.toFixed(0)} — cancelling`);
      await this.cancelLpOrdersFromClob(mm, tokenIndex);
      return 'collapsed';
    }

    // 2. Check if our order is exposed (wall moved below our price)
    // Find where the wall actually starts now
    const mid = tokenIndex === 0 ? mm.market.midpoint : 1 - mm.market.midpoint;
    const reqWallSize = Math.max(this.config.minWallSize, (this.balance * CAPITAL_PER_SIDE) * WALL_MULTIPLIER);
    const currentWall = this.findWallPrice(bids, mid, mm.market.rewardsMaxSpread, reqWallSize);

    if (currentWall) {
      const optimalPrice = currentWall.price;
      const priceDiff = Math.abs(highestLpPrice - optimalPrice);
      if (priceDiff >= 0.01) {
        // Price shifted ≥ 1¢ → needs requote
        return 'requote';
      }
    } else {
      // No wall found at all → cancel
      this.log('trade', `NO WALL: ${mm.market.slug} ${side} — cancelling`);
      await this.cancelLpOrdersFromClob(mm, tokenIndex);
      return 'collapsed';
    }

    return 'ok';
  }

  // ── P0: CLOB-based Order Management ──────────────────

  /**
   * Cancel LP orders using actual CLOB open orders (not engine memory).
   * This prevents order accumulation — the root cause of $29K losses.
   */
  private async cancelLpOrdersFromClob(mm: ManagedMarket, tokenIndex?: number) {
    if (!this.profile) return;

    try {
      const openOrders = await getProfileOpenOrders(this.profile);
      const targetTokens = tokenIndex !== undefined
        ? [mm.market.clobTokenIds[tokenIndex]]
        : mm.market.clobTokenIds;

      const toCancel = openOrders
        .filter((o: any) => targetTokens.includes(o.asset_id) && o.side === 'BUY')
        .map((o: any) => o.id)
        .filter((id: string) => id);

      if (toCancel.length > 0) {
        const { cancelProfileOrders } = await import('@/lib/bot/profile-client');
        await cancelProfileOrders(this.profile, toCancel);
        this.log('trade', `CANCEL ${toCancel.length} orders: ${mm.market.slug}${tokenIndex !== undefined ? ` ${tokenIndex === 0 ? 'Yes' : 'No'}` : ''}`);
      }
    } catch (err: any) {
      this.log('error', `CLOB cancel ${mm.market.slug}: ${err.message}`);
    }

    // Sync engine memory
    if (tokenIndex !== undefined) {
      mm.orders = mm.orders.filter((o) => !(o.purpose === 'lp' && o.tokenIndex === tokenIndex));
    } else {
      mm.orders = mm.orders.filter((o) => o.purpose === 'hedge');
    }
  }

  // ── P1: CLOB State Sync ──────────────────────────────

  /**
   * Reconcile engine state with CLOB reality.
   * - Cancel orphan orders (on CLOB but not tracked by engine)
   * - Remove stale orders (in engine but not on CLOB)
   */
  private async syncWithClob() {
    if (!this.profile) return;

    let openOrders: any[];
    try {
      openOrders = await getProfileOpenOrders(this.profile);
    } catch (err: any) {
      this.log('error', `CLOB sync failed: ${err.message}`);
      return;
    }

    // Build set of all tracked order IDs
    const trackedIds = new Set<string>();
    for (const [, mm] of this.managedMarkets) {
      for (const o of mm.orders) {
        if (o.orderId !== 'unknown') trackedIds.add(o.orderId);
      }
    }

    // Find orphan orders (on CLOB but not tracked)
    const orphanIds = openOrders
      .filter((o: any) => !trackedIds.has(o.id))
      .map((o: any) => o.id);

    if (orphanIds.length > 0) {
      this.log('info', `CLOB sync: cancelling ${orphanIds.length} orphan orders`);
      try {
        const { cancelProfileOrders } = await import('@/lib/bot/profile-client');
        await cancelProfileOrders(this.profile, orphanIds);
      } catch (err: any) {
        this.log('error', `Orphan cancel: ${err.message}`);
      }
    }

    // Remove stale orders (in engine but not on CLOB)
    const clobIds = new Set(openOrders.map((o: any) => o.id));
    for (const [, mm] of this.managedMarkets) {
      const before = mm.orders.length;
      mm.orders = mm.orders.filter((o) =>
        o.orderId === 'unknown' || o.purpose === 'hedge' || clobIds.has(o.orderId),
      );
      const removed = before - mm.orders.length;
      if (removed > 0) {
        this.log('info', `CLOB sync: removed ${removed} stale orders from ${mm.market.slug}`);
      }
    }

    this.log('info', `CLOB sync: ${openOrders.length} open orders, ${orphanIds.length} orphans cancelled`);
  }

  /**
   * Called instantly when our order gets filled via User WS channel.
   * Immediately places a sell order at the fill price — no 10s polling delay.
   */
  private async onUserTrade(trade: UserTrade) {
    if (!this.running || !this.profile) return;

    // Only care about BUY fills
    if (trade.side !== 'BUY') return;
    if (trade.status !== 'MATCHED' && trade.status !== 'MINED' && trade.status !== 'CONFIRMED') return;

    // On MATCHED: cancel all remaining orders for this market immediately (before settlement)
    if (trade.status === 'MATCHED') {
      let mm: ManagedMarket | null = null;
      for (const [, m] of this.managedMarkets) {
        if (m.market.clobTokenIds.includes(trade.asset_id)) { mm = m; break; }
      }
      if (mm) {
        this.log('trade', `MATCHED → emergency cancel all: ${mm.market.slug}`);
        this.cancelLpOrdersFromClob(mm); // fire-and-forget, don't await
      }
      return; // Wait for MINED to sell
    }

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

    this.log('reward', `WS FILL [${trade.status}]: ${slug} BUY ${side} @${price.toFixed(2)} x${size}`);

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
      const delays = [0, 1000, 3000]; // MINED = tokens available, fast retry
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

      // Refresh balance after sell
      this.refreshBalance();

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

    // Fill detected — cancel ALL orders for this market immediately (both sides)
    if (targetMm) {
      this.log('trade', `FILL → cancelling all orders for ${targetMm.market.slug}`);
      await this.cancelLpOrdersFromClob(targetMm);
      // Blacklist this market
      this.blacklistMarket(targetMm.market.conditionId, targetMm.market.slug);
    }
  }


  /** Get live orderbook for an asset, fallback to REST if WS not ready */
  /** Get orderbook — uses poll cache if fresh, otherwise REST fetch */
  private async getOrderBook(tokenId: string): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
    // Use cached data from REST polling if fresh (< 10s)
    const live = this.liveBooks.get(tokenId);
    if (live && (Date.now() - live.updated) < 10_000) {
      return { bids: live.bids, asks: live.asks };
    }
    // REST fetch
    try {
      const client = getReadClient();
      const book = await client.getOrderBook(tokenId);
      const bids = (book.bids ?? []).sort((a: BookLevel, b: BookLevel) => parseFloat(b.price) - parseFloat(a.price));
      const asks = (book.asks ?? []).sort((a: BookLevel, b: BookLevel) => parseFloat(a.price) - parseFloat(b.price));
      this.liveBooks.set(tokenId, { bids, asks, updated: Date.now() });
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

      // Fetch daily earnings (non-blocking)
      this.fetchEarnings().catch(() => {});

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

      // ── Wall check via REST (parallel batches) ──
      const client = getReadClient();
      const wallChecked: RewardEfficiency[] = [];

      // Batch fetch all orderbooks in parallel
      for (let i = 0; i < candidates.length; i += LpRewardsEngine.BATCH_SIZE) {
        if (wallChecked.length >= this.config.maxMarkets) break;

        const batch = candidates.slice(i, i + LpRewardsEngine.BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (eff) => {
            // maxSpread=1¢: only 1 price level (midpoint), no wall protection → skip
            if (eff.market.rewardsMaxSpread <= 1) return null;

            const isTightSpread = this.config.allowTightSpread && eff.market.rewardsMaxSpread <= 2;

            // Fetch YES + NO books in parallel
            const [yesRes, noRes] = await Promise.allSettled([
              client.getOrderBook(eff.market.clobTokenIds[0]),
              this.config.twoSided ? client.getOrderBook(eff.market.clobTokenIds[1]) : Promise.resolve(null),
            ]);

            const yesBook = yesRes.status === 'fulfilled' ? yesRes.value : null;
            const noBook = noRes.status === 'fulfilled' ? noRes.value : null;
            if (!yesBook) return null;

            // Tight spread: require at least one side with $5+ wall value
            if (isTightSpread) {
              const yesWallValue = this.getTotalWallValue(yesBook.bids ?? [], eff.market.midpoint, eff.market.rewardsMaxSpread);
              const noWallValue = noBook
                ? this.getTotalWallValue(noBook.bids ?? [], 1 - eff.market.midpoint, eff.market.rewardsMaxSpread)
                : 0;
              if (yesWallValue < 5 && noWallValue < 5) return null;
              return eff;
            }

            // Normal markets: require wall meeting minWall threshold
            const yesWall = this.findWallPrice(yesBook.bids ?? [], eff.market.midpoint, eff.market.rewardsMaxSpread, dynamicWallSize);
            if (!yesWall) return null;

            const yesDistCents = (eff.market.midpoint - yesWall.price) * 100;
            if (yesDistCents > eff.market.rewardsMaxSpread * MAX_SPREAD_RATIO) return null;

            if (this.config.twoSided && noBook) {
              const noMid = 1 - eff.market.midpoint;
              const noWall = this.findWallPrice(noBook.bids ?? [], noMid, eff.market.rewardsMaxSpread, dynamicWallSize);
              if (!noWall) return null;
              const noDistCents = (noMid - noWall.price) * 100;
              if (noDistCents > eff.market.rewardsMaxSpread * MAX_SPREAD_RATIO) return null;
            }

            return eff;
          }),
        );

        for (const r of results) {
          if (r.status === 'fulfilled' && r.value && wallChecked.length < this.config.maxMarkets) {
            wallChecked.push(r.value);
          }
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
        this.refreshBalance();
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

  private static readonly REQUOTE_BATCH_SIZE = 10; // parallel requote batch size

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

    // Fire all requotes with 300ms stagger — no need to await
    const markets = [...this.managedMarkets.values()];
    markets.forEach((mm, idx) => {
      setTimeout(() => {
        this.requoteMarket(mm).catch((err: any) => {
          this.log('error', `Requote ${mm.market.slug}: ${err.message}`);
        });
      }, idx * 300);
    });
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

  /**
   * Sum total $ value of bids within reward zone.
   * Used for tight-spread markets to compare wall sizes between YES/NO sides.
   */
  private getTotalWallValue(
    bids: Array<{ price: string; size: string }>,
    midpoint: number,
    maxSpreadCents: number,
  ): number {
    const minPrice = midpoint - maxSpreadCents / 100;
    let total = 0;
    for (const b of bids) {
      const price = parseFloat(b.price);
      const size = parseFloat(b.size);
      if (price > minPrice && price < midpoint && size > 0) {
        total += price * size;
      }
    }
    return total;
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
    // maxSpread=1¢: only 1 price level possible (= midpoint itself), no wall protection possible → always skip
    if (maxSpread <= 1) return;
    const isTightAllowed = this.config.allowTightSpread && maxSpread <= 2;
    if (maxSpread <= this.config.minSpreadCents && !isTightAllowed) return;

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

    // For tight-spread markets: compare walls, bigger side goes first (balance naturally blocks 2nd side)
    let tightPreferYes = true; // default: YES first
    if (isTightSpread) {
      const yesWallValue = this.getTotalWallValue(yesBook.bids ?? [], liveMid, maxSpread);
      const noWallValue = this.config.twoSided
        ? this.getTotalWallValue(noBook.bids ?? [], noMid, maxSpread)
        : 0;
      const TIGHT_MIN_WALL = 5; // $5 minimum
      if (yesWallValue < TIGHT_MIN_WALL && noWallValue < TIGHT_MIN_WALL) {
        this.log('info', `${market.slug}: tight — both walls too thin (Yes=$${yesWallValue.toFixed(0)}, No=$${noWallValue.toFixed(0)}) — skipping`);
        await this.cancelLpOrders(mm);
        return;
      }
      tightPreferYes = yesWallValue >= noWallValue;
      this.log('info', `${market.slug}: tight — ${tightPreferYes ? 'Yes' : 'No'} wall bigger ($${tightPreferYes ? yesWallValue.toFixed(0) : noWallValue.toFixed(0)} vs $${tightPreferYes ? noWallValue.toFixed(0) : yesWallValue.toFixed(0)}) — ordering ${tightPreferYes ? 'Yes' : 'No'} first`);
    }

    // For tight-spread markets: place at maxSpread edge
    const yesBidPrice = isTightSpread
      ? roundPrice(liveMid - maxSpread / 100 + 0.01)
      : yesWall!.price;
    const noBidPrice = isTightSpread
      ? roundPrice(noMid - maxSpread / 100 + 0.01)
      : noWall?.price ?? 0;

    // Validate within reward zone
    const yesDistCents = (liveMid - yesBidPrice) * 100;
    const noDistCents = (noMid - noBidPrice) * 100;
    if (yesDistCents > maxSpread || yesDistCents < 0) return;

    // ── Ladder: place orders from wall price down to maxSpread edge ──
    // All prices behind the wall earn rewards. More prices = more Q-score = more rewards.
    const rawMinSize = Math.max(market.rewardsMinSize || 1, 1);
    const capitalPerSide = this.balance * CAPITAL_PER_SIDE;

    // Build ladder prices for each side
    const yesLadder: number[] = [];
    const maxYesDist = maxSpread * MAX_SPREAD_RATIO;
    for (let p = yesBidPrice; p >= roundPrice(liveMid - maxYesDist / 100); p = roundPrice(p - 0.01)) {
      if (p <= 0.01 || p >= 0.99) continue;
      yesLadder.push(p);
    }

    const noLadder: number[] = [];
    if (this.config.twoSided && noBidPrice > 0) {
      const maxNoDist = maxSpread * MAX_SPREAD_RATIO;
      for (let p = noBidPrice; p >= roundPrice(noMid - maxNoDist / 100); p = roundPrice(p - 0.01)) {
        if (p <= 0.01 || p >= 0.99) continue;
        noLadder.push(p);
      }
    }

    // Split capital across ladder rungs (Polymarket locks balance per order)
    const totalRungs = yesLadder.length + noLadder.length;
    const capitalPerRung = totalRungs > 0 ? capitalPerSide / totalRungs : capitalPerSide;

    // Check if requote needed — compare ladder with existing orders
    const lpOrders = mm.orders.filter((o) => o.purpose === 'lp');
    const existingYesPrices = lpOrders.filter((o) => o.tokenIndex === 0).map((o) => o.price).sort();
    const existingNoPrices = lpOrders.filter((o) => o.tokenIndex === 1).map((o) => o.price).sort();
    const sameLadder = (existing: number[], ladder: number[]) => {
      if (existing.length !== ladder.length) return false;
      const sorted = [...ladder].sort();
      return existing.every((p, i) => Math.abs(p - sorted[i]) < 0.005);
    };
    if (sameLadder(existingYesPrices, yesLadder) && sameLadder(existingNoPrices, noLadder)) return;

    await this.cancelLpOrders(mm);

    const newOrders: ActiveOrder[] = [...mm.orders]; // Keep hedge orders

    // Interleave sides: for tight spread, bigger wall side goes first (balance naturally blocks 2nd).
    // For normal markets, YES first then NO interleaved.
    type LadderRung = { tokenIndex: number; tokenId: string; price: number; mid: number; wallInfo: typeof yesWall };
    const firstLadder: LadderRung[] = [];
    const secondLadder: LadderRung[] = [];

    const yesRungs: LadderRung[] = yesLadder.map((p) => ({
      tokenIndex: 0, tokenId: market.clobTokenIds[0], price: p, mid: liveMid, wallInfo: yesWall,
    }));
    const noRungs: LadderRung[] = noLadder.map((p) => ({
      tokenIndex: 1, tokenId: market.clobTokenIds[1], price: p, mid: noMid, wallInfo: noWall,
    }));

    if (isTightSpread && !tightPreferYes) {
      firstLadder.push(...noRungs);
      secondLadder.push(...yesRungs);
    } else {
      firstLadder.push(...yesRungs);
      secondLadder.push(...noRungs);
    }

    const maxLen = Math.max(firstLadder.length, secondLadder.length);
    let orderIdx = 0;
    for (let li = 0; li < maxLen; li++) {
      // First side rung
      if (li < firstLadder.length) {
        const rung = firstLadder[li];
        if (orderIdx > 0) await new Promise((r) => setTimeout(r, 100));
        const dist = (rung.mid - rung.price) * 100;
        const size = Math.max(rawMinSize, Math.floor(capitalPerRung / rung.price));
        const sideName = rung.tokenIndex === 0 ? 'Yes' : 'No';
        try {
          const result = await placeProfileOrder(this.profile, {
            tokenId: rung.tokenId, side: 'BUY', price: rung.price, size, postOnly: true,
          });
          const orderId = (result as any)?.orderID ?? (result as any)?.id ?? 'unknown';
          newOrders.push({
            orderId, tokenId: rung.tokenId, tokenIndex: rung.tokenIndex,
            side: 'BUY', price: rung.price, size,
            originalSize: size, marketId: market.id, purpose: 'lp',
          });
          this.log('trade', `${market.slug} BUY ${sideName} @${rung.price.toFixed(2)} x${size} ($${(rung.price * size).toFixed(0)}) (${dist.toFixed(1)}¢) [wall=$${rung.wallInfo?.wallSize.toFixed(0) ?? '?'}] [id=${orderId.slice(0, 10)}]`);
          orderIdx++;
        } catch (err: any) {
          this.log('error', `${market.slug} BUY ${sideName} @${rung.price.toFixed(2)}: ${err.message}`);
          break; // Balance exhausted
        }
      }

      // Second side rung
      if (li < secondLadder.length) {
        const rung = secondLadder[li];
        const dist = (rung.mid - rung.price) * 100;
        if (dist <= maxSpread) {
          if (orderIdx > 0) await new Promise((r) => setTimeout(r, 100));
          const size = Math.max(rawMinSize, Math.floor(capitalPerRung / rung.price));
          const sideName = rung.tokenIndex === 0 ? 'Yes' : 'No';
          try {
            const result = await placeProfileOrder(this.profile, {
              tokenId: rung.tokenId, side: 'BUY', price: rung.price, size, postOnly: true,
            });
            const orderId = (result as any)?.orderID ?? (result as any)?.id ?? 'unknown';
            newOrders.push({
              orderId, tokenId: rung.tokenId, tokenIndex: rung.tokenIndex,
              side: 'BUY', price: rung.price, size,
              originalSize: size, marketId: market.id, purpose: 'lp',
            });
            this.log('trade', `${market.slug} BUY ${sideName} @${rung.price.toFixed(2)} x${size} ($${(rung.price * size).toFixed(0)}) (${dist.toFixed(1)}¢) [wall=$${rung.wallInfo?.wallSize.toFixed(0) ?? '?'}] [id=${orderId.slice(0, 10)}]`);
            orderIdx++;
          } catch (err: any) {
            this.log('error', `${market.slug} BUY ${sideName} @${rung.price.toFixed(2)}: ${err.message}`);
            break; // Balance exhausted
          }
        }
      }
    }

    mm.orders = newOrders;
    mm.lastUpdate = Date.now();

    if (yesLadder.length + noLadder.length > 2) {
      this.log('info', `${market.slug}: ladder ${yesLadder.length} Yes + ${noLadder.length} No prices`);
    }

    // Recalculate Q score
    const lpOrdersForScore: LpOrder[] = newOrders
      .filter((o) => o.purpose === 'lp')
      .map((o) => ({ side: o.side, price: o.price, size: o.size, tokenIndex: o.tokenIndex }));
    mm.efficiency.qScore = calculateQScore({ ...market, midpoint: liveMid }, lpOrdersForScore);
  }

  // ── Fill Detection & Hedging ────────────────────────────

  /**
   * CLOB Sync (30s) — reconcile engine state with CLOB reality.
   * Fill detection is handled by User WS; this is the safety net.
   */
  private async clobSync() {
    if (!this.running || !this.profile) return;

    let openOrders: any[];
    try {
      openOrders = await getProfileOpenOrders(this.profile);
    } catch { return; }

    const openOrderIds = new Set(openOrders.map((o: any) => o.id));

    // 1. Cancel orphan orders (on CLOB but not tracked by engine)
    const trackedIds = new Set<string>();
    for (const [, mm] of this.managedMarkets) {
      for (const o of mm.orders) {
        if (o.orderId !== 'unknown') trackedIds.add(o.orderId);
      }
    }
    const orphanIds = openOrders
      .filter((o: any) => !trackedIds.has(o.id))
      .map((o: any) => o.id);
    if (orphanIds.length > 0) {
      this.log('info', `CLOB sync: cancelling ${orphanIds.length} orphan orders`);
      try {
        const { cancelProfileOrders } = await import('@/lib/bot/profile-client');
        await cancelProfileOrders(this.profile, orphanIds);
      } catch (err: any) {
        this.log('error', `Orphan cancel: ${err.message}`);
      }
    }

    // 2. Remove stale orders from engine (in engine but gone from CLOB)
    for (const [, mm] of this.managedMarkets) {
      mm.orders = mm.orders.filter((o) => {
        if (o.orderId === 'unknown' || o.purpose === 'hedge') return true;
        return openOrderIds.has(o.orderId);
      });

      // Clean up exited hedge positions
      mm.positions = mm.positions.filter((pos) => {
        if (!pos.hedgeOrderId) return true;
        if (openOrderIds.has(pos.hedgeOrderId)) return true;
        const pnl = (pos.hedgePrice - pos.fillPrice) * pos.size;
        this.log('reward', `HEDGE EXIT: ${mm.market.slug} ${pos.tokenIndex === 0 ? 'Yes' : 'No'} entry=${pos.fillPrice.toFixed(2)} exit=${pos.hedgePrice.toFixed(2)} pnl=$${pnl.toFixed(2)}`);
        this.updateInventory(mm, pos.tokenIndex, -pos.size);
        return false;
      });

      // Force exit stale hedges
      await this.forceExitStaleHedges(mm, openOrderIds);

      // Clean wsHedgedAssets
      for (const tokenId of mm.market.clobTokenIds) {
        this.wsHedgedAssets.delete(tokenId);
      }
    }

    // 3. Retry pending sells
    await this.retryPendingSells();

    this.log('info', `CLOB sync: ${openOrders.length} open, ${orphanIds.length} orphans cancelled`);
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
        this.refreshBalance();
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

  /** Refresh balance from CLOB after sell — fire and forget */
  private refreshBalance() {
    if (!this.profile) return;
    getProfileBalance(this.profile).then((b) => {
      this.balance = b;
    }).catch(() => { /* silent */ });
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
        this.refreshBalance();
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

  /** Cancel LP orders — delegates to CLOB-based cancel (P0) */
  private async cancelLpOrders(mm: ManagedMarket) {
    await this.cancelLpOrdersFromClob(mm);
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

  /** Get depth levels per 1¢ from mid to maxSpread edge for visualization */
  private getDepthLevels(mm: ManagedMarket, tokenIndex: number): Array<{ price: number; size: number; isMyOrder: boolean }> {
    const mid = tokenIndex === 0 ? mm.market.midpoint : 1 - mm.market.midpoint;
    const maxSpread = mm.market.rewardsMaxSpread;
    const book = this.liveBooks.get(mm.market.clobTokenIds[tokenIndex]);
    const myPrices = new Set(
      mm.orders.filter((o) => o.purpose === 'lp' && o.tokenIndex === tokenIndex).map((o) => o.price),
    );

    const levels: Array<{ price: number; size: number; isMyOrder: boolean }> = [];
    const steps = Math.min(10, Math.ceil(maxSpread));

    for (let i = 0; i < steps; i++) {
      const price = roundPrice(mid - (i + 1) * 0.01);
      if (price <= 0.01) break;

      let size = 0;
      if (book?.bids) {
        for (const b of book.bids) {
          const bp = parseFloat(b.price);
          if (Math.abs(bp - price) < 0.005) {
            size += parseFloat(b.price) * parseFloat(b.size);
          }
        }
      }

      levels.push({
        price,
        size,
        isMyOrder: myPrices.has(price),
      });
    }

    return levels;
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
