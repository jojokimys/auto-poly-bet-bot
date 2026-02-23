import { getEnv } from '@/lib/config/env';
import { trackClobCall } from './api-tracker';

interface BookLevel {
  price: string;
  size: string;
}

export interface BestBidAsk {
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth: number;
  askDepth: number;
}

/** Fetch orderbook and return best bid/ask with depth near the top of book */
export async function fetchBestBidAsk(tokenId: string): Promise<BestBidAsk | null> {
  try {
    const clobUrl = getEnv().CLOB_API_URL;
    trackClobCall();
    const res = await fetch(`${clobUrl}/book?token_id=${tokenId}`, { cache: 'no-store' });
    if (!res.ok) return null;

    const book: { bids: BookLevel[]; asks: BookLevel[] } = await res.json();

    let bestBid: number | null = null;
    let bidDepth = 0;

    if (book.bids && book.bids.length > 0) {
      const sortedBids = book.bids
        .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a, b) => b.price - a.price);

      bestBid = sortedBids[0].price;
      for (const level of sortedBids) {
        if (level.price < bestBid - 0.01) break;
        bidDepth += level.price * level.size;
      }
    }

    let bestAsk: number | null = null;
    let askDepth = 0;

    if (book.asks && book.asks.length > 0) {
      const sortedAsks = book.asks
        .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a, b) => a.price - b.price);

      bestAsk = sortedAsks[0].price;
      for (const level of sortedAsks) {
        if (level.price > bestAsk + 0.01) break;
        askDepth += level.price * level.size;
      }
    }

    return { bestBid, bestAsk, bidDepth, askDepth };
  } catch (err) {
    console.warn(`[orderbook] fetchBestBidAsk failed for ${tokenId.slice(0, 12)}…:`, err instanceof Error ? err.message : err);
    return null;
  }
}
