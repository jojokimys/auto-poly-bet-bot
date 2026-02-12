import 'server-only';

import { prisma } from '@/lib/db/prisma';
import { getBalanceAllowance } from '@/lib/polymarket/trading';
import { placeOrder } from '@/lib/polymarket/trading';
import { getOpenOrders } from '@/lib/polymarket/trading';
import { scanMarkets } from './scanner';
import { checkRisk } from './risk';
import { getDefaultStrategy } from './strategies';
import {
  DEFAULT_BOT_CONFIG,
  type BotConfig,
  type BotState,
  type BotLogEntry,
  type StrategySignal,
} from './types';

const MAX_LOG_BUFFER = 200;

/** In-memory ring buffer for recent logs (also persisted to DB) */
let logBuffer: BotLogEntry[] = [];

/** Bot state singleton */
let state: BotState = {
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

let scanInterval: ReturnType<typeof setInterval> | null = null;

// ─── Logging ──────────────────────────────────────────────

async function log(
  level: BotLogEntry['level'],
  event: string,
  message: string,
  data?: Record<string, unknown>
) {
  const entry: BotLogEntry = {
    id: crypto.randomUUID(),
    level,
    event,
    message,
    data,
    createdAt: new Date().toISOString(),
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer = logBuffer.slice(-MAX_LOG_BUFFER);
  }

  // Persist to DB (non-blocking)
  prisma.botLog
    .create({
      data: {
        level,
        event,
        message,
        data: data ? JSON.stringify(data) : null,
      },
    })
    .catch(() => {}); // Don't crash on log failures

  const prefix = `[bot:${level}]`;
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
    scanIntervalMinutes: settings.scanIntervalMinutes,
  };
}

// ─── Core Scan Cycle ──────────────────────────────────────

async function runCycle() {
  if (state.status !== 'running') return;

  state.cycleCount++;
  const cycleNum = state.cycleCount;

  try {
    await log('info', 'scan', `Cycle #${cycleNum} starting`);

    // 1. Load latest config from DB
    const config = await loadConfig();

    // 2. Get current balance
    const balanceResult = await getBalanceAllowance();
    const balance = parseFloat(balanceResult.balance);
    await log('info', 'scan', `Balance: $${balance.toFixed(2)}`);

    if (balance < 1) {
      await log('warn', 'risk', 'Balance too low to trade (<$1)');
      state.lastScanAt = new Date().toISOString();
      return;
    }

    // 3. Get open orders/positions for risk check
    const openOrders = await getOpenOrders();
    const openPositionCount = new Set(openOrders.map((o) => o.asset_id)).size;
    const totalExposure = openOrders.reduce(
      (sum, o) => sum + parseFloat(o.price) * parseFloat(o.original_size),
      0
    );

    // 4. Scan markets
    const opportunities = await scanMarkets(config);
    state.marketsScanned += opportunities.length;
    state.opportunitiesFound += opportunities.length;
    state.lastScanAt = new Date().toISOString();

    await log('info', 'scan', `Found ${opportunities.length} opportunities`, {
      top3: opportunities.slice(0, 3).map((o) => ({
        q: o.question.slice(0, 60),
        score: o.score.toFixed(1),
        price: o.price,
      })),
    });

    if (opportunities.length === 0) return;

    // 5. Evaluate strategy signals
    const strategy = getDefaultStrategy();
    const signals: StrategySignal[] = [];

    for (const opp of opportunities) {
      const signal = strategy.evaluate(opp, config, balance, openPositionCount);
      if (signal) signals.push(signal);
    }

    await log('info', 'signal', `Strategy "${strategy.name}" produced ${signals.length} signals`);

    // 6. Execute signals through risk gate
    let ordersThisCycle = 0;
    const maxOrdersPerCycle = 3; // Rate limit: max 3 orders per cycle

    for (const signal of signals) {
      if (ordersThisCycle >= maxOrdersPerCycle) break;

      const riskResult = checkRisk(
        signal,
        config,
        balance,
        openPositionCount + ordersThisCycle,
        totalExposure
      );

      if (!riskResult.allowed) {
        await log('info', 'risk', `Blocked: ${riskResult.reason}`, {
          question: signal.question.slice(0, 60),
        });
        continue;
      }

      const finalSize = riskResult.adjustedSize ?? signal.size;

      // Execute the trade
      try {
        await log('trade', 'order', `Placing ${signal.action} ${finalSize.toFixed(2)} @ $${signal.price.toFixed(2)}`, {
          outcome: signal.outcome,
          question: signal.question.slice(0, 80),
          reason: signal.reason,
        });

        const result = await placeOrder({
          tokenId: signal.tokenId,
          side: signal.action,
          price: signal.price,
          size: finalSize,
        });

        ordersThisCycle++;
        state.ordersPlaced++;

        await log('trade', 'order', `Order placed successfully`, {
          result: typeof result === 'object' ? JSON.stringify(result).slice(0, 200) : String(result),
          outcome: signal.outcome,
          cost: (signal.price * finalSize).toFixed(2),
        });
      } catch (err) {
        await log('error', 'order', `Order failed: ${err instanceof Error ? err.message : String(err)}`, {
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
      await log('info', 'scan', `Cycle #${cycleNum} complete: ${ordersThisCycle} orders placed`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log('error', 'error', `Cycle #${cycleNum} failed: ${msg}`);
    state.error = msg;
  }
}

// ─── Public API ───────────────────────────────────────────

export async function startBot(): Promise<BotState> {
  if (state.status === 'running') {
    return state;
  }

  const config = await loadConfig();

  state = {
    status: 'running',
    startedAt: new Date().toISOString(),
    lastScanAt: null,
    cycleCount: 0,
    marketsScanned: 0,
    opportunitiesFound: 0,
    ordersPlaced: 0,
    totalPnl: 0,
    error: null,
  };

  await log('info', 'start', `Bot started (interval: ${config.scanIntervalMinutes}m)`);

  // Run first cycle immediately
  runCycle();

  // Schedule subsequent cycles
  const intervalMs = config.scanIntervalMinutes * 60 * 1000;
  scanInterval = setInterval(() => {
    runCycle();
  }, intervalMs);

  return state;
}

export async function stopBot(): Promise<BotState> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  state.status = 'stopped';
  await log('info', 'stop', `Bot stopped after ${state.cycleCount} cycles, ${state.ordersPlaced} orders placed`);

  return state;
}

export function getBotState(): BotState {
  return { ...state };
}

export function getBotLogs(limit = 50): BotLogEntry[] {
  return logBuffer.slice(-limit);
}

export async function getPersistedLogs(limit = 100): Promise<BotLogEntry[]> {
  const logs = await prisma.botLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return logs.map((l) => ({
    id: l.id,
    level: l.level as BotLogEntry['level'],
    event: l.event,
    message: l.message,
    data: l.data ? JSON.parse(l.data) : undefined,
    createdAt: l.createdAt.toISOString(),
  }));
}
