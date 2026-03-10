/**
 * Cycle Runner — the self-improving trading loop.
 *
 * Each cycle:
 *   1. Scan for crypto markets (Gamma API)
 *   2. Start engine with current config
 *   3. Run for CYCLE_DURATION_MS (50 min)
 *   4. Stop engine, generate report
 *   5. Apply improvements from report
 *   6. Wait COOLDOWN_MS (10 min) — let markets rotate
 *   7. Repeat
 *
 * The runner automatically adjusts parameters between cycles
 * based on what worked and what didn't.
 */

import 'server-only';

import { EdgeEngine, type EngineConfig } from './engine';
import { generateCycleReport, formatReportText, type CycleReport, type Improvement } from './reporter';
import { getProfileBalance, loadProfile } from '../bot/profile-client';
import { prisma } from '@/lib/db/prisma';

// ─── Config ────────────────────────────────────────────

const CYCLE_DURATION_MS = 50 * 60 * 1000; // 50 minutes
const COOLDOWN_MS = 10 * 60 * 1000;       // 10 minutes between cycles
const MAX_CYCLES = 100;                   // safety cap

// ─── State ─────────────────────────────────────────────

interface RunnerState {
  running: boolean;
  cycleNumber: number;
  currentPhase: 'scanning' | 'trading' | 'reporting' | 'improving' | 'cooldown' | 'idle';
  engine: EdgeEngine | null;
  config: Partial<EngineConfig>;
  reports: CycleReport[];
  startedAt: Date | null;
  profileId: string;
}

let state: RunnerState = {
  running: false,
  cycleNumber: 0,
  currentPhase: 'idle',
  engine: null,
  config: {},
  reports: [],
  startedAt: null,
  profileId: '',
};

// ─── Public API ────────────────────────────────────────

export function getRunnerState() {
  return {
    running: state.running,
    cycleNumber: state.cycleNumber,
    currentPhase: state.currentPhase,
    engineRunning: state.engine?.isRunning() ?? false,
    engineStatus: state.engine?.getStatus() ?? null,
    totalCycles: state.reports.length,
    lastReport: state.reports.length > 0 ? state.reports[state.reports.length - 1] : null,
    cumulativePnl: state.reports.reduce((sum, r) => sum + r.totalPnl, 0),
    startedAt: state.startedAt?.toISOString() ?? null,
    currentConfig: state.config,
  };
}

export async function startRunner(profileId: string, initialConfig?: Partial<EngineConfig>): Promise<void> {
  if (state.running) throw new Error('Runner already active');

  const profile = await loadProfile(profileId);
  if (!profile) throw new Error(`Profile ${profileId} not found`);

  state = {
    running: true,
    cycleNumber: 0,
    currentPhase: 'idle',
    engine: null,
    config: {
      enableLatencyArb: true,
      enableMomentumSniper: true,
      preferMaker: false,
      minConfidence: 50,
      maxPositions: 4,
      tradeCooldownMs: 15_000,
      adaptiveMode: true,
      ...initialConfig,
    },
    reports: [],
    startedAt: new Date(),
    profileId,
  };

  console.log(`[runner] Starting cycle runner for profile ${profile.name}`);

  // Log start
  await prisma.botLog.create({
    data: {
      profileId,
      level: 'info',
      event: 'start',
      message: `[runner] Cycle runner started`,
      data: JSON.stringify(state.config),
    },
  });

  // Begin the loop (non-blocking)
  runLoop().catch(err => {
    console.error('[runner] Fatal error:', err);
    state.running = false;
    state.currentPhase = 'idle';
  });
}

export function stopRunner(): void {
  console.log('[runner] Stop requested');
  state.running = false;
  if (state.engine?.isRunning()) {
    state.engine.stop();
  }
}

// ─── Main Loop ─────────────────────────────────────────

async function runLoop(): Promise<void> {
  while (state.running && state.cycleNumber < MAX_CYCLES) {
    state.cycleNumber++;
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[runner] CYCLE #${state.cycleNumber} STARTING`);
    console.log(`${'═'.repeat(60)}\n`);

    try {
      await runOneCycle();
    } catch (err) {
      console.error(`[runner] Cycle #${state.cycleNumber} error:`, (err as Error).message);
      await prisma.botLog.create({
        data: {
          profileId: state.profileId,
          level: 'error',
          event: 'error',
          message: `[runner] Cycle #${state.cycleNumber} failed: ${(err as Error).message}`,
        },
      });
    }

    if (!state.running) break;

    // Cooldown between cycles
    state.currentPhase = 'cooldown';
    console.log(`[runner] Cooldown ${COOLDOWN_MS / 60_000}min before next cycle...`);
    await sleep(COOLDOWN_MS);
  }

  state.running = false;
  state.currentPhase = 'idle';
  console.log('[runner] Loop ended.');
}

async function runOneCycle(): Promise<void> {
  // ── Phase 1: Start engine ────────────────────────
  // Engine auto-scans for 5m Up/Down markets every 60s
  state.currentPhase = 'trading';
  const balanceBefore = await getProfileBalance((await loadProfile(state.profileId))!);
  const cycleStart = new Date();

  console.log(`[runner] Starting engine ($${balanceBefore.toFixed(2)} balance)`);

  state.engine = new EdgeEngine({
    profileId: state.profileId,
    ...state.config,
  });

  await state.engine.start();

  // Log initial market count
  const initialMarkets = state.engine.getActiveMarkets();
  console.log(`[runner] Engine found ${initialMarkets.length} active 5m markets`);

  if (initialMarkets.length === 0) {
    console.log('[runner] No 5m markets found. Engine will auto-rescan...');
  }

  // ── Phase 2: Run for CYCLE_DURATION ──────────────
  const cycleEnd = Date.now() + CYCLE_DURATION_MS;
  while (Date.now() < cycleEnd && state.running) {
    await sleep(30_000);
  }

  // ── Phase 4: Stop & Report ───────────────────────
  state.currentPhase = 'reporting';
  if (state.engine?.isRunning()) {
    state.engine.stop();
  }

  const cycleEndTime = new Date();
  const profile = await loadProfile(state.profileId);
  const balanceAfter = profile ? await getProfileBalance(profile) : balanceBefore;

  console.log(`[runner] Phase 4: Generating report...`);
  const report = await generateCycleReport(
    state.profileId,
    state.cycleNumber,
    cycleStart,
    cycleEndTime,
    balanceBefore,
    balanceAfter,
  );

  state.reports.push(report);

  // Print report
  const reportText = formatReportText(report);
  console.log(reportText);

  // ── Phase 5: Apply improvements ──────────────────
  state.currentPhase = 'improving';
  console.log('[runner] Phase 5: Applying improvements...');
  applyImprovements(report.improvements);

  // Log cumulative performance
  const cumPnl = state.reports.reduce((sum, r) => sum + r.totalPnl, 0);
  console.log(`[runner] Cumulative PnL after ${state.cycleNumber} cycles: $${cumPnl.toFixed(2)}`);
}

// ─── Improvement Application ──────────────────────────

function applyImprovements(improvements: Improvement[]): void {
  for (const imp of improvements) {
    if (!imp.suggestion) continue;

    const { param, to } = imp.suggestion;

    switch (param) {
      case 'minConfidence':
        state.config.minConfidence = to;
        console.log(`  [tuned] minConfidence → ${to}`);
        break;

      case 'minEdgeCents':
        // minEdgeCents is in math.ts constants, but we can influence via adaptiveMode
        // For now, log the suggestion — adaptive mode will pick it up
        console.log(`  [tuned] minEdgeCents → ${to} (adaptive will apply)`);
        break;

      case 'preferMaker':
        state.config.preferMaker = to === 1;
        console.log(`  [tuned] preferMaker → ${to === 1}`);
        break;

      case 'kellyFraction':
        // Kelly fraction is adaptive — will be picked up next cycle
        console.log(`  [tuned] kellyFraction → ${to} (adaptive will apply)`);
        break;

      case 'tradeCooldownMs':
        state.config.tradeCooldownMs = to;
        console.log(`  [tuned] tradeCooldownMs → ${to}ms`);
        break;

      default:
        console.log(`  [skip] Unknown param: ${param}`);
    }
  }

  // Progressive adjustments based on cumulative performance
  if (state.reports.length >= 3) {
    const last3 = state.reports.slice(-3);
    const last3Pnl = last3.reduce((sum, r) => sum + r.totalPnl, 0);
    const last3Trades = last3.reduce((sum, r) => sum + r.totalTrades, 0);

    if (last3Pnl < 0 && last3Trades >= 10) {
      // 3 consecutive losing cycles — get more conservative
      state.config.minConfidence = Math.min((state.config.minConfidence ?? 55) + 5, 80);
      state.config.maxPositions = Math.max((state.config.maxPositions ?? 3) - 1, 1);
      console.log(`  [auto] 3 losing cycles: minConf=${state.config.minConfidence}, maxPos=${state.config.maxPositions}`);
    }

    if (last3Pnl > 0 && last3.every(r => r.totalPnl > 0)) {
      // 3 consecutive winning cycles — slightly loosen up
      state.config.minConfidence = Math.max((state.config.minConfidence ?? 55) - 2, 40);
      state.config.maxPositions = Math.min((state.config.maxPositions ?? 3) + 1, 5);
      console.log(`  [auto] 3 winning cycles: minConf=${state.config.minConfidence}, maxPos=${state.config.maxPositions}`);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
