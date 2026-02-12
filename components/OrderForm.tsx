'use client';

import { Input, Button, Select, SelectItem } from '@heroui/react';
import { useOrderStore } from '@/store/useOrderStore';
import type { Market } from '@/lib/types/app';

interface OrderFormProps {
  market: Market;
}

export function OrderForm({ market }: OrderFormProps) {
  const { orderForm, setOrderForm, placeOrder, placing, error } = useOrderStore();

  const selectedOutcome = market.outcomes.find(
    (o) => o.name === orderForm.outcome,
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOutcome) return;

    const price = parseFloat(orderForm.price);
    const size = parseFloat(orderForm.size);
    if (isNaN(price) || isNaN(size) || price <= 0 || price >= 1 || size <= 0) return;

    await placeOrder({
      conditionId: market.conditionId,
      tokenId: selectedOutcome.tokenId,
      side: orderForm.side,
      price,
      size,
      outcome: orderForm.outcome,
    });
  };

  const estimatedCost = (() => {
    const price = parseFloat(orderForm.price);
    const size = parseFloat(orderForm.size);
    if (isNaN(price) || isNaN(size)) return null;
    return (price * size).toFixed(2);
  })();

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          color={orderForm.side === 'BUY' ? 'success' : 'default'}
          variant={orderForm.side === 'BUY' ? 'solid' : 'bordered'}
          onPress={() => setOrderForm({ side: 'BUY' })}
          className="flex-1"
        >
          Buy
        </Button>
        <Button
          type="button"
          size="sm"
          color={orderForm.side === 'SELL' ? 'danger' : 'default'}
          variant={orderForm.side === 'SELL' ? 'solid' : 'bordered'}
          onPress={() => setOrderForm({ side: 'SELL' })}
          className="flex-1"
        >
          Sell
        </Button>
      </div>

      <Select
        label="Outcome"
        placeholder="Select outcome"
        selectedKeys={orderForm.outcome ? [orderForm.outcome] : []}
        onSelectionChange={(keys) => {
          const val = Array.from(keys)[0] as string;
          const outcome = market.outcomes.find((o) => o.name === val);
          if (outcome) {
            setOrderForm({
              outcome: val,
              tokenId: outcome.tokenId,
              price: outcome.price.toFixed(2),
            });
          }
        }}
        size="sm"
      >
        {market.outcomes.map((o) => (
          <SelectItem key={o.name}>
            {o.name} ({(o.price * 100).toFixed(0)}¢)
          </SelectItem>
        ))}
      </Select>

      <Input
        type="number"
        label="Price"
        placeholder="0.50"
        size="sm"
        min={0.01}
        max={0.99}
        step={0.01}
        value={orderForm.price}
        onValueChange={(v) => setOrderForm({ price: v })}
        description="Between 0.01 and 0.99"
      />

      <Input
        type="number"
        label="Size (shares)"
        placeholder="10"
        size="sm"
        min={1}
        step={1}
        value={orderForm.size}
        onValueChange={(v) => setOrderForm({ size: v })}
      />

      {estimatedCost && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Estimated cost: ${estimatedCost} USDC
        </p>
      )}

      {error && (
        <p className="text-xs text-danger">{error}</p>
      )}

      <Button
        type="submit"
        color={orderForm.side === 'BUY' ? 'success' : 'danger'}
        className="w-full"
        isLoading={placing}
        isDisabled={!orderForm.outcome || !orderForm.price || !orderForm.size}
      >
        {placing
          ? 'Placing...'
          : `${orderForm.side === 'BUY' ? 'Buy' : 'Sell'} ${orderForm.outcome || '...'}`}
      </Button>
    </form>
  );
}
