import 'server-only';

import type { Candle, VolatilityRegime, VolatilityState } from './types';

// ─── Binance Kline Fetch ─────────────────────────────────

const BINANCE_API = 'https://api.binance.com/api/v3/klines';

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  const url = `${BINANCE_API}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Binance klines fetch failed: ${res.status}`);

  const raw: any[][] = await res.json();
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Technical Indicators ────────────────────────────────

function sma(values: number[], period: number): number {
  if (values.length < period) return values.reduce((s, v) => s + v, 0) / values.length;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function stddev(values: number[], period: number): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

function trueRange(candles: Candle[]): number[] {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      tr.push(c.high - c.low);
    } else {
      const prevClose = candles[i - 1].close;
      tr.push(Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose),
      ));
    }
  }
  return tr;
}

function atr(candles: Candle[], period: number): number {
  const tr = trueRange(candles);
  return sma(tr.slice(-period), period);
}

function percentileRank(current: number, history: number[]): number {
  if (history.length === 0) return 50;
  const below = history.filter((v) => v < current).length;
  return (below / history.length) * 100;
}

// ─── Volatility Computation ──────────────────────────────

export function computeVolatility(candles: Candle[]): VolatilityState {
  if (candles.length < 30) {
    return { regime: 'volatile', atrpPercentile: 100, bbwPercentile: 100, atrRatio: 2, lastUpdate: Date.now() };
  }

  const closes = candles.map((c) => c.close);
  const lastClose = closes[closes.length - 1];

  // ATR Percentage
  const atr14 = atr(candles, 14);
  const atrp = (atr14 / lastClose) * 100;

  // Compute rolling ATRP values for percentile
  const atrpHistory: number[] = [];
  for (let i = 28; i <= candles.length; i++) {
    const slice = candles.slice(0, i);
    const a = atr(slice, 14);
    atrpHistory.push((a / slice[slice.length - 1].close) * 100);
  }
  const atrpPct = percentileRank(atrp, atrpHistory.slice(-200));

  // Bollinger Band Width
  const period = 20;
  const k = 2;
  const middle = sma(closes, period);
  const sd = stddev(closes, period);
  const bbw = middle > 0 ? ((k * 2 * sd) / middle) * 100 : 0;

  // Rolling BBW for percentile
  const bbwHistory: number[] = [];
  for (let i = period; i <= closes.length; i++) {
    const slice = closes.slice(0, i);
    const m = sma(slice, period);
    const s = stddev(slice, period);
    if (m > 0) bbwHistory.push(((k * 2 * s) / m) * 100);
  }
  const bbwPct = percentileRank(bbw, bbwHistory.slice(-120));

  // ATR Ratio (short / long)
  const atr7 = atr(candles, 7);
  const atr28 = atr(candles, 28);
  const ratio = atr28 > 0 ? atr7 / atr28 : 2;

  // Regime classification
  let regime: VolatilityRegime;

  // Squeeze override: extremely low BBW signals impending expansion
  if (bbwPct < 10) {
    regime = 'volatile';
  } else if (atrpPct < 40 && bbwPct >= 15 && bbwPct <= 50 && ratio < 0.9) {
    regime = 'calm';
  } else if (atrpPct < 55 && bbwPct < 60 && ratio < 1.1) {
    regime = 'normal';
  } else if (atrpPct < 70 && ratio < 1.3) {
    regime = 'elevated';
  } else {
    regime = 'volatile';
  }

  return { regime, atrpPercentile: Math.round(atrpPct), bbwPercentile: Math.round(bbwPct), atrRatio: Math.round(ratio * 100) / 100, lastUpdate: Date.now() };
}

// ─── Cached State ────────────────────────────────────────

let cachedState: VolatilityState = {
  regime: 'volatile',
  atrpPercentile: 100,
  bbwPercentile: 100,
  atrRatio: 2,
  lastUpdate: 0,
};

export function getVolatilityRegime(): VolatilityState {
  return cachedState;
}

export async function refreshVolatility(klineInterval = '15m'): Promise<VolatilityState> {
  try {
    const candles = await fetchKlines('BTCUSDT', klineInterval, 200);
    cachedState = computeVolatility(candles);
  } catch (err) {
    console.error('[mm:volatility] Failed to refresh:', err instanceof Error ? err.message : err);
    // Keep old state but mark as volatile if stale > 5 min
    if (Date.now() - cachedState.lastUpdate > 5 * 60_000) {
      cachedState = { ...cachedState, regime: 'volatile', lastUpdate: Date.now() };
    }
  }
  return cachedState;
}
