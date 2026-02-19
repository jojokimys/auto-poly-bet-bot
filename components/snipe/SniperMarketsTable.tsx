'use client';

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
} from '@heroui/react';
import { useMMStore } from '@/store/useMMStore';
import type { SniperMarketInfo } from '@/lib/mm/types';

function formatMinutes(mins: number): string {
  const m = Math.floor(mins);
  const s = Math.round((mins - m) * 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function SniperMarketsTable() {
  const sniperDetail = useMMStore((s) => s.sniperDetail);
  const scannedMarkets = useMMStore((s) => s.scannedMarkets);

  const sniperMarkets: SniperMarketInfo[] = sniperDetail?.markets ?? [];
  const hasSniperData = sniperMarkets.length > 0;

  return (
    <Card>
      <CardHeader className="flex justify-between items-center">
        <h3 className="text-sm font-semibold">
          {hasSniperData ? 'Sniper Markets' : 'Scanned Markets'}
        </h3>
        {hasSniperData && (
          <div className="flex gap-2">
            <Chip size="sm" variant="flat" color="warning">
              {sniperMarkets.filter((m) => m.status === 'watching').length} watching
            </Chip>
            <Chip size="sm" variant="flat" color="success">
              {sniperMarkets.filter((m) => m.status === 'entered').length} entered
            </Chip>
          </div>
        )}
      </CardHeader>
      <CardBody className="pt-0">
        {hasSniperData ? (
          <Table
            aria-label="Sniper markets"
            removeWrapper
            classNames={{ th: 'text-xs', td: 'text-xs' }}
          >
            <TableHeader>
              <TableColumn>Asset</TableColumn>
              <TableColumn>Strike</TableColumn>
              <TableColumn>Direction</TableColumn>
              <TableColumn>Entry</TableColumn>
              <TableColumn>Confidence</TableColumn>
              <TableColumn>Time Left</TableColumn>
              <TableColumn>Status</TableColumn>
            </TableHeader>
            <TableBody emptyContent="No active sniper markets">
              {sniperMarkets.map((m) => (
                <TableRow key={m.conditionId}>
                  <TableCell>
                    <Chip size="sm" variant="flat" color="primary">
                      {m.cryptoAsset}
                    </Chip>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono">
                      {m.strikePrice !== null ? `$${m.strikePrice.toLocaleString()}` : '--'}
                    </span>
                  </TableCell>
                  <TableCell>
                    {m.direction ? (
                      <Chip size="sm" variant="flat" color={m.direction === 'YES' ? 'success' : 'danger'}>
                        {m.direction}
                      </Chip>
                    ) : (
                      <span className="text-gray-400">--</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {m.entryPrice !== null ? (
                      <span className="font-mono text-blue-600">{m.entryPrice.toFixed(2)}</span>
                    ) : '--'}
                  </TableCell>
                  <TableCell>
                    {m.confidence > 0 ? (
                      <Chip size="sm" variant="flat" color={m.confidence >= 2 ? 'success' : m.confidence >= 1 ? 'warning' : 'default'}>
                        {m.confidence.toFixed(1)}x
                      </Chip>
                    ) : '--'}
                  </TableCell>
                  <TableCell>
                    <Chip size="sm" variant="flat" color={m.minutesLeft < 1 ? 'danger' : m.minutesLeft < 3 ? 'warning' : 'default'}>
                      {formatMinutes(m.minutesLeft)}
                    </Chip>
                  </TableCell>
                  <TableCell>
                    <Chip size="sm" variant="dot" color={m.status === 'entered' ? 'success' : m.status === 'watching' ? 'warning' : 'default'}>
                      {m.status}
                    </Chip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table
            aria-label="Scanned markets"
            removeWrapper
            classNames={{ th: 'text-xs', td: 'text-xs' }}
          >
            <TableHeader>
              <TableColumn>Asset</TableColumn>
              <TableColumn>Strike</TableColumn>
              <TableColumn>Bid</TableColumn>
              <TableColumn>Ask</TableColumn>
              <TableColumn>Spread</TableColumn>
              <TableColumn>Time Left</TableColumn>
            </TableHeader>
            <TableBody emptyContent="No markets found">
              {scannedMarkets.map((m) => {
                const spread = m.bestBid !== null && m.bestAsk !== null
                  ? ((1 - m.bestBid - m.bestAsk) * 100).toFixed(1)
                  : '--';
                return (
                  <TableRow key={m.conditionId}>
                    <TableCell>
                      <Chip size="sm" variant="flat" color="primary">{m.cryptoAsset}</Chip>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono">
                        {m.strikePrice !== null ? `$${m.strikePrice.toLocaleString()}` : '--'}
                      </span>
                    </TableCell>
                    <TableCell>
                      {m.bestBid !== null ? <span className="text-green-600 font-mono">{m.bestBid.toFixed(2)}</span> : '--'}
                    </TableCell>
                    <TableCell>
                      {m.bestAsk !== null ? <span className="text-red-500 font-mono">{m.bestAsk.toFixed(2)}</span> : '--'}
                    </TableCell>
                    <TableCell><span className="font-mono">{spread}c</span></TableCell>
                    <TableCell>
                      <Chip size="sm" variant="flat" color={m.minutesLeft < 2 ? 'danger' : m.minutesLeft < 5 ? 'warning' : 'default'}>
                        {formatMinutes(m.minutesLeft)}
                      </Chip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}
