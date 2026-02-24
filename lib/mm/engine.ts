import 'server-only';

import { prisma } from '@/lib/db/prisma';
import {
  loadProfile,
  getClientForProfile,
  cancelAllProfileOrders,
  placeProfileOrder,
  getProfileBalance,
  getProfileOpenOrders,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';
import { getCryptoPrice } from '@/lib/polymarket/binance';
import {
  isConditionResolved,
  redeemPositions,
  mergePositions,
} from '@/lib/polymarket/redeem';
import { PolymarketWS } from './polymarket-ws';
import { RtdsWS } from './rtds-ws';
import { refreshVolatility } from './volatility';
import { calculateQuotes, type FairValueInput } from './quoter';
import { findActiveCryptoMarkets } from './market-finder';
import { takerFeePerShare } from './fees';
import {
  analyzeMispricing,
  realizedVolGarmanKlass,
  type MispricingResult,
} from './fair-value';
import type { MMState, MMConfig, ActiveMarket, BookSnapshot, VolatilityState, MarketMode, CryptoAsset, Candle } from './types';
import { DEFAULT_MM_CONFIG, MM_PRESETS } from './types';
import type { BotLogEntry } from '@/lib/bot/types';

const MAX_LOG_BUFFER = 200;

// ─── MM Instance ─────────────────────────────────────────

interface PendingRedeem {
  conditionId: string;
  negRisk: boolean;
  yesTokenId: string;
  noTokenId: string;
  cryptoAsset: string;
  addedAt: number;
}

interface MMInstance {
  profileId: string;
  profileName: string;
  profile: ProfileCredentials;
  state: MMState;
  config: MMConfig;
  ws: PolymarketWS;
  rtds: RtdsWS;
  activeMarkets: Map<string, ActiveMarket>; // conditionId → market
  assetToMarket: Map<string, string>; // assetId → conditionId
  pendingRedeems: Map<string, PendingRedeem>; // conditionId → pending redeem
  fairValues: Map<string, MispricingResult>; // conditionId → fair value analysis
  annualizedVol: Map<CryptoAsset, number>; // per-asset realized vol
  volatility: VolatilityState;
  marketFinderTimer: ReturnType<typeof setInterval> | null;
  volatilityTimer: ReturnType<typeof setInterval> | null;
  expiryCheckTimer: ReturnType<typeof setInterval> | null;
  circuitBreakerTimer: ReturnType<typeof setInterval> | null;
  fillCheckTimer: ReturnType<typeof setInterval> | null;
  redeemCheckTimer: ReturnType<typeof setInterval> | null;
  volCalcTimer: ReturnType<typeof setInterval> | null;
  logBuffer: BotLogEntry[];
  spotPrices: Map<string, { price: number; time: number }>; // asset → last spot
  cooldownUntil: number;
  lastQuoteTime: number;
}

// Survive Next.js HMR
const globalForMM = globalThis as unknown as { __mmInstances: Map<string, MMInstance> };
globalForMM.__mmInstances ??= new Map();
const instances = globalForMM.__mmInstances;

// ─── Logging ─────────────────────────────────────────────

function log(
  inst: MMInstance,
  level: BotLogEntry['level'],
  event: string,
  message: string,
  data?: Record<string, unknown>,
) {
  const tagged = `[MM:${inst.profileName}] ${message}`;
  const entry: BotLogEntry = {
    id: crypto.randomUUID(),
    profileId: inst.profileId,
    profileName: inst.profileName,
    level,
    event: `mm:${event}`,
    message: tagged,
    data,
    createdAt: new Date().toISOString(),
  };

  inst.logBuffer.push(entry);
  if (inst.logBuffer.length > MAX_LOG_BUFFER) {
    inst.logBuffer = inst.logBuffer.slice(-MAX_LOG_BUFFER);
  }

  prisma.botLog.create({
    data: { profileId: inst.profileId, level, event: `mm:${event}`, message: tagged, data: data ? JSON.stringify(data) : null },
  }).catch(() => {});

  const prefix = `[mm:${level}:${inst.profileName}]`;
  if (level === 'error') console.error(prefix, message, data ?? '');
  else console.log(prefix, message, data ?? '');
}

// ─── Exposure Calculation ────────────────────────────────

function calcTotalExposure(inst: MMInstance): number {
  let exposure = 0;
  for (const m of inst.activeMarkets.values()) {
    // Capital locked in filled positions
    if (m.yesEntryPrice !== null) exposure += m.yesHeld * m.yesEntryPrice;
    if (m.noEntryPrice !== null) exposure += m.noHeld * m.noEntryPrice;
    // Capital locked in pending orders (estimate)
    if (m.bidOrderId && m.bidPrice !== null) exposure += inst.config.maxPositionSize * m.bidPrice;
    if (m.askOrderId && m.askPrice !== null) exposure += inst.config.maxPositionSize * m.askPrice;
  }
  return exposure;
}

// ─── Order Management ────────────────────────────────────

async function cancelMarketOrders(inst: MMInstance, market: ActiveMarket): Promise<void> {
  try {
    const client = getClientForProfile(inst.profile);
    await client.cancelMarketOrders({ market: market.conditionId });
    market.bidOrderId = null;
    market.askOrderId = null;
    market.bidPrice = null;
    market.askPrice = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(inst, 'warn', 'cancel', `Failed to cancel orders for ${market.cryptoAsset}: ${msg}`);
  }
}

// ─── Balance Cache (avoid hammering CLOB API) ───────────

const BALANCE_CACHE_MS = 5_000;
let balanceCache: { value: number; time: number; profileId: string } | null = null;

async function getCachedBalance(inst: MMInstance): Promise<number> {
  const now = Date.now();
  if (balanceCache && balanceCache.profileId === inst.profileId && now - balanceCache.time < BALANCE_CACHE_MS) {
    return balanceCache.value;
  }
  const value = await getProfileBalance(inst.profile);
  balanceCache = { value, time: now, profileId: inst.profileId };
  return value;
}

async function placeQuotes(inst: MMInstance, market: ActiveMarket): Promise<void> {
  // P0: Don't place new quotes if one side is already filled.
  // The existing order on the other side stays — wait for round trip or timeout.
  if (market.yesFillTime !== null || market.noFillTime !== null) return;

  const { volatility, config, profile } = inst;

  if (Date.now() < inst.cooldownUntil) return;
  if (Date.now() - inst.lastQuoteTime < config.quoteRefreshMs) return;

  // Rate limit: update BEFORE any API calls to prevent WS floods
  inst.lastQuoteTime = Date.now();

  // Exposure limit check
  const exposure = calcTotalExposure(inst);
  inst.state.totalExposure = exposure;
  if (exposure >= config.maxTotalExposure) {
    if (market.bidOrderId || market.askOrderId) {
      await cancelMarketOrders(inst, market);
      log(inst, 'info', 'exposure', `Exposure $${exposure.toFixed(0)} >= limit $${config.maxTotalExposure} — pulling quotes for ${market.cryptoAsset}`);
    }
    return;
  }

  const balance = await getCachedBalance(inst);

  // Look up fair value for this market
  let fairValueInput: FairValueInput | null = null;
  if (config.enableFairValue) {
    const fv = inst.fairValues.get(market.conditionId);
    if (fv) {
      fairValueInput = { fairYesPrice: fv.fairYesPrice, edge: fv.edge };
    }
  }

  const quotes = calculateQuotes(market, volatility.regime, config, balance, 0.01, fairValueInput);

  if (!quotes) {
    if (market.bidOrderId || market.askOrderId) {
      await cancelMarketOrders(inst, market);
      log(inst, 'info', 'pull', `Pulled quotes: ${market.cryptoAsset} (regime: ${volatility.regime})`);
    }
    return;
  }

  // Check if quotes changed enough to warrant requote (> 0.5c)
  const bidChanged = market.bidPrice === null || Math.abs(quotes.bidPrice - market.bidPrice) >= 0.005;
  const askChanged = market.askPrice === null || Math.abs(quotes.askPrice - market.askPrice) >= 0.005;

  if (!bidChanged && !askChanged) return;

  // Cancel existing orders first
  if (market.bidOrderId || market.askOrderId) {
    await cancelMarketOrders(inst, market);
  }

  // Final NaN guard
  const bp = parseFloat(quotes.bidPrice.toFixed(2));
  const ap = parseFloat(quotes.askPrice.toFixed(2));
  const sz = Math.floor(quotes.size);
  if (!Number.isFinite(bp) || !Number.isFinite(ap) || !Number.isFinite(sz) || sz < 1 || bp <= 0 || ap <= 0) {
    log(inst, 'warn', 'quote', `Invalid quote values: bid=${bp} ask=${ap} size=${sz} — skipping`);
    return;
  }

  // Invalidate balance cache before placing orders (capital will be locked)
  balanceCache = null;

  try {
    const [bidResult, askResult] = await Promise.all([
      placeProfileOrder(profile, {
        tokenId: market.yesTokenId,
        side: 'BUY',
        price: bp,
        size: sz,
        postOnly: true,
      }),
      placeProfileOrder(profile, {
        tokenId: market.noTokenId,
        side: 'BUY',
        price: ap,
        size: sz,
        postOnly: true,
      }),
    ]);

    market.bidOrderId = (bidResult as any)?.orderID || 'placed';
    market.askOrderId = (askResult as any)?.orderID || 'placed';
    market.bidPrice = bp;
    market.askPrice = ap;
    inst.state.quotesPlaced += 2;

    const fvTag = fairValueInput ? ` fv:${fairValueInput.fairYesPrice.toFixed(2)} edge:${(fairValueInput.edge * 100).toFixed(1)}c` : '';
    log(inst, 'info', 'quote', `${market.cryptoAsset}: BUY YES @${bp} + BUY NO @${ap} × ${sz} (spread: ${((1 - bp - ap) * 100).toFixed(1)}c, regime: ${volatility.regime}${fvTag}) [postOnly]`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(inst, 'error', 'quote', `Failed to place quotes for ${market.cryptoAsset}: ${msg}`);
  }
}

// ─── Fill Detection & One-Side Sell ─────────────────────

/** Query actual token balance from CLOB to verify fills (with retry) */
async function getTokenBalanceCLOB(inst: MMInstance, tokenId: string): Promise<number> {
  const client = getClientForProfile(inst.profile);
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const bal = await client.getBalanceAllowance({
        asset_type: 'CONDITIONAL' as any,
        token_id: tokenId,
      });
      return parseFloat(bal.balance) / 1e6;
    } catch (err) {
      if (attempt < maxRetries && (err instanceof AggregateError || (err instanceof Error && /ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message)))) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  return 0;
}

async function checkFills(inst: MMInstance): Promise<void> {
  if (inst.state.status !== 'running') return;
  if (inst.activeMarkets.size === 0) return;

  try {
    const openOrders = await getProfileOpenOrders(inst.profile);
    const openById = new Map<string, any>();
    for (const o of openOrders) openById.set(o.id, o);

    for (const market of inst.activeMarkets.values()) {
      // ── Check YES side (bidOrderId) ──
      if (market.bidOrderId && market.bidOrderId !== 'placed' && market.yesFillTime === null) {
        const openOrder = openById.get(market.bidOrderId);

        if (openOrder) {
          // Order still open — check for partial fill
          const matched = parseFloat(openOrder.size_matched || '0');
          if (matched > 0) {
            // Partial fill detected — cancel remainder and treat as fill
            log(inst, 'info', 'partial-fill', `${market.cryptoAsset} YES partial fill (${matched} matched) — cancelling remainder`);
            try {
              const client = getClientForProfile(inst.profile);
              await client.cancelOrder({ orderID: market.bidOrderId });
            } catch { /* cancel best-effort */ }
            // Confirm with balance
            try {
              const actual = await getTokenBalanceCLOB(inst, market.yesTokenId);
              if (actual > market.yesHeld) market.yesHeld = Math.round(actual);
            } catch { market.yesHeld += Math.floor(matched); }
            market.bidOrderId = null;
            market.yesFillTime = Date.now();
            market.yesEntryPrice = market.bidPrice;
            inst.state.fillsBuy++;
            log(inst, 'trade', 'fill', `${market.cryptoAsset} YES filled (partial) @${market.yesEntryPrice} × ${market.yesHeld}`);
            // Also cancel NO side — we now have inventory, wait for round trip or timeout
            if (market.askOrderId) {
              try {
                const client = getClientForProfile(inst.profile);
                if (market.askOrderId !== 'placed') await client.cancelOrder({ orderID: market.askOrderId });
              } catch { /* best-effort */ }
              market.askOrderId = null;
              market.askPrice = null;
            }
          }
        } else {
          // Order gone — verify fill with actual token balance
          let fillConfirmed = false;
          try {
            const actual = await getTokenBalanceCLOB(inst, market.yesTokenId);
            if (actual > market.yesHeld) {
              fillConfirmed = true;
              market.yesHeld = Math.round(actual);
            } else {
              log(inst, 'info', 'cancel-detected', `${market.cryptoAsset} YES order gone but balance unchanged (${actual}) — not a fill`);
            }
          } catch {
            fillConfirmed = true;
            market.yesHeld += Math.floor(inst.config.maxPositionSize);
            log(inst, 'warn', 'fill-check', `${market.cryptoAsset} YES balance check failed, assuming fill`);
          }
          market.bidOrderId = null;
          if (fillConfirmed) {
            market.yesFillTime = Date.now();
            market.yesEntryPrice = market.bidPrice;
            inst.state.fillsBuy++;
            log(inst, 'trade', 'fill', `${market.cryptoAsset} YES filled @${market.yesEntryPrice} × ${market.yesHeld}`);
          }
        }
      }

      // ── Check NO side (askOrderId) ──
      if (market.askOrderId && market.askOrderId !== 'placed' && market.noFillTime === null) {
        const openOrder = openById.get(market.askOrderId);

        if (openOrder) {
          const matched = parseFloat(openOrder.size_matched || '0');
          if (matched > 0) {
            log(inst, 'info', 'partial-fill', `${market.cryptoAsset} NO partial fill (${matched} matched) — cancelling remainder`);
            try {
              const client = getClientForProfile(inst.profile);
              await client.cancelOrder({ orderID: market.askOrderId });
            } catch { /* best-effort */ }
            try {
              const actual = await getTokenBalanceCLOB(inst, market.noTokenId);
              if (actual > market.noHeld) market.noHeld = Math.round(actual);
            } catch { market.noHeld += Math.floor(matched); }
            market.askOrderId = null;
            market.noFillTime = Date.now();
            market.noEntryPrice = market.askPrice;
            inst.state.fillsBuy++;
            log(inst, 'trade', 'fill', `${market.cryptoAsset} NO filled (partial) @${market.noEntryPrice} × ${market.noHeld}`);
            if (market.bidOrderId) {
              try {
                const client = getClientForProfile(inst.profile);
                if (market.bidOrderId !== 'placed') await client.cancelOrder({ orderID: market.bidOrderId });
              } catch { /* best-effort */ }
              market.bidOrderId = null;
              market.bidPrice = null;
            }
          }
        } else {
          let fillConfirmed = false;
          try {
            const actual = await getTokenBalanceCLOB(inst, market.noTokenId);
            if (actual > market.noHeld) {
              fillConfirmed = true;
              market.noHeld = Math.round(actual);
            } else {
              log(inst, 'info', 'cancel-detected', `${market.cryptoAsset} NO order gone but balance unchanged (${actual}) — not a fill`);
            }
          } catch {
            fillConfirmed = true;
            market.noHeld += Math.floor(inst.config.maxPositionSize);
            log(inst, 'warn', 'fill-check', `${market.cryptoAsset} NO balance check failed, assuming fill`);
          }
          market.askOrderId = null;
          if (fillConfirmed) {
            market.noFillTime = Date.now();
            market.noEntryPrice = market.askPrice;
            inst.state.fillsBuy++;
            log(inst, 'trade', 'fill', `${market.cryptoAsset} NO filled @${market.noEntryPrice} × ${market.noHeld}`);
          }
        }
      }

      // ── Both sides filled → round trip! Merge to recover capital. ──
      if (market.yesFillTime !== null && market.noFillTime !== null && market.yesEntryPrice !== null && market.noEntryPrice !== null) {
        const cost = market.yesEntryPrice + market.noEntryPrice;
        const profit = 1 - cost;
        const shares = Math.min(market.yesHeld, market.noHeld);
        inst.state.roundTrips++;
        inst.state.grossPnl += profit * shares;
        log(inst, 'trade', 'round-trip', `${market.cryptoAsset} round trip! cost=${cost.toFixed(3)} profit=${(profit * shares).toFixed(3)} (${shares} shares)`);

        // Merge YES+NO → USDC on-chain to recover capital immediately
        triggerMerge(inst, market).catch(() => {});

        // Reset fill tracking
        market.yesFillTime = null;
        market.noFillTime = null;
      }

      // ── One-side fill timeout → SELL to close ──
      const now = Date.now();
      const timeout = inst.config.oneSideFillTimeoutMs;

      if (market.yesFillTime !== null && market.noFillTime === null && (now - market.yesFillTime) > timeout) {
        await sellPosition(inst, market, 'yes');
      }
      if (market.noFillTime !== null && market.yesFillTime === null && (now - market.noFillTime) > timeout) {
        await sellPosition(inst, market, 'no');
      }
    }

    inst.state.totalExposure = calcTotalExposure(inst);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(inst, 'warn', 'fill-check', `Fill check failed: ${msg}`);
  }
}

async function sellPosition(inst: MMInstance, market: ActiveMarket, side: 'yes' | 'no'): Promise<void> {
  const tokenId = side === 'yes' ? market.yesTokenId : market.noTokenId;
  const held = side === 'yes' ? market.yesHeld : market.noHeld;
  const entryPrice = side === 'yes' ? market.yesEntryPrice : market.noEntryPrice;

  if (held <= 0) return;

  try {
    // Get current best bid to sell at
    const { fetchBestBidAsk } = await import('@/lib/bot/orderbook');
    const book = await fetchBestBidAsk(tokenId);
    if (!book || book.bestBid === null || book.bestBid <= 0) {
      log(inst, 'warn', 'sell', `${market.cryptoAsset} ${side.toUpperCase()} no bid to sell into`);
      return;
    }

    const sellPrice = parseFloat(book.bestBid.toFixed(2));

    // Fee-aware: skip sell if loss after taker fees > 10c/share (hold to expiry instead)
    const fee = takerFeePerShare(sellPrice);
    const netSellPrice = sellPrice - fee;
    const lossPerShare = (entryPrice ?? 0) - netSellPrice;
    if (lossPerShare > 0.10) {
      log(inst, 'info', 'sell', `${market.cryptoAsset} ${side.toUpperCase()} sell would lose ${(lossPerShare * 100).toFixed(1)}c/share after fees — holding to expiry`);
      return;
    }

    await placeProfileOrder(inst.profile, {
      tokenId,
      side: 'SELL',
      price: sellPrice,
      size: held,
    });

    const pnl = (netSellPrice - (entryPrice ?? 0)) * held;
    inst.state.fillsSell++;
    inst.state.grossPnl += pnl;

    log(inst, 'trade', 'sell', `${market.cryptoAsset} SELL ${side.toUpperCase()} @${sellPrice} × ${held} (pnl: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)})`);

    // Reset
    if (side === 'yes') {
      market.yesHeld = 0;
      market.yesFillTime = null;
      market.yesEntryPrice = null;
    } else {
      market.noHeld = 0;
      market.noFillTime = null;
      market.noEntryPrice = null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(inst, 'error', 'sell', `Failed to sell ${market.cryptoAsset} ${side.toUpperCase()}: ${msg}`);
  }
}

// ─── On-Chain Merge (round trips) ────────────────────────

async function triggerMerge(inst: MMInstance, market: ActiveMarket): Promise<void> {
  try {
    log(inst, 'info', 'merge', `${market.cryptoAsset} merging YES+NO → USDC...`);
    const result = await mergePositions(
      inst.profile,
      market.conditionId,
      market.negRisk,
      market.yesTokenId,
      market.noTokenId,
    );
    if (result.success && result.txHash) {
      log(inst, 'trade', 'merge', `${market.cryptoAsset} merged! tx: ${result.txHash.slice(0, 10)}...`);
      market.yesHeld = 0;
      market.noHeld = 0;
    } else if (result.error) {
      log(inst, 'warn', 'merge', `${market.cryptoAsset} merge failed: ${result.error}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(inst, 'warn', 'merge', `${market.cryptoAsset} merge error: ${msg}`);
  }
}

// ─── On-Chain Redeem (after resolution) ──────────────────

async function checkPendingRedeems(inst: MMInstance): Promise<void> {
  if (inst.pendingRedeems.size === 0) return;

  const MAX_PENDING_MS = 60 * 60_000; // 60 min max wait

  for (const [conditionId, pending] of inst.pendingRedeems) {
    // Remove if too old
    if (Date.now() - pending.addedAt > MAX_PENDING_MS) {
      log(inst, 'warn', 'redeem', `${pending.cryptoAsset} pending redeem timed out (60m) — removing`);
      inst.pendingRedeems.delete(conditionId);
      continue;
    }

    try {
      const resolved = await isConditionResolved(conditionId);
      if (!resolved) continue; // not yet resolved, check next cycle

      log(inst, 'info', 'redeem', `${pending.cryptoAsset} condition resolved — redeeming on-chain...`);
      const result = await redeemPositions(
        inst.profile,
        conditionId,
        pending.negRisk,
        pending.yesTokenId,
        pending.noTokenId,
      );

      if (result.success) {
        const msg = result.txHash ? `tx: ${result.txHash.slice(0, 10)}...` : 'no tokens to redeem';
        log(inst, 'trade', 'redeem', `${pending.cryptoAsset} redeemed! ${msg}`);
      } else {
        log(inst, 'warn', 'redeem', `${pending.cryptoAsset} redeem failed: ${result.error}`);
      }
      inst.pendingRedeems.delete(conditionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(inst, 'warn', 'redeem', `${pending.cryptoAsset} redeem check error: ${msg}`);
    }
  }
}

// ─── WS Disconnect Handler ───────────────────────────────

function handleWSDisconnect(inst: MMInstance): void {
  if (inst.state.status !== 'running') return;

  log(inst, 'warn', 'ws-disconnect', 'WebSocket disconnected — cancelling all quotes to prevent stale fills');

  // Cancel all orders so stale quotes don't get adversely filled
  for (const market of inst.activeMarkets.values()) {
    cancelMarketOrders(inst, market).catch(() => {});
  }

  // Brief cooldown to allow reconnection before re-quoting
  inst.cooldownUntil = Math.max(inst.cooldownUntil, Date.now() + 10_000);
}

// ─── Book Update Handler ─────────────────────────────────

function handleBookUpdate(inst: MMInstance, book: BookSnapshot): void {
  const conditionId = inst.assetToMarket.get(book.assetId);
  if (!conditionId) return;

  const market = inst.activeMarkets.get(conditionId);
  if (!market) return;

  if (book.buys.length > 0) {
    const bids = book.buys.map((b) => parseFloat(b.price)).filter((p) => p > 0);
    if (bids.length > 0) market.bestBid = Math.max(...bids);
  }
  if (book.sells.length > 0) {
    const asks = book.sells.map((s) => parseFloat(s.price)).filter((p) => p > 0);
    if (asks.length > 0) market.bestAsk = Math.min(...asks);
  }

  if (market.bestBid !== null && market.bestAsk !== null) {
    market.midpoint = (market.bestBid + market.bestAsk) / 2;
  }

  placeQuotes(inst, market).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(inst, 'error', 'requote', `Requote error: ${msg}`);
  });
}

// ─── Circuit Breaker ─────────────────────────────────────

const ASSET_TO_SYMBOL: Record<string, import('@/lib/polymarket/binance').CryptoSymbol> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
};

async function checkCircuitBreaker(inst: MMInstance): Promise<void> {
  // Collect unique assets from active markets
  const activeAssets = new Set<string>();
  for (const market of inst.activeMarkets.values()) {
    activeAssets.add(market.cryptoAsset);
  }
  if (activeAssets.size === 0) return;

  const now = Date.now();

  for (const asset of activeAssets) {
    const symbol = ASSET_TO_SYMBOL[asset];
    if (!symbol) continue;

    try {
      // Prefer RTDS sync read (free, no API call), fallback to Binance REST
      let price: number;
      const rtdsPrice = inst.rtds.getSpotPrice(asset as CryptoAsset);
      if (rtdsPrice !== null) {
        price = rtdsPrice;
      } else {
        price = await getCryptoPrice(symbol);
      }
      const prev = inst.spotPrices.get(asset);

      if (prev && prev.price > 0) {
        const elapsed = (now - prev.time) / 1000;
        if (elapsed < 120) {
          const pctChange = Math.abs(price - prev.price) / prev.price;
          if (pctChange >= inst.config.circuitBreakerPct) {
            log(inst, 'warn', 'circuit-breaker', `${asset} moved ${(pctChange * 100).toFixed(2)}% in ${elapsed.toFixed(0)}s — pulling all quotes, 60s cooldown`);

            for (const market of inst.activeMarkets.values()) {
              await cancelMarketOrders(inst, market);
            }
            inst.cooldownUntil = Math.max(inst.cooldownUntil, now + 60_000);
            inst.volatility = { ...inst.volatility, regime: 'volatile' };
            // One asset tripped → cooldown applies globally, no need to check others
            inst.spotPrices.set(asset, { price, time: now });
            return;
          }
        }
      }

      inst.spotPrices.set(asset, { price, time: now });
    } catch {
      // Ignore individual price fetch errors
    }
  }
}

// ─── RTDS Price Handler ──────────────────────────────────

function handleRtdsPrice(inst: MMInstance, asset: CryptoAsset, spotPrice: number): void {
  if (inst.state.status !== 'running') return;
  if (!inst.config.enableFairValue) return;

  inst.state.rtdsConnected = inst.rtds.isConnected();

  // Update fair values for all active markets matching this asset
  for (const [conditionId, market] of inst.activeMarkets) {
    if (market.cryptoAsset !== asset) continue;
    if (market.strikePrice === null || market.midpoint === null) continue;

    const minutesLeft = Math.max(0, (market.endTime.getTime() - Date.now()) / 60_000);
    if (minutesLeft <= 0) continue;

    const sigma = inst.annualizedVol.get(asset) ?? 0.6; // fallback 60%
    const result = analyzeMispricing(
      spotPrice,
      market.strikePrice,
      sigma,
      minutesLeft,
      market.midpoint,
      inst.config.minEdgeCents,
    );

    inst.fairValues.set(conditionId, result);
  }
}

/** Calculate realized vol from kline data for each active asset */
async function refreshVolEstimates(inst: MMInstance): Promise<void> {
  const activeAssets = new Set<CryptoAsset>();
  for (const market of inst.activeMarkets.values()) {
    activeAssets.add(market.cryptoAsset as CryptoAsset);
  }

  for (const asset of activeAssets) {
    try {
      const symbol = `${asset}USDT`;
      const { fetchKlines } = await import('@/lib/mm/volatility');
      const candles: Candle[] = await fetchKlines(symbol, '1m', 60);
      if (candles.length >= 10) {
        const vol = realizedVolGarmanKlass(candles);
        if (vol > 0 && Number.isFinite(vol)) {
          inst.annualizedVol.set(asset, vol);
        }
      }
    } catch {
      // Keep previous estimate
    }
  }
}

// ─── Market Lifecycle ────────────────────────────────────

async function refreshMarkets(inst: MMInstance): Promise<void> {
  if (inst.state.status !== 'running') return;

  try {
    const targetWindow = inst.config.mode === '5m' ? 5 : 15;
    const markets = await findActiveCryptoMarkets(inst.config.assets, inst.config.minMinutes, inst.config.maxMinutes, targetWindow);

    for (const market of markets) {
      if (inst.activeMarkets.has(market.conditionId)) continue;

      inst.activeMarkets.set(market.conditionId, market);
      inst.assetToMarket.set(market.yesTokenId, market.conditionId);
      inst.assetToMarket.set(market.noTokenId, market.conditionId);

      inst.ws.subscribe([market.yesTokenId, market.noTokenId]);

      inst.state.activeMarkets = inst.activeMarkets.size;
      log(inst, 'info', 'market', `New market: ${market.cryptoAsset} — ${market.question.slice(0, 60)} (expires ${Math.round((market.endTime.getTime() - Date.now()) / 60000)}m)`);

      const { fetchBestBidAsk } = await import('@/lib/bot/orderbook');
      const yesBook = await fetchBestBidAsk(market.yesTokenId);
      if (yesBook && yesBook.bestBid !== null && yesBook.bestAsk !== null) {
        market.bestBid = yesBook.bestBid;
        market.bestAsk = yesBook.bestAsk;
        market.midpoint = (yesBook.bestBid + yesBook.bestAsk) / 2;
        await placeQuotes(inst, market);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(inst, 'warn', 'market-finder', `Market scan failed: ${msg}`);
  }
}

async function checkExpiries(inst: MMInstance): Promise<void> {
  const now = Date.now();

  for (const [conditionId, market] of inst.activeMarkets) {
    const msLeft = market.endTime.getTime() - now;

    if (msLeft <= inst.config.preExpiryPullMs) {
      log(inst, 'info', 'expiry', `${market.cryptoAsset} expiring in ${Math.round(msLeft / 1000)}s — pulling quotes`);
      await cancelMarketOrders(inst, market);
      inst.ws.unsubscribe([market.yesTokenId, market.noTokenId]);
      inst.assetToMarket.delete(market.yesTokenId);
      inst.assetToMarket.delete(market.noTokenId);

      // Queue for on-chain redeem after resolution
      if (market.yesHeld > 0 || market.noHeld > 0) {
        inst.pendingRedeems.set(conditionId, {
          conditionId,
          negRisk: market.negRisk,
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
          cryptoAsset: market.cryptoAsset,
          addedAt: Date.now(),
        });
        log(inst, 'info', 'redeem', `${market.cryptoAsset} queued for on-chain redeem (YES: ${market.yesHeld}, NO: ${market.noHeld})`);
      }

      inst.activeMarkets.delete(conditionId);
      inst.state.activeMarkets = inst.activeMarkets.size;
    }
  }
}

// ─── Public API ──────────────────────────────────────────

export async function startMM(profileId: string, configOverrides?: Partial<MMConfig>): Promise<MMState> {
  const existing = instances.get(profileId);
  if (existing && existing.state.status === 'running') {
    return { ...existing.state };
  }

  const profile = await loadProfile(profileId);
  if (!profile) throw new Error('Profile not found');

  const dbProfile = await prisma.botProfile.findUnique({
    where: { id: profileId },
    select: { isActive: true },
  });
  if (!dbProfile?.isActive) throw new Error('Profile not active');

  // Build config: start from mode preset, then apply overrides
  const mode: MarketMode = configOverrides?.mode ?? '15m';
  const basePreset = MM_PRESETS[mode];
  const config: MMConfig = { ...basePreset, ...configOverrides, mode };

  const volatility = await refreshVolatility(config.klineInterval);

  const ws = new PolymarketWS();
  const rtds = new RtdsWS();

  const inst: MMInstance = {
    profileId,
    profileName: profile.name,
    profile,
    state: {
      status: 'running',
      startedAt: new Date().toISOString(),
      volatilityRegime: volatility.regime,
      activeMarkets: 0,
      quotesPlaced: 0,
      fillsBuy: 0,
      fillsSell: 0,
      roundTrips: 0,
      grossPnl: 0,
      totalExposure: 0,
      rtdsConnected: false,
      error: null,
    },
    config,
    ws,
    rtds,
    activeMarkets: new Map(),
    assetToMarket: new Map(),
    pendingRedeems: existing?.pendingRedeems ?? new Map(),
    fairValues: new Map(),
    annualizedVol: new Map(),
    volatility,
    marketFinderTimer: null,
    volatilityTimer: null,
    expiryCheckTimer: null,
    circuitBreakerTimer: null,
    fillCheckTimer: null,
    redeemCheckTimer: null,
    volCalcTimer: null,
    logBuffer: existing?.logBuffer ?? [],
    spotPrices: new Map(),
    cooldownUntil: 0,
    lastQuoteTime: 0,
  };

  instances.set(profileId, inst);

  log(inst, 'info', 'start', `Market maker started (mode: ${config.mode}, regime: ${volatility.regime}, maxPos: ${config.maxPositionSize}, exposure: $${config.maxTotalExposure}, range: ${config.minMinutes}-${config.maxMinutes}m)`);

  ws.connect(
    [],
    (book) => handleBookUpdate(inst, book),
    () => handleWSDisconnect(inst),
  );

  // Connect RTDS for real-time spot prices → fair value computation
  if (config.enableFairValue) {
    rtds.connect((asset, price) => handleRtdsPrice(inst, asset, price));
    log(inst, 'info', 'rtds', 'RTDS WebSocket connecting for real-time spot prices');
  }

  await refreshMarkets(inst);

  // Periodic tasks — intervals scale with market mode
  const fast = config.mode === '5m';
  inst.marketFinderTimer = setInterval(() => refreshMarkets(inst), fast ? 60_000 : 120_000);
  inst.volatilityTimer = setInterval(async () => {
    const v = await refreshVolatility(inst.config.klineInterval);
    const prevRegime = inst.volatility.regime;
    inst.volatility = v;
    inst.state.volatilityRegime = v.regime;

    if (prevRegime !== v.regime) {
      log(inst, 'info', 'volatility', `Regime: ${prevRegime} → ${v.regime} (ATRP: ${v.atrpPercentile}%, BBW: ${v.bbwPercentile}%, ratio: ${v.atrRatio})`);

      if (v.regime === 'volatile') {
        for (const market of inst.activeMarkets.values()) {
          await cancelMarketOrders(inst, market);
        }
      }
    }
  }, fast ? 30_000 : 60_000);
  inst.expiryCheckTimer = setInterval(() => checkExpiries(inst), fast ? 5_000 : 10_000);
  inst.circuitBreakerTimer = setInterval(() => checkCircuitBreaker(inst), config.enableFairValue ? 2_000 : 5_000);
  inst.fillCheckTimer = setInterval(() => checkFills(inst), fast ? 3_000 : 5_000);
  inst.redeemCheckTimer = setInterval(() => checkPendingRedeems(inst), 60_000);

  // Volatility estimation for fair value (every 60s)
  if (config.enableFairValue) {
    refreshVolEstimates(inst).catch(() => {}); // initial estimate
    inst.volCalcTimer = setInterval(() => refreshVolEstimates(inst), 60_000);
  }

  return { ...inst.state };
}

export async function stopMM(profileId: string): Promise<MMState> {
  const inst = instances.get(profileId);
  if (!inst) {
    return {
      status: 'stopped',
      startedAt: null,
      volatilityRegime: 'volatile',
      activeMarkets: 0,
      quotesPlaced: 0,
      fillsBuy: 0,
      fillsSell: 0,
      roundTrips: 0,
      grossPnl: 0,
      totalExposure: 0,
      rtdsConnected: false,
      error: null,
    };
  }

  inst.state.status = 'stopped';

  // Clear all timers
  if (inst.marketFinderTimer) clearInterval(inst.marketFinderTimer);
  if (inst.volatilityTimer) clearInterval(inst.volatilityTimer);
  if (inst.expiryCheckTimer) clearInterval(inst.expiryCheckTimer);
  if (inst.circuitBreakerTimer) clearInterval(inst.circuitBreakerTimer);
  if (inst.fillCheckTimer) clearInterval(inst.fillCheckTimer);
  if (inst.redeemCheckTimer) clearInterval(inst.redeemCheckTimer);
  if (inst.volCalcTimer) clearInterval(inst.volCalcTimer);

  // Disconnect RTDS
  inst.rtds.disconnect();

  // Cancel all orders
  try {
    await cancelAllProfileOrders(inst.profile);
  } catch {}

  inst.ws.disconnect();

  log(inst, 'info', 'stop', `Market maker stopped (quotes: ${inst.state.quotesPlaced}, fills: ${inst.state.fillsBuy}/${inst.state.fillsSell}, PnL: $${inst.state.grossPnl.toFixed(3)})`);

  return { ...inst.state };
}

export function getMMState(profileId?: string): MMState | Record<string, MMState> {
  if (profileId) {
    const inst = instances.get(profileId);
    if (!inst) {
      return {
        status: 'stopped', startedAt: null, volatilityRegime: 'volatile',
        activeMarkets: 0, quotesPlaced: 0, fillsBuy: 0, fillsSell: 0,
        roundTrips: 0, grossPnl: 0, totalExposure: 0, rtdsConnected: false, error: null,
      };
    }
    return { ...inst.state };
  }

  const all: Record<string, MMState> = {};
  for (const [id, inst] of instances) {
    all[id] = { ...inst.state };
  }
  return all;
}

export function getMMDetail(profileId: string) {
  const inst = instances.get(profileId);
  if (!inst) return null;

  const now = Date.now();
  const markets = [...inst.activeMarkets.values()].map((m) => {
    const fv = inst.fairValues.get(m.conditionId);
    return {
      conditionId: m.conditionId,
      question: m.question,
      cryptoAsset: m.cryptoAsset,
      endTime: m.endTime.toISOString(),
      bestBid: m.bestBid,
      bestAsk: m.bestAsk,
      midpoint: m.midpoint,
      bidPrice: m.bidPrice,
      askPrice: m.askPrice,
      yesHeld: m.yesHeld,
      noHeld: m.noHeld,
      minutesLeft: Math.max(0, (m.endTime.getTime() - now) / 60_000),
      strikePrice: m.strikePrice,
      // Fair value fields
      fairYesPrice: fv?.fairYesPrice ?? null,
      edge: fv ? Math.round(fv.edge * 10000) / 10000 : null, // 4 decimal places
      signal: fv?.signal ?? null,
      confidence: fv?.confidence ?? null,
      spotPrice: m.cryptoAsset ? (inst.rtds.getSpotPrice(m.cryptoAsset as CryptoAsset) ?? null) : null,
    };
  });

  return {
    state: { ...inst.state },
    markets,
    volatility: { ...inst.volatility },
    config: { ...inst.config },
  };
}

export function getMMLogs(profileId?: string, limit = 50): BotLogEntry[] {
  if (profileId) {
    return instances.get(profileId)?.logBuffer.slice(-limit) ?? [];
  }

  const all: BotLogEntry[] = [];
  for (const inst of instances.values()) {
    all.push(...inst.logBuffer);
  }
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return all.slice(-limit);
}
