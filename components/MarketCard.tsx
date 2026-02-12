'use client';

import { Card, CardBody, Chip } from '@heroui/react';
import { formatDistanceToNow } from 'date-fns';
import type { Market } from '@/lib/types/app';

interface MarketCardProps {
  market: Market;
  onClick?: (market: Market) => void;
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function MarketCard({ market, onClick }: MarketCardProps) {
  const yesOutcome = market.outcomes.find((o) => o.name === 'Yes');
  const noOutcome = market.outcomes.find((o) => o.name === 'No');
  const yesPrice = yesOutcome?.price ?? 0;
  const noPrice = noOutcome?.price ?? 0;

  let timeLeft = '';
  try {
    timeLeft = formatDistanceToNow(new Date(market.endDate), { addSuffix: true });
  } catch {
    timeLeft = market.endDate;
  }

  return (
    <Card
      isPressable={!!onClick}
      onPress={() => onClick?.(market)}
      className="hover:shadow-lg transition-shadow"
    >
      <CardBody className="p-4 space-y-3">
        <p className="text-sm font-semibold leading-tight line-clamp-2">
          {market.question}
        </p>

        <div className="flex items-center gap-2">
          <Chip size="sm" color="success" variant="flat">
            Yes {(yesPrice * 100).toFixed(0)}¢
          </Chip>
          <Chip size="sm" color="danger" variant="flat">
            No {(noPrice * 100).toFixed(0)}¢
          </Chip>
        </div>

        <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>Vol: {formatVolume(market.volume)}</span>
          <span>Liq: {formatVolume(market.liquidity)}</span>
          <span>Ends {timeLeft}</span>
        </div>
      </CardBody>
    </Card>
  );
}
