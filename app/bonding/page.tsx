'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardBody, Button, Chip, Spinner, Select, SelectItem } from '@heroui/react';
import { useProfileStore } from '@/store/useProfileStore';

interface BondingTrade {
  conditionId: string;
  question: string;
  winningSide: 'YES' | 'NO';
  tokenId: string;
  buyPrice: number;
  size: number;
  netProfitCents: number;
  roi: number;
  timestamp: number;
  status: 'pending' | 'filled' | 'redeemed' | 'failed';
  redeemTxHash?: string;
  source: 'scan' | 'watch' | 'limit';
}

interface WatchedMarket {
  conditionId: string;
  question: string;
  endDate: string;
  resolved: boolean;
  winningSide: 'YES' | 'NO' | null;
  predictedWinner: 'YES' | 'NO' | null;
  predictionSource: 'price' | 'uma_proposal' | null;
  yesBestAsk: number | null;
  noBestAsk: number | null;
  limitSignalSent: boolean;
  addedAt: number;
}

interface Opportunity {
  conditionId: string;
  question: string;
  winningSide: 'YES' | 'NO';
  winningPrice: number;
  discountCents: number;
  netProfitCents: number;
  roi: number;
  hoursToExpiry: number;
  liquidity: number;
}

interface EngineStatus {
  running: boolean;
  profileId?: string;
  balance?: number;
  lastScan?: {
    opportunities: Opportunity[];
    scannedCount: number;
    resolvedCount: number;
    timestamp: number;
  };
  trades: BondingTrade[];
  totalPnl: number;
  scanCount: number;
  lastScanTime?: number;
  watchedMarkets: WatchedMarket[];
}

interface LogLine {
  text: string;
  type: 'info' | 'scan' | 'trade' | 'redeem' | 'error' | 'watch';
  timestamp: number;
}

type LogFilter = 'scan' | 'trade' | 'redeem' | 'watch';

export default function BondingPage() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [logFilters, setLogFilters] = useState<Set<LogFilter>>(new Set(['trade', 'redeem', 'watch']));
  const [profileId, setProfileId] = useState('cmlmpyou700bn0y09gh4fem6y');
  const { profiles, fetchProfiles } = useProfileStore();

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bonding');
      const data = await res.json();
      setStatus(data.engine);
    } catch {
      setStatus(null);
    }
    setLoading(false);
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/bonding?logs=true&limit=300');
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
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchProfiles, fetchStatus, fetchLogs]);

  const handleStart = async () => {
    if (!profileId.trim()) return;
    setActionLoading(true);
    try {
      await fetch('/api/bonding', {
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
      await fetch('/api/bonding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      await fetchStatus();
    } catch { /* ignore */ }
    setActionLoading(false);
  };

  const toggleFilter = (f: LogFilter) => {
    setLogFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const filteredLogs = logs.filter((l) => {
    if (l.type === 'info' || l.type === 'error') return true;
    return logFilters.has(l.type as LogFilter);
  });

  const reversedLogs = [...filteredLogs].reverse();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  const opportunities = status?.lastScan?.opportunities ?? [];
  const trades = status?.trades ?? [];
  const watchedMarkets = status?.watchedMarkets ?? [];

  return (
    <div className="flex gap-4 h-full">
      {/* Left: Main Content */}
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        {/* Header row */}
        <div className="flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">
              Bonding Arb
            </h1>
            <Chip
              size="sm"
              color={status?.running ? 'success' : 'default'}
              variant="flat"
            >
              {status?.running ? 'RUNNING' : 'STOPPED'}
            </Chip>
            {status?.totalPnl !== undefined && status.totalPnl !== 0 && (
              <Chip size="sm" color={status.totalPnl >= 0 ? 'success' : 'danger'} variant="flat">
                PnL {status.totalPnl >= 0 ? '+' : ''}${status.totalPnl.toFixed(2)}
              </Chip>
            )}
            {status?.scanCount !== undefined && status.scanCount > 0 && (
              <span className="text-xs text-gray-500">
                Scans: {status.scanCount}
              </span>
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
          {status?.lastScan && (
            <>
              <span className="text-gray-500">
                Last scan: {status.lastScan.scannedCount} markets, {status.lastScan.resolvedCount} resolved
              </span>
              <span className="text-gray-600">|</span>
              <span className="text-gray-500">
                {status.lastScan.opportunities.length} opps
              </span>
              {watchedMarkets.length > 0 && (
                <>
                  <span className="text-gray-600">|</span>
                  <Chip size="sm" color="primary" variant="flat">
                    {watchedMarkets.length} watching
                  </Chip>
                </>
              )}
              {status.lastScanTime && (
                <>
                  <span className="text-gray-600">|</span>
                  <span className="text-gray-400">
                    {new Date(status.lastScanTime).toLocaleTimeString('en-US', { hour12: false })}
                  </span>
                </>
              )}
            </>
          )}
        </div>

        {/* Opportunities Table */}
        <Card className="flex-shrink-0">
          <CardBody className="p-3">
            <h3 className="text-sm font-semibold mb-2 text-gray-900 dark:text-white">
              Live Opportunities
            </h3>
            {opportunities.length === 0 ? (
              <p className="text-xs text-gray-500">No bonding opportunities detected</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-700">
                      <th className="text-left py-1 pr-2">Market</th>
                      <th className="text-center py-1 px-2">Winner</th>
                      <th className="text-right py-1 px-2">Price</th>
                      <th className="text-right py-1 px-2">Discount</th>
                      <th className="text-right py-1 px-2">Net Profit</th>
                      <th className="text-right py-1 px-2">ROI</th>
                      <th className="text-right py-1 pl-2">Expiry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opportunities.map((opp) => (
                      <tr key={opp.conditionId} className="border-b border-gray-800 hover:bg-gray-800/30">
                        <td className="py-1.5 pr-2 max-w-[300px] truncate">{opp.question}</td>
                        <td className="text-center py-1.5 px-2">
                          <Chip size="sm" color={opp.winningSide === 'YES' ? 'success' : 'danger'} variant="flat">
                            {opp.winningSide}
                          </Chip>
                        </td>
                        <td className="text-right py-1.5 px-2 font-mono">
                          {(opp.winningPrice * 100).toFixed(1)}c
                        </td>
                        <td className="text-right py-1.5 px-2 font-mono text-yellow-400">
                          {opp.discountCents.toFixed(1)}c
                        </td>
                        <td className="text-right py-1.5 px-2 font-mono text-green-400">
                          +{opp.netProfitCents.toFixed(1)}c
                        </td>
                        <td className="text-right py-1.5 px-2 font-mono text-green-400">
                          {opp.roi.toFixed(1)}%
                        </td>
                        <td className="text-right py-1.5 pl-2 font-mono text-gray-400">
                          {opp.hoursToExpiry.toFixed(1)}h
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        {/* Watched Markets (Phase 2) */}
        {watchedMarkets.length > 0 && (
          <Card className="flex-shrink-0">
            <CardBody className="p-3">
              <h3 className="text-sm font-semibold mb-2 text-gray-900 dark:text-white">
                Active Watches (Phase 2 — WS + UMA + 3s poll)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-700">
                      <th className="text-left py-1 pr-2">Market</th>
                      <th className="text-center py-1 px-2">Status</th>
                      <th className="text-center py-1 px-2">Predict</th>
                      <th className="text-right py-1 px-2">YES Ask</th>
                      <th className="text-right py-1 px-2">NO Ask</th>
                      <th className="text-right py-1 px-2">Expiry</th>
                      <th className="text-center py-1 pl-2">Order</th>
                    </tr>
                  </thead>
                  <tbody>
                    {watchedMarkets.map((wm) => {
                      const expiryDate = new Date(wm.endDate);
                      const minsLeft = Math.max(0, (expiryDate.getTime() - Date.now()) / 60_000);
                      return (
                        <tr key={wm.conditionId} className="border-b border-gray-800 hover:bg-gray-800/30">
                          <td className="py-1.5 pr-2 max-w-[250px] truncate">{wm.question}</td>
                          <td className="text-center py-1.5 px-2">
                            {wm.resolved ? (
                              <Chip size="sm" color="success" variant="flat">
                                {wm.winningSide}
                              </Chip>
                            ) : (
                              <Chip size="sm" color="warning" variant="dot">
                                pending
                              </Chip>
                            )}
                          </td>
                          <td className="text-center py-1.5 px-2">
                            {wm.predictedWinner ? (
                              <span className={`text-[10px] font-mono ${wm.predictionSource === 'uma_proposal' ? 'text-orange-400' : 'text-gray-400'}`}>
                                {wm.predictedWinner} ({wm.predictionSource === 'uma_proposal' ? 'UMA' : 'price'})
                              </span>
                            ) : (
                              <span className="text-[10px] text-gray-600">—</span>
                            )}
                          </td>
                          <td className="text-right py-1.5 px-2 font-mono">
                            {wm.yesBestAsk != null ? `${(wm.yesBestAsk * 100).toFixed(1)}c` : '—'}
                          </td>
                          <td className="text-right py-1.5 px-2 font-mono">
                            {wm.noBestAsk != null ? `${(wm.noBestAsk * 100).toFixed(1)}c` : '—'}
                          </td>
                          <td className="text-right py-1.5 px-2 font-mono text-gray-400">
                            {minsLeft < 60 ? `${minsLeft.toFixed(0)}m` : `${(minsLeft / 60).toFixed(1)}h`}
                          </td>
                          <td className="text-center py-1.5 pl-2">
                            {wm.limitSignalSent ? (
                              <Chip size="sm" color="primary" variant="flat">limit</Chip>
                            ) : (
                              <span className="text-[10px] text-gray-600">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        )}

        {/* Trades Table */}
        <Card className="flex-1 min-h-0 overflow-auto">
          <CardBody className="p-3">
            <h3 className="text-sm font-semibold mb-2 text-gray-900 dark:text-white">
              Trades ({trades.length})
            </h3>
            {trades.length === 0 ? (
              <p className="text-xs text-gray-500">No trades yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-700">
                      <th className="text-left py-1 pr-2">Market</th>
                      <th className="text-center py-1 px-2">Side</th>
                      <th className="text-center py-1 px-2">Src</th>
                      <th className="text-right py-1 px-2">Price</th>
                      <th className="text-right py-1 px-2">Size</th>
                      <th className="text-right py-1 px-2">Profit</th>
                      <th className="text-center py-1 px-2">Status</th>
                      <th className="text-right py-1 pl-2">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((trade, i) => {
                      const profit = trade.status === 'redeemed'
                        ? trade.size * (1 - trade.buyPrice)
                        : trade.size * trade.netProfitCents / 100;
                      return (
                        <tr key={`${trade.conditionId}-${i}`} className="border-b border-gray-800">
                          <td className="py-1.5 pr-2 max-w-[250px] truncate">{trade.question}</td>
                          <td className="text-center py-1.5 px-2">
                            <Chip size="sm" color={trade.winningSide === 'YES' ? 'success' : 'danger'} variant="flat">
                              {trade.winningSide}
                            </Chip>
                          </td>
                          <td className="text-center py-1.5 px-2">
                            <span className={`text-[10px] font-mono ${
                              trade.source === 'limit' ? 'text-yellow-400'
                                : trade.source === 'watch' ? 'text-purple-400'
                                  : 'text-blue-400'
                            }`}>
                              {trade.source === 'limit' ? 'LIMIT' : trade.source === 'watch' ? 'WS' : 'SCAN'}
                            </span>
                          </td>
                          <td className="text-right py-1.5 px-2 font-mono">
                            {(trade.buyPrice * 100).toFixed(1)}c
                          </td>
                          <td className="text-right py-1.5 px-2 font-mono">{trade.size}</td>
                          <td className="text-right py-1.5 px-2 font-mono text-green-400">
                            +${profit.toFixed(2)}
                          </td>
                          <td className="text-center py-1.5 px-2">
                            <Chip
                              size="sm"
                              variant="flat"
                              color={
                                trade.status === 'redeemed' ? 'success'
                                  : trade.status === 'filled' ? 'warning'
                                    : trade.status === 'failed' ? 'danger'
                                      : 'default'
                              }
                            >
                              {trade.status}
                            </Chip>
                          </td>
                          <td className="text-right py-1.5 pl-2 font-mono text-gray-400">
                            {new Date(trade.timestamp).toLocaleTimeString('en-US', { hour12: false })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Right: Live Logs */}
      <div className="w-[420px] flex-shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              Live Logs
            </h3>
            <span className="text-[10px] text-gray-500">{filteredLogs.length}</span>
          </div>
          <div className="flex items-center gap-3">
            {([
              { key: 'scan' as const, label: 'Scan', color: 'text-blue-400' },
              { key: 'watch' as const, label: 'Watch', color: 'text-purple-400' },
              { key: 'trade' as const, label: 'Trades', color: 'text-green-400' },
              { key: 'redeem' as const, label: 'Redeem', color: 'text-yellow-400' },
            ]).map(({ key, label, color }) => (
              <label key={key} className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={logFilters.has(key)}
                  onChange={() => toggleFilter(key)}
                  className="w-3 h-3 rounded"
                />
                <span className={`text-[10px] ${color} font-medium`}>{label}</span>
              </label>
            ))}
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
                    : log.type === 'redeem' ? 'text-yellow-400'
                      : log.type === 'watch' ? 'text-purple-400'
                        : log.type === 'scan' ? 'text-blue-400'
                          : log.type === 'error' ? 'text-red-400'
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
