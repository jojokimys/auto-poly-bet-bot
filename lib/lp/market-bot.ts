import 'server-only';
import { appendFile, stat, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { RewardMarket } from './scanner';
import { checkWall, type WallCheckResult } from './engine';
import {
  loadProfile,
  placeProfileOrder,
  cancelProfileOrders,
  getProfileOpenOrders,
  getProfileBalance,
  getProfileTokenBalance,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';
import { getReadClient } from '@/lib/polymarket/client';
import { PolymarketWS } from '@/lib/polymarket-ws';
import type { BookSnapshot, BookLevel } from '@/lib/trading-types';

// ─── File Logger ─────────────────────────────────────────

const LOG_DIR = join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'lp-bots.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

async function ensureLogDir() {
  await mkdir(LOG_DIR, { recursive: true });
}

async function fileLog(line: string) {
  try {
    await ensureLogDir();
    await appendFile(LOG_FILE, line + '\n');
    const s = await stat(LOG_FILE);
    if (s.size > MAX_LOG_BYTES) {
      const content = await readFile(LOG_FILE, 'utf-8');
      const lines = content.split('\n');
      await writeFile(LOG_FILE, lines.slice(Math.floor(lines.length * 0.4)).join('\n'));
    }
  } catch { /* silent */ }
}

// ─── Types ───────────────────────────────────────────────

interface ActiveOrder {
  orderId: string;
  tokenId: string;
  tokenIndex: number;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  originalSize: number;
  purpose: 'lp' | 'hedge';
}

interface HeldPosition {
  tokenId: string;
  tokenIndex: number;
  fillPrice: number;
  size: number;
  hedgeOrderId?: string;
  hedgePrice: number;
  timestamp: number;
}

export interface BotLogLine {
  text: string;
  type: 'info' | 'trade' | 'error' | 'reward';
  timestamp: number;
}

export interface MarketBotStatus {
  marketId: string;
  question: string;
  slug: string;
  running: boolean;
  capital: number;
  dominantSide: string;
  midpoint: number;
  orders: number;
  positions: number;
  wallSize: number;
  orderPrice: number;
  pnl: number;
  fills: number;
  lastUpdate: number;
  /** Per-side details for two-sided quoting */
  yesPrice: number;
  noPrice: number;
  yesWall: number;
  noWall: number;
}

// ─── Constants ───────────────────────────────────────────

const MAX_LOGS = 200;
const REQUOTE_INTERVAL_MS = 15_000;
const FILL_CHECK_INTERVAL_MS = 10_000;
const HEDGE_OFFSET_CENTS = 1;
const MIN_WALL_SIZE = 100;

// ─── MarketBot (Two-Sided) ──────────────────────────────

export class MarketBot {
  private running = false;
  private profile: ProfileCredentials | null = null;
  private market: RewardMarket;
  private capital: number;
  private profileId: string;

  private yesTokenId: string;
  private noTokenId: string;
  /** Order size for each side: rewardsMinSize + 1 */
  private minSize: number;

  private orders: ActiveOrder[] = [];
  private positions: HeldPosition[] = [];
  private logs: BotLogLine[] = [];
  private pnl = 0;
  private fills = 0;
  private wallSizes = { yes: 0, no: 0 };
  private orderPrices = { yes: 0, no: 0 };

  private ws: PolymarketWS | null = null;
  private liveBooks = new Map<string, { bids: BookLevel[]; asks: BookLevel[]; updated: number }>();

  private requoteTimer: ReturnType<typeof setInterval> | null = null;
  private fillCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(market: RewardMarket, profileId: string, capital: number) {
    this.market = market;
    this.profileId = profileId;
    this.capital = capital;

    this.yesTokenId = market.clobTokenIds[0];
    this.noTokenId = market.clobTokenIds[1];
    this.minSize = (market.rewardsMinSize || 1) + 1;
  }

  isRunning() { return this.running; }
  getLogs(limit = 100) { return this.logs.slice(-limit); }

  getStatus(): MarketBotStatus {
    return {
      marketId: this.market.id,
      question: this.market.question,
      slug: this.market.slug,
      running: this.running,
      capital: this.capital,
      dominantSide: 'Both',
      midpoint: this.market.midpoint,
      orders: this.orders.length,
      positions: this.positions.length,
      wallSize: Math.min(this.wallSizes.yes || Infinity, this.wallSizes.no || Infinity) === Infinity ? 0 : Math.min(this.wallSizes.yes || Infinity, this.wallSizes.no || Infinity),
      orderPrice: this.orderPrices.yes || this.orderPrices.no,
      pnl: this.pnl,
      fills: this.fills,
      lastUpdate: Math.max(
        this.liveBooks.get(this.yesTokenId)?.updated ?? 0,
        this.liveBooks.get(this.noTokenId)?.updated ?? 0,
      ),
      yesPrice: this.orderPrices.yes,
      noPrice: this.orderPrices.no,
      yesWall: this.wallSizes.yes,
      noWall: this.wallSizes.no,
    };
  }

  async start() {
    if (this.running) return;

    const profile = await loadProfile(this.profileId);
    if (!profile) throw new Error(`Profile not found: ${this.profileId}`);
    this.profile = profile;
    this.running = true;

    this.log('info', `Started: ${this.market.question.slice(0, 50)} | Both sides | size=${this.minSize}`);

    // Connect WS for both tokens
    this.ws = new PolymarketWS();
    this.ws.connect([this.yesTokenId, this.noTokenId], (book: BookSnapshot) => {
      const realBids = book.buys.filter((b) => parseFloat(b.size) > 0);
      if (realBids.length >= 2) {
        this.liveBooks.set(book.assetId, {
          bids: book.buys,
          asks: book.sells,
          updated: book.timestamp,
        });
        const tokenIndex = book.assetId === this.yesTokenId ? 0 : 1;
        this.onBookUpdate(tokenIndex, book.buys);
      }
    });

    // Wait for initial books
    await new Promise((r) => setTimeout(r, 2000));

    // Initial order placement on both sides
    await this.requote();

    // Periodic REST fallback requote
    this.requoteTimer = setInterval(() => this.requote(), REQUOTE_INTERVAL_MS);
    this.fillCheckTimer = setInterval(() => this.checkFills(), FILL_CHECK_INTERVAL_MS);
  }

  async stop() {
    this.running = false;

    if (this.requoteTimer) { clearInterval(this.requoteTimer); this.requoteTimer = null; }
    if (this.fillCheckTimer) { clearInterval(this.fillCheckTimer); this.fillCheckTimer = null; }
    if (this.urgentRequoteTimerYes) { clearTimeout(this.urgentRequoteTimerYes); this.urgentRequoteTimerYes = null; }
    if (this.urgentRequoteTimerNo) { clearTimeout(this.urgentRequoteTimerNo); this.urgentRequoteTimerNo = null; }

    // Cancel all orders (LP + hedge)
    if (this.profile) {
      const allIds = this.orders
        .filter((o) => o.orderId !== 'unknown')
        .map((o) => o.orderId);
      if (allIds.length > 0) {
        try {
          await cancelProfileOrders(this.profile, allIds);
          this.log('info', `Cancelled ${allIds.length} orders`);
        } catch (err: any) {
          this.log('error', `Cancel orders: ${err.message}`);
        }
      }
    }

    if (this.ws) { this.ws.disconnect(); this.ws = null; }
    this.liveBooks.clear();

    this.log('info', `Stopped | PnL: $${this.pnl.toFixed(2)} | Fills: ${this.fills}`);
  }

  // ── Real-time Wall Monitoring (per-side) ────────────────

  private requoteInFlight = false;
  private urgentRequoteTimerYes: ReturnType<typeof setTimeout> | null = null;
  private urgentRequoteTimerNo: ReturnType<typeof setTimeout> | null = null;

  /**
   * Called on every full WS book update for a specific token.
   * If wall drops below threshold, trigger immediate requote for that side only.
   */
  private onBookUpdate(tokenIndex: number, bids: BookLevel[]) {
    if (!this.running || this.requoteInFlight) return;

    const lpOrder = this.orders.find((o) => o.purpose === 'lp' && o.tokenIndex === tokenIndex);
    if (!lpOrder) return;

    let wallAboveUs = 0;
    for (const bid of bids) {
      const bidPrice = parseFloat(bid.price);
      const bidSize = parseFloat(bid.size);
      if (bidPrice > lpOrder.price && bidSize > 0) {
        wallAboveUs += bidPrice * bidSize;
      }
    }

    // Danger threshold based on actual order cost, not capital
    const orderCost = lpOrder.price * lpOrder.size;
    const dangerThreshold = MIN_WALL_SIZE + orderCost;
    const side = tokenIndex === 0 ? 'Yes' : 'No';

    if (wallAboveUs < dangerThreshold) {
      const timerKey = tokenIndex === 0 ? 'urgentRequoteTimerYes' : 'urgentRequoteTimerNo';
      if (!this[timerKey]) {
        this[timerKey] = setTimeout(() => {
          this[timerKey] = null;
          this.log('info', `${side} wall thin: $${wallAboveUs.toFixed(0)} < $${dangerThreshold.toFixed(0)} — requoting`);
          this.requoteSide(tokenIndex);
        }, 500);
      }
    } else {
      if (tokenIndex === 0) this.wallSizes.yes = wallAboveUs;
      else this.wallSizes.no = wallAboveUs;
    }
  }

  // ── Orderbook ──────────────────────────────────────────

  private async getBook(tokenId: string): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
    const live = this.liveBooks.get(tokenId);
    if (live && (Date.now() - live.updated) < 60_000) {
      const realBids = live.bids.filter((b) => parseFloat(b.size) > 0);
      if (realBids.length >= 2) {
        return { bids: live.bids, asks: live.asks };
      }
    }
    try {
      const client = getReadClient();
      const book = await client.getOrderBook(tokenId);
      return { bids: book.bids ?? [], asks: book.asks ?? [] };
    } catch {
      return { bids: [], asks: [] };
    }
  }

  // ── Wall Detection & Order Placement (two-sided) ───────

  private async requote() {
    if (!this.running || !this.profile || this.requoteInFlight) return;
    this.requoteInFlight = true;
    try {
      await this.requoteSide(0); // Yes
      await this.requoteSide(1); // No
    } finally {
      this.requoteInFlight = false;
    }
  }

  private async requoteSide(tokenIndex: number) {
    if (!this.profile) return;

    const tokenId = tokenIndex === 0 ? this.yesTokenId : this.noTokenId;
    const mid = tokenIndex === 0 ? this.market.midpoint : 1 - this.market.midpoint;
    const side = tokenIndex === 0 ? 'Yes' : 'No';

    const book = await this.getBook(tokenId);
    if (!book.bids.length) return;

    // Calculate live mid from book
    let liveMid = mid;
    if (book.bids.length && book.asks.length) {
      const bestBid = Math.max(...book.bids.map((b) => parseFloat(b.price)));
      const bestAsk = Math.min(...book.asks.map((a) => parseFloat(a.price)));
      if (bestBid > 0 && bestAsk > bestBid) {
        liveMid = (bestBid + bestAsk) / 2;
      }
    }

    const maxSpread = this.market.rewardsMaxSpread;
    const wall = checkWall(book.bids, liveMid, maxSpread, MIN_WALL_SIZE);

    if (!wall) {
      const hasLp = this.orders.some((o) => o.purpose === 'lp' && o.tokenIndex === tokenIndex);
      if (hasLp) {
        this.log('info', `${side} wall gone — pulling LP order`);
        await this.cancelLpOrdersSide(tokenIndex);
      }
      if (tokenIndex === 0) { this.wallSizes.yes = 0; this.orderPrices.yes = 0; }
      else { this.wallSizes.no = 0; this.orderPrices.no = 0; }
      return;
    }

    if (tokenIndex === 0) this.wallSizes.yes = wall.wallSize;
    else this.wallSizes.no = wall.wallSize;

    // Place our order 1¢ below the wall (right behind it)
    const ourPrice = roundPrice(wall.price);

    // Verify still in reward zone
    const distCents = (liveMid - ourPrice) * 100;
    if (distCents > maxSpread || distCents < 0 || ourPrice <= 0.01 || ourPrice >= 0.99) return;

    // Check if requote needed
    const currentLp = this.orders.find((o) => o.purpose === 'lp' && o.tokenIndex === tokenIndex);
    if (currentLp && Math.abs(currentLp.price - ourPrice) < 0.005) {
      return; // No significant change
    }

    // Cancel old LP order for this side
    await this.cancelLpOrdersSide(tokenIndex);

    const size = this.minSize;

    // Balance check
    const orderCost = ourPrice * size;
    try {
      const balance = await getProfileBalance(this.profile);
      if (orderCost > balance * 0.95) {
        this.log('info', `${side}: Insufficient balance: need $${orderCost.toFixed(2)}, have $${balance.toFixed(2)}`);
        return;
      }
    } catch { /* proceed */ }

    try {
      const result = await placeProfileOrder(this.profile, {
        tokenId,
        side: 'BUY',
        price: ourPrice,
        size,
        postOnly: true,
      });
      const orderId = (result as any)?.orderID ?? (result as any)?.id ?? 'unknown';
      this.orders.push({
        orderId, tokenId, tokenIndex,
        side: 'BUY', price: ourPrice, size, originalSize: size, purpose: 'lp',
      });
      if (tokenIndex === 0) this.orderPrices.yes = ourPrice;
      else this.orderPrices.no = ourPrice;
      this.log('trade', `BUY ${side} @${ourPrice.toFixed(2)} x${size} (${distCents.toFixed(1)}¢ from mid) [wall=$${wall.wallSize.toFixed(0)}]`);
    } catch (err: any) {
      this.log('error', `BUY ${side}: ${err.message}`);
    }
  }

  // ── Fill Detection & Hedging ───────────────────────────

  private async checkFills() {
    if (!this.running || !this.profile) return;

    let openOrders: any[];
    try {
      openOrders = await getProfileOpenOrders(this.profile);
    } catch { return; }

    const openIds = new Set(openOrders.map((o: any) => o.id));

    const filled: ActiveOrder[] = [];
    const stillActive: ActiveOrder[] = [];

    for (const order of this.orders) {
      if (order.orderId === 'unknown') { stillActive.push(order); continue; }

      if (openIds.has(order.orderId)) {
        stillActive.push(order);
      } else if (order.purpose === 'lp') {
        filled.push(order);
      } else if (order.purpose === 'hedge') {
        const pos = this.positions.find((p) => p.hedgeOrderId === order.orderId);
        if (pos) {
          const profit = (pos.hedgePrice - pos.fillPrice) * pos.size;
          this.pnl += profit;
          this.log('reward', `HEDGE EXIT: entry=${pos.fillPrice.toFixed(2)} exit=${pos.hedgePrice.toFixed(2)} pnl=$${profit.toFixed(2)} (total=$${this.pnl.toFixed(2)})`);
          this.positions = this.positions.filter((p) => p.hedgeOrderId !== order.orderId);
        }
      }
    }

    this.orders = stillActive;

    for (const f of filled) {
      this.fills++;
      const side = f.tokenIndex === 0 ? 'Yes' : 'No';
      this.log('reward', `FILLED: BUY ${side} @${f.price.toFixed(2)} x${f.originalSize}`);

      // Place hedge
      const hedgePrice = roundPrice(f.price + HEDGE_OFFSET_CENTS / 100);
      if (hedgePrice > 0.01 && hedgePrice < 0.99) {
        try {
          const result = await placeProfileOrder(this.profile!, {
            tokenId: f.tokenId,
            side: 'SELL',
            price: hedgePrice,
            size: f.originalSize,
            postOnly: true,
          });
          const hedgeId = (result as any)?.orderID ?? (result as any)?.id ?? 'unknown';
          this.positions.push({
            tokenId: f.tokenId, tokenIndex: f.tokenIndex,
            fillPrice: f.price, size: f.originalSize,
            hedgeOrderId: hedgeId, hedgePrice, timestamp: Date.now(),
          });
          this.orders.push({
            orderId: hedgeId, tokenId: f.tokenId, tokenIndex: f.tokenIndex,
            side: 'SELL', price: hedgePrice, size: f.originalSize,
            originalSize: f.originalSize, purpose: 'hedge',
          });
          this.log('trade', `HEDGE: SELL ${side} @${hedgePrice.toFixed(2)} x${f.originalSize} (+${HEDGE_OFFSET_CENTS}¢)`);
        } catch (err: any) {
          this.log('error', `Hedge ${side}: ${err.message}`);
        }
      }
    }

    // If LP order was filled, trigger requote to re-enter
    if (filled.length > 0) {
      await this.requote();
    }
  }

  // ── Order Management ───────────────────────────────────

  private async cancelLpOrdersSide(tokenIndex: number) {
    if (!this.profile) return;
    const ids = this.orders
      .filter((o) => o.purpose === 'lp' && o.tokenIndex === tokenIndex && o.orderId !== 'unknown')
      .map((o) => o.orderId);
    if (ids.length > 0) {
      try {
        await cancelProfileOrders(this.profile, ids);
      } catch (err: any) {
        this.log('error', `Cancel: ${err.message}`);
      }
    }
    this.orders = this.orders.filter((o) => !(o.purpose === 'lp' && o.tokenIndex === tokenIndex));
  }

  private log(type: BotLogLine['type'], text: string) {
    const ts = Date.now();
    const time = new Date(ts).toISOString().slice(11, 19);
    const slug = this.market.slug.slice(0, 30);
    const formatted = `[${time}] [${slug}] ${text}`;
    this.logs.push({ text: formatted, type, timestamp: ts });
    if (this.logs.length > MAX_LOGS) this.logs = this.logs.slice(-MAX_LOGS);
    const tag = type.toUpperCase().padEnd(6);
    fileLog(`${new Date(ts).toISOString()} [${tag}] [${slug}] ${text}`);
  }
}

// ─── Bot Manager (Singleton) ─────────────────────────────

class BotManager {
  private bots = new Map<string, MarketBot>();

  async startBot(market: RewardMarket, profileId: string, capital: number): Promise<MarketBotStatus> {
    if (this.bots.has(market.id)) {
      throw new Error('Bot already running for this market');
    }
    const bot = new MarketBot(market, profileId, capital);
    this.bots.set(market.id, bot);
    await bot.start();
    return bot.getStatus();
  }

  async stopBot(marketId: string) {
    const bot = this.bots.get(marketId);
    if (!bot) throw new Error('Bot not found');
    await bot.stop();
    this.bots.delete(marketId);
  }

  getBot(marketId: string): MarketBot | undefined {
    return this.bots.get(marketId);
  }

  getAllStatuses(): MarketBotStatus[] {
    return Array.from(this.bots.values()).map((b) => b.getStatus());
  }

  getAllLogs(limit = 200): BotLogLine[] {
    const all: BotLogLine[] = [];
    for (const bot of this.bots.values()) {
      all.push(...bot.getLogs(limit));
    }
    return all.sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
  }
}

let manager: BotManager | null = null;

export function getBotManager(): BotManager {
  if (!manager) manager = new BotManager();
  return manager;
}

function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}
