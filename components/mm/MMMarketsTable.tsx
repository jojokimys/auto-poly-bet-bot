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

function formatMinutes(mins: number): string {
  const m = Math.floor(mins);
  const s = Math.round((mins - m) * 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface MarketRow {
  conditionId: string;
  cryptoAsset: string;
  question: string;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  minutesLeft: number;
  yesHeld: number;
  noHeld: number;
}

export function MMMarketsTable() {
  const detail = useMMStore((s) => s.detail);
  const scannedMarkets = useMMStore((s) => s.scannedMarkets);

  const isRunning = detail !== null;
  const engineMarkets = detail?.markets ?? [];

  const rows: MarketRow[] = isRunning
    ? engineMarkets.map((m) => ({
        conditionId: m.conditionId,
        cryptoAsset: m.cryptoAsset,
        question: m.question,
        bestBid: m.bestBid,
        bestAsk: m.bestAsk,
        midpoint: m.midpoint,
        bidPrice: m.bidPrice,
        askPrice: m.askPrice,
        minutesLeft: m.minutesLeft,
        yesHeld: m.yesHeld,
        noHeld: m.noHeld,
      }))
    : scannedMarkets.map((m) => ({
        conditionId: m.conditionId,
        cryptoAsset: m.cryptoAsset,
        question: m.question,
        bestBid: m.bestBid,
        bestAsk: m.bestAsk,
        midpoint: m.midpoint,
        bidPrice: null,
        askPrice: null,
        minutesLeft: m.minutesLeft,
        yesHeld: 0,
        noHeld: 0,
      }));

  return (
    <Card>
      <CardHeader className="flex justify-between items-center">
        <h3 className="text-sm font-semibold">
          {isRunning ? 'Active Markets' : 'Scanned Markets'}
        </h3>
        {!isRunning && rows.length > 0 && (
          <span className="text-[10px] text-gray-400">CLOB orderbook</span>
        )}
      </CardHeader>
      <CardBody className="pt-0">
        <Table
          aria-label="MM markets"
          removeWrapper
          classNames={{ th: 'text-xs', td: 'text-xs' }}
        >
          <TableHeader>
            <TableColumn>Asset</TableColumn>
            <TableColumn>Question</TableColumn>
            <TableColumn>Bid</TableColumn>
            <TableColumn>Ask</TableColumn>
            <TableColumn>Mid</TableColumn>
            <TableColumn>Spread</TableColumn>
            <TableColumn>Time Left</TableColumn>
            <TableColumn>Inventory</TableColumn>
          </TableHeader>
          <TableBody emptyContent={isRunning ? 'No active markets' : 'No markets found'}>
            {rows.map((m) => {
              const bid = isRunning ? m.bidPrice : m.bestBid;
              const ask = isRunning ? m.askPrice : m.bestAsk;
              const spread = bid !== null && ask !== null
                ? ((1 - bid - ask) * 100).toFixed(1)
                : '--';
              return (
                <TableRow key={m.conditionId}>
                  <TableCell>
                    <Chip size="sm" variant="flat" color="primary">
                      {m.cryptoAsset}
                    </Chip>
                  </TableCell>
                  <TableCell>
                    <span className="text-gray-700 dark:text-gray-300 truncate max-w-[200px] block">
                      {m.question.length > 50 ? m.question.slice(0, 50) + '...' : m.question}
                    </span>
                  </TableCell>
                  <TableCell>
                    {bid !== null ? (
                      <span className="text-green-600 font-mono">{bid.toFixed(2)}</span>
                    ) : '--'}
                  </TableCell>
                  <TableCell>
                    {ask !== null ? (
                      <span className="text-red-500 font-mono">{ask.toFixed(2)}</span>
                    ) : '--'}
                  </TableCell>
                  <TableCell>
                    <span className="font-mono">
                      {m.midpoint !== null ? m.midpoint.toFixed(3) : '--'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono">{spread}c</span>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="sm"
                      variant="flat"
                      color={m.minutesLeft < 2 ? 'danger' : m.minutesLeft < 5 ? 'warning' : 'default'}
                    >
                      {formatMinutes(m.minutesLeft)}
                    </Chip>
                  </TableCell>
                  <TableCell>
                    {isRunning ? (
                      <div className="flex gap-1 text-[10px]">
                        <span className="text-green-600">Y:{m.yesHeld}</span>
                        <span className="text-red-500">N:{m.noHeld}</span>
                      </div>
                    ) : '--'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardBody>
    </Card>
  );
}
