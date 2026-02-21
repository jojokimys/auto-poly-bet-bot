'use client';

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { Card, CardBody, CardHeader, Chip } from '@heroui/react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  ColorType,
  LineStyle,
  CrosshairMode,
} from 'lightweight-charts';
import { useAppStore } from '@/store/useAppStore';
import { useMMStore } from '@/store/useMMStore';
import { useBinanceWS, type LiveKline } from '@/hooks/useBinanceWS';
import type { CryptoAsset } from '@/lib/mm/types';

// ─── Single asset mini chart ─────────────────────────────

interface MiniChartProps {
  asset: CryptoAsset;
  height: number;
}

interface KlinePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function MiniChart({ asset, height }: MiniChartProps) {
  const theme = useAppStore((s) => s.theme);
  const isDark = theme === 'dark';
  const sniperDetail = useMMStore((s) => s.sniperDetail);
  const scannedMarkets = useMMStore((s) => s.scannedMarkets);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const strikeLinesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const klinesRef = useRef<KlinePoint[]>([]);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Fetch initial klines
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/mm/klines?symbol=${asset}USDT&interval=1m&limit=60`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          klinesRef.current = data.klines ?? [];
          updateChartData();
        }
      } catch { /* silent */ }
    })();
    // Refresh every 15s
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/mm/klines?symbol=${asset}USDT&interval=1m&limit=60`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          klinesRef.current = data.klines ?? [];
          updateChartData();
        }
      } catch { /* silent */ }
    }, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [asset]);

  // WS kline update
  const handleKline = useCallback((kline: LiveKline) => {
    const klines = klinesRef.current;
    if (klines.length === 0) return;
    const last = klines[klines.length - 1];

    if (kline.time === last.time) {
      klines[klines.length - 1] = { ...kline };
    } else if (kline.time > last.time) {
      klines.push({ time: kline.time, open: kline.open, high: kline.high, low: kline.low, close: kline.close, volume: kline.volume });
      if (klines.length > 60) klines.shift();
    }
    setLivePrice(kline.close);
    updateChartData();
  }, []);

  useBinanceWS({ symbol: `${asset}USDT`, onKline: handleKline, enabled: true });

  function updateChartData() {
    if (!seriesRef.current) return;
    const data: CandlestickData<Time>[] = klinesRef.current.map((k) => ({
      time: (k.time / 1000) as Time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));
    seriesRef.current.setData(data);
  }

  // Detect 5m vs 15m from question time range
  const detectMode = useCallback((question: string): '5m' | '15m' => {
    const m = question.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return '15m';
    let startH = parseInt(m[1]), startM = parseInt(m[2]);
    let endH = parseInt(m[4]), endM = parseInt(m[5]);
    if (m[3].toUpperCase() === 'PM' && startH !== 12) startH += 12;
    if (m[3].toUpperCase() === 'AM' && startH === 12) startH = 0;
    if (m[6].toUpperCase() === 'PM' && endH !== 12) endH += 12;
    if (m[6].toUpperCase() === 'AM' && endH === 12) endH = 0;
    const diff = (endH * 60 + endM) - (startH * 60 + startM);
    return diff <= 7 ? '5m' : '15m';
  }, []);

  // Strike prices enriched with sniper market data
  interface StrikeInfo {
    price: number;
    endTime: string;
    mode: '5m' | '15m';
    status: 'watching' | 'entered' | 'expired' | null;
    direction: 'YES' | 'NO' | null;
    entryPrice: number | null;
    held: number;
    confidence: number;
  }

  const strikePrices: StrikeInfo[] = useMemo(() => {
    const strikes = new Map<number, StrikeInfo>();

    const sniperMarkets = sniperDetail?.markets ?? [];
    for (const m of sniperMarkets) {
      if (m.cryptoAsset === asset && m.strikePrice !== null && m.strikePrice > 0) {
        strikes.set(m.strikePrice, {
          price: m.strikePrice,
          endTime: m.endTime,
          mode: detectMode(m.question),
          status: m.status,
          direction: m.direction,
          entryPrice: m.entryPrice,
          held: m.held,
          confidence: m.confidence,
        });
      }
    }
    for (const m of scannedMarkets) {
      if (m.cryptoAsset === asset && m.strikePrice !== null && m.strikePrice > 0) {
        if (!strikes.has(m.strikePrice)) {
          strikes.set(m.strikePrice, {
            price: m.strikePrice,
            endTime: m.endTime,
            mode: detectMode(m.question),
            status: null,
            direction: null,
            entryPrice: null,
            held: 0,
            confidence: 0,
          });
        }
      }
    }
    return [...strikes.values()];
  }, [sniperDetail?.markets, scannedMarkets, asset, detectMode]);

  // Stable key: only changes when actual strike values change
  const strikeKey = useMemo(
    () => strikePrices.map((s) => `${s.price}:${s.endTime}`).join('|'),
    [strikePrices],
  );

  // Create chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: isDark ? '#9ca3af' : '#6b7280',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: isDark ? '#1f2937' : '#f3f4f6' },
        horzLines: { color: isDark ? '#1f2937' : '#f3f4f6' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: isDark ? '#374151' : '#e5e7eb' },
      timeScale: {
        borderColor: isDark ? '#374151' : '#e5e7eb',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    chartRef.current = chart;
    seriesRef.current = series;
    updateChartData();

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        chart.applyOptions({ width, height });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      strikeLinesRef.current = [];
    };
  }, [isDark, height]);

  // Strike lines — redraw when strikes change or klines update
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const line of strikeLinesRef.current) {
      chart.removeSeries(line);
    }
    strikeLinesRef.current = [];

    const klines = klinesRef.current;
    if (strikePrices.length === 0 || klines.length === 0) return;

    const startTime = (klines[0].time / 1000) as Time;
    const endTime = (klines[klines.length - 1].time / 1000) as Time;

    for (const strike of strikePrices) {
      const is5m = strike.mode === '5m';
      const strikeLine = chart.addSeries(LineSeries, {
        color: is5m ? '#facc15' : '#38bdf8',   // yellow (5m) vs sky-blue (15m)
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        crosshairMarkerVisible: false,
        priceLineVisible: true,
        lastValueVisible: true,
        title: `${strike.mode} $${strike.price.toLocaleString()}`,
      });
      strikeLine.setData([
        { time: startTime, value: strike.price },
        { time: endTime, value: strike.price },
      ]);
      strikeLinesRef.current.push(strikeLine);
    }
  }, [strikeKey, strikePrices]);

  const currentPrice = livePrice ?? (klinesRef.current.length > 0 ? klinesRef.current[klinesRef.current.length - 1]?.close : null);

  return (
    <Card className="h-full">
      <CardHeader className="py-2 flex flex-col gap-1">
        {/* Row 1: Asset + price */}
        <div className="flex justify-between items-center w-full">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold">{asset}/USDT</h3>
            {currentPrice && (
              <span className="text-xs font-mono font-semibold text-gray-900 dark:text-white">
                ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            )}
          </div>
        </div>
        {/* Row 2: Strike info cards */}
        {strikePrices.length > 0 && (
          <div className="flex flex-wrap gap-1.5 w-full">
            {strikePrices.map((s) => {
              const secsLeft = Math.max(0, Math.floor((new Date(s.endTime).getTime() - now) / 1000));
              const m = Math.floor(secsLeft / 60);
              const sec = secsLeft % 60;
              const is5m = s.mode === '5m';

              // % diff from current price to strike
              const priceDiff = currentPrice && s.price > 0
                ? ((currentPrice - s.price) / s.price)
                : null;
              const diffSign = priceDiff !== null ? (priceDiff >= 0 ? '+' : '') : '';
              const diffColor = priceDiff !== null
                ? (Math.abs(priceDiff) < 0.001 ? '#9ca3af' : priceDiff >= 0 ? '#22c55e' : '#ef4444')
                : '#9ca3af';

              const isEntered = s.status === 'entered';
              const isUrgent = secsLeft > 0 && secsLeft <= 60;

              return (
                <div
                  key={s.price}
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1"
                  style={{
                    backgroundColor: isEntered
                      ? 'rgba(34, 197, 94, 0.12)'
                      : is5m ? 'rgba(250, 204, 21, 0.10)' : 'rgba(56, 189, 248, 0.10)',
                    border: `1px solid ${isEntered ? 'rgba(34, 197, 94, 0.3)' : is5m ? 'rgba(250, 204, 21, 0.25)' : 'rgba(56, 189, 248, 0.25)'}`,
                  }}
                >
                  {/* Mode badge */}
                  <span
                    className="text-[9px] font-bold px-1 rounded"
                    style={{
                      backgroundColor: is5m ? 'rgba(250, 204, 21, 0.25)' : 'rgba(56, 189, 248, 0.25)',
                      color: is5m ? '#facc15' : '#38bdf8',
                    }}
                  >
                    {s.mode}
                  </span>

                  {/* Strike price */}
                  <span className="text-[10px] font-mono text-gray-400">
                    ${s.price.toLocaleString()}
                  </span>

                  {/* % diff */}
                  {priceDiff !== null && (
                    <span className="text-[10px] font-mono font-semibold" style={{ color: diffColor }}>
                      {diffSign}{(priceDiff * 100).toFixed(3)}%
                    </span>
                  )}

                  {/* Countdown */}
                  <span
                    className="text-[10px] font-mono font-semibold"
                    style={{ color: isUrgent ? '#f59e0b' : '#9ca3af' }}
                  >
                    {m}:{String(sec).padStart(2, '0')}
                  </span>

                  {/* Entry status */}
                  {isEntered && s.direction && (
                    <Chip
                      size="sm"
                      variant="flat"
                      className="text-[9px] h-4 min-w-0 px-1"
                      style={{
                        backgroundColor: 'rgba(34, 197, 94, 0.20)',
                        color: '#22c55e',
                      }}
                    >
                      {s.direction} {s.held}@{s.entryPrice?.toFixed(2)}
                    </Chip>
                  )}
                  {s.status === 'watching' && s.confidence > 0 && (
                    <span className="text-[9px] font-mono text-gray-500">
                      {(s.confidence * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardHeader>
      <CardBody className="pt-0 pb-2">
        <div ref={containerRef} style={{ width: '100%', height }} />
      </CardBody>
    </Card>
  );
}

// ─── Multi-chart container ───────────────────────────────

export function SniperMultiChart() {
  const sniperDetail = useMMStore((s) => s.sniperDetail);

  // Derive unique assets from running config, or default
  const assets: CryptoAsset[] = useMemo(() => {
    if (sniperDetail?.config?.selections) {
      const unique = new Set(sniperDetail.config.selections.map((s) => s.asset));
      return [...unique] as CryptoAsset[];
    }
    return ['BTC'];
  }, [sniperDetail?.config?.selections]);

  // Responsive height: fewer charts = taller
  const chartHeight = assets.length <= 2 ? 250 : assets.length <= 3 ? 200 : 170;

  return (
    <div className="grid grid-cols-1 gap-4">
      {assets.map((asset) => (
        <MiniChart key={asset} asset={asset} height={chartHeight} />
      ))}
    </div>
  );
}
