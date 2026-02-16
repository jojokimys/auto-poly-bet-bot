import 'server-only';

import { prisma } from '@/lib/db/prisma';
import { clearProfileClient } from './profile-client';
import {
  addOpportunity,
  getAutoExecutableOpportunities,
  markAutoExecuted,
  expireStale,
} from './opportunity-queue';
import { getPositions } from '@/lib/skills/position-monitor';
import { getRiskAssessment } from '@/lib/skills/risk-manager';
import { explore } from '@/lib/skills/explorer';
import { executeOrder, executeArbOrder } from '@/lib/skills/order-manager';
import { executeEarlyExits } from '@/lib/skills/early-exit';
import {
  createSession,
  endSession,
  incrementCycle,
  logDecision,
} from '@/lib/skills/reporter';
import type { BotState, BotLogEntry } from './types';

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

const DEFAULT_SCAN_INTERVAL_MS = 30 * 1000;

function loadScanInterval(): number {
  return DEFAULT_SCAN_INTERVAL_MS;
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

    // ── Phase 1: Briefing ──
    const [positions, risk] = await Promise.all([
      getPositions(instance.profileId),
      getRiskAssessment(instance.profileId),
    ]);

    if (!positions || !risk) {
      await log(instance, 'error', 'error', 'Profile not found, stopping');
      instance.state.status = 'error';
      instance.state.error = 'Profile not found';
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
    try {
      const exitResult = await executeEarlyExits(instance.profileId);
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

    // ── Phase 2: Recon ──
    const exploreResult = await explore('all');
    const opportunities = exploreResult.opportunities;

    instance.state.marketsScanned += exploreResult.marketConditions.totalActiveMarkets;
    instance.state.opportunitiesFound += opportunities.length;
    instance.state.lastScanAt = new Date().toISOString();

    await log(instance, 'info', 'scan', `Found ${opportunities.length} opportunities across ${exploreResult.marketConditions.totalActiveMarkets} markets`, {
      top3: opportunities.slice(0, 3).map((o) => ({
        type: o.type,
        q: o.question.slice(0, 50),
        conf: o.confidence,
        profit: o.expectedProfit.toFixed(3),
      })),
    });

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
      if (ordersThisCycle >= risk.limits.remainingCapacity) break;

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

        const arbResult = await executeArbOrder(allLegs);

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
        const result = await executeOrder(primaryLeg);

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
