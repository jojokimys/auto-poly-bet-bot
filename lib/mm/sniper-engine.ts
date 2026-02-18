import 'server-only';

import { prisma } from '@/lib/db/prisma';
import {
  loadProfile,
  placeProfileOrder,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';
import { getCryptoPrice } from '@/lib/polymarket/binance';
import { isConditionResolved, redeemPositions } from '@/lib/polymarket/redeem';
import { fetchBestBidAsk } from '@/lib/bot/orderbook';
import { findActiveCryptoMarkets } from './market-finder';
import type {
  SniperState,
  SniperConfig,
  SniperMarket,
  SniperDetail,
  SniperMarketInfo,
  ActiveMarket,
  MarketMode,
} from './types';
import { DEFAULT_SNIPER_CONFIG } from './types';
import type { BotLogEntry } from '@/lib/bot/types';

const MAX_LOG_BUFFER = 200;

const ASSET_TO_SYMBOL: Record<string, import('@/lib/polymarket/binance').CryptoSymbol> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
};

// ─── Sniper Instance ─────────────────────────────────────

interface PendingRedeem {
  conditionId: string;
  negRisk: boolean;
  yesTokenId: string;
  noTokenId: string;
  cryptoAsset: string;
  entryPrice: number;
  held: number;
  addedAt: number;
}

interface SniperInstance {
  profileId: string;
  profileName: string;
  profile: ProfileCredentials;
  state: SniperState;
  config: SniperConfig;
  activeMarkets: Map<string, SniperMarket>;
  pendingRedeems: Map<string, PendingRedeem>;
  priceCheckTimer: ReturnType<typeof setInterval> | null;
  marketScanTimer: ReturnType<typeof setInterval> | null;
  expiryTimer: ReturnType<typeof setInterval> | null;
  redeemTimer: ReturnType<typeof setInterval> | null;
  logBuffer: BotLogEntry[];
}

// Survive Next.js HMR
const globalForSniper = globalThis as unknown as { __sniperInstances: Map<string, SniperInstance> };
globalForSniper.__sniperInstances ??= new Map();
const instances = globalForSniper.__sniperInstances;

// ─── Logging ─────────────────────────────────────────────

function log(
  inst: SniperInstance,
  level: BotLogEntry['level'],
  event: string,
  message: string,
  data?: Record<string, unknown>,
) {
  const tagged = `[Sniper:${inst.profileName}] ${message}`;
  const entry: BotLogEntry = {
    id: crypto.randomUUID(),
    profileId: inst.profileId,
    profileName: inst.profileName,
    level,
    event: `sniper:${event}`,
    message: tagged,
    data,
    createdAt: new Date().toISOString(),
  };

  inst.logBuffer.push(entry);
  if (inst.logBuffer.length > MAX_LOG_BUFFER) {
    inst.logBuffer = inst.logBuffer.slice(-MAX_LOG_BUFFER);
  }

  prisma.botLog.create({
    data: { profileId: inst.profileId, level, event: `sniper:${event}`, message: tagged, data: data ? JSON.stringify(data) : null },
  }).catch(() => {});

  const prefix = `[sniper:${level}:${inst.profileName}]`;
  if (level === 'error') console.error(prefix, message, data ?? '');
  else console.log(prefix, message, data ?? '');
}

// ─── Position Sizing ─────────────────────────────────────

function calcPositionSize(priceDiffPct: number, config: SniperConfig): number {
  const absDiff = Math.abs(priceDiffPct);
  if (absDiff >= 0.005) return config.maxPositionSize;       // > 0.50%
  if (absDiff >= 0.003) return Math.min(7, config.maxPositionSize); // 0.30-0.50%
  return Math.min(5, config.maxPositionSize);                 // 0.15-0.30%
}

// ─── Exposure Calculation ────────────────────────────────

function calcTotalExposure(inst: SniperInstance): number {
  let exposure = 0;
  for (const m of inst.activeMarkets.values()) {
    if (m.entryPrice !== null && m.held > 0) {
      exposure += m.held * m.entryPrice;
    }
  }
  for (const p of inst.pendingRedeems.values()) {
    exposure += p.held * p.entryPrice;
  }
  return exposure;
}

// ─── Core: Price Check & Snipe ───────────────────────────

function countActivePositions(inst: SniperInstance): number {
  let count = 0;
  for (const m of inst.activeMarkets.values()) {
    if (m.entryTime !== null) count++;
  }
  return count + inst.pendingRedeems.size;
}

async function checkPriceAndSnipe(inst: SniperInstance): Promise<void> {
  if (inst.state.status !== 'running') return;

  for (const [, market] of inst.activeMarkets) {
    if (market.entryTime !== null) continue; // already entered

    const minutesLeft = (market.endTime.getTime() - Date.now()) / 60_000;
    if (minutesLeft < inst.config.minMinutesLeft || minutesLeft > inst.config.maxMinutesLeft) continue;

    // Concurrent position limit
    if (countActivePositions(inst) >= inst.config.maxConcurrentPositions) continue;

    // Exposure limit
    const exposure = calcTotalExposure(inst);
    inst.state.totalExposure = exposure;
    if (exposure >= inst.config.maxTotalExposure) continue;

    const symbol = ASSET_TO_SYMBOL[market.cryptoAsset];
    if (!symbol) continue;
    if (market.strikePrice === null) continue;

    try {
      const spotPrice = await getCryptoPrice(symbol);
      const priceDiffPct = (spotPrice - market.strikePrice) / market.strikePrice;

      if (Math.abs(priceDiffPct) < inst.config.minPriceDiffPct) {
        market.confidence = Math.abs(priceDiffPct) / inst.config.minPriceDiffPct;
        continue;
      }

      const direction: 'YES' | 'NO' = priceDiffPct > 0 ? 'YES' : 'NO';
      const tokenId = direction === 'YES' ? market.yesTokenId : market.noTokenId;

      // Check token price
      const book = await fetchBestBidAsk(tokenId);
      if (!book?.bestAsk || book.bestAsk > inst.config.maxTokenPrice) {
        log(inst, 'info', 'skip', `${market.cryptoAsset} ${direction} ask ${book?.bestAsk?.toFixed(2) ?? 'N/A'} > max ${inst.config.maxTokenPrice} — skipping`);
        continue;
      }

      const confidence = Math.abs(priceDiffPct) / inst.config.minPriceDiffPct;
      const usdcSize = calcPositionSize(priceDiffPct, inst.config);
      const size = Math.floor(usdcSize / book.bestAsk);

      if (size < 1) continue;

      // Place BUY order
      log(inst, 'info', 'entry', `${market.cryptoAsset} ${direction} — spot $${spotPrice.toFixed(2)}, strike $${market.strikePrice.toFixed(2)}, diff ${(priceDiffPct * 100).toFixed(3)}%, ask ${book.bestAsk.toFixed(2)}, size ${size}, confidence ${confidence.toFixed(1)}x`);

      await placeProfileOrder(inst.profile, {
        tokenId,
        side: 'BUY',
        price: book.bestAsk,
        size,
      });

      // Update market state
      market.direction = direction;
      market.entryPrice = book.bestAsk;
      market.entryTime = Date.now();
      market.confidence = confidence;
      market.tokenId = tokenId;
      market.held = size;

      inst.state.totalTrades++;
      inst.state.totalExposure = calcTotalExposure(inst);

      log(inst, 'trade', 'buy', `BUY ${direction} ${market.cryptoAsset} @${book.bestAsk.toFixed(2)} x ${size} (${minutesLeft.toFixed(1)}m left, confidence: ${confidence.toFixed(1)}x)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(inst, 'error', 'snipe', `${market.cryptoAsset} snipe error: ${msg}`);
    }
  }
}

// ─── Market Refresh ──────────────────────────────────────

function activeMarketToSniper(m: ActiveMarket): SniperMarket {
  return {
    ...m,
    direction: null,
    entryPrice: null,
    entryTime: null,
    confidence: 0,
    tokenId: null,
    held: 0,
  };
}

async function refreshMarkets(inst: SniperInstance): Promise<void> {
  if (inst.state.status !== 'running') return;

  try {
    const targetWindow = inst.config.mode === '5m' ? 5 : 15;
    // Use wider scan window: 0 to maxMinutesLeft + extra buffer for watching
    const markets = await findActiveCryptoMarkets(
      inst.config.assets,
      0, // minMinutes — include markets that are about to expire
      inst.config.maxMinutesLeft + 5, // scan buffer
      targetWindow,
    );

    for (const market of markets) {
      if (inst.activeMarkets.has(market.conditionId)) continue;

      inst.activeMarkets.set(market.conditionId, activeMarketToSniper(market));
      inst.state.activeMarkets = inst.activeMarkets.size;

      log(inst, 'info', 'market', `Watching: ${market.cryptoAsset} — ${market.question.slice(0, 60)} (strike: $${market.strikePrice?.toLocaleString() ?? '?'}, expires ${Math.round((market.endTime.getTime() - Date.now()) / 60000)}m)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(inst, 'warn', 'scan', `Market scan failed: ${msg}`);
  }
}

// ─── Expiry Check & Redeem Queue ─────────────────────────

async function checkExpiries(inst: SniperInstance): Promise<void> {
  const now = Date.now();

  for (const [conditionId, market] of inst.activeMarkets) {
    const msLeft = market.endTime.getTime() - now;

    // Market expired — remove and queue redeem if we have a position
    if (msLeft <= 0) {
      if (market.entryTime !== null && market.held > 0) {
        inst.pendingRedeems.set(conditionId, {
          conditionId,
          negRisk: market.negRisk,
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
          cryptoAsset: market.cryptoAsset,
          entryPrice: market.entryPrice ?? 0,
          held: market.held,
          addedAt: now,
        });
        log(inst, 'info', 'expiry', `${market.cryptoAsset} expired — queued for redeem (${market.direction} @${market.entryPrice?.toFixed(2)}, ${market.held} shares)`);
      } else {
        log(inst, 'info', 'expiry', `${market.cryptoAsset} expired — no position`);
      }

      inst.activeMarkets.delete(conditionId);
      inst.state.activeMarkets = inst.activeMarkets.size;
    }
  }
}

// ─── Redeem Check ────────────────────────────────────────

async function checkPendingRedeems(inst: SniperInstance): Promise<void> {
  if (inst.pendingRedeems.size === 0) return;

  const MAX_PENDING_MS = 60 * 60_000; // 60 min max wait

  for (const [conditionId, pending] of inst.pendingRedeems) {
    if (Date.now() - pending.addedAt > MAX_PENDING_MS) {
      log(inst, 'warn', 'redeem', `${pending.cryptoAsset} pending redeem timed out (60m) — removing`);
      inst.pendingRedeems.delete(conditionId);
      continue;
    }

    try {
      const resolved = await isConditionResolved(conditionId);
      if (!resolved) continue;

      log(inst, 'info', 'redeem', `${pending.cryptoAsset} condition resolved — redeeming on-chain...`);
      const result = await redeemPositions(
        inst.profile.privateKey,
        conditionId,
        pending.negRisk,
        pending.yesTokenId,
        pending.noTokenId,
      );

      if (result.success) {
        // Assume win: token resolved to $1, profit = (1 - entryPrice) * held - 2% fee
        const grossProfit = (1 - pending.entryPrice) * pending.held;
        const fee = 0.02 * pending.held; // 2% fee on winning
        const netProfit = grossProfit - fee;

        inst.state.wins++;
        inst.state.grossPnl += netProfit;

        const msg = result.txHash ? `tx: ${result.txHash.slice(0, 10)}...` : 'no tokens to redeem';
        log(inst, 'trade', 'redeem', `${pending.cryptoAsset} WIN! redeemed ${pending.held} shares @${pending.entryPrice.toFixed(2)} → net +$${netProfit.toFixed(3)} ${msg}`);
      } else {
        // Lost — tokens are worthless
        const loss = pending.entryPrice * pending.held;
        inst.state.losses++;
        inst.state.grossPnl -= loss;
        log(inst, 'trade', 'redeem', `${pending.cryptoAsset} LOSS — ${pending.held} shares @${pending.entryPrice.toFixed(2)} → -$${loss.toFixed(3)}: ${result.error}`);
      }

      inst.pendingRedeems.delete(conditionId);
      inst.state.totalExposure = calcTotalExposure(inst);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(inst, 'warn', 'redeem', `${pending.cryptoAsset} redeem check error: ${msg}`);
    }
  }
}

// ─── Public API ──────────────────────────────────────────

export async function startSniper(profileId: string, configOverrides?: Partial<SniperConfig>): Promise<SniperState> {
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

  const mode: MarketMode = configOverrides?.mode ?? '15m';
  const config: SniperConfig = { ...DEFAULT_SNIPER_CONFIG, ...configOverrides, mode };

  const inst: SniperInstance = {
    profileId,
    profileName: profile.name,
    profile,
    state: {
      status: 'running',
      startedAt: new Date().toISOString(),
      activeMarkets: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      grossPnl: 0,
      totalExposure: 0,
      error: null,
    },
    config,
    activeMarkets: new Map(),
    pendingRedeems: existing?.pendingRedeems ?? new Map(),
    priceCheckTimer: null,
    marketScanTimer: null,
    expiryTimer: null,
    redeemTimer: null,
    logBuffer: existing?.logBuffer ?? [],
  };

  instances.set(profileId, inst);

  log(inst, 'info', 'start', `Sniper started (mode: ${config.mode}, assets: ${config.assets.join(',')}, window: ${config.minMinutesLeft}-${config.maxMinutesLeft}m, minDiff: ${(config.minPriceDiffPct * 100).toFixed(2)}%, maxToken: ${config.maxTokenPrice}, maxPos: $${config.maxPositionSize})`);

  // Initial market scan
  await refreshMarkets(inst);

  // Timers
  inst.priceCheckTimer = setInterval(() => checkPriceAndSnipe(inst), config.priceCheckIntervalMs);
  inst.marketScanTimer = setInterval(() => refreshMarkets(inst), config.marketScanIntervalMs);
  inst.expiryTimer = setInterval(() => checkExpiries(inst), 5000);
  inst.redeemTimer = setInterval(() => checkPendingRedeems(inst), 30000);

  return { ...inst.state };
}

export async function stopSniper(profileId: string): Promise<SniperState> {
  const inst = instances.get(profileId);
  if (!inst) {
    return {
      status: 'stopped',
      startedAt: null,
      activeMarkets: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      grossPnl: 0,
      totalExposure: 0,
      error: null,
    };
  }

  inst.state.status = 'stopped';

  if (inst.priceCheckTimer) clearInterval(inst.priceCheckTimer);
  if (inst.marketScanTimer) clearInterval(inst.marketScanTimer);
  if (inst.expiryTimer) clearInterval(inst.expiryTimer);
  if (inst.redeemTimer) clearInterval(inst.redeemTimer);

  log(inst, 'info', 'stop', `Sniper stopped (trades: ${inst.state.totalTrades}, wins: ${inst.state.wins}, losses: ${inst.state.losses}, PnL: $${inst.state.grossPnl.toFixed(3)})`);

  return { ...inst.state };
}

export function getSniperState(profileId?: string): SniperState | Record<string, SniperState> {
  if (profileId) {
    const inst = instances.get(profileId);
    if (!inst) {
      return {
        status: 'stopped', startedAt: null, activeMarkets: 0,
        totalTrades: 0, wins: 0, losses: 0, grossPnl: 0,
        totalExposure: 0, error: null,
      };
    }
    return { ...inst.state };
  }

  const all: Record<string, SniperState> = {};
  for (const [id, inst] of instances) {
    all[id] = { ...inst.state };
  }
  return all;
}

export function getSniperDetail(profileId: string): SniperDetail | null {
  const inst = instances.get(profileId);
  if (!inst) return null;

  const now = Date.now();
  const markets: SniperMarketInfo[] = [...inst.activeMarkets.values()].map((m) => {
    const minutesLeft = Math.max(0, (m.endTime.getTime() - now) / 60_000);
    let status: 'watching' | 'entered' | 'expired' = 'watching';
    if (m.entryTime !== null) status = 'entered';
    if (minutesLeft <= 0) status = 'expired';

    return {
      conditionId: m.conditionId,
      question: m.question,
      cryptoAsset: m.cryptoAsset,
      endTime: m.endTime.toISOString(),
      strikePrice: m.strikePrice,
      minutesLeft,
      direction: m.direction,
      entryPrice: m.entryPrice,
      entryTime: m.entryTime,
      confidence: m.confidence,
      held: m.held,
      bestAsk: m.bestAsk,
      status,
    };
  });

  return {
    state: { ...inst.state },
    markets,
    config: { ...inst.config },
  };
}

export function getSniperLogs(profileId?: string, limit = 50): BotLogEntry[] {
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
