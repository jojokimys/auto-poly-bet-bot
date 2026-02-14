import 'server-only';

import { fetchMarkets, fetchEvents, fetchMarket } from '@/lib/polymarket/gamma';
import { getEnv } from '@/lib/config/env';
import { prisma } from '@/lib/db/prisma';
import type { GammaMarket } from '@/lib/types/polymarket';
import type { MarketData, OrderBookData, SnapshotData } from './types';

// ─── Helpers ────────────────────────────────────────────

function parseGammaMarket(gm: GammaMarket): MarketData | null {
  try {
    const prices: number[] = JSON.parse(gm.outcomePrices || '[]');
    const outcomes: string[] = JSON.parse(gm.outcomes || '[]');
    const tokenIds: string[] = JSON.parse(gm.clobTokenIds || '[]');

    if (prices.length < 2 || outcomes.length < 2 || tokenIds.length < 2) return null;

    const yesPrice = prices[0] || 0;
    const noPrice = prices[1] || 0;
    if (yesPrice === 0 && noPrice === 0) return null;

    const endDate = new Date(gm.endDate);
    const hoursToExpiry = Math.max(0, (endDate.getTime() - Date.now()) / (1000 * 60 * 60));

    return {
      conditionId: gm.conditionId,
      question: gm.question,
      endDate: gm.endDate,
      yesPrice,
      noPrice,
      volume24hr: parseFloat(gm.volume24hr || '0'),
      liquidity: parseFloat(gm.liquidity || '0'),
      spread: parseFloat(gm.spread || '0'),
      hoursToExpiry,
      outcomes: outcomes.map((name, i) => ({
        name,
        tokenId: tokenIds[i] || '',
        price: prices[i] || 0,
      })),
    };
  } catch {
    return null;
  }
}

interface OrderBookLevel { price: string; size: string }
interface OrderBookResponse { asks: OrderBookLevel[]; bids: OrderBookLevel[] }

function parseSide(levels: OrderBookLevel[]): {
  bestBid: number; bestAsk: number; depth: number;
  levels: { price: number; size: number }[];
} {
  if (!levels || levels.length === 0) {
    return { bestBid: 0, bestAsk: 0, depth: 0, levels: [] };
  }
  const parsed = levels.map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
  const depth = parsed.reduce((sum, l) => sum + l.price * l.size, 0);
  return {
    bestBid: parsed[parsed.length - 1]?.price ?? 0,
    bestAsk: parsed[0]?.price ?? 0,
    depth,
    levels: parsed.slice(0, 10),
  };
}

// ─── Public API ─────────────────────────────────────────

export async function getMarkets(params: {
  limit?: number;
  minLiquidity?: number;
  minVolume?: number;
  sortBy?: string;
}): Promise<MarketData[]> {
  const { limit = 50, minLiquidity = 0, minVolume = 0, sortBy = 'volume24hr' } = params;

  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit,
    order: sortBy,
    ascending: false,
  });

  const markets: MarketData[] = [];
  for (const gm of gammaMarkets) {
    const parsed = parseGammaMarket(gm);
    if (!parsed) continue;
    if (parsed.liquidity < minLiquidity) continue;
    if (parsed.volume24hr < minVolume) continue;
    markets.push(parsed);
  }

  return markets;
}

export async function getOrderBook(conditionId: string): Promise<OrderBookData | null> {
  const gm = await fetchMarket(conditionId);
  const parsed = parseGammaMarket(gm);
  if (!parsed) return null;

  const clobUrl = getEnv().CLOB_API_URL;
  const tokenIds = parsed.outcomes.map(o => o.tokenId);
  if (tokenIds.length < 2) return null;

  const [yesRes, noRes] = await Promise.all([
    fetch(`${clobUrl}/book?token_id=${tokenIds[0]}`, { cache: 'no-store' }).then(r => r.ok ? r.json() as Promise<OrderBookResponse> : null),
    fetch(`${clobUrl}/book?token_id=${tokenIds[1]}`, { cache: 'no-store' }).then(r => r.ok ? r.json() as Promise<OrderBookResponse> : null),
  ]);

  const yes = yesRes
    ? { ...parseSide(yesRes.asks), bestBid: parseSide(yesRes.bids).bestAsk }
    : { bestBid: 0, bestAsk: 0, depth: 0, levels: [] };
  const no = noRes
    ? { ...parseSide(noRes.asks), bestBid: parseSide(noRes.bids).bestAsk }
    : { bestBid: 0, bestAsk: 0, depth: 0, levels: [] };

  const combinedAsk = yes.bestAsk + no.bestAsk;

  return {
    conditionId,
    question: parsed.question,
    yes,
    no,
    combinedAsk,
    arbOpportunity: combinedAsk > 0 && combinedAsk < 0.975,
  };
}

export async function getEvents(params: { limit?: number; active?: boolean }) {
  const events = await fetchEvents({
    active: params.active ?? true,
    closed: false,
    limit: params.limit ?? 20,
    order: 'volume',
    ascending: false,
  });

  return events.map(e => ({
    id: e.id,
    title: e.title,
    slug: e.slug,
    marketCount: e.markets?.length ?? 0,
    markets: (e.markets || []).slice(0, 5).map(m => {
      const p = parseGammaMarket(m);
      return p ? { conditionId: p.conditionId, question: p.question, yesPrice: p.yesPrice } : null;
    }).filter(Boolean),
  }));
}

export async function getSnapshots(conditionId: string, hours = 24): Promise<SnapshotData> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const snapshots = await prisma.marketSnapshot.findMany({
    where: {
      market: { conditionId },
      snapshotAt: { gte: since },
    },
    orderBy: { snapshotAt: 'asc' },
    select: { yesPrice: true, noPrice: true, volume24hr: true, snapshotAt: true },
  });

  return {
    conditionId,
    snapshots: snapshots.map(s => ({
      yesPrice: s.yesPrice,
      noPrice: s.noPrice,
      volume24hr: s.volume24hr,
      snapshotAt: s.snapshotAt.toISOString(),
    })),
  };
}
