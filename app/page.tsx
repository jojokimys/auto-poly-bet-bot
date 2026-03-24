'use client';

import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { Card, CardBody, Button, Chip, Spinner, Select, SelectItem } from '@heroui/react';
import { useProfileStore } from '@/store/useProfileStore';

const PriceChart = lazy(() => import('@/components/PriceChart'));

interface EngineStatus {
  running: boolean;
  profileId?: string;
  balance?: number;
  binanceConnected: boolean;
  rtdsConnected: boolean;
  clobConnected: boolean;
  binancePingMs: number | null;
  rtdsPingMs: number | null;
  clobPingMs: number | null;
  activeMarket?: {
    slug: string;
    endTime: number;
    strikePrice: number;
    secondsToExpiry: number;
  };
  positions: number;
  tradesTotal: number;
  hourlyPnl: number;
  windowPnl: number;
  vol?: number;
}

interface LogLine {
  text: string;
  type: 'trade' | 'error' | 'eval' | 'info';
  timestamp: number;
}

type LogFilter = 'trade' | 'eval';

export default function Home() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [logFilters, setLogFilters] = useState<Set<LogFilter>>(new Set(['trade', 'eval']));
  const [profileId, setProfileId] = useState('cmlmpyou700bn0y09gh4fem6y');
  const { profiles, fetchProfiles } = useProfileStore();

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/arb');
      const data = await res.json();
      setStatus(data.engine);
    } catch {
      setStatus(null);
    }
    setLoading(false);
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/arb?logs=true&limit=300');
      const data = await res.json();
      setLogs(data.logs ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchProfiles();
    fetchStatus();
    fetchLogs();
    const interval = setInterval(() => {
      fetchStatus();
      fetchLogs();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchProfiles, fetchStatus, fetchLogs]);

  const handleStart = async () => {
    if (!profileId.trim()) return;
    setActionLoading(true);
    try {
      await fetch('/api/arb', {
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
      await fetch('/api/arb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      await fetchStatus();
    } catch { /* ignore */ }
    setActionLoading(false);
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

  // Reverse: newest first
  const reversedLogs = [...filteredLogs].reverse();

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
              BTC Latency Arb
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
        </div>

        {/* Status bar */}
        <div className="flex items-center gap-4 text-xs flex-shrink-0">
          <div className="flex items-center gap-2">
            {([
              { label: 'Binance', connected: status?.binanceConnected, ping: status?.binancePingMs },
              { label: 'RTDS', connected: status?.rtdsConnected, ping: status?.rtdsPingMs },
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
              <span className="font-mono text-gray-300">{status.activeMarket.secondsToExpiry}s</span>
              <span className="font-mono text-gray-300">pos={status.positions}</span>
              <span className="font-mono text-gray-300">vol={status.vol ? `${(status.vol * 100).toFixed(1)}%` : '—'}</span>
            </>
          )}
        </div>

        {/* Price Chart — fills remaining space */}
        <Card className="flex-1 min-h-0">
          <CardBody className="h-full p-3">
            <Suspense fallback={<div className="h-full flex items-center justify-center"><Spinner /></div>}>
              <PriceChart />
            </Suspense>
          </CardBody>
        </Card>
      </div>

      {/* ─── Right: Live Logs ─── */}
      <div className="w-[420px] flex-shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              Live Logs
            </h3>
            <span className="text-[10px] text-gray-500">{filteredLogs.length}</span>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={logFilters.has('trade')}
                onChange={() => toggleFilter('trade')}
                className="w-3 h-3 rounded accent-green-500"
              />
              <span className="text-[10px] text-green-400 font-medium">Trades</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={logFilters.has('eval')}
                onChange={() => toggleFilter('eval')}
                className="w-3 h-3 rounded accent-gray-500"
              />
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
