'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  LineSeries,
  ColorType,
  type IChartApi,
  type LineData,
  type Time,
} from 'lightweight-charts';

interface PriceTick {
  binance: number | null;
  rtdsBinance: number | null;
  chainlink: number | null;
  strike: number | null;
  upMid: number | null;
  downMid: number | null;
  debug: string;
  timestamp: number;
}

export default function PriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [latest, setLatest] = useState<PriceTick | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0a0a0a' },
        textColor: '#9ca3af',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1f2937' },
        horzLines: { color: '#1f2937' },
      },
      crosshair: { mode: 0 },
      rightPriceScale: {
        borderColor: '#374151',
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
      leftPriceScale: {
        visible: true,
        borderColor: '#374151',
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
      timeScale: {
        borderColor: '#374151',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 5,
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 400,
    });

    // Right Y-axis: BTC prices
    const binanceSeries = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 2,
      title: 'Binance',
      lastValueVisible: true,
      priceLineVisible: false,
      priceScaleId: 'right',
    });

    const rtdsSeries = chart.addSeries(LineSeries, {
      color: '#a855f7',
      lineWidth: 1,
      title: 'RTDS',
      lastValueVisible: true,
      priceLineVisible: false,
      priceScaleId: 'right',
      lineStyle: 2,
    });

    const chainlinkSeries = chart.addSeries(LineSeries, {
      color: '#10b981',
      lineWidth: 1,
      title: 'Chainlink',
      lastValueVisible: true,
      priceLineVisible: false,
      priceScaleId: 'right',
      lineStyle: 2,
    });

    const strikeSeries = chart.addSeries(LineSeries, {
      color: '#ef4444',
      lineWidth: 1,
      title: 'Strike',
      lastValueVisible: true,
      priceLineVisible: true,
      priceScaleId: 'right',
      lineStyle: 3,
    });

    // Left Y-axis: token mid prices (0~1)
    const upMidSeries = chart.addSeries(LineSeries, {
      color: '#f472b6',
      lineWidth: 2,
      title: 'Up Mid',
      lastValueVisible: true,
      priceLineVisible: true,
      priceScaleId: 'left',
    });



    const onResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight || 400,
        });
      }
    };
    window.addEventListener('resize', onResize);

    // Left Y-axis fixed 0–1: transparent anchor series force autoScale range
    chart.priceScale('left').applyOptions({
      autoScale: true,
      scaleMargins: { top: 0, bottom: 0 },
    });
    const anchorTop = chart.addSeries(LineSeries, {
      priceScaleId: 'left',
      color: 'rgba(0,0,0,0)',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const anchorBot = chart.addSeries(LineSeries, {
      priceScaleId: 'left',
      color: 'rgba(0,0,0,0)',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    const es = new EventSource('/api/arb/prices');
    let lastStrike: number | null = null;
    let lastTimeSec = 0;

    es.onmessage = (e) => {
      try {
        const tick: PriceTick = JSON.parse(e.data);
        const timeSec = Math.floor(tick.timestamp / 1000);

        // lightweight-charts requires strictly increasing time — skip duplicate seconds
        if (timeSec <= lastTimeSec) {
          setLatest(tick);
          return;
        }
        lastTimeSec = timeSec;
        const time = timeSec as Time;
        setLatest(tick);

        // Pin left Y-axis anchors at 0 and 1
        anchorBot.update({ time, value: 0 } as LineData<Time>);
        anchorTop.update({ time, value: 1 } as LineData<Time>);

        // Detect strike change → clear strike & token series for clean redraw
        if (tick.strike && lastStrike && Math.abs(tick.strike - lastStrike) > 1) {
          strikeSeries.setData([]);
          upMidSeries.setData([]);
        }
        if (tick.strike) lastStrike = tick.strike;

        if (tick.binance) binanceSeries.update({ time, value: tick.binance } as LineData<Time>);
        if (tick.rtdsBinance) rtdsSeries.update({ time, value: tick.rtdsBinance } as LineData<Time>);
        if (tick.chainlink) chainlinkSeries.update({ time, value: tick.chainlink } as LineData<Time>);
        if (tick.strike) strikeSeries.update({ time, value: tick.strike } as LineData<Time>);
        if (tick.upMid != null) upMidSeries.update({ time, value: tick.upMid } as LineData<Time>);
      } catch (err) {
        console.error('[PriceChart] update error:', err);
      }
    };

    return () => {
      window.removeEventListener('resize', onResize);
      es.close();
      chart.remove();
    };
  }, []);

  // Compute latency diffs
  const bnPrice = latest?.binance;
  const rtdsPrice = latest?.rtdsBinance;
  const clPrice = latest?.chainlink;
  const rtdsDiff = bnPrice && rtdsPrice ? (rtdsPrice - bnPrice).toFixed(2) : null;
  const clDiff = bnPrice && clPrice ? (clPrice - bnPrice).toFixed(2) : null;

  return (
    <div className="relative h-full">
      {/* Legend */}
      <div className="absolute top-2 left-2 z-10 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono leading-tight">
        <span className="text-amber-500">BN ${latest?.binance?.toFixed(1) ?? '—'}</span>
        <span className="text-purple-400">
          RTDS ${latest?.rtdsBinance?.toFixed(1) ?? '—'}
          {rtdsDiff && <span className="text-gray-500 ml-1">({rtdsDiff})</span>}
        </span>
        <span className="text-emerald-500">
          CL ${latest?.chainlink?.toFixed(1) ?? '—'}
          {clDiff && <span className="text-gray-500 ml-1">({clDiff})</span>}
        </span>
        <span className="text-red-400">STK ${latest?.strike?.toFixed(1) ?? '—'}</span>
        <span className="text-pink-400">Up {latest?.upMid?.toFixed(3) ?? '—'}</span>
        {latest?.debug && (
          <span className="text-yellow-500">[{latest.debug}]</span>
        )}
      </div>
      <div ref={containerRef} className="h-full" />
    </div>
  );
}
