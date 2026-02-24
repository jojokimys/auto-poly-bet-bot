'use client';

import { useEffect } from 'react';
import { useMMStore } from '@/store/useMMStore';
import { useProfileStore } from '@/store/useProfileStore';
import { SniperControl } from '@/components/snipe/SniperControl';
import { SniperMultiChart } from '@/components/snipe/SniperMultiChart';
import { SniperMarketsTable } from '@/components/snipe/SniperMarketsTable';
import { SniperLogFeed } from '@/components/snipe/SniperLogFeed';

export default function SnipePage() {
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-w-0">
        <div className="lg:col-span-1 min-w-0">
          <SniperControl />
        </div>
        <div className="lg:col-span-2 min-w-0">
          <SniperMultiChart />
        </div>
      </div>

      <SniperMarketsTable />
      <SniperLogFeed />
    </div>
  );
}
