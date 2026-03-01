'use client';

import { useState } from 'react';
import { Spinner } from '@heroui/react';
import type { DailyPnl } from '@/lib/types/dashboard';

interface PnlCalendarProps {
  data: DailyPnl[];
  loading: boolean;
  balance: number | null;
  onRefresh?: () => void;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pnlBg(pnl: number): string {
  if (pnl > 50) return 'bg-green-200/70 dark:bg-green-900/40';
  if (pnl > 10) return 'bg-green-100/70 dark:bg-green-900/25';
  if (pnl > 0) return 'bg-green-50/80 dark:bg-green-950/30';
  if (pnl < -50) return 'bg-red-200/70 dark:bg-red-900/40';
  if (pnl < -10) return 'bg-red-100/70 dark:bg-red-900/25';
  if (pnl < 0) return 'bg-red-50/80 dark:bg-red-950/30';
  return 'bg-gray-50 dark:bg-gray-900/50';
}

export function PnlCalendar({ data, loading, balance, onRefresh }: PnlCalendarProps) {
  const [viewDate, setViewDate] = useState(() => new Date());

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Index data by date
  const dayMap = new Map<string, DailyPnl>();
  for (const d of data) {
    const existing = dayMap.get(d.date);
    if (existing) {
      existing.pnl += d.pnl;
      existing.wins += d.wins;
      existing.losses += d.losses;
    } else {
      dayMap.set(d.date, { ...d });
    }
  }

  // Monthly totals
  let monthPnl = 0;
  let monthWins = 0;
  let monthLosses = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const entry = dayMap.get(key);
    if (entry) {
      monthPnl += entry.pnl;
      monthWins += entry.wins;
      monthLosses += entry.losses;
    }
  }

  const monthClosed = monthWins + monthLosses;
  const monthWinRate = monthClosed > 0 ? (monthWins / monthClosed) * 100 : 0;

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));

  const monthLabel = viewDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const cells: React.ReactNode[] = [];

  for (let i = 0; i < firstDay; i++) {
    cells.push(<div key={`empty-${i}`} />);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const entry = dayMap.get(key);
    const hasData = !!entry;
    const pnl = entry?.pnl ?? 0;
    const wins = entry?.wins ?? 0;
    const losses = entry?.losses ?? 0;
    const dayClosed = wins + losses;
    const dayWinRate = dayClosed > 0 ? Math.round((wins / dayClosed) * 100) : null;

    const bg = hasData ? pnlBg(pnl) : 'bg-gray-50 dark:bg-gray-900/50';
    const pnlTextColor = hasData
      ? pnl >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'
      : '';

    cells.push(
      <div
        key={key}
        className={`rounded-md p-1.5 leading-tight min-h-[56px] flex flex-col gap-0.5 ${bg}`}
        title={hasData ? `${key}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${wins}W ${losses}L` : key}
      >
        <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400">{day}</span>
        {hasData && (
          <div className="flex flex-col items-center flex-1 justify-center">
            <span className={`font-mono text-sm font-bold leading-none ${pnlTextColor}`}>
              {pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}
            </span>
            {dayClosed > 0 && (
              <span className="text-[10px] font-semibold text-gray-600 dark:text-gray-300 mt-0.5">
                {dayWinRate}% ({wins}/{dayClosed})
              </span>
            )}
          </div>
        )}
      </div>,
    );
  }

  return (
    <div className="bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
      {/* Header row: Balance | Month nav | Win Rate */}
      <div className="flex items-center justify-between mb-4 px-1">
        <div>
          <span className="text-[10px] text-gray-400 uppercase font-medium">
            Portfolio Balance
            {onRefresh && (
              <button
                onClick={onRefresh}
                disabled={loading}
                className="ml-1.5 inline-flex align-middle text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={loading ? 'animate-spin' : ''}>
                  <path d="M14 8A6 6 0 1 1 8 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <path d="M8 0l3 2-3 2" fill="currentColor"/>
                </svg>
              </button>
            )}
          </span>
          <p className="text-2xl font-bold font-mono text-gray-900 dark:text-white">
            {balance !== null ? `$${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '--'}
            {balance !== null && monthClosed > 0 && (
              <span className={`ml-1.5 text-lg ${monthPnl >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                ({monthPnl >= 0 ? '+' : ''}{monthPnl.toFixed(2)})
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={prevMonth}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{monthLabel}</h3>
          <button
            onClick={nextMonth}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
        <div className="text-right">
          <span className="text-[10px] text-gray-400 uppercase font-medium">Monthly Win Rate</span>
          <p className={`text-2xl font-bold font-mono ${monthWinRate >= 50 ? 'text-green-600' : monthClosed > 0 ? 'text-red-500' : 'text-gray-400'}`}>
            {monthClosed > 0 ? `${monthWinRate.toFixed(0)}% (${monthWins}/${monthClosed})` : '--'}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-[200px]">
          <Spinner size="sm" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DAY_LABELS.map((d) => (
              <div key={d} className="text-center text-[10px] font-medium text-gray-400 uppercase">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells}
          </div>
        </>
      )}
    </div>
  );
}
