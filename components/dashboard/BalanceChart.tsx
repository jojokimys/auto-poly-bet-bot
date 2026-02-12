'use client';

import { Card, CardBody, CardHeader } from '@heroui/react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useAppStore } from '@/store/useAppStore';
import type { BalanceDataPoint } from '@/lib/types/dashboard';

interface BalanceChartProps {
  data: BalanceDataPoint[];
  loading: boolean;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function BalanceChart({ data, loading }: BalanceChartProps) {
  const theme = useAppStore((s) => s.theme);
  const isDark = theme === 'dark';

  const axisColor = isDark ? '#9ca3af' : '#6b7280';
  const gridColor = isDark ? '#374151' : '#e5e7eb';

  return (
    <Card className="h-full">
      <CardHeader>
        <h3 className="text-sm font-semibold">Balance Over Time</h3>
      </CardHeader>
      <CardBody className="pt-0">
        {loading ? (
          <div className="h-[250px] flex items-center justify-center">
            <div className="h-full w-full bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
          </div>
        ) : data.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-gray-400 text-sm">
            No trade data available
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDate}
                tick={{ fill: axisColor, fontSize: 11 }}
                stroke={gridColor}
              />
              <YAxis
                tickFormatter={(v) => `$${v.toFixed(0)}`}
                tick={{ fill: axisColor, fontSize: 11 }}
                stroke={gridColor}
                width={60}
              />
              <Tooltip
                formatter={(value) => [`$${Number(value).toFixed(2)}`, 'Balance']}
                labelFormatter={(label) => new Date(label).toLocaleString()}
                contentStyle={{
                  backgroundColor: isDark ? '#1f2937' : '#ffffff',
                  border: `1px solid ${gridColor}`,
                  borderRadius: '8px',
                  color: isDark ? '#f3f4f6' : '#111827',
                }}
              />
              <Area
                type="monotone"
                dataKey="balance"
                stroke="#3b82f6"
                fill="url(#balanceGradient)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardBody>
    </Card>
  );
}
