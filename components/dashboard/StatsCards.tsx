'use client';

import { Card, CardBody } from '@heroui/react';
import type { DashboardStats } from '@/lib/types/dashboard';

interface StatsCardsProps {
  stats: DashboardStats | null;
  loading: boolean;
}

interface StatCardProps {
  label: string;
  value: string;
  color: string;
}

function StatCard({ label, value, color }: StatCardProps) {
  return (
    <Card>
      <CardBody className="py-3 px-4">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {label}
        </p>
        <p className={`text-xl font-bold ${color}`}>{value}</p>
      </CardBody>
    </Card>
  );
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function fmtUsd(n: number): string {
  return `$${fmt(n)}`;
}

function fmtPct(n: number): string {
  return `${fmt(n * 100, 1)}%`;
}

export function StatsCards({ stats, loading }: StatsCardsProps) {
  if (loading || !stats) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i}>
            <CardBody className="py-3 px-4">
              <div className="h-4 w-20 bg-gray-200 dark:bg-gray-700 rounded animate-pulse mb-2" />
              <div className="h-6 w-16 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
            </CardBody>
          </Card>
        ))}
      </div>
    );
  }

  const cards: StatCardProps[] = [
    {
      label: 'Balance',
      value: fmtUsd(stats.currentBalance),
      color: 'text-blue-500',
    },
    {
      label: 'Total P&L',
      value: fmtUsd(stats.totalPnl),
      color: stats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500',
    },
    {
      label: 'Win Rate',
      value: fmtPct(stats.winRate),
      color: stats.winRate >= 0.5 ? 'text-green-500' : 'text-orange-500',
    },
    {
      label: 'Total Trades',
      value: stats.totalTrades.toString(),
      color: 'text-purple-500',
    },
    {
      label: 'Avg Trade Size',
      value: fmtUsd(stats.avgTradeSize),
      color: 'text-gray-700 dark:text-gray-300',
    },
    {
      label: 'Best Trade',
      value: fmtUsd(stats.bestTrade),
      color: 'text-green-500',
    },
    {
      label: 'Worst Trade',
      value: fmtUsd(stats.worstTrade),
      color: 'text-red-500',
    },
    {
      label: 'Total Fees',
      value: fmtUsd(stats.totalFees),
      color: 'text-gray-500',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((card) => (
        <StatCard key={card.label} {...card} />
      ))}
    </div>
  );
}
