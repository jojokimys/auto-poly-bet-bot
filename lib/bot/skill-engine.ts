import 'server-only';

import { prisma } from '@/lib/db/prisma';
import { clearProfileClient, loadProfile } from './profile-client';
import {
  addOpportunity,
  getAutoExecutableOpportunities,
  markAutoExecuted,
  expireStale,
} from './opportunity-queue';
import { getPositions } from '@/lib/skills/position-monitor';
import { getRiskAssessment } from '@/lib/skills/risk-manager';
import { executeOrder, executeArbOrder } from '@/lib/skills/order-manager';
import { executeEarlyExits } from '@/lib/skills/early-exit';
import {
  isConditionResolved,
  redeemPositions as redeemOnChain,
} from '@/lib/polymarket/redeem';
import { getReadClient } from '@/lib/polymarket/client';
import {
  createSession,
  endSession,
  incrementCycle,
  logDecision,
} from '@/lib/skills/reporter';
import { getStrategyEntry } from './strategy-registry';
import { signalToOpportunity } from './signal-converter';
import { DEFAULT_BOT_CONFIG } from './types';
import type { BotState, BotLogEntry } from './types';
import type { Opportunity } from '@/lib/skills/types';

const MAX_LOG_BUFFER = 200;
const MAX_ORDERS_PER_CYCLE = 3;
const MIN_CONFIDENCE = 60;

// ─── Bot Instance ────────────────────────────────────────

interface BotInstance {
  profileId: string;
  profileName: string;
  sessionId: string | null;
  state: BotState;
  scheduledTimeout: ReturnType<typeof setTimeout> | null;
  logBuffer: BotLogEntry[];
  redeemRunning: boolean;
}

// Use globalThis to survive Next.js HMR — prevents zombie engine loops
const globalForEngine = globalThis as unknown as { __engineInstances: Map<string, BotInstance> };
globalForEngine.__engineInstances ??= new Map<string, BotInstance>();
const instances = globalForEngine.__engineInstances;

// ─── Logging ─────────────────────────────────────────────

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
    .catch(() => {});

  const prefix = `[skill-engine:${level}:${instance.profileName}]`;
  if (level === 'error') {
    console.error(prefix, message, data ?? '');
  } else {
    console.log(prefix, message, data ?? '');
  }
}

// ─── Config ──────────────────────────────────────────────

function loadScanInterval(): number {
  return DEFAULT_BOT_CONFIG.scanIntervalSeconds * 1000;
}

// ─── Cycle Loop ──────────────────────────────────────────

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
    const timeoutMs = Math.max(intervalMs * 0.8, 10000);

    try {
      await withTimeout(runCycle(instance), timeoutMs, 'runCycle');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(instance, 'error', 'error', `Cycle error: ${msg}`);
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

// ─── Core Skill Cycle ────────────────────────────────────

async function runCycle(instance: BotInstance) {
  if (instance.state.status !== 'running') return;

  instance.state.cycleCount++;
  const cycleNum = instance.state.cycleCount;

  try {
    await log(instance, 'info', 'scan', `Cycle #${cycleNum} starting`);

    // ── Phase 0: Load profile once for entire cycle ──
    const profile = await loadProfile(instance.profileId);
    if (!profile) {
      await log(instance, 'error', 'error', 'Profile not found, stopping');
      instance.state.status = 'error';
      instance.state.error = 'Profile not found';
      return;
    }

    // ── Phase 1: Briefing (reuse profile) ──
    const dbProfile = await prisma.botProfile.findUnique({
      where: { id: instance.profileId },
      select: { maxPortfolioExposure: true },
    });
    const positions = await getPositions(instance.profileId, profile);
    const risk = await getRiskAssessment(instance.profileId, profile, positions!, dbProfile?.maxPortfolioExposure ?? undefined);

    if (!positions || !risk) {
      await log(instance, 'error', 'error', 'Failed to load positions/risk');
      instance.state.error = 'Position data unavailable';
      return;
    }

    await log(instance, 'info', 'scan', `Balance: $${positions.balance.toFixed(2)} | Risk: ${risk.riskLevel} | Positions: ${positions.summary.totalPositions}`, {
      exposure: risk.exposurePercent,
      canTrade: risk.canTrade,
      warnings: risk.warnings,
    });

    if (!risk.canTrade) {
      await log(instance, 'warn', 'risk', `Cannot trade: ${risk.warnings.join(', ')}`);
      instance.state.lastScanAt = new Date().toISOString();

      if (instance.sessionId) {
        await logDecision({
          sessionId: instance.sessionId,
          profileId: instance.profileId,
          type: 'skip',
          reason: `Risk gate blocked: ${risk.warnings.join(', ')}`,
          confidence: 100,
        });
        await incrementCycle(instance.sessionId);
      }
      return;
    }

    // ── Phase 1.5: Early Exit ──
    let exitResult: Awaited<ReturnType<typeof executeEarlyExits>> | null = null;
    try {
      exitResult = await executeEarlyExits(instance.profileId, undefined, profile);
      if (exitResult.summary.totalExecuted > 0) {
        await log(instance, 'trade', 'early-exit', `Early exit: sold ${exitResult.summary.totalExecuted} near-confirmed positions, freed ~$${exitResult.summary.capitalFreed.toFixed(2)}`, {
          candidates: exitResult.candidates.map(c => ({
            outcome: c.outcome,
            bid: c.currentBestBid,
            size: c.netSize,
            pnl: c.estimatedPnl,
          })),
          executed: exitResult.executed.filter(e => e.success).map(e => ({
            outcome: e.outcome,
            size: e.size,
            price: e.price,
          })),
        });

        if (instance.sessionId) {
          for (const ex of exitResult.executed.filter(e => e.success)) {
            const candidate = exitResult.candidates.find(c => c.tokenId === ex.tokenId);
            await logDecision({
              sessionId: instance.sessionId,
              profileId: instance.profileId,
              type: 'trade',
              conditionId: candidate?.conditionId,
              action: 'SELL',
              tokenId: ex.tokenId,
              outcome: ex.outcome,
              price: ex.price,
              size: ex.size,
              reason: `[early-exit] Sold near-confirmed winner at $${ex.price} (entry: $${candidate?.avgEntryPrice ?? '?'})`,
              confidence: 95,
              strategy: 'early-exit',
            });
          }
        }
      } else if (exitResult.candidates.length > 0) {
        await log(instance, 'info', 'early-exit', `${exitResult.candidates.length} early-exit candidates found but none executed`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(instance, 'warn', 'early-exit', `Early exit scan failed: ${msg}`);
    }

    // ── Phase 1.7: On-chain Redeem (for resolved positions) ──
    // Early-exit (Phase 1.5) already sells at bestBid >= 99.5¢ via CLOB.
    // This phase claims resolved positions via CTF/NegRisk contract.
    const redeemCandidates = exitResult?.candidates.filter(c => c.currentBestBid >= 0.995) ?? [];
    if (redeemCandidates.length > 0 && !instance.redeemRunning) {
      instance.redeemRunning = true;
      (async () => {
        let redeemed = 0;
        const clobUrl = (await import('@/lib/config/env')).getEnv().CLOB_API_URL;
        const readClient = getReadClient();

        // Deduplicate by conditionId (one redeem per condition)
        const seen = new Set<string>();
        for (const c of redeemCandidates) {
          if (seen.has(c.conditionId)) continue;
          seen.add(c.conditionId);

          try {
            const resolved = await isConditionResolved(c.conditionId);
            if (!resolved) continue;

            // Fetch market to get both YES/NO tokenIds
            const negRisk = await readClient.getNegRisk(c.tokenId).catch(() => true);
            let yesTokenId = c.tokenId;
            let noTokenId = c.tokenId;
            try {
              const res = await fetch(`${clobUrl}/markets/${c.conditionId}`, { cache: 'no-store' });
              const mkt = await res.json();
              if (mkt.tokens?.length >= 2) {
                yesTokenId = mkt.tokens[0].token_id;
                noTokenId = mkt.tokens[1].token_id;
              }
            } catch { /* fallback: both set to c.tokenId — standard CTF still works with indexSets */ }

            const result = await redeemOnChain(
              profile!.privateKey,
              c.conditionId,
              negRisk,
              yesTokenId,
              noTokenId,
            );
            if (result.success && result.txHash) {
              redeemed++;
              await log(instance, 'trade', 'redeem', `Redeemed resolved: ${c.outcome} (tx: ${result.txHash.slice(0, 10)}...)`, {
                conditionId: c.conditionId,
                txHash: result.txHash,
              });
            } else if (result.error) {
              await log(instance, 'warn', 'redeem', `Redeem failed for ${c.outcome}: ${result.error}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await log(instance, 'warn', 'redeem', `Redeem error: ${msg}`);
          }
        }
        if (redeemed > 0) {
          await log(instance, 'trade', 'redeem', `On-chain redeemed ${redeemed} resolved position(s)`);
        }
      })()
        .catch(() => {})
        .finally(() => { instance.redeemRunning = false; });
    }

    // ── Phase 2: Multi-Strategy Scan + Evaluate (parallel) ──
    const enabledStrategies = await loadEnabledStrategies(instance.profileId);
    const config = loadConfig();
    const opportunities: Opportunity[] = [];
    let totalMarketsScanned = 0;

    // Resolve strategy entries, filter unknown
    const strategyEntries = enabledStrategies
      .map((name) => ({ name, entry: getStrategyEntry(name) }))
      .filter((s): s is { name: string; entry: NonNullable<ReturnType<typeof getStrategyEntry>> } => {
        if (!s.entry) {
          log(instance, 'warn', 'scan', `Unknown strategy: ${s.name}, skipping`).catch(() => {});
          return false;
        }
        return true;
      });

    // Run all strategy scans in parallel
    const scanResults = await Promise.allSettled(
      strategyEntries.map(async ({ name, entry }) => {
        const scored = await entry.scan(config);

        // Evaluate all scored opportunities in parallel within this strategy
        const signals = await Promise.all(
          scored.map(async (opp) => {
            const signal = await entry.strategy.evaluate(
              opp,
              config,
              positions.balance,
              positions.summary.totalPositions,
              instance.profileId,
            );
            return signal ? signalToOpportunity(signal, entry, opp) : null;
          }),
        );

        return { name, scored, opportunities: signals.filter((s): s is Opportunity => s !== null) };
      }),
    );

    // Collect results from all parallel scans
    for (const result of scanResults) {
      if (result.status === 'fulfilled') {
        const { name, scored, opportunities: stratOpps } = result.value;
        totalMarketsScanned += scored.length;
        opportunities.push(...stratOpps);
        await log(instance, 'info', 'scan', `[${name}] Scanned ${scored.length} markets → ${stratOpps.length} signals`);
      } else {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        await log(instance, 'warn', 'scan', `Strategy scan failed: ${msg}`);
      }
    }

    // Sort by confidence DESC
    opportunities.sort((a, b) => b.confidence - a.confidence);

    instance.state.marketsScanned += totalMarketsScanned;
    instance.state.opportunitiesFound += opportunities.length;
    instance.state.lastScanAt = new Date().toISOString();

    await log(instance, 'info', 'scan', `Found ${opportunities.length} opportunities from ${enabledStrategies.length} strategies`);

    if (opportunities.length > 0) {
      console.table(opportunities.map((o) => ({
        strategy: o.type,
        question: o.question.slice(0, 60),
        confidence: o.confidence,
        signal: o.signal,
        price: o.suggestedPrice,
        size: o.suggestedSize,
        profit: +o.expectedProfit.toFixed(3),
        risk: o.riskLevel,
        timeWindow: o.timeWindow,
        autoExec: o.autoExecutable,
      })));
    }

    if (opportunities.length === 0) {
      if (instance.sessionId) {
        await logDecision({
          sessionId: instance.sessionId,
          profileId: instance.profileId,
          type: 'skip',
          reason: 'No opportunities found',
          confidence: 80,
        });
        await incrementCycle(instance.sessionId);
      }
      return;
    }

    // ── Phase 3: Queue all opportunities ──
    expireStale();
    let queued = 0;
    for (const opp of opportunities) {
      if (opp.confidence < MIN_CONFIDENCE) continue;
      if (addOpportunity(opp)) queued++;
    }

    await log(instance, 'info', 'scan', `Queued ${queued} new opportunities (${opportunities.length} total found)`);

    // ── Phase 4: Auto-execute arb opportunities only ──
    const autoOpps = getAutoExecutableOpportunities();
    let ordersThisCycle = 0;

    if (autoOpps.length > 0) {
      await log(instance, 'info', 'scan', `${autoOpps.length} auto-executable arb opportunities in queue`);
    }

    for (const queuedOpp of autoOpps) {
      if (ordersThisCycle >= MAX_ORDERS_PER_CYCLE) break;

      const opp = queuedOpp.opportunity;

      // Safety: skip arbs with too many legs (partial fill risk)
      const legCount = 1 + (opp.arbLegs?.length ?? 0);
      if (legCount > 3) {
        await log(instance, 'warn', 'order', `Skipping ${legCount}-leg arb (too many legs, partial fill risk): ${opp.question.slice(0, 60)}`);
        markAutoExecuted(queuedOpp.id);
        continue;
      }

      // Cap size to maxPositionSize (use combined cost for arb)
      let size = opp.suggestedSize;
      const combinedCost = opp.arbLegs
        ? opp.suggestedPrice + opp.arbLegs.reduce((s, l) => s + l.price, 0)
        : opp.suggestedPrice;
      if (combinedCost * size > risk.limits.maxPositionSize) {
        size = Math.floor((risk.limits.maxPositionSize / combinedCost) * 100) / 100;
      }
      if (size < 1) continue;

      await log(instance, 'trade', 'order', `Auto-executing arb (${legCount} legs): ${opp.signal} ${size}x ${opp.outcome} @ $${opp.suggestedPrice}`, {
        type: opp.type,
        question: opp.question.slice(0, 80),
        confidence: opp.confidence,
        reasoning: opp.reasoning,
        arbLegs: opp.arbLegs?.length ?? 0,
      });

      // Build all legs: primary + arbLegs
      const primaryLeg = {
        profileId: instance.profileId,
        action: opp.signal as 'BUY' | 'SELL',
        conditionId: opp.conditionId,
        tokenId: opp.tokenId,
        outcome: opp.outcome,
        price: opp.suggestedPrice,
        size,
        reason: `[auto:${opp.type}] ${opp.reasoning}`,
      };

      if (opp.arbLegs && opp.arbLegs.length > 0) {
        // Multi-leg arb: execute all legs in parallel
        const allLegs = [
          primaryLeg,
          ...opp.arbLegs.map(leg => ({
            profileId: instance.profileId,
            action: 'BUY' as const,
            conditionId: leg.conditionId,
            tokenId: leg.tokenId,
            outcome: leg.outcome,
            price: leg.price,
            size,
            reason: `[auto:${opp.type}:leg] ${opp.reasoning}`,
          })),
        ];

        const arbResult = await executeArbOrder(allLegs, profile);

        if (arbResult.success) {
          ordersThisCycle++;
          instance.state.ordersPlaced += allLegs.length;
          markAutoExecuted(queuedOpp.id);
          await log(instance, 'trade', 'order', `Arb complete: ${arbResult.message}`, {
            orderIds: arbResult.results.map(r => r.orderId),
          });
        } else {
          await log(instance, 'error', 'order', `Arb failed: ${arbResult.message}`, {
            results: arbResult.results.map(r => ({ success: r.success, msg: r.message })),
          });
        }
      } else {
        // Single-leg (fallback)
        const result = await executeOrder(primaryLeg, profile);

        if (result.success) {
          ordersThisCycle++;
          instance.state.ordersPlaced++;
          markAutoExecuted(queuedOpp.id);
          await log(instance, 'trade', 'order', `Order placed: ${result.message}`, {
            orderId: result.orderId,
          });
        } else {
          await log(instance, 'error', 'order', `Order failed: ${result.message}`);
        }
      }

      // Log decision to session
      if (instance.sessionId) {
        await logDecision({
          sessionId: instance.sessionId,
          profileId: instance.profileId,
          type: 'trade',
          conditionId: opp.conditionId,
          action: opp.signal,
          tokenId: opp.tokenId,
          outcome: opp.outcome,
          price: opp.suggestedPrice,
          size,
          reason: `[auto:${opp.type}] ${opp.reasoning}`,
          confidence: opp.confidence,
          strategy: opp.type,
        });
      }
    }

    // ── Phase 5: Debrief ──
    if (instance.sessionId) {
      await incrementCycle(instance.sessionId);
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

// ─── Helpers ─────────────────────────────────────────────

async function loadEnabledStrategies(profileId: string): Promise<string[]> {
  const profile = await prisma.botProfile.findUnique({
    where: { id: profileId },
    select: { enabledStrategies: true },
  });
  if (!profile) return ['value-betting'];
  try {
    const parsed = JSON.parse(profile.enabledStrategies);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : ['value-betting'];
  } catch {
    return ['value-betting'];
  }
}

function loadConfig() {
  return DEFAULT_BOT_CONFIG;
}

// ─── Public API ──────────────────────────────────────────

export async function startBot(profileId: string): Promise<BotState> {
  const existing = instances.get(profileId);
  if (existing && existing.state.status === 'running') {
    return { ...existing.state };
  }

  const profile = await prisma.botProfile.findUnique({
    where: { id: profileId },
  });
  if (!profile || !profile.isActive) {
    throw new Error('Profile not found or inactive');
  }

  // Create AI session
  const sessionId = await createSession(profileId);

  const intervalMs = loadScanInterval();

  const instance: BotInstance = {
    profileId,
    profileName: profile.name,
    sessionId,
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
    redeemRunning: false,
  };

  instances.set(profileId, instance);

  await log(instance, 'info', 'start', `Skill engine started (interval: ${intervalMs / 1000}s, session: ${sessionId})`);

  cycleLoop(instance, intervalMs).catch(() => {});

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

  // End AI session
  if (instance.sessionId) {
    await endSession(
      instance.sessionId,
      `Stopped after ${instance.state.cycleCount} cycles, ${instance.state.ordersPlaced} orders`,
    );
  }

  await log(instance, 'info', 'stop', `Skill engine stopped after ${instance.state.cycleCount} cycles, ${instance.state.ordersPlaced} orders`);

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
