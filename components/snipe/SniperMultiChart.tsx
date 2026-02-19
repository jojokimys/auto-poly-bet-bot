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

  // Strike prices for this asset — stable key to avoid unnecessary redraws
  const strikePrices = useMemo(() => {
    const strikes = new Map<number, { price: number; endTime: string }>();

    const sniperMarkets = sniperDetail?.markets ?? [];
    for (const m of sniperMarkets) {
      if (m.cryptoAsset === asset && m.strikePrice !== null && m.strikePrice > 0) {
        strikes.set(m.strikePrice, { price: m.strikePrice, endTime: m.endTime });
      }
    }
    for (const m of scannedMarkets) {
      if (m.cryptoAsset === asset && m.strikePrice !== null && m.strikePrice > 0) {
        if (!strikes.has(m.strikePrice)) {
          strikes.set(m.strikePrice, { price: m.strikePrice, endTime: m.endTime });
        }
      }
    }
    return [...strikes.values()];
  }, [sniperDetail?.markets, scannedMarkets, asset]);

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
      const strikeLine = chart.addSeries(LineSeries, {
        color: '#f59e0b',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        crosshairMarkerVisible: false,
        priceLineVisible: true,
        lastValueVisible: true,
        title: `$${strike.price.toLocaleString()}`,
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
      <CardHeader className="py-2 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold">{asset}/USDT</h3>
          {currentPrice && (
            <span className="text-xs font-mono font-semibold text-gray-900 dark:text-white">
              ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {strikePrices.map((s) => {
            const secsLeft = Math.max(0, Math.floor((new Date(s.endTime).getTime() - now) / 1000));
            const m = Math.floor(secsLeft / 60);
            const sec = secsLeft % 60;
            return (
              <Chip key={s.price} size="sm" variant="flat" color="warning" className="text-[10px]">
                ${s.price.toLocaleString()} ({m}:{String(sec).padStart(2, '0')})
              </Chip>
            );
          })}
        </div>
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
