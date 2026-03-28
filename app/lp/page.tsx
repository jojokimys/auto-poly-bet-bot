'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Chip, Spinner, Select, SelectItem } from '@heroui/react';
import { useProfileStore } from '@/store/useProfileStore';
import { DepthGrid } from '@/components/DepthGrid';

interface EngineMarket {
  id: string;
  question: string;
  slug: string;
  midpoint: number;
  allocatedCapital: number;
  activeOrders: number;
  heldPositions: number;
  lpDeployed: number;
  rewardsDailyRate: number;
  estDailyReward: number;
  roiAtMin: number;
  inventorySkew: number;
  daysToExpiry: number;
  liveBidYes: number;
  liveBidNo: number;
  myBidYes: number;
  myBidNo: number;
  wallYes: number;
  wallNo: number;
  rewardsMaxSpread: number;
  depthYes?: Array<{ price: number; size: number; isMyOrder: boolean }>;
  depthNo?: Array<{ price: number; size: number; isMyOrder: boolean }>;
  pollIntervalMs?: number;
}

/** Lightweight market from scan API (used when engine is not running) */
interface ScannedMarket {
  id: string;
  question: string;
  slug: string;
  midpoint: number;
  rewardsDailyRate: number;
  rewardsMaxSpread: number;
  liquidity: number;
  wallYes: number;
  wallNo: number;
  roiAtMin: number;
  estDailyReward: number;
  daysToExpiry: number;
  eventTitle?: string;
}

interface EngineStatus {
  running: boolean;
  profileId?: string;
  profileName?: string;
  balance?: number;
  managedMarkets: number;
  totalAllocatedCapital: number;
  totalActiveOrders: number;
  totalPositions: number;
  totalLpDeployed: number;
  totalEstDailyReward: number;
  lastScanTime?: number;
  markets: EngineMarket[];
  dailyEarnings?: { earnings: any; totalEarnings: any; marketsConfig: any; fetchedAt: number };
}

interface LogLine {
  text: string;
  type: 'info' | 'trade' | 'error' | 'reward';
  timestamp: number;
}

export default function LpRewardsPage() {
  const [scannedMarkets, setScannedMarkets] = useState<ScannedMarket[]>([]);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [engineLogs, setEngineLogs] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [engineStarting, setEngineStarting] = useState(false);
  const [maxMarketsInput, setMaxMarketsInput] = useState(50);
  const [allowTightSpread, setAllowTightSpread] = useState(false);
  const [profileId, setProfileId] = useState('cmlmpyou700bn0y09gh4fem6y');
  const [standaloneBalance, setStandaloneBalance] = useState<number | null>(null);
  const { profiles, fetchProfiles } = useProfileStore();

  const isEngineRunning = engineStatus?.running ?? false;

  // Fetch engine status + logs
  const fetchEngine = useCallback(async () => {
    try {
      const res = await fetch('/api/lp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status' }),
      });
      const data = await res.json();
      if (data.engine) setEngineStatus(data.engine);
      if (data.logs) setEngineLogs(data.logs);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  // Fetch scanned markets (used when engine is NOT running)
  const fetchScannedMarkets = useCallback(async () => {
    try {
      const res = await fetch('/api/lp?scan=true&capital=50&wall=500&topN=100');
      const data = await res.json();
      setScannedMarkets((data.ranked ?? []).map((m: any) => ({
        id: m.id,
        question: m.question,
        slug: m.slug,
        midpoint: m.midpoint,
        rewardsDailyRate: m.rewardsDailyRate ?? 0,
        rewardsMaxSpread: m.rewardsMaxSpread,
        liquidity: m.liquidity,
        wallYes: m.wallYes ?? 0,
        wallNo: m.wallNo ?? 0,
        roiAtMin: m.roiAtMin ?? 0,
        estDailyReward: m.estDailyReward ?? 0,
        daysToExpiry: m.daysToExpiry ?? 0,
        eventTitle: m.eventTitle,
      })));
    } catch { /* ignore */ }
  }, []);

  const fetchBalance = useCallback(async () => {
    if (!profileId) return;
    try {
      const res = await fetch(`/api/lp?balance=true&profileId=${profileId}`);
      const data = await res.json();
      if (data.balance != null) setStandaloneBalance(data.balance);
    } catch { /* ignore */ }
  }, [profileId]);

  useEffect(() => {
    fetchProfiles();
    fetchEngine();
    fetchScannedMarkets();
    fetchBalance();
    // Poll engine status every 5s
    const engineInterval = setInterval(fetchEngine, 5000);
    return () => clearInterval(engineInterval);
  }, [fetchProfiles, fetchEngine, fetchScannedMarkets, fetchBalance]);

  // Engine start/stop
  const handleEngineStart = async () => {
    if (!profileId) return;
    setEngineStarting(true);
    try {
      const res = await fetch('/api/lp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', profileId, maxMarkets: maxMarketsInput, allowTightSpread }),
      });
      const data = await res.json();
      if (data.status) setEngineStatus(data.status);
    } catch { /* ignore */ }
    setEngineStarting(false);
  };

  const handleEngineStop = async () => {
    setEngineStarting(true);
    try {
      await fetch('/api/lp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      await fetchEngine();
      // Refresh scanned markets after engine stops
      fetchScannedMarkets();
    } catch { /* ignore */ }
    setEngineStarting(false);
  };

  const reversedLogs = [...engineLogs].reverse();

  // Show engine markets when running, scanned markets otherwise
  const displayMarkets: EngineMarket[] = isEngineRunning && engineStatus
    ? engineStatus.markets
    : scannedMarkets.map((m) => ({
        id: m.id,
        question: m.question,
        slug: m.slug,
        midpoint: m.midpoint,
        allocatedCapital: 0,
        activeOrders: 0,
        heldPositions: 0,
        lpDeployed: 0,
        rewardsDailyRate: m.rewardsDailyRate,
        estDailyReward: m.estDailyReward,
        roiAtMin: m.roiAtMin,
        inventorySkew: 0,
        daysToExpiry: m.daysToExpiry,
        liveBidYes: 0,
        liveBidNo: 0,
        myBidYes: 0,
        myBidNo: 0,
        wallYes: m.wallYes,
        wallNo: m.wallNo,
        rewardsMaxSpread: m.rewardsMaxSpread,
      }));

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;
  }

  return (
    <div className="flex gap-4 h-full">
      {/* Left: Markets */}
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">LP Rewards</h1>
            {isEngineRunning && (
              <Chip size="sm" color="success" variant="dot">Engine ON</Chip>
            )}
          </div>
          <div className="flex items-center gap-2">
            {(standaloneBalance ?? engineStatus?.balance) != null && (
              <button
                onClick={fetchBalance}
                className="text-2xl font-bold font-mono text-gray-900 dark:text-white hover:text-blue-500 transition-colors cursor-pointer"
                title="Click to refresh balance"
              >
                ${(engineStatus?.balance ?? standaloneBalance ?? 0).toFixed(2)}
              </button>
            )}
            <Select
              size="sm" label="Profile" placeholder="Select"
              selectedKeys={profileId ? [profileId] : []}
              onSelectionChange={(keys) => { const s = Array.from(keys)[0] as string; if (s) setProfileId(s); }}
              className="w-36"
            >
              {profiles.map((p) => <SelectItem key={p.id}>{p.name}</SelectItem>)}
            </Select>
          </div>
        </div>

        {/* Engine controls */}
        <div className="flex items-center gap-4 flex-shrink-0 bg-gray-100 dark:bg-gray-800 rounded-lg px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">Max:</span>
            <input type="number" value={maxMarketsInput} onChange={(e) => setMaxMarketsInput(Number(e.target.value))}
              className="w-14 px-1 py-0.5 text-xs bg-white dark:bg-gray-900 rounded text-center" min={1} max={200} />
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={allowTightSpread} onChange={(e) => setAllowTightSpread(e.target.checked)}
              className="w-3.5 h-3.5 rounded" />
            <span className="text-xs text-gray-500">Tight Spread</span>
          </label>
          <button
            onClick={isEngineRunning ? handleEngineStop : handleEngineStart}
            disabled={engineStarting}
            className={`px-4 py-2 text-sm rounded-lg font-bold transition-colors ${
              engineStarting ? 'opacity-50 cursor-wait' :
              isEngineRunning
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-green-500 text-white hover:bg-green-600'
            }`}>
            {engineStarting ? '...' : isEngineRunning ? 'Stop Engine' : 'Start Engine'}
          </button>
          {isEngineRunning && engineStatus && (
            <div className="flex items-center gap-4 text-xs">
              <span className="text-gray-400">
                Markets: <span className="text-white font-mono">{engineStatus.managedMarkets}</span>
              </span>
              <span className="text-gray-400">
                Deployed: <span className="text-white font-mono">${engineStatus.totalLpDeployed.toFixed(0)}</span>
              </span>
              <span className="text-gray-400">
                Orders: <span className="text-white font-mono">{engineStatus.totalActiveOrders}</span>
              </span>
              <span className="text-green-400 font-mono">
                est +${engineStatus.totalEstDailyReward.toFixed(2)}/day
              </span>
              {engineStatus.dailyEarnings?.totalEarnings != null && (
                <span className="text-purple-400 font-mono">
                  earned ${typeof engineStatus.dailyEarnings.totalEarnings === 'number'
                    ? `$${engineStatus.dailyEarnings.totalEarnings.toFixed(2)}`
                    : `$${parseFloat(engineStatus.dailyEarnings.totalEarnings?.amount ?? engineStatus.dailyEarnings.totalEarnings ?? '0').toFixed(2)}`}
                </span>
              )}
            </div>
          )}
          {!isEngineRunning && scannedMarkets.length > 0 && (
            <span className="text-xs text-gray-500">{scannedMarkets.length} markets scanned</span>
          )}
        </div>

        {/* Markets table */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {displayMarkets.length > 0 ? (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 dark:bg-gray-900 z-10">
                <tr className="text-left text-gray-500">
                  <th className="px-2 py-1.5 font-medium">#</th>
                  <th className="px-2 py-1.5 font-medium min-w-[200px]">Market</th>
                  <th className="px-2 py-1.5 font-medium text-right">Orders</th>
                  <th className="px-2 py-1.5 font-medium text-right">Rate</th>
                  {isEngineRunning && <th className="px-2 py-1.5 font-medium text-right">Poll</th>}
                  <th className="px-2 py-1.5 font-medium text-center">Orderbook</th>
                </tr>
              </thead>
              <tbody>
                {displayMarkets.map((m, i) => (
                  <EngineMarketRow key={m.id} market={m} index={i} showPoll={isEngineRunning} />
                ))}
              </tbody>
            </table>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              {isEngineRunning ? 'Scanning markets...' : 'Loading markets...'}
            </div>
          )}
        </div>
      </div>

      {/* Right: Logs */}
      <div className="w-[360px] flex-shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2 flex-shrink-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Engine Logs</h3>
          <span className="text-[10px] text-gray-500">{engineLogs.length}</span>
        </div>
        <div className="flex-1 min-h-0 bg-gray-950 rounded-lg p-3 overflow-y-auto font-mono text-[11px] leading-relaxed">
          {reversedLogs.length === 0 ? (
            <span className="text-gray-600">Start engine to see logs...</span>
          ) : (
            reversedLogs.map((log, i) => (
              <div key={`${log.timestamp}-${i}`}
                className={
                  log.type === 'trade' ? 'text-green-400' : log.type === 'error' ? 'text-red-400'
                  : log.type === 'reward' ? 'text-purple-400' : 'text-gray-500'
                }>
                {log.text}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Engine market row with flash effects on price changes */
function EngineMarketRow({ market: m, index: i, showPoll }: { market: EngineMarket; index: number; showPoll: boolean }) {
  const prevYesBid = useRef(m.myBidYes);
  const prevNoBid = useRef(m.myBidNo);
  const prevWallY = useRef(m.wallYes);
  const prevWallN = useRef(m.wallNo);
  const [rowFlash, setRowFlash] = useState<string>('');

  useEffect(() => {
    const yesChanged = Math.abs(m.myBidYes - prevYesBid.current) > 0.001;
    const noChanged = Math.abs(m.myBidNo - prevNoBid.current) > 0.001;
    const wallYDrop = m.wallYes < prevWallY.current * 0.5 && prevWallY.current > 100;
    const wallNDrop = m.wallNo < prevWallN.current * 0.5 && prevWallN.current > 100;

    prevYesBid.current = m.myBidYes;
    prevNoBid.current = m.myBidNo;
    prevWallY.current = m.wallYes;
    prevWallN.current = m.wallNo;

    if (wallYDrop || wallNDrop) {
      setRowFlash('bg-red-500/20');
    } else if (yesChanged || noChanged) {
      setRowFlash('bg-blue-500/15');
    } else {
      return;
    }
    const timer = setTimeout(() => setRowFlash(''), 2000);
    return () => clearTimeout(timer);
  }, [m.myBidYes, m.myBidNo, m.wallYes, m.wallNo]);

  return (
    <tr className={`border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors duration-700 ${rowFlash}`}>
      <td className="px-2 py-1.5 text-gray-400">{i + 1}</td>
      <td className="px-2 py-1.5">
        <a href={`https://polymarket.com/event/${m.slug}`} target="_blank" rel="noopener noreferrer"
          className="font-medium text-gray-900 dark:text-white truncate max-w-[250px] hover:text-blue-500 hover:underline block">
          {m.question}
        </a>
      </td>
      <td className="px-2 py-1.5 text-right font-mono">{m.activeOrders || '-'}</td>
      <td className="px-2 py-1.5 text-right font-mono text-yellow-400">${m.rewardsDailyRate.toFixed(0)}</td>
      {showPoll && (
        <td className="px-2 py-1.5 text-right font-mono text-gray-400">{m.pollIntervalMs ? `${(m.pollIntervalMs / 1000).toFixed(0)}s` : '-'}</td>
      )}
      <td className="px-2 py-1.5 text-center">
        <div className="flex justify-center">
          <DepthGrid mid={m.midpoint} depthYes={m.depthYes ?? []} depthNo={m.depthNo ?? []} wallYes={m.wallYes} wallNo={m.wallNo} maxSpread={m.rewardsMaxSpread} />
        </div>
      </td>
    </tr>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
