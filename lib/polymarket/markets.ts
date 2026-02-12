import 'server-only';
import { getReadClient } from './client';
import { fetchMarkets as fetchGammaMarkets } from './gamma';
import type { GammaMarket, OrderBookSummary } from '@/lib/types/polymarket';
import type { Market, Outcome } from '@/lib/types/app';

/** Convert a Gamma market to our app Market type */
function normalizeMarket(gm: GammaMarket): Market {
  let outcomes: Outcome[] = [];
  try {
    const names: string[] = JSON.parse(gm.outcomes || '[]');
    const prices: number[] = JSON.parse(gm.outcomePrices || '[]');
    const tokenIds: string[] = JSON.parse(gm.clobTokenIds || '[]');
    outcomes = names.map((name, i) => ({
      name,
      tokenId: tokenIds[i] || '',
      price: prices[i] || 0,
    }));
  } catch {
    // Fall back to empty outcomes
  }

  return {
    conditionId: gm.conditionId,
    question: gm.question,
    slug: gm.slug,
    endDate: gm.endDate,
    active: gm.active,
    closed: gm.closed,
    liquidity: parseFloat(gm.liquidity) || 0,
    volume: parseFloat(gm.volume) || 0,
    volume24hr: parseFloat(gm.volume24hr || '0'),
    spread: parseFloat(gm.spread || '0'),
    outcomes,
    description: gm.description,
    image: gm.image,
    icon: gm.icon,
  };
}

/** Fetch active markets from Gamma, normalized */
export async function getActiveMarkets(params?: {
  limit?: number;
  offset?: number;
}): Promise<Market[]> {
  const gammaMarkets = await fetchGammaMarkets({
    active: true,
    closed: false,
    limit: params?.limit ?? 50,
    offset: params?.offset,
    order: 'volume24hr',
    ascending: false,
  });
  return gammaMarkets.map(normalizeMarket);
}

/** Get a single market by condition ID */
export async function getMarketByConditionId(conditionId: string): Promise<Market> {
  const { fetchMarket } = await import('./gamma');
  const gm = await fetchMarket(conditionId);
  return normalizeMarket(gm);
}

/** Get order book for a token from CLOB */
export async function getOrderBook(tokenId: string): Promise<OrderBookSummary> {
  const client = getReadClient();
  return client.getOrderBook(tokenId);
}

/** Get best prices for a token */
export async function getPrice(tokenId: string, side: 'BUY' | 'SELL'): Promise<number> {
  const client = getReadClient();
  const result = await client.getPrice(tokenId, side);
  return parseFloat(result?.price ?? '0');
}

/** Get midpoint price for a token */
export async function getMidpoint(tokenId: string): Promise<number> {
  const client = getReadClient();
  const result = await client.getMidpoint(tokenId);
  return parseFloat(result?.mid ?? '0');
}
