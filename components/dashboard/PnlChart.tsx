'use client';

import { Card, CardBody, CardHeader } from '@heroui/react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { useAppStore } from '@/store/useAppStore';
import type { PnlDataPoint } from '@/lib/types/dashboard';

interface PnlChartProps {
  data: PnlDataPoint[];
  loading: boolean;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function PnlChart({ data, loading }: PnlChartProps) {
  const theme = useAppStore((s) => s.theme);
  const isDark = theme === 'dark';

  const axisColor = isDark ? '#9ca3af' : '#6b7280';
  const gridColor = isDark ? '#374151' : '#e5e7eb';

  const finalPnl = data.length > 0 ? data[data.length - 1].pnl : 0;
  const isPositive = finalPnl >= 0;
  const strokeColor = isPositive ? '#22c55e' : '#ef4444';
  const gradientId = 'pnlGradient';

  return (
    <Card className="h-full">
      <CardHeader>
        <h3 className="text-sm font-semibold">Cumulative P&L</h3>
      </CardHeader>
      <CardBody className="pt-0">
        {loading ? (
          <div className="h-[250px] flex items-center justify-center">
            <div className="h-full w-full bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
          </div>
        ) : data.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-gray-400 text-sm">
            No realized P&L data yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={strokeColor} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={strokeColor} stopOpacity={0} />
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
                formatter={(value) => [`$${Number(value).toFixed(2)}`, 'P&L']}
                labelFormatter={(label) => new Date(label).toLocaleString()}
                contentStyle={{
                  backgroundColor: isDark ? '#1f2937' : '#ffffff',
                  border: `1px solid ${gridColor}`,
                  borderRadius: '8px',
                  color: isDark ? '#f3f4f6' : '#111827',
                }}
              />
              <ReferenceLine y={0} stroke={axisColor} strokeDasharray="3 3" />
              <Area
                type="monotone"
                dataKey="pnl"
                stroke={strokeColor}
                fill={`url(#${gradientId})`}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardBody>
    </Card>
  );
}
