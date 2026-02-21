import 'server-only';

import { prisma } from '@/lib/db/prisma';
import {
  loadProfile,
  placeProfileOrder,
  getProfileBalance,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';
import { getCryptoPrice } from '@/lib/polymarket/binance';
import { redeemPositions, fetchClaimablePositions } from '@/lib/polymarket/redeem';
import { fetchBestBidAsk } from '@/lib/bot/orderbook';
import { Wallet } from '@ethersproject/wallet';
import { findActiveCryptoMarkets } from './market-finder';
import { logTrade } from './trade-logger';
import type {
  SniperState,
  SniperConfig,
  SniperMarket,
  SniperDetail,
  SniperMarketInfo,
  ActiveMarket,
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
  direction: 'YES' | 'NO';
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
  claimTimer: ReturnType<typeof setInterval> | null;
  logBuffer: BotLogEntry[];
  priceCheckRunning: boolean; // prevent overlapping checkPriceAndSnipe calls
  claimScanRunning: boolean;  // prevent overlapping auto-claim scans
  lastBalance: number;        // cached balance for position sizing
  lastBalanceAt: number;      // timestamp of last balance fetch
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

// ─── Asset Volatility Multiplier ─────────────────────────
// Altcoins are more volatile than BTC — same priceDiff is less "safe".
// Higher multiplier = stricter threshold = fewer but higher-quality entries.
// Based on typical 1-minute price swing ranges:
//   BTC ~0.03-0.05%, ETH ~0.05-0.08%, SOL ~0.10-0.20%, XRP ~0.08-0.15%

const ASSET_VOLATILITY_MULT: Record<string, number> = {
  BTC: 1.0,    // baseline — most stable
  ETH: 1.2,    // slightly more volatile
  SOL: 1.6,    // more volatile but still tradeable
  XRP: 1.4,    // moderate volatility
};

// ─── Adaptive Threshold ──────────────────────────────────
// Near expiry → lower threshold (price has less time to reverse)
// Further from expiry → higher threshold (need more safety margin)
// Asset volatility scales the base diff so altcoins need bigger leads.

function getAdaptiveMinDiff(minutesLeft: number, baseDiff: number, asset: string): number {
  const volMult = ASSET_VOLATILITY_MULT[asset] ?? 1.5;
  const assetDiff = baseDiff * volMult;

  // 0.3-1.0m window — 6 tiers for fine-grained control
  if (minutesLeft <= 0.35) return assetDiff * 0.35;  // ~20s, 거의 확정
  if (minutesLeft <= 0.45) return assetDiff * 0.50;  // ~27s
  if (minutesLeft <= 0.55) return assetDiff * 0.65;  // ~33s
  if (minutesLeft <= 0.70) return assetDiff * 0.80;  // ~42s
  if (minutesLeft <= 0.85) return assetDiff * 0.90;  // ~51s
  return assetDiff;                                    // ~60s, 풀 기준
}

// ─── Balance Cache ───────────────────────────────────────

const BALANCE_CACHE_MS = 10_000; // 10s cache to avoid excessive API calls

async function getCachedBalance(inst: SniperInstance): Promise<number> {
  if (Date.now() - inst.lastBalanceAt < BALANCE_CACHE_MS) return inst.lastBalance;
  try {
    const balance = await getProfileBalance(inst.profile);
    inst.lastBalance = balance;
    inst.lastBalanceAt = Date.now();
    return balance;
  } catch {
    return inst.lastBalance; // fallback to last known balance
  }
}

// ─── Position Sizing ─────────────────────────────────────
// Scales with price confidence, time proximity, AND available balance

function calcPositionSize(priceDiffPct: number, minutesLeft: number, balance: number, config: SniperConfig): number {
  const maxPosition = balance * config.maxPositionPct;
  if (maxPosition < 1) return 0; // balance too low

  const absDiff = Math.abs(priceDiffPct);

  // Base size from price diff confidence
  let size: number;
  if (absDiff >= 0.005) size = maxPosition;             // > 0.50% — max conviction
  else if (absDiff >= 0.003) size = maxPosition * 0.75; // 0.30-0.50%
  else if (absDiff >= 0.002) size = maxPosition * 0.55; // 0.20-0.30%
  else size = maxPosition * 0.40;                        // 0.12-0.20%

  // Time multiplier: 0.3-1.0m range, closer = bigger
  if (minutesLeft <= 0.35) size *= 1.4;      // +40% — ~20s, 거의 확정
  else if (minutesLeft <= 0.50) size *= 1.25; // +25% — ~30s
  else if (minutesLeft <= 0.65) size *= 1.10; // +10% — ~40s
  else if (minutesLeft <= 0.80) size *= 1.0;  // base — ~48s
  else size *= 0.85;                          // -15% — ~60s, 약간 보수적

  return Math.min(Math.max(1, Math.floor(size)), Math.floor(maxPosition));
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
  // Prevent overlapping calls (interval can fire while previous is still awaiting)
  if (inst.priceCheckRunning) return;
  inst.priceCheckRunning = true;

  try {
    await _checkPriceAndSnipeInner(inst);
  } finally {
    inst.priceCheckRunning = false;
  }
}

async function _checkPriceAndSnipeInner(inst: SniperInstance): Promise<void> {
  // Fetch balance once per cycle (cached 10s)
  const balance = await getCachedBalance(inst);
  if (balance < 1) return; // no funds

  const maxExposure = balance * inst.config.maxExposurePct;

  for (const [, market] of inst.activeMarkets) {
    if (market.entryTime !== null) continue; // already entered

    const minutesLeft = (market.endTime.getTime() - Date.now()) / 60_000;
    if (minutesLeft < inst.config.minMinutesLeft || minutesLeft > inst.config.maxMinutesLeft) continue;

    // Concurrent position limit
    if (countActivePositions(inst) >= inst.config.maxConcurrentPositions) continue;

    // Exposure limit (percentage of balance)
    const exposure = calcTotalExposure(inst);
    inst.state.totalExposure = exposure;
    if (exposure >= maxExposure) continue;

    const symbol = ASSET_TO_SYMBOL[market.cryptoAsset];
    if (!symbol) continue;
    if (market.strikePrice === null) continue;

    try {
      const spotPrice = await getCryptoPrice(symbol);
      const priceDiffPct = (spotPrice - market.strikePrice) / market.strikePrice;

      const adaptiveDiff = getAdaptiveMinDiff(minutesLeft, inst.config.minPriceDiffPct, market.cryptoAsset);
      if (Math.abs(priceDiffPct) < adaptiveDiff) {
        market.confidence = Math.abs(priceDiffPct) / adaptiveDiff;
        // Log skip reason once when confidence is close (>50%) to help debug
        if (market.confidence >= 0.5 && minutesLeft <= 1.0) {
          log(inst, 'info', 'skip-threshold', `${market.cryptoAsset} diff ${(priceDiffPct * 100).toFixed(3)}% < threshold ${(adaptiveDiff * 100).toFixed(3)}% (${(market.confidence * 100).toFixed(0)}% conf, ${minutesLeft.toFixed(2)}m left)`);
          logTrade({
            event: 'skip', ts: new Date().toISOString(), profileId: inst.profileId,
            asset: market.cryptoAsset, conditionId: market.conditionId,
            reason: 'threshold', secondsLeft: Math.round(minutesLeft * 60),
            spotPrice, strikePrice: market.strikePrice,
            priceDiffPct, adaptiveThreshold: adaptiveDiff,
            confidence: market.confidence,
          });
        }
        continue;
      }

      const direction: 'YES' | 'NO' = priceDiffPct > 0 ? 'YES' : 'NO';
      const tokenId = direction === 'YES' ? market.yesTokenId : market.noTokenId;

      // Check token price
      const book = await fetchBestBidAsk(tokenId);
      if (!book?.bestAsk || book.bestAsk > inst.config.maxTokenPrice) {
        log(inst, 'info', 'skip', `${market.cryptoAsset} ${direction} ask ${book?.bestAsk?.toFixed(2) ?? 'N/A'} > max ${inst.config.maxTokenPrice} — skipping`);
        logTrade({
          event: 'skip', ts: new Date().toISOString(), profileId: inst.profileId,
          asset: market.cryptoAsset, conditionId: market.conditionId,
          reason: 'price-too-high', secondsLeft: Math.round(minutesLeft * 60),
          spotPrice, strikePrice: market.strikePrice!,
          priceDiffPct, adaptiveThreshold: adaptiveDiff,
          confidence: Math.abs(priceDiffPct) / adaptiveDiff,
          askPrice: book?.bestAsk ?? undefined, maxTokenPrice: inst.config.maxTokenPrice,
        });
        continue;
      }

      const confidence = Math.abs(priceDiffPct) / adaptiveDiff;
      const usdcSize = calcPositionSize(priceDiffPct, minutesLeft, balance, inst.config);
      const size = Math.floor(usdcSize / book.bestAsk);

      if (size < 1) continue;

      // Mark as entered BEFORE placing order to prevent duplicate entries
      // from the next timer tick while awaiting placeProfileOrder
      market.direction = direction;
      market.entryPrice = book.bestAsk;
      market.entryTime = Date.now();
      market.confidence = confidence;
      market.tokenId = tokenId;
      market.held = size;

      log(inst, 'info', 'entry', `${market.cryptoAsset} ${direction} — spot $${spotPrice.toFixed(2)}, strike $${market.strikePrice.toFixed(2)}, diff ${(priceDiffPct * 100).toFixed(3)}%, ask ${book.bestAsk.toFixed(2)}, size ${size} ($${usdcSize.toFixed(1)}, ${(inst.config.maxPositionPct * 100).toFixed(0)}% of $${balance.toFixed(1)}), confidence ${confidence.toFixed(1)}x`);

      try {
        await placeProfileOrder(inst.profile, {
          tokenId,
          side: 'BUY',
          price: book.bestAsk,
          size,
          taker: true,  // aggressive fill — <1m to expiry, can't risk maker miss
        });

        inst.state.totalTrades++;
        inst.state.totalExposure = calcTotalExposure(inst);

        log(inst, 'trade', 'buy', `BUY ${direction} ${market.cryptoAsset} @${book.bestAsk.toFixed(2)} x ${size} (${minutesLeft.toFixed(1)}m left, confidence: ${confidence.toFixed(1)}x)`);
        logTrade({
          event: 'entry', ts: new Date().toISOString(), profileId: inst.profileId,
          asset: market.cryptoAsset, mode: market.question.includes('5 min') ? '5m' : '15m',
          conditionId: market.conditionId, direction,
          spotPrice, strikePrice: market.strikePrice!,
          priceDiffPct, adaptiveThreshold: adaptiveDiff, confidence,
          secondsLeft: Math.round(minutesLeft * 60),
          askPrice: book.bestAsk, bidPrice: book.bestBid, spread: book.bestBid ? book.bestAsk - book.bestBid : null,
          size, usdcSize, balance, totalExposure: calcTotalExposure(inst),
          positionSizePct: usdcSize / balance,
          expectedPnl: (1 - book.bestAsk) * size - 0.02 * size,
        });
      } catch (orderErr) {
        // Order failed — rollback the pre-set entry state
        market.direction = null;
        market.entryPrice = null;
        market.entryTime = null;
        market.confidence = 0;
        market.tokenId = null;
        market.held = 0;

        const msg = orderErr instanceof Error ? orderErr.message : String(orderErr);
        log(inst, 'error', 'order', `${market.cryptoAsset} order failed: ${msg}`);
        logTrade({
          event: 'skip', ts: new Date().toISOString(), profileId: inst.profileId,
          asset: market.cryptoAsset, conditionId: market.conditionId,
          reason: 'order-failed', secondsLeft: Math.round(minutesLeft * 60),
          spotPrice, strikePrice: market.strikePrice!,
          priceDiffPct, adaptiveThreshold: adaptiveDiff, confidence,
          askPrice: book.bestAsk, error: msg,
        });
      }
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

  // Group selections by mode → assets
  const byMode = new Map<string, Set<string>>();
  for (const sel of inst.config.selections) {
    const modeKey = sel.mode;
    if (!byMode.has(modeKey)) byMode.set(modeKey, new Set());
    byMode.get(modeKey)!.add(sel.asset);
  }

  for (const [mode, assetSet] of byMode) {
    try {
      const targetWindow = mode === '5m' ? 5 : 15;
      const assets = [...assetSet] as import('./types').CryptoAsset[];
      const markets = await findActiveCryptoMarkets(
        assets,
        0,
        inst.config.maxMinutesLeft + 5,
        targetWindow,
      );

      for (const market of markets) {
        if (inst.activeMarkets.has(market.conditionId)) continue;

        inst.activeMarkets.set(market.conditionId, activeMarketToSniper(market));
        inst.state.activeMarkets = inst.activeMarkets.size;

        log(inst, 'info', 'market', `Watching: ${market.cryptoAsset} ${mode} — ${market.question.slice(0, 60)} (strike: $${market.strikePrice?.toLocaleString() ?? '?'}, expires ${Math.round((market.endTime.getTime() - Date.now()) / 60000)}m)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(inst, 'warn', 'scan', `Market scan failed (${mode}): ${msg}`);
    }
  }
}

// ─── Expiry Check & Redeem Queue ─────────────────────────

async function checkExpiries(inst: SniperInstance): Promise<void> {
  const now = Date.now();

  for (const [conditionId, market] of inst.activeMarkets) {
    const msLeft = market.endTime.getTime() - now;

    // Market expired — remove and queue redeem if we have a position
    if (msLeft <= 0) {
      if (market.entryTime !== null && market.held > 0 && market.direction) {
        inst.pendingRedeems.set(conditionId, {
          conditionId,
          negRisk: market.negRisk,
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
          cryptoAsset: market.cryptoAsset,
          direction: market.direction,
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

  // Immediately scan for next markets after any expiry
  if (inst.activeMarkets.size === 0 || [...inst.activeMarkets.values()].every((m) => m.entryTime !== null)) {
    refreshMarkets(inst).catch(() => {});
  }
}

// ─── Pending Redeem Cleanup ─────────────────────────────
// Just expire old pending redeems. Actual claiming is done by the Data API scanner.

function cleanupPendingRedeems(inst: SniperInstance): void {
  const MAX_PENDING_MS = 180 * 60_000;
  for (const [conditionId, pending] of inst.pendingRedeems) {
    if (Date.now() - pending.addedAt > MAX_PENDING_MS) {
      log(inst, 'warn', 'redeem', `${pending.cryptoAsset} pending redeem timed out (180m) — removing`);
      inst.pendingRedeems.delete(conditionId);
    }
  }
}

// ─── Auto-Claim Scanner ─────────────────────────────────
// Uses Polymarket Data API to get claimable positions in ONE call.
// Also resolves pendingRedeems for PnL tracking.
// Runs every 2 min.

async function scanAndClaimResolved(inst: SniperInstance): Promise<void> {
  if (inst.state.status !== 'running') return;
  if (inst.claimScanRunning) return;
  inst.claimScanRunning = true;

  try {
    // Cleanup old pending redeems first
    cleanupPendingRedeems(inst);

    // Use proxy address (funderAddress) if available, otherwise derive from private key
    const walletAddress = inst.profile.funderAddress || new Wallet(inst.profile.privateKey).address;
    const claimable = await fetchClaimablePositions(walletAddress);

    // Resolve pendingRedeems that are now claimable (track PnL)
    for (const pos of claimable) {
      const pending = inst.pendingRedeems.get(pos.conditionId);
      if (pending) {
        // We know this position won (it's claimable = redeemable = winning side)
        const grossProfit = (1 - pending.entryPrice) * pending.held;
        const fee = 0.02 * pending.held;
        const netProfit = grossProfit - fee;
        inst.state.wins++;
        inst.state.grossPnl += netProfit;
        log(inst, 'trade', 'redeem', `${pending.cryptoAsset} WIN! ${pending.direction} ${pending.held} shares @${pending.entryPrice.toFixed(2)} → net +$${netProfit.toFixed(3)}`);
        logTrade({
          event: 'exit', ts: new Date().toISOString(), profileId: inst.profileId,
          asset: pending.cryptoAsset, conditionId: pos.conditionId,
          direction: pending.direction, entryPrice: pending.entryPrice,
          held: pending.held, result: 'win', pnl: netProfit,
          holdDurationSec: Math.round((Date.now() - pending.addedAt) / 1000),
        });
        inst.pendingRedeems.delete(pos.conditionId);
        inst.state.totalExposure = calcTotalExposure(inst);
      }
    }

    // Also mark expired pendingRedeems that are NOT claimable as losses
    // (if market expired > 5 min ago and not in claimable list → lost)
    const claimableIds = new Set(claimable.map((c) => c.conditionId));
    for (const [conditionId, pending] of inst.pendingRedeems) {
      const age = Date.now() - pending.addedAt;
      if (age > 5 * 60_000 && !claimableIds.has(conditionId)) {
        const loss = pending.entryPrice * pending.held;
        inst.state.losses++;
        inst.state.grossPnl -= loss;
        log(inst, 'trade', 'redeem', `${pending.cryptoAsset} LOSS — ${pending.direction} ${pending.held} shares @${pending.entryPrice.toFixed(2)} → -$${loss.toFixed(3)}`);
        logTrade({
          event: 'exit', ts: new Date().toISOString(), profileId: inst.profileId,
          asset: pending.cryptoAsset, conditionId,
          direction: pending.direction, entryPrice: pending.entryPrice,
          held: pending.held, result: 'loss', pnl: -loss,
          holdDurationSec: Math.round((Date.now() - pending.addedAt) / 1000),
        });
        inst.pendingRedeems.delete(conditionId);
        inst.state.totalExposure = calcTotalExposure(inst);
      }
    }

    if (claimable.length === 0) return;

    log(inst, 'info', 'auto-claim', `Found ${claimable.length} claimable position(s) — redeeming...`);
    let claimed = 0;

    for (const pos of claimable) {
      try {
        const yesTokenId = pos.outcomeIndex === 0 ? pos.asset : pos.oppositeAsset;
        const noTokenId = pos.outcomeIndex === 1 ? pos.asset : pos.oppositeAsset;

        const result = await redeemPositions(
          inst.profile,
          pos.conditionId,
          pos.negativeRisk,
          yesTokenId,
          noTokenId,
        );

        if (result.success && result.txHash) {
          claimed++;
          log(inst, 'trade', 'auto-claim', `Claimed "${pos.title}" (${pos.outcome}, ${pos.size} shares) → tx: ${result.txHash.slice(0, 10)}...`);
        } else if (!result.success) {
          log(inst, 'warn', 'auto-claim', `Claim failed "${pos.title}": ${result.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(inst, 'warn', 'auto-claim', `Error claiming "${pos.title}": ${msg}`);
      }
    }

    if (claimed > 0) {
      log(inst, 'info', 'auto-claim', `Auto-claim done: ${claimed}/${claimable.length} redeemed`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(inst, 'warn', 'auto-claim', `Auto-claim scan error: ${msg}`);
  } finally {
    inst.claimScanRunning = false;
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

  const config: SniperConfig = { ...DEFAULT_SNIPER_CONFIG, ...configOverrides };

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
    claimTimer: null,
    logBuffer: existing?.logBuffer ?? [],
    priceCheckRunning: false,
    claimScanRunning: false,
    lastBalance: 0,
    lastBalanceAt: 0,
  };

  instances.set(profileId, inst);

  // Fetch initial balance
  try {
    inst.lastBalance = await getProfileBalance(profile);
    inst.lastBalanceAt = Date.now();
  } catch { /* will be fetched on first price check */ }

  const selLabels = config.selections.map((s) => `${s.asset} ${s.mode}`).join(', ');
  log(inst, 'info', 'start', `Sniper started (balance: $${inst.lastBalance.toFixed(2)}, markets: ${selLabels}, window: ${config.minMinutesLeft}-${config.maxMinutesLeft}m, posSize: ${(config.maxPositionPct * 100).toFixed(0)}%, exposure: ${(config.maxExposurePct * 100).toFixed(0)}%)`);

  // Initial market scan
  await refreshMarkets(inst);

  // Timers
  inst.priceCheckTimer = setInterval(() => checkPriceAndSnipe(inst), config.priceCheckIntervalMs);
  inst.marketScanTimer = setInterval(() => refreshMarkets(inst), config.marketScanIntervalMs);
  inst.expiryTimer = setInterval(() => checkExpiries(inst), 5000);
  inst.claimTimer = setInterval(() => scanAndClaimResolved(inst), 120_000); // every 2 min (Data API only, no RPC)

  // Run initial auto-claim scan after 10s (catch positions from previous sessions)
  setTimeout(() => scanAndClaimResolved(inst), 10_000);

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
  if (inst.claimTimer) clearInterval(inst.claimTimer);

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
