'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Card, CardBody, Button, Chip, Spinner, Select, SelectItem } from '@heroui/react';
import { useProfileStore } from '@/store/useProfileStore';

// ─── Trade Sound (Web Audio API — works even when tab is not focused) ───

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTradeSound(type: 'buy' | 'sell' = 'buy') {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    if (type === 'buy') {
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(900, ctx.currentTime + 0.15);
    } else {
      osc.frequency.setValueAtTime(900, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(600, ctx.currentTime + 0.15);
    }
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch { /* ignore */ }
}

// ─── Types ───

interface EngineStatus {
  running: boolean;
  profileId?: string;
  balance?: number;
  binanceConnected: boolean;
  depthConnected: boolean;
  clobConnected: boolean;
  binancePingMs: number | null;
  depthPingMs: number | null;
  clobPingMs: number | null;
  activeMarket?: {
    slug: string;
    endTime: number;
    strikePrice: number;
    secondsToExpiry: number;
  };
  currentOBI: number;
  depthRatio: number;
  positions: number;
  tradesTotal: number;
  hourlyPnl: number;
  windowPnl: number;
  signalState: string;
  strikeCrossings: number;
  trendUsed: boolean;
  toggles: { collect: boolean; trend: boolean; reversal: boolean };
}

interface DepthLevel { price: number; qty: number }

interface TradeFlowStats {
  imbalance: number;
  buyVolume: number;
  sellVolume: number;
  tradesPerSec: number;
  acceleration: number;
  tradeCount: number;
  volumeSpike: number;
}

interface DepthData {
  bids: DepthLevel[];
  asks: DepthLevel[];
  obi: number;
  obiHistory: { obi: number; timestamp: number }[];
  depthRatio: number;
  obiFlip: { flipped: boolean; delta: number; recentOBI: number; olderOBI: number };
  walls: { bidWall: DepthLevel | null; askWall: DepthLevel | null };
  spread: number;
  strikePrice: number;
  binancePrice: number | null;
  windowOpenPrice: number;
  secondsToExpiry: number;
  flow: TradeFlowStats;
  confidence: {
    reversalPct: number;
    noReversalPct: number;
    direction: 'Up' | 'Down' | null;
    factors: { name: string; value: number; signal: 'reversal' | 'no-reversal' | 'neutral' }[];
  };
}

interface LogLine {
  text: string;
  type: 'trade' | 'error' | 'eval' | 'info';
  timestamp: number;
}

interface Trade {
  id: string;
  timestamp: number;
  strategy?: 'reversal' | 'trend';
  side: 'BUY' | 'SELL';
  direction: 'Up' | 'Down';
  tokenPrice: number;
  size: number;
  obi: number;
  obiDelta: number;
  depthRatio: number;
  secondsToExpiry: number;
  result?: string;
  pnl?: number;
  error?: string;
}

type LogFilter = 'trade' | 'eval';

// ─── Orderbook Visualization Component ───

function OrderbookViz({ depth }: { depth: DepthData | null }) {
  if (!depth || depth.bids.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-600 text-xs">
        Waiting for orderbook data...
      </div>
    );
  }

  const { bids, asks, strikePrice, binancePrice, windowOpenPrice, walls, obiFlip, spread, flow, confidence } = depth;

  // Find max qty for bar scaling
  const allQty = [...bids, ...asks].map(l => l.qty);
  const maxQty = Math.max(...allQty, 0.001);

  // Determine price direction relative to window open price
  const openPrice = windowOpenPrice > 0 ? windowOpenPrice : strikePrice;
  const priceVsStrike = binancePrice && openPrice
    ? binancePrice > openPrice ? 'above' : binancePrice < openPrice ? 'below' : 'at'
    : null;
  const priceDist = binancePrice && openPrice ? ((binancePrice - openPrice) / openPrice * 100) : 0;
  const blocked = Math.abs(priceDist) > 0.2;

  // Cumulative volumes for depth visualization
  let cumBidQty = 0;
  let cumAskQty = 0;
  const bidsCum = bids.map(b => { cumBidQty += b.qty; return { ...b, cum: cumBidQty }; });
  const asksCum = asks.map(a => { cumAskQty += a.qty; return { ...a, cum: cumAskQty }; });
  const maxCum = Math.max(cumBidQty, cumAskQty, 0.001);

  return (
    <div className="h-full flex flex-col gap-2">
      {/* Header: BTC price vs strike */}
      <div className="flex items-center justify-between text-[10px] flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-gray-500">BTC</span>
          <span className="font-mono font-bold text-gray-200">
            ${binancePrice?.toLocaleString(undefined, { minimumFractionDigits: 1 }) ?? '—'}
          </span>
          <span className={`font-mono font-bold ${
            blocked ? 'text-red-400' : Math.abs(priceDist) > 0.15 ? 'text-yellow-400' : 'text-gray-400'
          }`}>
            {priceDist >= 0 ? '+' : ''}{priceDist.toFixed(3)}%
          </span>
          {priceVsStrike && (
            <Chip size="sm" variant="flat" color={blocked ? 'danger' : priceVsStrike === 'above' ? 'success' : priceVsStrike === 'below' ? 'danger' : 'default'}>
              {blocked ? 'BLOCKED' : priceVsStrike === 'above' ? 'ABOVE' : priceVsStrike === 'below' ? 'BELOW' : 'AT'}
            </Chip>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-gray-500">Open</span>
          <span className="font-mono text-yellow-400">${openPrice.toLocaleString()}</span>
          <span className="text-gray-500">Strike</span>
          <span className="font-mono text-gray-400">${strikePrice.toLocaleString()}</span>
          <span className="text-gray-500">Spread</span>
          <span className="font-mono text-gray-300">${spread.toFixed(2)}</span>
        </div>
      </div>

      {/* OBI Flip indicator */}
      {obiFlip.flipped && (
        <div className={`text-[10px] font-bold px-2 py-1 rounded ${
          obiFlip.delta > 0 ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'
        }`}>
          OBI FLIP {obiFlip.delta > 0 ? 'BULLISH' : 'BEARISH'} (delta: {obiFlip.delta.toFixed(3)})
          {obiFlip.delta > 0 ? ' — Price may reverse UP' : ' — Price may reverse DOWN'}
        </div>
      )}

      {/* Orderbook ladder */}
      <div className="flex-1 min-h-0 flex gap-1 overflow-hidden">
        {/* Bids (left) */}
        <div className="flex-1 flex flex-col-reverse gap-px overflow-hidden">
          <div className="text-[9px] text-green-500 font-semibold mb-0.5 text-center">BIDS</div>
          {bidsCum.slice(0, 12).map((b, i) => {
            const barPct = (b.qty / maxQty) * 100;
            const cumPct = (b.cum / maxCum) * 100;
            const isWall = walls.bidWall && Math.abs(b.price - walls.bidWall.price) < 1;
            return (
              <div key={i} className="relative flex items-center h-[18px] group">
                {/* Cumulative depth fill */}
                <div
                  className="absolute inset-y-0 right-0 bg-green-900/20 transition-all duration-300"
                  style={{ width: `${cumPct}%` }}
                />
                {/* Individual level bar */}
                <div
                  className={`absolute inset-y-0 right-0 transition-all duration-200 ${
                    isWall ? 'bg-green-500/50' : 'bg-green-500/25'
                  }`}
                  style={{ width: `${barPct}%` }}
                />
                <span className={`relative z-10 text-[10px] font-mono pl-1 ${
                  isWall ? 'text-green-300 font-bold' : 'text-green-500/70'
                }`}>
                  {b.price.toFixed(1)}
                </span>
                <span className={`relative z-10 text-[10px] font-mono ml-auto pr-1 ${
                  isWall ? 'text-green-200 font-bold' : 'text-green-400/60'
                }`}>
                  {b.qty.toFixed(3)}
                  {isWall && ' WALL'}
                </span>
              </div>
            );
          })}
        </div>

        {/* Center: mid price + OBI arrow */}
        <div className="w-12 flex flex-col items-center justify-center gap-1 flex-shrink-0">
          <div className={`text-xl ${
            depth.obi > 0.1 ? 'text-green-400' : depth.obi < -0.1 ? 'text-red-400' : 'text-gray-500'
          }`}>
            {depth.obi > 0.15 ? '⬆' : depth.obi < -0.15 ? '⬇' : '●'}
          </div>
          <div className="text-[9px] font-mono text-gray-400">
            {depth.obi.toFixed(2)}
          </div>
          <div className="text-[9px] text-gray-600">
            {depth.depthRatio.toFixed(2)}
          </div>
        </div>

        {/* Asks (right) */}
        <div className="flex-1 flex flex-col gap-px overflow-hidden">
          <div className="text-[9px] text-red-500 font-semibold mb-0.5 text-center">ASKS</div>
          {asksCum.slice(0, 12).map((a, i) => {
            const barPct = (a.qty / maxQty) * 100;
            const cumPct = (a.cum / maxCum) * 100;
            const isWall = walls.askWall && Math.abs(a.price - walls.askWall.price) < 1;
            return (
              <div key={i} className="relative flex items-center h-[18px] group">
                {/* Cumulative depth fill */}
                <div
                  className="absolute inset-y-0 left-0 bg-red-900/20 transition-all duration-300"
                  style={{ width: `${cumPct}%` }}
                />
                {/* Individual level bar */}
                <div
                  className={`absolute inset-y-0 left-0 transition-all duration-200 ${
                    isWall ? 'bg-red-500/50' : 'bg-red-500/25'
                  }`}
                  style={{ width: `${barPct}%` }}
                />
                <span className={`relative z-10 text-[10px] font-mono pl-1 ${
                  isWall ? 'text-red-200 font-bold' : 'text-red-400/60'
                }`}>
                  {a.qty.toFixed(3)}
                  {isWall && ' WALL'}
                </span>
                <span className={`relative z-10 text-[10px] font-mono ml-auto pr-1 ${
                  isWall ? 'text-red-300 font-bold' : 'text-red-500/70'
                }`}>
                  {a.price.toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Trade Flow (체결강도) */}
      <div className="flex-shrink-0 border-t border-gray-800 pt-1.5 mt-1">
        <div className="flex items-center justify-between text-[10px] mb-1">
          <span className="text-gray-500 font-semibold">Trade Flow (5s)</span>
          <span className="font-mono text-gray-400">{flow.tradesPerSec.toFixed(1)} tps · {flow.tradeCount} trades</span>
        </div>

        {/* Flow imbalance bar */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[9px] text-green-500 w-12 text-right font-mono">{flow.buyVolume.toFixed(3)}</span>
          <div className="flex-1 h-4 bg-gray-800 rounded-sm overflow-hidden relative">
            <div className="absolute inset-y-0 left-1/2 w-px bg-gray-600 z-10" />
            {/* Buy bar (right of center) */}
            {flow.imbalance > 0 && (
              <div
                className="absolute inset-y-0 bg-green-500/60 transition-all duration-300"
                style={{ left: '50%', width: `${Math.min(Math.abs(flow.imbalance) * 50, 50)}%` }}
              />
            )}
            {/* Sell bar (left of center) */}
            {flow.imbalance < 0 && (
              <div
                className="absolute inset-y-0 bg-red-500/60 transition-all duration-300"
                style={{ right: '50%', width: `${Math.min(Math.abs(flow.imbalance) * 50, 50)}%` }}
              />
            )}
            {/* Imbalance label */}
            <span className={`absolute inset-0 flex items-center justify-center text-[9px] font-mono font-bold z-20 ${
              flow.imbalance > 0.15 ? 'text-green-300' :
              flow.imbalance < -0.15 ? 'text-red-300' : 'text-gray-500'
            }`}>
              {flow.imbalance > 0 ? '+' : ''}{(flow.imbalance * 100).toFixed(1)}%
            </span>
          </div>
          <span className="text-[9px] text-red-500 w-12 font-mono">{flow.sellVolume.toFixed(3)}</span>
        </div>

        {/* Acceleration + Volume spike */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-gray-500">Accel</span>
              <span className={`text-[10px] font-mono font-bold ${
                flow.acceleration > 0.10 ? 'text-green-400' :
                flow.acceleration < -0.10 ? 'text-red-400' : 'text-gray-500'
              }`}>
                {flow.acceleration > 0 ? '+' : ''}{(flow.acceleration * 100).toFixed(1)}%
                {flow.acceleration > 0.10 ? ' ▲' : flow.acceleration < -0.10 ? ' ▼' : ''}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-gray-500">Vol</span>
              <span className={`text-[10px] font-mono font-bold ${
                flow.volumeSpike >= 3 ? 'text-yellow-300' :
                flow.volumeSpike >= 2 ? 'text-yellow-500' : 'text-gray-500'
              }`}>
                {flow.volumeSpike.toFixed(1)}x
                {flow.volumeSpike >= 3 ? ' SPIKE' : flow.volumeSpike >= 2 ? ' HIGH' : ''}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[9px] text-gray-500">Depth</span>
            <span className="text-[9px] font-mono text-green-400">{bids.reduce((s, b) => s + b.qty, 0).toFixed(2)}</span>
            <span className="text-[9px] text-gray-600">/</span>
            <span className="text-[9px] font-mono text-red-400">{asks.reduce((s, a) => s + a.qty, 0).toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Confidence meter */}
      <div className="flex-shrink-0 border-t border-gray-800 pt-1.5 mt-1">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[9px] text-gray-500 font-semibold">Confidence</span>
          {confidence.direction && (
            <span className="text-[9px] text-gray-400">
              Reversal {confidence.direction} ?
            </span>
          )}
        </div>

        {/* Reversal vs No-Reversal bar */}
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-[10px] font-mono font-bold w-8 text-right ${
            confidence.reversalPct >= 60 ? 'text-yellow-400' : 'text-gray-500'
          }`}>
            {confidence.reversalPct}%
          </span>
          <div className="flex-1 h-4 bg-gray-800 rounded-sm overflow-hidden flex">
            <div
              className={`transition-all duration-300 ${
                confidence.reversalPct >= 60 ? 'bg-yellow-500/60' :
                confidence.reversalPct >= 40 ? 'bg-yellow-900/40' : 'bg-gray-700'
              }`}
              style={{ width: `${confidence.reversalPct}%` }}
            />
            <div
              className={`transition-all duration-300 ${
                confidence.noReversalPct >= 60 ? 'bg-blue-500/60' :
                confidence.noReversalPct >= 40 ? 'bg-blue-900/40' : 'bg-gray-700'
              }`}
              style={{ width: `${confidence.noReversalPct}%` }}
            />
          </div>
          <span className={`text-[10px] font-mono font-bold w-8 ${
            confidence.noReversalPct >= 60 ? 'text-blue-400' : 'text-gray-500'
          }`}>
            {confidence.noReversalPct}%
          </span>
        </div>

        {/* Factor labels */}
        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
          {confidence.factors.map((f, i) => (
            <span key={i} className={`text-[9px] font-mono ${
              f.signal === 'reversal' ? 'text-yellow-500' :
              f.signal === 'no-reversal' ? 'text-blue-400' : 'text-gray-600'
            }`}>
              {f.signal === 'reversal' ? '+' : f.signal === 'no-reversal' ? '-' : '~'}{f.name}
            </span>
          ))}
        </div>

        {/* Label */}
        <div className="flex justify-between mt-0.5">
          <span className="text-[8px] text-yellow-600">REVERSAL</span>
          <span className="text-[8px] text-blue-600">NO REVERSAL</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ───

export default function ReversalPage() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [depth, setDepth] = useState<DepthData | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [logFilters, setLogFilters] = useState<Set<LogFilter>>(new Set(['trade', 'eval']));
  const [profileId, setProfileId] = useState('cmlmpyou700bn0y09gh4fem6y');
  const { profiles, fetchProfiles } = useProfileStore();
  const prevTradeCountRef = useRef<number>(0);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/reversal');
      const data = await res.json();
      setStatus(data.engine);
    } catch {
      setStatus(null);
    }
    setLoading(false);
  }, []);

  const fetchDepth = useCallback(async () => {
    try {
      const res = await fetch('/api/reversal?depth=true');
      const data = await res.json();
      setDepth(data.depth ?? null);
    } catch { /* ignore */ }
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/reversal?logs=true&limit=300');
      const data = await res.json();
      setLogs(data.logs ?? []);
    } catch { /* ignore */ }
  }, []);

  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/reversal?trades=true&limit=30');
      const data = await res.json();
      const newTrades: Trade[] = data.trades ?? [];
      setTrades(newTrades);
      if (newTrades.length > 0 && prevTradeCountRef.current > 0 && newTrades.length > prevTradeCountRef.current) {
        const latest = newTrades[0];
        playTradeSound(latest.side === 'BUY' ? 'buy' : 'sell');
      }
      prevTradeCountRef.current = newTrades.length;
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchProfiles();
    fetchStatus();
    fetchDepth();
    fetchLogs();
    fetchTrades();

    // Depth updates faster (1s) for responsive orderbook viz
    const depthInterval = setInterval(fetchDepth, 1000);
    const statusInterval = setInterval(() => {
      fetchStatus();
      fetchLogs();
      fetchTrades();
    }, 3000);

    return () => {
      clearInterval(depthInterval);
      clearInterval(statusInterval);
    };
  }, [fetchProfiles, fetchStatus, fetchDepth, fetchLogs, fetchTrades]);

  const handleStart = async () => {
    if (!profileId.trim()) return;
    setActionLoading(true);
    try {
      await fetch('/api/reversal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', profileId: profileId.trim() }),
      });
      await fetchStatus();
    } catch { /* ignore */ }
    setActionLoading(false);
  };

  const handleStop = async () => {
    setActionLoading(true);
    try {
      await fetch('/api/reversal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      await fetchStatus();
    } catch { /* ignore */ }
    setActionLoading(false);
  };

  const handleToggle = async (key: 'collect' | 'trend' | 'reversal') => {
    if (!status?.toggles) return;
    const newVal = !status.toggles[key];
    try {
      await fetch('/api/reversal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggles', [key]: newVal }),
      });
      await fetchStatus();
    } catch { /* ignore */ }
  };

  const toggleFilter = (f: LogFilter) => {
    setLogFilters(prev => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const filteredLogs = logs.filter(l => {
    if (l.type === 'info' || l.type === 'error') return true;
    if (l.type === 'trade') return logFilters.has('trade');
    if (l.type === 'eval') return logFilters.has('eval');
    return true;
  });

  const reversedLogs = [...filteredLogs].reverse();

  const obiBarWidth = status ? Math.min(Math.abs(status.currentOBI) * 100, 50) : 0;
  const obiColor = status && status.currentOBI > 0 ? 'bg-green-500' : 'bg-red-500';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex gap-4 h-full">
      {/* ─── Left: Main Content ─── */}
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        {/* Header row */}
        <div className="flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">
              BTC 5M Reversal
            </h1>
            <Chip
              size="sm"
              color={status?.running ? 'success' : 'default'}
              variant="flat"
            >
              {status?.running ? 'RUNNING' : 'STOPPED'}
            </Chip>
            {status?.windowPnl !== undefined && status.windowPnl !== 0 && (
              <Chip size="sm" color={status.windowPnl >= 0 ? 'success' : 'danger'} variant="flat">
                win {status.windowPnl >= 0 ? '+' : ''}{status.windowPnl.toFixed(2)}
              </Chip>
            )}
            {status?.hourlyPnl !== undefined && status.hourlyPnl !== 0 && (
              <Chip size="sm" color={status.hourlyPnl >= 0 ? 'success' : 'danger'} variant="flat">
                {status.hourlyPnl >= 0 ? '+' : ''}{status.hourlyPnl.toFixed(2)}/hr
              </Chip>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold font-mono text-gray-900 dark:text-white">
              ${status?.balance?.toFixed(2) ?? '—'}
            </span>
            {!status?.running && (
              <Select
                size="sm"
                label="Profile"
                placeholder="Select profile"
                selectedKeys={profileId ? [profileId] : []}
                onSelectionChange={(keys) => {
                  const selected = Array.from(keys)[0] as string;
                  if (selected) setProfileId(selected);
                }}
                className="w-48"
              >
                {profiles.map((p) => (
                  <SelectItem key={p.id}>{p.name}</SelectItem>
                ))}
              </Select>
            )}
            {status?.running ? (
              <Button size="sm" color="danger" variant="flat" onPress={handleStop} isLoading={actionLoading}>
                Stop
              </Button>
            ) : (
              <Button size="sm" color="success" variant="flat" onPress={handleStart} isLoading={actionLoading} isDisabled={!profileId}>
                Start
              </Button>
            )}
          </div>

          {/* Feature toggles (always visible) */}
          <div className="flex items-center gap-3">
            {(['collect', 'trend', 'reversal'] as const).map(key => (
              <label key={key} className="flex items-center gap-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={status?.toggles?.[key] ?? (key === 'collect' || key === 'reversal')}
                  onChange={() => handleToggle(key)}
                  className="w-3 h-3 accent-blue-500"
                />
                <span className="text-[11px] text-gray-400 capitalize">{key}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Status bar */}
        <div className="flex items-center gap-4 text-xs flex-shrink-0">
          <div className="flex items-center gap-2">
            {([
              { label: 'Binance', connected: status?.binanceConnected, ping: status?.binancePingMs },
              { label: 'Depth', connected: status?.depthConnected, ping: status?.depthPingMs },
              { label: 'CLOB', connected: status?.clobConnected, ping: status?.clobPingMs },
            ] as const).map(feed => (
              <Chip key={feed.label} size="sm" color={feed.connected ? 'success' : 'danger'} variant="dot">
                {feed.label}
                {feed.connected && feed.ping != null && (
                  <span className="ml-1 text-[10px] opacity-70">{feed.ping}ms</span>
                )}
              </Chip>
            ))}
          </div>
          {status?.activeMarket && (
            <>
              <span className="text-gray-600">|</span>
              <span className="font-mono text-gray-400">{status.activeMarket.slug}</span>
              <span className="font-mono text-gray-300">STK ${status.activeMarket.strikePrice.toLocaleString()}</span>
              <span className={`font-mono font-bold ${
                status.activeMarket.secondsToExpiry <= 60 ? 'text-yellow-400' : 'text-gray-300'
              }`}>
                {status.activeMarket.secondsToExpiry}s
                {status.activeMarket.secondsToExpiry <= 60 && ' EVAL ACTIVE'}
              </span>
              <span className="font-mono text-gray-300">pos={status.positions}</span>
            </>
          )}
        </div>

        {/* Signal cards + Orderbook */}
        <div className="flex gap-3 flex-shrink-0" style={{ height: '280px' }}>
          {/* Signal gauges */}
          <div className="w-48 flex flex-col gap-3 flex-shrink-0">
            {/* OBI */}
            <Card className="flex-1">
              <CardBody className="p-3">
                <div className="text-[10px] text-gray-500 mb-1">OBI</div>
                <span className={`text-lg font-mono font-bold ${
                  (status?.currentOBI ?? 0) > 0.1 ? 'text-green-400' :
                  (status?.currentOBI ?? 0) < -0.1 ? 'text-red-400' : 'text-gray-400'
                }`}>
                  {status?.currentOBI?.toFixed(3) ?? '0.000'}
                </span>
                <div className="h-3 bg-gray-800 rounded-full overflow-hidden relative mt-1">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-gray-600" />
                  <div
                    className={`absolute inset-y-0 ${obiColor} rounded-full transition-all duration-200`}
                    style={{
                      left: (status?.currentOBI ?? 0) >= 0 ? '50%' : `${50 - obiBarWidth}%`,
                      width: `${obiBarWidth}%`,
                    }}
                  />
                </div>
                <div className="text-[10px] text-gray-600 mt-1">
                  {(status?.currentOBI ?? 0) > 0.2 ? 'Strong Buy' :
                   (status?.currentOBI ?? 0) > 0.1 ? 'Mild Buy' :
                   (status?.currentOBI ?? 0) < -0.2 ? 'Strong Sell' :
                   (status?.currentOBI ?? 0) < -0.1 ? 'Mild Sell' : 'Balanced'}
                </div>
              </CardBody>
            </Card>

            {/* Depth Ratio */}
            <Card className="flex-1">
              <CardBody className="p-3">
                <div className="text-[10px] text-gray-500 mb-1">Depth Ratio</div>
                <span className={`text-lg font-mono font-bold ${
                  (status?.depthRatio ?? 1) > 1.3 ? 'text-green-400' :
                  (status?.depthRatio ?? 1) < 0.77 ? 'text-red-400' : 'text-gray-400'
                }`}>
                  {status?.depthRatio?.toFixed(3) ?? '1.000'}
                </span>
                <div className="text-[10px] text-gray-600 mt-1">
                  {(status?.depthRatio ?? 1) > 1.5 ? 'Heavy Bid' :
                   (status?.depthRatio ?? 1) > 1.3 ? 'Bid Favored' :
                   (status?.depthRatio ?? 1) < 0.67 ? 'Heavy Ask' :
                   (status?.depthRatio ?? 1) < 0.77 ? 'Ask Favored' : 'Balanced'}
                </div>
              </CardBody>
            </Card>

            {/* Signal State */}
            <Card className="flex-1">
              <CardBody className="p-3">
                <div className="text-[10px] text-gray-500 mb-1">Signal</div>
                <span className="text-[11px] font-mono text-gray-300 break-all">
                  {status?.signalState ?? 'idle'}
                </span>
                <div className="text-[10px] text-gray-600 mt-1">
                  T:{status?.tradesTotal ?? 0} P:{status?.positions ?? 0} X:{status?.strikeCrossings ?? 0} {status?.trendUsed ? 'TRD' : ''}
                </div>
              </CardBody>
            </Card>
          </div>

          {/* Binance Orderbook Visualization */}
          <Card className="flex-1">
            <CardBody className="p-3 h-full">
              <OrderbookViz depth={depth} />
            </CardBody>
          </Card>
        </div>

        {/* Recent Trades Table */}
        <Card className="flex-1 min-h-0">
          <CardBody className="p-3 overflow-y-auto">
            <div className="text-xs font-semibold text-gray-500 mb-2">Recent Trades</div>
            {trades.length === 0 ? (
              <div className="text-sm text-gray-600 text-center py-4">No trades yet</div>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-800">
                    <th className="text-left py-1">Time</th>
                    <th className="text-left">Strat</th>
                    <th className="text-left">Side</th>
                    <th className="text-left">Dir</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Size</th>
                    <th className="text-right">OBI</th>
                    <th className="text-right">TTX</th>
                    <th className="text-right">PnL</th>
                    <th className="text-left">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} className="border-b border-gray-800/50">
                      <td className="py-1 text-gray-500">{new Date(t.timestamp).toLocaleTimeString()}</td>
                      <td className={t.strategy === 'trend' ? 'text-blue-400' : 'text-yellow-400'}>{t.strategy === 'trend' ? 'TRD' : 'REV'}</td>
                      <td className={t.side === 'BUY' ? 'text-green-400' : 'text-red-400'}>{t.side}</td>
                      <td className={t.direction === 'Up' ? 'text-green-300' : 'text-red-300'}>{t.direction}</td>
                      <td className="text-right">${t.tokenPrice.toFixed(2)}</td>
                      <td className="text-right">{t.size}</td>
                      <td className="text-right">{t.obi.toFixed(3)}</td>
                      <td className="text-right">{Math.round(t.secondsToExpiry)}s</td>
                      <td className={`text-right ${(t.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {t.pnl != null ? `$${t.pnl.toFixed(2)}` : '—'}
                      </td>
                      <td>
                        <Chip size="sm" variant="flat" color={
                          t.result === 'exit-profit' || t.result === 'win' ? 'success' :
                          t.result === 'loss' || t.result === 'exit-expiry' ? 'danger' :
                          'default'
                        }>
                          {t.result ?? 'pending'}
                        </Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </div>

      {/* ─── Right: Live Logs ─── */}
      <div className="w-[420px] flex-shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Live Logs</h3>
            <span className="text-[10px] text-gray-500">{filteredLogs.length}</span>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={logFilters.has('trade')} onChange={() => toggleFilter('trade')} className="w-3 h-3 rounded accent-green-500" />
              <span className="text-[10px] text-green-400 font-medium">Trades</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={logFilters.has('eval')} onChange={() => toggleFilter('eval')} className="w-3 h-3 rounded accent-gray-500" />
              <span className="text-[10px] text-gray-500 font-medium">Eval</span>
            </label>
          </div>
        </div>
        <div className="flex-1 min-h-0 bg-gray-950 rounded-lg p-3 overflow-y-auto font-mono text-[11px] leading-relaxed">
          {reversedLogs.length === 0 ? (
            <span className="text-gray-600">Waiting for logs...</span>
          ) : (
            reversedLogs.map((log, i) => (
              <div
                key={`${log.timestamp}-${i}`}
                className={
                  log.type === 'trade' ? 'text-green-400'
                    : log.type === 'error' ? 'text-red-400'
                      : log.type === 'eval' ? 'text-gray-600'
                        : 'text-gray-500'
                }
              >
                {log.text}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
