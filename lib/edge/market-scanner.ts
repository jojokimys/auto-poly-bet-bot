/**
 * Market Scanner — finds active 5-minute crypto Up/Down markets on Polymarket.
 *
 * Polymarket runs rolling 5-minute binary options for BTC, ETH, SOL, XRP:
 *   "Bitcoin Up or Down - March 10, 9:40PM-9:45PM ET"
 *   Resolves "Up" if Chainlink price at end >= price at start.
 *
 * Slug pattern: {asset}-updown-5m-{unix_start_timestamp}
 * New markets created every 5 minutes, 24/7.
 *
 * Resolution source: Chainlink BTC/USD data stream (NOT Binance).
 *
 * IMPORTANT: The Gamma API's `active=true` query returns future-scheduled
 * markets, not necessarily the currently running window. We must query
 * by exact slug to get the current 5-minute window.
 */

import 'server-only';

import { fetchEvents } from '@/lib/polymarket/gamma';
import type { CryptoAsset } from '@/lib/trading-types';

// ─── Types ─────────────────────────────────────────────

export interface UpDownMarket {
  /** Polymarket condition ID */
  conditionId: string;
  /** Crypto asset */
  asset: CryptoAsset;
  /** "Up" token ID (wins if price goes up) */
  upTokenId: string;
  /** "Down" token ID (wins if price goes down) */
  downTokenId: string;
  /** Window start timestamp (ms) */
  startMs: number;
  /** Window end timestamp (ms) — 5 min after start */
  endMs: number;
  /** Current Up price (0-1) */
  upPrice: number;
  /** Current Down price (0-1) */
  downPrice: number;
  /** Market slug */
  slug: string;
  /** Market question */
  question: string;
}

// ─── Asset Config ──────────────────────────────────────

const ASSET_SLUGS: Record<CryptoAsset, string> = {
  BTC: 'btc',
  ETH: 'eth',
  SOL: 'sol',
  XRP: 'xrp',
};

const FIVE_MIN_MS = 5 * 60 * 1000;

// ─── Scanner ───────────────────────────────────────────

/**
 * Scan for currently active 5-minute Up/Down markets.
 *
 * Strategy: Calculate the current and next 5-min window timestamps,
 * then query Gamma API by exact slug for each asset × window.
 * This is reliable because the Gamma broad query doesn't return
 * currently-running windows at the top of results.
 *
 * @param assets - which crypto assets to scan (default: all 4)
 */
export async function scanUpDownMarkets(
  assets: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'],
): Promise<UpDownMarket[]> {
  const now = Date.now();
  const nowUnix = Math.floor(now / 1000);

  // Current window: floor to 5-min boundary
  const currentStart = Math.floor(nowUnix / 300) * 300;
  // Next window
  const nextStart = currentStart + 300;

  // Build slugs for current + next window, per asset
  const slugs: { slug: string; startUnix: number; asset: CryptoAsset }[] = [];
  for (const asset of assets) {
    const assetSlug = ASSET_SLUGS[asset];
    slugs.push({ slug: `${assetSlug}-updown-5m-${currentStart}`, startUnix: currentStart, asset });
    slugs.push({ slug: `${assetSlug}-updown-5m-${nextStart}`, startUnix: nextStart, asset });
  }

  // Fetch all slugs in parallel
  const results: UpDownMarket[] = [];
  const fetches = slugs.map(async ({ slug, startUnix, asset }) => {
    try {
      const events = await fetchEvents({ slug });
      if (!events || events.length === 0) return;

      const event = events[0];
      for (const market of event.markets) {
        // Parse token IDs
        let tokenIds: string[];
        try {
          tokenIds = JSON.parse(market.clobTokenIds || '[]');
        } catch { continue; }
        if (tokenIds.length < 2) continue;

        // Parse outcomes
        let outcomes: string[];
        try {
          outcomes = JSON.parse(market.outcomes || '[]');
        } catch { continue; }

        const upIdx = outcomes.findIndex(o => o.toLowerCase() === 'up');
        const downIdx = outcomes.findIndex(o => o.toLowerCase() === 'down');
        if (upIdx === -1 || downIdx === -1) continue;

        // Parse prices
        let prices: number[];
        try {
          prices = JSON.parse(market.outcomePrices || '[]').map(Number);
        } catch { prices = [0.5, 0.5]; }

        const startMs = startUnix * 1000;
        const endMs = startMs + FIVE_MIN_MS;

        // Skip already expired windows
        if (endMs <= now) continue;

        results.push({
          conditionId: market.conditionId,
          asset,
          upTokenId: tokenIds[upIdx],
          downTokenId: tokenIds[downIdx],
          startMs,
          endMs,
          upPrice: prices[upIdx] ?? 0.5,
          downPrice: prices[downIdx] ?? 0.5,
          slug,
          question: market.question || event.title,
        });
      }
    } catch (err) {
      // Silently skip — market may not exist yet
    }
  });

  await Promise.all(fetches);

  // Sort by end time (soonest first)
  results.sort((a, b) => a.endMs - b.endMs);

  console.log(`[scanner] Found ${results.length} active 5m Up/Down markets`);
  for (const m of results.slice(0, 8)) {
    const secsLeft = Math.round((m.endMs - now) / 1000);
    console.log(`  ${m.asset} ${secsLeft}s left | Up=${m.upPrice.toFixed(3)} Down=${m.downPrice.toFixed(3)} | ${m.slug}`);
  }

  return results;
}

/**
 * Get the next upcoming 5m market slug for an asset.
 * Useful for pre-subscribing to orderbook before market opens.
 *
 * 5m markets start at every :00, :05, :10, :15, :20, :25, :30, :35, :40, :45, :50, :55
 */
export function getNext5mSlug(asset: CryptoAsset): { slug: string; startMs: number; endMs: number } {
  const now = Date.now();
  const assetSlug = ASSET_SLUGS[asset];

  // Round up to next 5-minute boundary
  const nextStart = Math.ceil(now / FIVE_MIN_MS) * FIVE_MIN_MS;
  const nextEnd = nextStart + FIVE_MIN_MS;
  const startUnix = Math.floor(nextStart / 1000);

  return {
    slug: `${assetSlug}-updown-5m-${startUnix}`,
    startMs: nextStart,
    endMs: nextEnd,
  };
}
