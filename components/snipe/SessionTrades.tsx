'use client';

import { useEffect, useState, useMemo } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  Chip,
  Button,
  Divider,
  Spinner,
  Select,
  SelectItem,
} from '@heroui/react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { useMMStore } from '@/store/useMMStore';
import type { SniperTradeSession, SniperMatchedTrade } from '@/store/useMMStore';

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateTime(ts: string): string {
  return `${formatDate(ts)} ${formatTime(ts)}`;
}

// ─── Single Trade Row ────────────────────────────────────

function TradeRow({ trade }: { trade: SniperMatchedTrade }) {
  const isWin = trade.result === 'win';
  const isLoss = trade.result === 'loss';
  const isPending = trade.result === 'pending';

  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
      {/* Asset + Direction */}
      <div className="flex items-center gap-1.5 min-w-[80px]">
        <Chip
          size="sm"
          variant="flat"
          className="text-[10px] h-5 min-w-0 px-1.5"
          color={trade.direction === 'YES' ? 'success' : 'danger'}
        >
          {trade.asset}
        </Chip>
        <span className="text-[10px] font-mono text-gray-500">
          {trade.direction}
        </span>
      </div>

      {/* Mode */}
      <span className="text-[10px] font-mono text-gray-400 w-[28px]">
        {trade.mode}
      </span>

      {/* Entry Price */}
      <span className="text-[10px] font-mono text-gray-500 w-[36px]">
        @{trade.entryPrice.toFixed(2)}
      </span>

      {/* Size */}
      <span className="text-[10px] font-mono text-gray-400 w-[40px]">
        ${trade.usdcSize.toFixed(0)}
      </span>

      {/* Time left at entry */}
      <span className="text-[10px] font-mono text-gray-400 w-[28px]">
        {trade.secondsLeft}s
      </span>

      {/* Confidence */}
      <span className="text-[10px] font-mono text-gray-400 w-[34px]">
        {trade.confidence.toFixed(1)}x
      </span>

      {/* Result + PnL */}
      <div className="flex items-center gap-1 ml-auto">
        {isPending ? (
          <Chip size="sm" variant="flat" className="text-[10px] h-5 px-1.5" color="warning">
            pending
          </Chip>
        ) : (
          <>
            <Chip
              size="sm"
              variant="flat"
              className="text-[10px] h-5 px-1.5"
              color={isWin ? 'success' : 'danger'}
            >
              {trade.result}
            </Chip>
            <span
              className="text-[11px] font-mono font-semibold min-w-[48px] text-right"
              style={{ color: trade.pnl >= 0 ? '#22c55e' : '#ef4444' }}
            >
              {trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(3)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Session Card ────────────────────────────────────────

function SessionCard({ session, defaultOpen }: { session: SniperTradeSession; defaultOpen: boolean }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const total = session.wins + session.losses + session.pending;
  const winRate = session.wins + session.losses > 0
    ? Math.round((session.wins / (session.wins + session.losses)) * 100)
    : 0;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      {/* Session Header */}
      <button
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400">{isOpen ? '▼' : '▶'}</span>
          <span className="text-xs font-mono font-semibold text-gray-700 dark:text-gray-200">
            {formatDateTime(session.startTs)}
          </span>
          <span className="text-[10px] text-gray-400">~</span>
          <span className="text-[10px] font-mono text-gray-400">
            {formatTime(session.endTs)}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-gray-400">
            {total} trades
          </span>
          <span className="text-[10px] font-mono text-gray-400">
            {winRate}% WR
          </span>
          <Chip
            size="sm"
            variant="flat"
            className="text-[10px] h-5 px-1.5 font-mono"
            color={session.totalPnl >= 0 ? 'success' : 'danger'}
          >
            W{session.wins}/L{session.losses}
          </Chip>
          <span
            className="text-xs font-mono font-bold min-w-[56px] text-right"
            style={{ color: session.totalPnl >= 0 ? '#22c55e' : '#ef4444' }}
          >
            {session.totalPnl >= 0 ? '+' : ''}${session.totalPnl.toFixed(2)}
          </span>
        </div>
      </button>

      {/* Trade List */}
      {isOpen && (
        <div className="border-t border-gray-100 dark:border-gray-700/50 px-1 py-1">
          {session.trades.map((trade, i) => (
            <TradeRow key={`${trade.conditionId}-${i}`} trade={trade} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── PnL Chart ───────────────────────────────────────────

function PnlChart() {
  const pnlChart = useMMStore((s) => s.sniperPnlChart);

  const chartData = useMemo(() => {
    return pnlChart.map((p) => ({
      time: formatDateTime(p.ts),
      pnl: p.pnl,
      asset: p.asset,
    }));
  }, [pnlChart]);

  if (chartData.length < 2) {
    return (
      <div className="h-[160px] flex items-center justify-center text-xs text-gray-400">
        Not enough data for chart
      </div>
    );
  }

  const minPnl = Math.min(...chartData.map((d) => d.pnl));
  const maxPnl = Math.max(...chartData.map((d) => d.pnl));
  const padding = Math.max(0.5, (maxPnl - minPnl) * 0.15);

  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.3} />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 9, fill: '#9ca3af' }}
          interval="preserveStartEnd"
          tickCount={5}
        />
        <YAxis
          tick={{ fontSize: 9, fill: '#9ca3af' }}
          tickFormatter={(v: number) => `$${v.toFixed(1)}`}
          domain={[minPnl - padding, maxPnl + padding]}
          width={45}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: 8,
            fontSize: 11,
          }}
          formatter={(value) => [`$${Number(value ?? 0).toFixed(3)}`, 'Cumulative PnL']}
          labelStyle={{ fontSize: 10, color: '#9ca3af' }}
        />
        <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="3 3" />
        <Area
          type="monotone"
          dataKey="pnl"
          stroke="#22c55e"
          fill="url(#pnlGrad)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3, fill: '#22c55e' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Main Component ──────────────────────────────────────

export function SessionTrades() {
  const selectedProfileId = useMMStore((s) => s.selectedProfileId);
  const sessions = useMMStore((s) => s.sniperSessions);
  const summary = useMMStore((s) => s.sniperTradeSummary);
  const loading = useMMStore((s) => s.sniperTradesLoading);
  const fetchSniperTrades = useMMStore((s) => s.fetchSniperTrades);
  const [days, setDays] = useState('1');

  useEffect(() => {
    if (selectedProfileId) {
      fetchSniperTrades(parseInt(days, 10));
    }
  }, [selectedProfileId, days, fetchSniperTrades]);

  // Auto-refresh every 30s when viewing today
  useEffect(() => {
    if (!selectedProfileId || days !== '1') return;
    const id = setInterval(() => fetchSniperTrades(1), 30_000);
    return () => clearInterval(id);
  }, [selectedProfileId, days, fetchSniperTrades]);

  return (
    <Card>
      <CardHeader className="flex justify-between items-center py-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">Session Trades</h3>
          {summary && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-gray-400">
                {summary.totalTrades} trades
              </span>
              <span className="text-[10px] font-mono text-gray-400">
                W{summary.totalWins}/L{summary.totalLosses}
              </span>
              <span
                className="text-xs font-mono font-bold"
                style={{ color: (summary.totalPnl ?? 0) >= 0 ? '#22c55e' : '#ef4444' }}
              >
                {summary.totalPnl >= 0 ? '+' : ''}${summary.totalPnl.toFixed(2)}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select
            size="sm"
            variant="bordered"
            aria-label="Days"
            className="w-[100px]"
            selectedKeys={[days]}
            onSelectionChange={(keys) => {
              const v = Array.from(keys)[0] as string;
              if (v) setDays(v);
            }}
          >
            <SelectItem key="1">Today</SelectItem>
            <SelectItem key="3">3 days</SelectItem>
            <SelectItem key="7">7 days</SelectItem>
          </Select>
          <Button
            size="sm"
            variant="light"
            isIconOnly
            isLoading={loading}
            onPress={() => fetchSniperTrades(parseInt(days, 10))}
          >
            <span className="text-xs">↻</span>
          </Button>
        </div>
      </CardHeader>
      <CardBody className="pt-0 space-y-4">
        {/* PnL Chart */}
        <div>
          <p className="text-[10px] text-gray-500 uppercase font-semibold mb-2">Cumulative PnL</p>
          <PnlChart />
        </div>

        <Divider />

        {/* Sessions List */}
        {loading && sessions.length === 0 ? (
          <div className="flex justify-center py-8">
            <Spinner size="sm" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-4">No trades found</p>
        ) : (
          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {sessions.map((session, i) => (
              <SessionCard key={session.id} session={session} defaultOpen={i === 0} />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
