'use client';

import { useEffect } from 'react';
import { useDashboardStore } from '@/store/useDashboardStore';
import {
  StatsCards,
  BalanceChart,
  PnlChart,
  TradeHistoryTable,
} from '@/components/dashboard';
import { BotControl } from '@/components/BotControl';

export default function Home() {
  const {
    trades,
    stats,
    balanceHistory,
    pnlHistory,
    loading,
    error,
    fetchDashboard,
  } = useDashboardStore();

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
        Dashboard
      </h2>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      <BotControl />

      <StatsCards stats={stats} loading={loading} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BalanceChart data={balanceHistory} loading={loading} />
        <PnlChart data={pnlHistory} loading={loading} />
      </div>

      <TradeHistoryTable trades={trades} loading={loading} />
    </div>
  );
}
