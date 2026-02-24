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
import { useBinanceWS } from '@/hooks/useBinanceWS';
import type { VolatilityRegime } from '@/lib/mm/types';

const REGIME_COLORS: Record<VolatilityRegime, 'success' | 'warning' | 'danger' | 'default'> = {
  calm: 'success',
  normal: 'warning',
  elevated: 'danger',
  volatile: 'danger',
};

export function CryptoChart() {
  const theme = useAppStore((s) => s.theme);
  const isDark = theme === 'dark';
  const klines = useMMStore((s) => s.klines);
  const livePrice = useMMStore((s) => s.livePrice);
  const detail = useMMStore((s) => s.detail);
  const scannedMarkets = useMMStore((s) => s.scannedMarkets);
  const updateLiveKline = useMMStore((s) => s.updateLiveKline);
  const selectedAsset = useMMStore((s) => s.selectedAsset);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const strikeLinesRef = useRef<ISeriesApi<'Line'>[]>([]);

  const regime = detail?.volatility?.regime ?? 'volatile';

  // Active markets with strike prices (from engine if running, otherwise from scan)
  const engineMarkets = detail?.markets ?? [];
  const activeQuotes = engineMarkets.filter((m) => m.bidPrice !== null);

  // Strike prices: merge engine markets + scanned markets (scanned always available)
  const strikePrices = useMemo(() => {
    const strikes = new Map<string, { price: number; asset: string; endTime: string }>();

    // From engine (running MM)
    for (const m of engineMarkets) {
      if (m.strikePrice !== null && m.strikePrice > 0) {
        const key = `${m.cryptoAsset}-${m.strikePrice}`;
        strikes.set(key, { price: m.strikePrice, asset: m.cryptoAsset, endTime: m.endTime });
      }
    }

    // From scan (always available, even when MM not running)
    for (const m of scannedMarkets) {
      if (m.strikePrice !== null && m.strikePrice > 0) {
        const key = `${m.cryptoAsset}-${m.strikePrice}`;
        if (!strikes.has(key)) {
          strikes.set(key, { price: m.strikePrice, asset: m.cryptoAsset, endTime: m.endTime });
        }
      }
    }

    return [...strikes.values()];
  }, [engineMarkets, scannedMarkets]);

  // 1-second ticker for live countdown
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Current price
  const currentPrice = livePrice ?? (klines.length > 0 ? klines[klines.length - 1].close : null);

  // Binance WS: real-time 1m kline updates
  const handleKline = useCallback(
    (kline: { time: number; open: number; high: number; low: number; close: number; volume: number; isClosed: boolean }) => {
      updateLiveKline(kline);
    },
    [updateLiveKline],
  );
  useBinanceWS({ symbol: `${selectedAsset}USDT`, onKline: handleKline, enabled: true });

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const initWidth = containerRef.current.clientWidth || containerRef.current.getBoundingClientRect().width;

    const chart = createChart(containerRef.current, {
      width: initWidth,
      height: 300,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: isDark ? '#9ca3af' : '#6b7280',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: isDark ? '#1f2937' : '#f3f4f6' },
        horzLines: { color: isDark ? '#1f2937' : '#f3f4f6' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: isDark ? '#374151' : '#e5e7eb',
      },
      timeScale: {
        borderColor: isDark ? '#374151' : '#e5e7eb',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      autoSize: false,
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

    // Responsive resize
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
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
  }, [isDark]);

  // Update candlestick data when klines change
  useEffect(() => {
    if (!seriesRef.current) return;

    if (klines.length === 0) {
      // Clear chart when switching assets
      seriesRef.current.setData([]);
      return;
    }

    const data: CandlestickData<Time>[] = klines.map((k) => ({
      time: (k.time / 1000) as Time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));

    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [klines]);

  // Update strike price lines
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Remove old strike lines
    for (const line of strikeLinesRef.current) {
      chart.removeSeries(line);
    }
    strikeLinesRef.current = [];

    if (strikePrices.length === 0 || klines.length === 0) return;

    const startTime = (klines[0].time / 1000) as Time;
    const endTime = (klines[klines.length - 1].time / 1000) as Time;

    for (const strike of strikePrices) {
      // Only show strikes matching selected asset
      if (strike.asset !== selectedAsset) continue;

      const strikeLine = chart.addSeries(LineSeries, {
        color: '#f59e0b',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        crosshairMarkerVisible: false,
        priceLineVisible: true,
        lastValueVisible: true,
        title: `Open $${strike.price.toLocaleString()}`,
      });

      strikeLine.setData([
        { time: startTime, value: strike.price },
        { time: endTime, value: strike.price },
      ]);

      strikeLinesRef.current.push(strikeLine);
    }
  }, [strikePrices, klines, selectedAsset]);

  return (
    <Card className="h-full overflow-hidden">
      <CardHeader className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{selectedAsset}/USDT</h3>
          <span className="text-[10px] text-gray-400">1m</span>
          {currentPrice && (
            <span className="text-sm font-mono font-semibold text-gray-900 dark:text-white">
              ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {strikePrices
            .filter((s) => s.asset === selectedAsset)
            .map((s) => {
              const secsLeft = Math.max(0, Math.floor((new Date(s.endTime).getTime() - now) / 1000));
              const m = Math.floor(secsLeft / 60);
              const sec = secsLeft % 60;
              return (
                <Chip key={s.price} size="sm" variant="flat" color="warning">
                  ${s.price.toLocaleString()} ({m}:{String(sec).padStart(2, '0')})
                </Chip>
              );
            })}
          <Chip size="sm" variant="flat" color={REGIME_COLORS[regime]}>
            {regime}
          </Chip>
        </div>
      </CardHeader>
      <CardBody className="pt-0 min-w-0 overflow-hidden">
        <div ref={containerRef} className="w-full h-[300px]" />

        {/* Active quotes bar */}
        {activeQuotes.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {activeQuotes.map((m) => (
              <div
                key={m.conditionId}
                className="flex items-center gap-1.5 text-[10px] bg-gray-50 dark:bg-gray-800 rounded px-2 py-1"
              >
                <span className="font-semibold">{m.cryptoAsset}</span>
                {m.strikePrice && (
                  <span className="text-amber-500 font-mono">${m.strikePrice.toLocaleString()}</span>
                )}
                <span className="text-green-600 font-mono">B:{m.bidPrice?.toFixed(2)}</span>
                <span className="text-red-500 font-mono">A:{m.askPrice?.toFixed(2)}</span>
                <span className="text-gray-400">
                  ({((1 - (m.bidPrice ?? 0) - (m.askPrice ?? 0)) * 100).toFixed(1)}c)
                </span>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
