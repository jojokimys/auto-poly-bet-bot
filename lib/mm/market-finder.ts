import 'server-only';

import { fetchMarkets } from '@/lib/polymarket/gamma';
import {
  CRYPTO_KEYWORDS,
  detectCryptoAsset,
  parseCryptoMarketStartTime,
  parseCryptoMarketEndTime,
} from '@/lib/bot/scanner';
import { getHistoricalPrice } from '@/lib/polymarket/binance';
import type { ActiveMarket, CryptoAsset } from './types';

/**
 * Find active crypto markets suitable for market making.
 * Returns at most one market per asset, picking the soonest-expiring one.
 */
export async function findActiveCryptoMarkets(
  assets: CryptoAsset[],
  minMinutes = 3,
  maxMinutes = 14,
  targetWindowMinutes?: number,
): Promise<ActiveMarket[]> {
  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit: 100,
    order: 'endDate',
    ascending: true,
    endDateMin: new Date().toISOString(),
  });

  const assetSet = new Set(assets.map((a) => a.toUpperCase()));
  const found = new Map<string, ActiveMarket>(); // asset → best market

  for (const gm of gammaMarkets) {
    if (!CRYPTO_KEYWORDS.test(gm.question)) continue;

    const detected = detectCryptoAsset(gm.question);
    if (!detected) continue;
    if (!assetSet.has(detected.asset)) continue;

    // Parse actual start/end time from question (5-min/15-min window)
    const startTime = parseCryptoMarketStartTime(gm.question);
    const endTime = parseCryptoMarketEndTime(gm.question);
    if (!endTime) continue;

    // Filter by market window duration (e.g., only 15m markets for 15m mode)
    if (targetWindowMinutes && startTime) {
      const windowMin = (endTime.getTime() - startTime.getTime()) / 60_000;
      if (Math.abs(windowMin - targetWindowMinutes) > 2) continue;
    }

    const minutesLeft = (endTime.getTime() - Date.now()) / 60_000;
    if (minutesLeft < minMinutes || minutesLeft > maxMinutes) continue;

    // Parse token IDs
    let tokenIds: string[];
    try {
      tokenIds = JSON.parse(gm.clobTokenIds || '[]');
    } catch {
      continue;
    }
    if (tokenIds.length < 2) continue;

    // Only keep the soonest-expiring market per asset
    const existing = found.get(detected.asset);
    if (existing && existing.endTime.getTime() <= endTime.getTime()) continue;

    // Extract strike price from question (e.g., "$97,500")
    const strikeMatch = gm.question.match(/\$([\d,]+(?:\.\d+)?)/);
    let strikePrice = strikeMatch ? parseFloat(strikeMatch[1].replace(/,/g, '')) : null;
    if (strikePrice !== null && !Number.isFinite(strikePrice)) strikePrice = null;

    // For "Up or Down" markets with no explicit strike, use Binance opening price
    if (strikePrice === null) {
      if (startTime && startTime.getTime() <= Date.now()) {
        try {
          const openPrice = await getHistoricalPrice(detected.symbol, startTime.getTime());
          if (openPrice !== null) strikePrice = openPrice;
        } catch {
          // No target price available
        }
      }
    }

    found.set(detected.asset, {
      conditionId: gm.conditionId,
      question: gm.question,
      yesTokenId: tokenIds[0],
      noTokenId: tokenIds[1],
      endTime,
      cryptoAsset: detected.asset as CryptoAsset,
      bestBid: null,
      bestAsk: null,
      midpoint: null,
      yesHeld: 0,
      noHeld: 0,
      bidOrderId: null,
      askOrderId: null,
      bidPrice: null,
      askPrice: null,
      yesFillTime: null,
      noFillTime: null,
      yesEntryPrice: null,
      noEntryPrice: null,
      negRisk: gm.negRisk ?? true,
      strikePrice,
    });
  }

  return [...found.values()];
}
