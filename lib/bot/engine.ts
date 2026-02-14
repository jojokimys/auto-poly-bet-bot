import 'server-only';

import { prisma } from '@/lib/db/prisma';
import {
  scanMarkets,
  scanNearExpiryMarkets,
  scanMicroScalpMarkets,
  scanComplementArbMarkets,
  scanPanicReversalMarkets,
  scanCryptoLatencyMarkets,
  scanMultiOutcomeArbMarkets,
  scanCryptoScalperMarkets,
} from './scanner';
import { checkRisk } from './risk';
import { getStrategy, getDefaultStrategy } from './strategies';
import {
  getProfileBalance,
  getProfileOpenOrders,
  placeProfileOrder,
  clearProfileClient,
  type ProfileCredentials,
} from './profile-client';
import {
  DEFAULT_BOT_CONFIG,
  type BotConfig,
  type BotState,
  type BotLogEntry,
  type StrategySignal,
} from './types';

const MAX_LOG_BUFFER = 200;

// ─── Multi-Profile Bot Instance ──────────────────────────

interface BotInstance {
  profileId: string;
  profileName: string;
  state: BotState;
  scheduledTimeout: ReturnType<typeof setTimeout> | null;
  logBuffer: BotLogEntry[];
}

/** Map of profileId → BotInstance for all active bots */
const instances = new Map<string, BotInstance>();

// ─── Logging ──────────────────────────────────────────────

async function log(
  instance: BotInstance,
  level: BotLogEntry['level'],
  event: string,
  message: string,
  data?: Record<string, unknown>,
) {
  const taggedMessage = `[${instance.profileName}] ${message}`;

  const entry: BotLogEntry = {
    id: crypto.randomUUID(),
    profileId: instance.profileId,
    profileName: instance.profileName,
    level,
    event,
    message: taggedMessage,
    data,
    createdAt: new Date().toISOString(),
  };

  instance.logBuffer.push(entry);
  if (instance.logBuffer.length > MAX_LOG_BUFFER) {
    instance.logBuffer = instance.logBuffer.slice(-MAX_LOG_BUFFER);
  }

  // Persist to DB (non-blocking)
  prisma.botLog
    .create({
      data: {
        profileId: instance.profileId,
        level,
        event,
        message: taggedMessage,
        data: data ? JSON.stringify(data) : null,
      },
    })
    .catch(() => {}); // Don't crash on log failures

  const prefix = `[bot:${level}:${instance.profileName}]`;
  if (level === 'error') {
    console.error(prefix, message, data ?? '');
  } else {
    console.log(prefix, message, data ?? '');
  }
}

// ─── Config Loading ───────────────────────────────────────

async function loadConfig(): Promise<BotConfig> {
  const settings = await prisma.botSettings.findUnique({
    where: { id: 'default' },
  });

  if (!settings) {
    return { ...DEFAULT_BOT_CONFIG };
  }

  return {
    ...DEFAULT_BOT_CONFIG,
    maxBetAmount: settings.maxBetAmount,
    minLiquidity: settings.minLiquidity,
    minVolume: settings.minVolume,
    maxSpread: settings.maxSpread,
    scanIntervalSeconds: settings.scanIntervalSeconds,
  };
}

// ─── Profile Loading ──────────────────────────────────────

async function loadProfileCredentials(profileId: string): Promise<ProfileCredentials | null> {
  const profile = await prisma.botProfile.findUnique({
    where: { id: profileId },
  });

  if (!profile || !profile.isActive) return null;

  return {
    id: profile.id,
    name: profile.name,
    privateKey: profile.privateKey,
    funderAddress: profile.funderAddress,
    apiKey: profile.apiKey,
    apiSecret: profile.apiSecret,
    apiPassphrase: profile.apiPassphrase,
  };
}

// ─── Cycle Loop & Timeout ────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function cycleLoop(instance: BotInstance, intervalMs: number) {
  while (instance.state.status === 'running') {
    const start = Date.now();
    const timeoutMs = Math.max(intervalMs * 0.8, 5000); // 80% of interval, min 5s

    try {
      await withTimeout(runCycle(instance), timeoutMs, 'runCycle');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(instance, 'error', 'error', `Cycle timeout/error: ${msg}`);
      instance.state.error = msg;
    }

    if (instance.state.status !== 'running') break;

    const elapsed = Date.now() - start;
    const remaining = Math.max(0, intervalMs - elapsed);
    if (remaining > 0) {
      await new Promise<void>((resolve) => {
        instance.scheduledTimeout = setTimeout(() => {
          instance.scheduledTimeout = null;
          resolve();
        }, remaining);
      });
    }
  }
}

// ─── Core Scan Cycle ──────────────────────────────────────

async function runCycle(instance: BotInstance) {
  if (instance.state.status !== 'running') return;

  instance.state.cycleCount++;
  const cycleNum = instance.state.cycleCount;

  try {
    await log(instance, 'info', 'scan', `Cycle #${cycleNum} starting`);

    // 1. Load latest config from DB
    const config = await loadConfig();

    // 2. Load fresh profile credentials
    const profile = await loadProfileCredentials(instance.profileId);
    if (!profile) {
      await log(instance, 'error', 'error', 'Profile not found or inactive, stopping bot');
      instance.state.status = 'error';
      instance.state.error = 'Profile not found or inactive';
      if (instance.scheduledTimeout) {
        clearTimeout(instance.scheduledTimeout);
        instance.scheduledTimeout = null;
      }
      return;
    }

    // 3. Get current balance using profile-specific client
    const balance = await getProfileBalance(profile);
    await log(instance, 'info', 'scan', `Balance: $${balance.toFixed(2)}`);

    if (balance < 1) {
      await log(instance, 'warn', 'risk', 'Balance too low to trade (<$1)');
      instance.state.lastScanAt = new Date().toISOString();
      return;
    }

    // 4. Get open orders/positions for risk check using profile-specific client
    const openOrders = await getProfileOpenOrders(profile);
    const openPositionCount = new Set(
      openOrders.map((o: { asset_id?: string }) => o.asset_id),
    ).size;
    const totalExposure = openOrders.reduce(
      (sum: number, o: { price?: string; original_size?: string }) =>
        sum + parseFloat(o.price || '0') * parseFloat(o.original_size || '0'),
      0,
    );

    // 5. Load profile strategy (before scan so we pick the right scanner)
    const profileRecord = await prisma.botProfile.findUnique({
      where: { id: instance.profileId },
    });
    const strategyName = profileRecord?.strategy ?? 'value-betting';
    const strategy = getStrategy(strategyName) ?? getDefaultStrategy();

    // 6. Scan markets (use strategy-specific scanner)
    let opportunities;
    switch (strategyName) {
      case 'near-expiry-sniper':
        opportunities = await scanNearExpiryMarkets(config);
        break;
      case 'micro-scalper':
        opportunities = await scanMicroScalpMarkets(config);
        break;
      case 'complement-arb':
        opportunities = await scanComplementArbMarkets(config);
        break;
      case 'panic-reversal':
        opportunities = await scanPanicReversalMarkets(config);
        break;
      case 'crypto-latency':
        opportunities = await scanCryptoLatencyMarkets(config);
        break;
      case 'multi-outcome-arb':
        opportunities = await scanMultiOutcomeArbMarkets(config);
        break;
      case 'crypto-scalper':
        opportunities = await scanCryptoScalperMarkets(config);
        break;
      default:
        opportunities = await scanMarkets(config);
        break;
    }
    instance.state.marketsScanned += opportunities.length;
    instance.state.opportunitiesFound += opportunities.length;
    instance.state.lastScanAt = new Date().toISOString();

    await log(instance, 'info', 'scan', `Found ${opportunities.length} opportunities (${strategyName})`, {
      top3: opportunities.slice(0, 3).map((o) => ({
        q: o.question.slice(0, 60),
        score: o.score.toFixed(1),
        price: o.price,
      })),
    });

    if (opportunities.length === 0) return;

    // 7. Evaluate strategy signals
    const signals: StrategySignal[] = [];

    for (const opp of opportunities) {
      const signal = await strategy.evaluate(opp, config, balance, openPositionCount, instance.profileId);
      if (signal) signals.push(signal);
    }

    await log(instance, 'info', 'signal', `Strategy "${strategy.name}" produced ${signals.length} signals`);

    // 8. Execute signals through risk gate
    let ordersThisCycle = 0;
    const maxOrdersPerCycle = 3; // Rate limit: max 3 orders per cycle

    for (const signal of signals) {
      if (ordersThisCycle >= maxOrdersPerCycle) break;

      const riskResult = checkRisk(
        signal,
        config,
        balance,
        openPositionCount + ordersThisCycle,
        totalExposure,
      );

      if (!riskResult.allowed) {
        await log(instance, 'info', 'risk', `Blocked: ${riskResult.reason}`, {
          question: signal.question.slice(0, 60),
        });
        continue;
      }

      const finalSize = riskResult.adjustedSize ?? signal.size;

      // Execute the trade using profile-specific client
      try {
        await log(instance, 'trade', 'order', `Placing ${signal.action} ${finalSize.toFixed(2)} @ $${signal.price.toFixed(2)}`, {
          outcome: signal.outcome,
          question: signal.question.slice(0, 80),
          reason: signal.reason,
        });

        const result = await placeProfileOrder(profile, {
          tokenId: signal.tokenId,
          side: signal.action,
          price: signal.price,
          size: finalSize,
        });

        ordersThisCycle++;
        instance.state.ordersPlaced++;

        await log(instance, 'trade', 'order', `Order placed successfully`, {
          result: typeof result === 'object' ? JSON.stringify(result).slice(0, 200) : String(result),
          outcome: signal.outcome,
          cost: (signal.price * finalSize).toFixed(2),
        });

        // Execute second leg for complement arb (opposing token)
        if (signal.secondLeg) {
          try {
            const leg2 = signal.secondLeg;
            await log(instance, 'trade', 'order', `Placing second leg: BUY ${leg2.size.toFixed(2)} ${leg2.outcome} @ $${leg2.price.toFixed(2)}`, {
              tokenId: leg2.tokenId,
            });

            const leg2Result = await placeProfileOrder(profile, {
              tokenId: leg2.tokenId,
              side: 'BUY',
              price: leg2.price,
              size: leg2.size,
            });

            instance.state.ordersPlaced++;
            await log(instance, 'trade', 'order', `Second leg placed successfully`, {
              result: typeof leg2Result === 'object' ? JSON.stringify(leg2Result).slice(0, 200) : String(leg2Result),
              outcome: leg2.outcome,
              cost: (leg2.price * leg2.size).toFixed(2),
            });
          } catch (leg2Err) {
            await log(instance, 'error', 'order', `Second leg failed: ${leg2Err instanceof Error ? leg2Err.message : String(leg2Err)}`);
          }
        }

        // Execute bundle legs for multi-outcome arb
        if (signal.bundleLegs && signal.bundleLegs.length > 0) {
          for (let i = 0; i < signal.bundleLegs.length; i++) {
            const leg = signal.bundleLegs[i];
            try {
              await log(instance, 'trade', 'order', `Placing bundle leg ${i + 2}/${signal.bundleLegs.length + 1}: BUY ${leg.size.toFixed(2)} ${leg.outcome} @ $${leg.price.toFixed(2)}`, {
                tokenId: leg.tokenId,
              });

              const legResult = await placeProfileOrder(profile, {
                tokenId: leg.tokenId,
                side: 'BUY',
                price: leg.price,
                size: leg.size,
              });

              instance.state.ordersPlaced++;
              await log(instance, 'trade', 'order', `Bundle leg ${i + 2} placed successfully`, {
                result: typeof legResult === 'object' ? JSON.stringify(legResult).slice(0, 200) : String(legResult),
                outcome: leg.outcome,
                cost: (leg.price * leg.size).toFixed(2),
              });
            } catch (legErr) {
              await log(instance, 'error', 'order', `Bundle leg ${i + 2} failed: ${legErr instanceof Error ? legErr.message : String(legErr)}`);
            }
          }
        }
      } catch (err) {
        await log(instance, 'error', 'order', `Order failed: ${err instanceof Error ? err.message : String(err)}`, {
          signal: {
            action: signal.action,
            tokenId: signal.tokenId,
            price: signal.price,
            size: finalSize,
          },
        });
      }
    }

    if (ordersThisCycle > 0) {
      await log(instance, 'info', 'scan', `Cycle #${cycleNum} complete: ${ordersThisCycle} orders placed`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(instance, 'error', 'error', `Cycle #${cycleNum} failed: ${msg}`);
    instance.state.error = msg;
  }
}

// ─── Public API ───────────────────────────────────────────

export async function startBot(profileId: string): Promise<BotState> {
  // Check if already running
  const existing = instances.get(profileId);
  if (existing && existing.state.status === 'running') {
    return { ...existing.state };
  }

  // Load profile from DB
  const profile = await loadProfileCredentials(profileId);
  if (!profile) {
    throw new Error('Profile not found or inactive');
  }

  const config = await loadConfig();

  const instance: BotInstance = {
    profileId,
    profileName: profile.name,
    state: {
      status: 'running',
      startedAt: new Date().toISOString(),
      lastScanAt: null,
      cycleCount: 0,
      marketsScanned: 0,
      opportunitiesFound: 0,
      ordersPlaced: 0,
      totalPnl: 0,
      error: null,
    },
    scheduledTimeout: null,
    logBuffer: existing?.logBuffer ?? [],
  };

  instances.set(profileId, instance);

  await log(instance, 'info', 'start', `Bot started (interval: ${config.scanIntervalSeconds}s)`);

  // Start the cycle loop (runs in background, awaits each cycle before scheduling next)
  const intervalMs = config.scanIntervalSeconds * 1000;
  cycleLoop(instance, intervalMs).catch(() => {}); // fire-and-forget; errors are handled inside

  return { ...instance.state };
}

export async function stopBot(profileId: string): Promise<BotState> {
  const instance = instances.get(profileId);
  if (!instance) {
    return {
      status: 'stopped',
      startedAt: null,
      lastScanAt: null,
      cycleCount: 0,
      marketsScanned: 0,
      opportunitiesFound: 0,
      ordersPlaced: 0,
      totalPnl: 0,
      error: null,
    };
  }

  if (instance.scheduledTimeout) {
    clearTimeout(instance.scheduledTimeout);
    instance.scheduledTimeout = null;
  }

  instance.state.status = 'stopped';
  await log(instance, 'info', 'stop', `Bot stopped after ${instance.state.cycleCount} cycles, ${instance.state.ordersPlaced} orders placed`);

  // Clear the cached client for this profile
  clearProfileClient(profileId);

  return { ...instance.state };
}

export async function stopAllBots(): Promise<Record<string, BotState>> {
  const results: Record<string, BotState> = {};
  for (const profileId of instances.keys()) {
    results[profileId] = await stopBot(profileId);
  }
  return results;
}

export function getBotState(profileId?: string): BotState | Record<string, BotState> {
  if (profileId) {
    const instance = instances.get(profileId);
    if (!instance) {
      return {
        status: 'stopped',
        startedAt: null,
        lastScanAt: null,
        cycleCount: 0,
        marketsScanned: 0,
        opportunitiesFound: 0,
        ordersPlaced: 0,
        totalPnl: 0,
        error: null,
      };
    }
    return { ...instance.state };
  }

  // Return all states
  const allStates: Record<string, BotState> = {};
  for (const [id, inst] of instances) {
    allStates[id] = { ...inst.state };
  }
  return allStates;
}

export function getBotLogs(profileId?: string, limit = 50): BotLogEntry[] {
  if (profileId) {
    const instance = instances.get(profileId);
    if (!instance) return [];
    return instance.logBuffer.slice(-limit);
  }

  // Merge all logs from all instances, sorted by time
  const allLogs: BotLogEntry[] = [];
  for (const inst of instances.values()) {
    allLogs.push(...inst.logBuffer);
  }
  allLogs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return allLogs.slice(-limit);
}

export async function getPersistedLogs(
  limit = 100,
  profileId?: string,
): Promise<BotLogEntry[]> {
  const where = profileId ? { profileId } : {};

  const logs = await prisma.botLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return logs.map((l) => ({
    id: l.id,
    profileId: l.profileId ?? undefined,
    level: l.level as BotLogEntry['level'],
    event: l.event,
    message: l.message,
    data: l.data ? JSON.parse(l.data) : undefined,
    createdAt: l.createdAt.toISOString(),
  }));
}
