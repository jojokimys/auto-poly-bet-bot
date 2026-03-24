'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Chip, Spinner, Select, SelectItem } from '@heroui/react';
import { useProfileStore } from '@/store/useProfileStore';

interface MarketRow {
  id: string;
  question: string;
  slug: string;
  midpoint: number;
  spread: number;
  liquidity: number;
  volume24hr?: number;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  qScorePerDollar: number;
  qScore: number;
  rewardRatio: number;
  bestBid?: number;
  bestAsk?: number;
  eventTitle?: string;
  outcomes?: string[];
  outcomePrices?: number[];
  rewardsDailyRate?: number;
  competitiveness?: number;
  estDailyReward?: number;
  minCapital?: number;
  roiAtMin?: number;
  roiAtConfig?: number;
  wallYes?: number;
  wallNo?: number;
  yesDistCents?: number;
  noDistCents?: number;
  daysToExpiry?: number;
  clobTokenIds?: string[];
  conditionId?: string;
  endDate?: string;
  negRisk?: boolean;
}

interface BotStatus {
  marketId: string;
  question: string;
  slug: string;
  running: boolean;
  capital: number;
  dominantSide: string;
  midpoint: number;
  orders: number;
  positions: number;
  wallSize: number;
  orderPrice: number;
  pnl: number;
  fills: number;
  lastUpdate: number;
  yesPrice: number;
  noPrice: number;
  yesWall: number;
  noWall: number;
}

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
}

interface LogLine {
  text: string;
  type: 'info' | 'trade' | 'error' | 'reward';
  timestamp: number;
}

type TabType = 'scan' | 'engine';

export default function LpRewardsPage() {
  const [tab, setTab] = useState<TabType>('scan');
  const [scannedMarkets, setScannedMarkets] = useState<MarketRow[]>([]);
  const [botStatuses, setBotStatuses] = useState<Map<string, BotStatus>>(new Map());
  const [botLogs, setBotLogs] = useState<LogLine[]>([]);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [engineLogs, setEngineLogs] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [engineStarting, setEngineStarting] = useState(false);
  const [maxMarketsInput, setMaxMarketsInput] = useState(50);
  const [allowTightSpread, setAllowTightSpread] = useState(false);
  const [profileId, setProfileId] = useState('cmlmpyou700bn0y09gh4fem6y');
  const [capitalInput, setCapitalInput] = useState(50);
  const [minWallInput, setMinWallInput] = useState(500);
  const [sortBy, setSortBy] = useState<'roiAtMin' | 'rewardsDailyRate' | 'competitiveness' | 'liquidity'>('roiAtMin');
  const [standaloneBalance, setStandaloneBalance] = useState<number | null>(null);
  const [perMarketCapital, setPerMarketCapital] = useState<Map<string, number>>(new Map());
  const [botLoading, setBotLoading] = useState<Set<string>>(new Set());
  const { profiles, fetchProfiles } = useProfileStore();

  // Fetch everything: bots + engine
  const fetchAll = useCallback(async () => {
    try {
      const [botsRes, engineRes] = await Promise.all([
        fetch('/api/lp?bots=true&limit=200'),
        fetch('/api/lp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status' }) }),
      ]);
      const botsData = await botsRes.json();
      const engineData = await engineRes.json();

      const map = new Map<string, BotStatus>();
      for (const b of (botsData.bots ?? [])) map.set(b.marketId, b);
      setBotStatuses(map);
      setBotLogs(botsData.logs ?? []);

      if (engineData.engine) setEngineStatus(engineData.engine);
      if (engineData.logs) setEngineLogs(engineData.logs);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch(`/api/lp?scan=true&capital=${capitalInput}&wall=${minWallInput}`);
      const data = await res.json();
      setScannedMarkets(data.ranked ?? []);
    } catch { /* ignore */ }
    setScanning(false);
  }, [capitalInput, minWallInput]);

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
    fetchAll();
    handleScan();
    fetchBalance();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, [fetchProfiles, fetchAll, handleScan, fetchBalance]);

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
      setTab('engine');
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
      await fetchAll();
    } catch { /* ignore */ }
    setEngineStarting(false);
  };

  // Per-market bot start/stop
  const handleStartBot = async (market: MarketRow) => {
    if (!profileId) return;
    const capital = perMarketCapital.get(market.id) ?? market.rewardsMinSize ?? capitalInput;
    setBotLoading((prev) => new Set(prev).add(market.id));
    try {
      await fetch('/api/lp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start-bot', marketData: market, profileId, capital }),
      });
      await fetchAll();
    } catch { /* ignore */ }
    setBotLoading((prev) => { const s = new Set(prev); s.delete(market.id); return s; });
  };

  const handleStopBot = async (marketId: string) => {
    setBotLoading((prev) => new Set(prev).add(marketId));
    try {
      await fetch('/api/lp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop-bot', marketId }),
      });
      await fetchAll();
    } catch { /* ignore */ }
    setBotLoading((prev) => { const s = new Set(prev); s.delete(marketId); return s; });
  };

  const sortedMarkets = [...scannedMarkets].sort((a, b) => {
    if (sortBy === 'roiAtMin') return (b.roiAtMin ?? 0) - (a.roiAtMin ?? 0);
    if (sortBy === 'rewardsDailyRate') return (b.rewardsDailyRate ?? 0) - (a.rewardsDailyRate ?? 0);
    if (sortBy === 'competitiveness') return (a.competitiveness ?? 999999) - (b.competitiveness ?? 999999);
    return (b.liquidity ?? 0) - (a.liquidity ?? 0);
  });

  const activeBots = Array.from(botStatuses.values()).filter((b) => b.running);
  const totalPnl = activeBots.reduce((s, b) => s + b.pnl, 0);
  const totalFills = activeBots.reduce((s, b) => s + b.fills, 0);
  const isEngineRunning = engineStatus?.running ?? false;

  const logs = tab === 'engine' ? engineLogs : botLogs;
  const reversedLogs = [...logs].reverse();

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
            {/* Tab switcher */}
            <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setTab('scan')}
                className={`px-3 py-1 text-xs font-medium ${tab === 'scan' ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}
              >
                Scan
              </button>
              <button
                onClick={() => setTab('engine')}
                className={`px-3 py-1 text-xs font-medium ${tab === 'engine' ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}
              >
                Auto Engine
              </button>
            </div>
            {isEngineRunning && (
              <Chip size="sm" color="success" variant="dot">Engine ON</Chip>
            )}
            {activeBots.length > 0 && (
              <Chip size="sm" color="success" variant="flat">{activeBots.length} bots</Chip>
            )}
            {totalFills > 0 && (
              <Chip size="sm" color="warning" variant="flat">{totalFills} fills</Chip>
            )}
            {totalPnl !== 0 && (
              <Chip size="sm" color={totalPnl >= 0 ? 'success' : 'danger'} variant="flat">
                PnL: ${totalPnl.toFixed(2)}
              </Chip>
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

        {/* ── Scan Tab ── */}
        {tab === 'scan' && (
          <>
            {/* Config row */}
            <div className="flex items-center gap-4 flex-shrink-0 bg-gray-100 dark:bg-gray-800 rounded-lg px-3 py-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">Capital $:</span>
                <input type="number" value={capitalInput} onChange={(e) => setCapitalInput(Number(e.target.value))}
                  className="w-14 px-1 py-0.5 text-xs bg-white dark:bg-gray-900 rounded text-center" min={1} max={10000} />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">Wall $:</span>
                <input type="number" value={minWallInput} onChange={(e) => setMinWallInput(Number(e.target.value))}
                  className="w-16 px-1 py-0.5 text-xs bg-white dark:bg-gray-900 rounded text-center" min={10} max={50000} step={10} />
              </div>
              <button onClick={handleScan} disabled={scanning}
                className="px-3 py-1.5 text-xs rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50">
                {scanning ? 'Scanning...' : 'Scan'}
              </button>
              <span className="text-[10px] text-gray-400 ml-auto">
                Wall Rider | Two-sided | Post-only hedge +1c | Force exit 60s
              </span>
            </div>

            {/* Sort bar */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs text-gray-500">Sort:</span>
              {(['roiAtMin', 'rewardsDailyRate', 'competitiveness', 'liquidity'] as const).map((key) => (
                <button key={key} onClick={() => setSortBy(key)}
                  className={`text-xs px-2 py-0.5 rounded ${sortBy === key ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>
                  {key === 'roiAtMin' ? 'ROI/day' : key === 'rewardsDailyRate' ? '$/day' : key === 'competitiveness' ? 'Competition' : 'Liquidity'}
                </button>
              ))}
              <span className="text-xs text-gray-500 ml-2">{sortedMarkets.length} markets</span>
              {sortedMarkets.length > 0 && (
                <span className="text-xs text-green-400 font-mono">
                  est +${sortedMarkets.reduce((s, m) => s + (m.estDailyReward ?? 0), 0).toFixed(2)}/day
                </span>
              )}
            </div>

            {/* Markets Table */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50 dark:bg-gray-900 z-10">
                  <tr className="text-left text-gray-500">
                    <th className="px-2 py-1.5 font-medium">#</th>
                    <th className="px-2 py-1.5 font-medium min-w-[200px]">Market</th>
                    <th className="px-2 py-1.5 font-medium text-right">Mid</th>
                    <th className="px-2 py-1.5 font-medium text-right">Liq</th>
                    <th className="px-2 py-1.5 font-medium text-right">Comp</th>
                    <th className="px-2 py-1.5 font-medium text-right">Wall</th>
                    <th className="px-2 py-1.5 font-medium text-right">Rate</th>
                    <th className="px-2 py-1.5 font-medium text-right">ROI/d</th>
                    <th className="px-2 py-1.5 font-medium text-right">$/day</th>
                    <th className="px-2 py-1.5 font-medium text-right">Dist</th>
                    <th className="px-2 py-1.5 font-medium text-right">Exp</th>
                    <th className="px-2 py-1.5 font-medium text-center">Bot</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMarkets.map((m, i) => {
                    const bot = botStatuses.get(m.id);
                    const isRunning = bot?.running ?? false;
                    const isLoading = botLoading.has(m.id);
                    const comp = m.competitiveness ?? 0;

                    return (
                      <tr key={m.id}
                        className={`border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 ${isRunning ? 'bg-green-900/10' : ''}`}>
                        <td className="px-2 py-1.5 text-gray-400">{i + 1}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-col">
                            <a href={`https://polymarket.com/event/${m.slug}`} target="_blank" rel="noopener noreferrer"
                              className="font-medium text-gray-900 dark:text-white truncate max-w-[250px] hover:text-blue-500 hover:underline">
                              {m.question}
                            </a>
                            {m.eventTitle && <span className="text-[10px] text-gray-400 truncate max-w-[250px]">{m.eventTitle}</span>}
                            {isRunning && bot && (
                              <span className="text-[10px] text-green-400">
                                {bot.orders} ord | {bot.fills} fills
                                {bot.yesPrice > 0 && ` | Y@${bot.yesPrice.toFixed(2)}`}
                                {bot.noPrice > 0 && ` | N@${bot.noPrice.toFixed(2)}`}
                                {` | wall Y$${(bot.yesWall ?? 0).toFixed(0)} N$${(bot.noWall ?? 0).toFixed(0)}`}
                                {bot.pnl !== 0 && ` | pnl=$${bot.pnl.toFixed(2)}`}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">{(m.midpoint * 100).toFixed(0)}c</td>
                        <td className="px-2 py-1.5 text-right font-mono">${formatCompact(m.liquidity)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">
                          {comp > 0 ? (
                            <span className={comp < 20 ? 'text-green-400' : comp < 100 ? 'text-yellow-400' : 'text-gray-500'}>
                              {comp.toFixed(0)}
                            </span>
                          ) : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">
                          {m.wallYes != null ? (
                            <span className="text-green-400">${Math.round(Math.min(m.wallYes, m.wallNo ?? m.wallYes))}</span>
                          ) : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-yellow-400">
                          {(m.rewardsDailyRate ?? 0) > 0 ? `$${m.rewardsDailyRate!.toFixed(0)}` : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">
                          {(m.roiAtMin ?? 0) > 0 ? (
                            <span className={(m.roiAtMin ?? 0) >= 1 ? 'text-green-400' : (m.roiAtMin ?? 0) >= 0.1 ? 'text-yellow-400' : 'text-gray-500'}>
                              {(m.roiAtMin ?? 0).toFixed(2)}%
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">
                          {(m.estDailyReward ?? 0) > 0 ? <span className="text-green-400">+${m.estDailyReward!.toFixed(2)}</span> : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-gray-400">
                          {(m.yesDistCents ?? -1) >= 0 ? (
                            <span className={(m.yesDistCents ?? 99) <= 2 ? 'text-green-400' : (m.yesDistCents ?? 99) <= 3 ? 'text-yellow-400' : 'text-red-400'}>
                              {(m.yesDistCents ?? 0).toFixed(1)}c
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">
                          {(m.daysToExpiry ?? 0) > 0 ? (
                            <span className={(m.daysToExpiry ?? 0) < 1 ? 'text-red-400' : (m.daysToExpiry ?? 0) < 7 ? 'text-yellow-400' : 'text-gray-400'}>
                              {(m.daysToExpiry ?? 0) < 1 ? `${((m.daysToExpiry ?? 0) * 24).toFixed(0)}h` : `${(m.daysToExpiry ?? 0).toFixed(0)}d`}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            {!isRunning && (
                              <input type="number"
                                value={perMarketCapital.get(m.id) ?? m.rewardsMinSize ?? capitalInput}
                                onChange={(e) => setPerMarketCapital((prev) => new Map(prev).set(m.id, Number(e.target.value)))}
                                className="w-12 px-1 py-0.5 text-[11px] bg-white dark:bg-gray-900 rounded text-center font-mono"
                                min={1} max={10000} />
                            )}
                            <button
                              onClick={() => isRunning ? handleStopBot(m.id) : handleStartBot(m)}
                              disabled={isLoading || !profileId}
                              className={`px-2 py-0.5 text-[11px] rounded font-medium transition-colors ${
                                isLoading ? 'opacity-50 cursor-wait' :
                                isRunning ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                              }`}>
                              {isLoading ? '...' : isRunning ? '■' : '▶'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {sortedMarkets.length === 0 && (
                    <tr><td colSpan={12} className="px-2 py-8 text-center text-gray-500">
                      {scanning ? 'Scanning markets...' : 'No reward markets found. Click Scan.'}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ── Engine Tab ── */}
        {tab === 'engine' && (
          <>
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
                <span className="text-xs text-gray-500">1¢ Sports</span>
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
                </div>
              )}
              <span className="text-[10px] text-gray-400 ml-auto">
                Auto: scan 5m | requote 30s | fill check 10s | 40% cash reserve
              </span>
            </div>

            {/* Engine managed markets */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {isEngineRunning && engineStatus && engineStatus.markets.length > 0 ? (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-50 dark:bg-gray-900 z-10">
                    <tr className="text-left text-gray-500">
                      <th className="px-2 py-1.5 font-medium">#</th>
                      <th className="px-2 py-1.5 font-medium min-w-[200px]">Market</th>
                      <th className="px-2 py-1.5 font-medium text-right">Alloc$</th>
                      <th className="px-2 py-1.5 font-medium text-right">Deployed</th>
                      <th className="px-2 py-1.5 font-medium text-right">Orders</th>
                      <th className="px-2 py-1.5 font-medium text-right">Rate</th>
                      <th className="px-2 py-1.5 font-medium text-right">Est/day</th>
                      <th className="px-2 py-1.5 font-medium min-w-[280px]">Orderbook</th>
                      <th className="px-2 py-1.5 font-medium text-right">Expiry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {engineStatus.markets.map((m, i) => (
                      <EngineMarketRow key={m.id} market={m} index={i} />
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-full text-gray-500">
                  {isEngineRunning ? 'Scanning markets...' : 'Engine is stopped. Click Start Engine to auto-manage LP positions.'}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Right: Logs */}
      <div className="w-[360px] flex-shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2 flex-shrink-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {tab === 'engine' ? 'Engine Logs' : 'Bot Logs'}
          </h3>
          <span className="text-[10px] text-gray-500">{logs.length}</span>
        </div>
        <div className="flex-1 min-h-0 bg-gray-950 rounded-lg p-3 overflow-y-auto font-mono text-[11px] leading-relaxed">
          {reversedLogs.length === 0 ? (
            <span className="text-gray-600">{tab === 'engine' ? 'Start engine to see logs...' : 'No active bots...'}</span>
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

/** Flash cell — highlights when value changes */
function FlashValue({ value, format, className = '' }: { value: number; format: (v: number) => string; className?: string }) {
  const prevRef = useRef(value);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    if (Math.abs(value - prevRef.current) > 0.001) {
      setFlash(value > prevRef.current ? 'up' : 'down');
      prevRef.current = value;
      const timer = setTimeout(() => setFlash(null), 1500);
      return () => clearTimeout(timer);
    }
  }, [value]);

  const flashClass = flash === 'up'
    ? 'animate-flash-green'
    : flash === 'down'
      ? 'animate-flash-red'
      : '';

  return <span className={`${className} ${flashClass} transition-colors duration-500`}>{format(value)}</span>;
}

/** Engine market row with flash effects on price changes */
function EngineMarketRow({ market: m, index: i }: { market: EngineMarket; index: number }) {
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
      <td className="px-2 py-1.5 text-right font-mono">${m.allocatedCapital.toFixed(0)}</td>
      <td className="px-2 py-1.5 text-right font-mono text-blue-400">${m.lpDeployed.toFixed(0)}</td>
      <td className="px-2 py-1.5 text-right font-mono">{m.activeOrders}</td>
      <td className="px-2 py-1.5 text-right font-mono text-yellow-400">${m.rewardsDailyRate.toFixed(0)}</td>
      <td className="px-2 py-1.5 text-right font-mono">
        <FlashValue value={m.estDailyReward} format={(v) => `+$${v.toFixed(3)}`} className="text-green-400" />
      </td>
      <td className="px-2 py-1.5">
        <DepthBar label="Y" liveBid={m.liveBidYes} myBid={m.myBidYes} mid={m.midpoint} wall={m.wallYes} maxSpread={m.rewardsMaxSpread} />
        <DepthBar label="N" liveBid={m.liveBidNo} myBid={m.myBidNo} mid={1 - m.midpoint} wall={m.wallNo} maxSpread={m.rewardsMaxSpread} />
      </td>
      <td className="px-2 py-1.5 text-right font-mono text-gray-400">{(m.daysToExpiry ?? 0).toFixed(0)}d</td>
    </tr>
  );
}

/**
 * Orderbook depth visualization per side.
 * Shows: live bid price, my bid price, distance gap, wall size with color coding.
 */
function DepthBar({ label, liveBid, myBid, mid, wall, maxSpread }: {
  label: string;
  liveBid: number;
  myBid: number;
  mid: number;
  wall: number;
  maxSpread: number;
}) {
  if (mid <= 0) return <div className="h-5" />;

  const edgePrice = Math.max(0.01, mid - maxSpread / 100);
  const range = mid - edgePrice;
  if (range <= 0) return <div className="h-5" />;

  const myPos = myBid > 0 ? Math.min(100, Math.max(0, ((myBid - edgePrice) / range) * 100)) : -1;
  const livePos = liveBid > 0 ? Math.min(100, Math.max(0, ((liveBid - edgePrice) / range) * 100)) : -1;
  const distCents = myBid > 0 ? ((mid - myBid) * 100).toFixed(1) : '?';

  // Wall color by safety level
  const wallColor = wall > 5000 ? 'bg-green-500/40' : wall > 2000 ? 'bg-green-500/25' : wall > 500 ? 'bg-yellow-500/25' : wall > 0 ? 'bg-red-500/20' : 'bg-gray-700/30';
  const wallTextColor = wall > 5000 ? 'text-green-400' : wall > 2000 ? 'text-green-500' : wall > 500 ? 'text-yellow-400' : wall > 0 ? 'text-red-400' : 'text-gray-600';
  const wallLeft = myPos >= 0 ? myPos : 0;
  const wallWidth = livePos >= 0 && myPos >= 0 ? Math.max(0, livePos - myPos) : 0;

  const isYes = label === 'Y';

  return (
    <div className="flex items-center gap-1.5 h-5">
      {/* Side label */}
      <span className={`text-[10px] font-bold w-3 ${isYes ? 'text-blue-400' : 'text-red-400'}`}>{label}</span>

      {/* Depth bar */}
      <div className="relative flex-1 h-4 bg-gray-800/80 rounded overflow-hidden cursor-help group"
        title={`Mid: ${mid.toFixed(2)} | Live: ${liveBid.toFixed(2)} | My: ${myBid.toFixed(2)} | Wall: $${wall.toFixed(0)} | Dist: ${distCents}¢`}>

        {/* Reward zone */}
        <div className="absolute inset-0 bg-gray-700/30 rounded" />

        {/* Wall fill */}
        {wallWidth > 0 && (
          <div className={`absolute top-0 bottom-0 ${wallColor} rounded transition-all duration-300`}
            style={{ left: `${wallLeft}%`, width: `${wallWidth}%` }}
          />
        )}

        {/* My bid marker */}
        {myPos >= 0 && (
          <>
            <div className={`absolute top-0 bottom-0 w-[3px] ${isYes ? 'bg-blue-400' : 'bg-red-400'} z-20 rounded-full shadow-[0_0_4px_rgba(96,165,250,0.6)]`}
              style={{ left: `${myPos}%` }}
            />
            <div className={`absolute top-[-1px] text-[8px] font-mono font-bold ${isYes ? 'text-blue-300' : 'text-red-300'} z-20`}
              style={{ left: `${Math.min(myPos + 1, 85)}%` }}>
              {myBid.toFixed(2)}
            </div>
          </>
        )}

        {/* Live bid marker */}
        {livePos >= 0 && (
          <>
            <div className="absolute top-0 bottom-0 w-[2px] bg-white/70 z-10"
              style={{ left: `${livePos}%` }}
            />
            <div className="absolute bottom-[-1px] text-[7px] font-mono text-white/50 z-10"
              style={{ left: `${Math.min(livePos + 1, 85)}%` }}>
              {liveBid.toFixed(2)}
            </div>
          </>
        )}

        {/* Mid marker */}
        <div className="absolute top-0 bottom-0 w-[2px] bg-white/20 right-0" />
        <div className="absolute top-0 right-1 text-[7px] text-white/30">{mid.toFixed(2)}</div>
      </div>

      {/* Distance from mid */}
      <span className={`text-[10px] font-mono w-7 text-right ${
        parseFloat(distCents) <= 1.5 ? 'text-green-400' : parseFloat(distCents) <= 3 ? 'text-yellow-400' : 'text-gray-500'
      }`}>
        {myBid > 0 ? <FlashValue value={parseFloat(distCents)} format={(v) => `${v.toFixed(1)}¢`} className="" /> : '—'}
      </span>

      {/* Wall size */}
      <span className={`text-[10px] font-mono w-12 text-right font-semibold ${wallTextColor}`}
        title={`Wall: $${wall.toFixed(0)}`}>
        {wall > 0 ? (
          <FlashValue value={wall} format={(v) => `$${formatCompact(v)}`} className="" />
        ) : <span className="text-gray-600">no wall</span>}
      </span>
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
