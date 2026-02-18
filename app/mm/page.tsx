'use client';

import { useEffect } from 'react';
import { useMMStore } from '@/store/useMMStore';
import { useProfileStore } from '@/store/useProfileStore';
import { MMControl } from '@/components/mm/MMControl';
import { CryptoChart } from '@/components/mm/CryptoChart';
import { MMMarketsTable } from '@/components/mm/MMMarketsTable';
import { MMLogFeed } from '@/components/mm/MMLogFeed';

export default function MMPage() {
  const startPolling = useMMStore((s) => s.startPolling);
  const stopPolling = useMMStore((s) => s.stopPolling);
  const fetchProfiles = useProfileStore((s) => s.fetchProfiles);

  useEffect(() => {
    fetchProfiles();
    startPolling();
    return () => stopPolling();
  }, [fetchProfiles, startPolling, stopPolling]);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Expiry Sniper</h2>

      {/* Top section: Control + Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <MMControl />
        </div>
        <div className="lg:col-span-2">
          <CryptoChart />
        </div>
      </div>

      {/* Active Markets */}
      <MMMarketsTable />

      {/* Log Feed */}
      <MMLogFeed />
    </div>
  );
}
