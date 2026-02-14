'use client';

import { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader, Chip, Divider, Spinner } from '@heroui/react';
import { OrderForm } from './OrderForm';
import type { Market } from '@/lib/types/app';
import type { OrderBookSummary } from '@/lib/types/polymarket';

interface MarketDetailProps {
  market: Market;
}

function OrderBookTable({ book, label }: { book: OrderBookSummary | null; label: string }) {
  if (!book) return null;
  const topBids = (book.bids ?? []).slice(0, 5);
  const topAsks = (book.asks ?? []).slice(0, 5);

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">{label} Order Book</p>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="font-medium text-green-600 dark:text-green-400 mb-1">Bids</p>
          {topBids.length === 0 && <p className="text-gray-400">No bids</p>}
          {topBids.map((b, i) => (
            <div key={i} className="flex justify-between">
              <span>{parseFloat(b.price).toFixed(2)}</span>
              <span className="text-gray-500">{parseFloat(b.size).toFixed(0)}</span>
            </div>
          ))}
        </div>
        <div>
          <p className="font-medium text-red-600 dark:text-red-400 mb-1">Asks</p>
          {topAsks.length === 0 && <p className="text-gray-400">No asks</p>}
          {topAsks.map((a, i) => (
            <div key={i} className="flex justify-between">
              <span>{parseFloat(a.price).toFixed(2)}</span>
              <span className="text-gray-500">{parseFloat(a.size).toFixed(0)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MarketDetail({ market }: MarketDetailProps) {
  const [orderBooks, setOrderBooks] = useState<(OrderBookSummary | null)[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchDetail() {
      setLoading(true);
      try {
        const res = await fetch(`/api/markets/${market.conditionId}`);
        if (res.ok) {
          const data = await res.json();
          setOrderBooks(data.orderBooks || []);
        }
      } catch {
        // Silently fail — order book is supplementary
      }
      setLoading(false);
    }
    fetchDetail();
  }, [market.conditionId]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-col items-start gap-2">
          <h3 className="text-lg font-bold">{market.question}</h3>
          <div className="flex gap-2 flex-wrap">
            {market.outcomes.map((o) => (
              <Chip
                key={o.name}
                size="sm"
                color={o.name === 'Yes' ? 'success' : 'danger'}
                variant="flat"
              >
                {o.name}: {(o.price * 100).toFixed(1)}¢
              </Chip>
            ))}
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          {market.description && (
            <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-3">
              {market.description}
            </p>
          )}

          <Divider />

          {loading ? (
            <div className="flex justify-center py-4">
              <Spinner size="sm" />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {market.outcomes.map((outcome, i) => (
                <OrderBookTable
                  key={outcome.name}
                  book={orderBooks[i] || null}
                  label={outcome.name}
                />
              ))}
            </div>
          )}

          <Divider />

          <div>
            <p className="text-sm font-semibold mb-3">Place Order</p>
            <OrderForm market={market} />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
