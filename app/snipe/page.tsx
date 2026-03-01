'use client';

import { useEffect } from 'react';
import { useMMStore } from '@/store/useMMStore';
import { useProfileStore } from '@/store/useProfileStore';
import { SniperControl } from '@/components/snipe/SniperControl';
import { SniperMultiChart } from '@/components/snipe/SniperMultiChart';
import { SniperMarketsTable } from '@/components/snipe/SniperMarketsTable';
import { SniperLogFeed } from '@/components/snipe/SniperLogFeed';
import { PnlCalendar } from '@/components/snipe/PnlCalendar';
import { SessionTrades } from '@/components/snipe/SessionTrades';

export default function SnipePage() {
  const startPolling = useMMStore((s) => s.startPolling);
  const stopPolling = useMMStore((s) => s.stopPolling);
  const dailyPnl = useMMStore((s) => s.dailyPnl);
  const dailyPnlLoading = useMMStore((s) => s.dailyPnlLoading);
  const portfolioBalance = useMMStore((s) => s.portfolioBalance);
  const fetchDailyPnl = useMMStore((s) => s.fetchDailyPnl);
  const fetchProfiles = useProfileStore((s) => s.fetchProfiles);

  useEffect(() => {
    fetchProfiles();
    startPolling();
    return () => stopPolling();
  }, [fetchProfiles, startPolling, stopPolling]);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Expiry Sniper</h2>

      <PnlCalendar data={dailyPnl} loading={dailyPnlLoading} balance={portfolioBalance} onRefresh={fetchDailyPnl} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-w-0">
        <div className="lg:col-span-1 min-w-0">
          <SniperControl />
        </div>
        <div className="lg:col-span-2 min-w-0">
          <SniperMultiChart />
        </div>
      </div>

      <SessionTrades />
      <SniperMarketsTable />
      <SniperLogFeed />
    </div>
  );
}
