'use client';

import { useEffect, useCallback } from 'react';
import { Select, SelectItem } from '@heroui/react';
import { useDashboardStore } from '@/store/useDashboardStore';
import { useProfileStore } from '@/store/useProfileStore';
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
    selectedProfileId,
    setSelectedProfileId,
    fetchDashboard,
  } = useDashboardStore();

  const { profiles, fetchProfiles } = useProfileStore();

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  useEffect(() => {
    fetchDashboard(selectedProfileId);
  }, [fetchDashboard, selectedProfileId]);

  const handleProfileChange = useCallback(
    (keys: Set<string> | any) => {
      // HeroUI Select onChange gives a Set or SharedSelection
      const value = typeof keys === 'string'
        ? keys
        : keys instanceof Set
          ? [...keys][0]
          : keys?.currentKey ?? [...keys][0];
      const profileId = value === 'all' ? null : (value || null);
      setSelectedProfileId(profileId);
      fetchDashboard(profileId);
    },
    [setSelectedProfileId, fetchDashboard],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          Dashboard
        </h2>
        <Select
          aria-label="Select profile"
          placeholder="All Profiles"
          size="sm"
          className="max-w-[200px]"
          selectedKeys={new Set([selectedProfileId ?? 'all'])}
          onSelectionChange={handleProfileChange}
        >
          {[
            <SelectItem key="all">All Profiles</SelectItem>,
            ...profiles.filter((p) => p.isActive).map((p) => (
              <SelectItem key={p.id}>{p.name}</SelectItem>
            )),
          ]}
        </Select>
      </div>

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

      <TradeHistoryTable
        trades={trades}
        loading={loading}
        showProfile={!selectedProfileId}
      />
    </div>
  );
}
