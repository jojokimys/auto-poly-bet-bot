'use client';

import { useState, useMemo } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  Pagination,
} from '@heroui/react';
import type { DashboardTrade } from '@/lib/types/dashboard';

interface TradeHistoryTableProps {
  trades: DashboardTrade[];
  loading: boolean;
}

const ROWS_PER_PAGE = 10;

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TradeHistoryTable({ trades, loading }: TradeHistoryTableProps) {
  const [page, setPage] = useState(1);

  const sortedTrades = useMemo(
    () => [...trades].sort(
      (a, b) => new Date(b.matchTime).getTime() - new Date(a.matchTime).getTime()
    ),
    [trades]
  );

  const totalPages = Math.max(1, Math.ceil(sortedTrades.length / ROWS_PER_PAGE));
  const paginated = sortedTrades.slice(
    (page - 1) * ROWS_PER_PAGE,
    page * ROWS_PER_PAGE
  );

  return (
    <Card>
      <CardHeader className="flex justify-between items-center">
        <h3 className="text-sm font-semibold">Trade History</h3>
        <span className="text-xs text-gray-500">{sortedTrades.length} trades</span>
      </CardHeader>
      <CardBody className="pt-0">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-10 bg-gray-100 dark:bg-gray-800 rounded animate-pulse"
              />
            ))}
          </div>
        ) : sortedTrades.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-8">
            No trades found
          </p>
        ) : (
          <>
            <Table
              aria-label="Trade history"
              removeWrapper
              classNames={{
                th: 'text-xs',
                td: 'text-xs',
              }}
            >
              <TableHeader>
                <TableColumn>Date</TableColumn>
                <TableColumn>Side</TableColumn>
                <TableColumn>Outcome</TableColumn>
                <TableColumn>Price</TableColumn>
                <TableColumn>Size</TableColumn>
                <TableColumn>Fee</TableColumn>
                <TableColumn>P&L</TableColumn>
              </TableHeader>
              <TableBody>
                {paginated.map((trade) => (
                  <TableRow key={trade.id}>
                    <TableCell>{formatDate(trade.matchTime)}</TableCell>
                    <TableCell>
                      <Chip
                        size="sm"
                        variant="flat"
                        color={trade.side === 'BUY' ? 'primary' : 'warning'}
                      >
                        {trade.side}
                      </Chip>
                    </TableCell>
                    <TableCell className="max-w-[120px] truncate">
                      {trade.outcome}
                    </TableCell>
                    <TableCell>${trade.price.toFixed(2)}</TableCell>
                    <TableCell>{trade.size.toFixed(2)}</TableCell>
                    <TableCell className="text-gray-500">
                      ${trade.fee.toFixed(4)}
                    </TableCell>
                    <TableCell>
                      {trade.realizedPnl !== null ? (
                        <Chip
                          size="sm"
                          variant="flat"
                          color={trade.realizedPnl >= 0 ? 'success' : 'danger'}
                        >
                          ${trade.realizedPnl.toFixed(2)}
                        </Chip>
                      ) : (
                        <span className="text-gray-400">--</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {totalPages > 1 && (
              <div className="flex justify-center pt-4">
                <Pagination
                  total={totalPages}
                  page={page}
                  onChange={setPage}
                  size="sm"
                />
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
