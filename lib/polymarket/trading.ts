import 'server-only';
import { getAuthClient } from './client';
import type { BalanceAllowance, OpenOrder, TradeRecord } from '@/lib/types/polymarket';

interface PlaceOrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

/** Place a limit order (GTC) */
export async function placeOrder(params: PlaceOrderParams) {
  const client = getAuthClient();

  // Get tick size for this market
  const tickSize = await client.getTickSize(params.tokenId);
  const negRisk = await client.getNegRisk(params.tokenId);

  const result = await client.createAndPostOrder(
    {
      tokenID: params.tokenId,
      price: params.price,
      size: params.size,
      side: params.side as any,
    },
    { tickSize, negRisk },
  );

  return result;
}

/** Cancel a single order by ID */
export async function cancelOrder(orderId: string) {
  const client = getAuthClient();
  return client.cancelOrder({ orderID: orderId });
}

/** Cancel all open orders */
export async function cancelAllOrders() {
  const client = getAuthClient();
  return client.cancelAll();
}

/** Get open orders, optionally filtered by market */
export async function getOpenOrders(market?: string): Promise<OpenOrder[]> {
  const client = getAuthClient();
  const params = market ? { market } : undefined;
  const orders = await client.getOpenOrders(params);

  return (orders as any[]).map((o) => ({
    id: o.id,
    market: o.market,
    asset_id: o.asset_id,
    side: o.side as 'BUY' | 'SELL',
    price: o.price,
    original_size: o.original_size,
    size_matched: o.size_matched,
    status: o.status,
    outcome: o.outcome,
    type: o.order_type || o.type,
    created_at: String(o.created_at),
    expiration: o.expiration,
    associate_trades: o.associate_trades || [],
  }));
}

/** Get trade history */
export async function getTrades(market?: string): Promise<TradeRecord[]> {
  const client = getAuthClient();
  const params = market ? { market } : undefined;
  const trades = await client.getTrades(params);

  return (trades as any[]).map((t) => ({
    id: t.id,
    market: t.market,
    asset_id: t.asset_id,
    side: t.side as 'BUY' | 'SELL',
    price: t.price,
    size: t.size,
    fee_rate_bps: t.fee_rate_bps,
    status: t.status,
    match_time: t.match_time,
    type: t.type || 'LIMIT',
    outcome: t.outcome,
  }));
}

/** Get USDC balance and allowance (converted from 6-decimal micro-USDC to USDC) */
export async function getBalanceAllowance(): Promise<BalanceAllowance> {
  const client = getAuthClient();
  const result = await client.getBalanceAllowance({
    asset_type: 'COLLATERAL' as any,
  });
  const USDC_DECIMALS = 1e6;
  return {
    balance: String(parseFloat(result.balance) / USDC_DECIMALS),
    allowance: String(parseFloat(result.allowance) / USDC_DECIMALS),
  };
}
