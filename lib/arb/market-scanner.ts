/**
 * Market scanner — finds active BTC 5m/15m Up/Down markets on Polymarket.
 *
 * Slug pattern: {asset}-updown-{duration}-{unix_start}
 * Example: btc-updown-5m-1710288000
 *
 * Market structure: Single market per event with outcomes ["Up", "Down"].
 * Token 0 = Up (Yes), Token 1 = Down (Yes).
 */

import { fetchEvents } from '@/lib/polymarket/gamma';
import type { GammaEvent, GammaMarket } from '@/lib/types/polymarket';

export interface ActiveMarket {
  eventId: string;
  eventSlug: string;
  direction: 'Up' | 'Down';
  conditionId: string;
  tokenId: string;
  question: string;
  endDate: Date;
}

export interface MarketWindow {
  event: GammaEvent;
  /** Two entries: one for Up, one for Down — same conditionId, different tokenIds */
  markets: ActiveMarket[];
  startTime: number; // unix ms
  endTime: number;   // unix ms
  duration: '5m' | '15m';
}

/**
 * Scan for the current active BTC up/down market window.
 */
export async function scanCurrentWindow(duration: '5m' | '15m' = '5m'): Promise<MarketWindow | null> {
  const now = Date.now();
  const durationSec = duration === '5m' ? 300 : 900;

  const windowStart = Math.floor(now / 1000 / durationSec) * durationSec;
  const slug = `btc-updown-${duration}-${windowStart}`;

  try {
    const events = await fetchEvents({ slug, active: true, limit: 1 });
    if (events.length === 0) {
      console.log(`[scanner] No event for slug: ${slug}`);
      return null;
    }

    const event = events[0];
    return parseEventToWindow(event, duration, windowStart);
  } catch (err) {
    console.error(`[scanner] Failed to fetch window ${slug}:`, err);
    return null;
  }
}

/**
 * Scan for upcoming windows (next 1-2 windows ahead).
 */
export async function scanUpcomingWindows(duration: '5m' | '15m' = '5m', count = 2): Promise<MarketWindow[]> {
  const now = Date.now();
  const durationSec = duration === '5m' ? 300 : 900;
  const currentWindowStart = Math.floor(now / 1000 / durationSec) * durationSec;

  const windows: MarketWindow[] = [];

  for (let i = 0; i <= count; i++) {
    const windowStart = currentWindowStart + i * durationSec;
    const slug = `btc-updown-${duration}-${windowStart}`;

    try {
      const events = await fetchEvents({ slug, active: true, limit: 1 });
      if (events.length > 0) {
        const w = parseEventToWindow(events[0], duration, windowStart);
        if (w) windows.push(w);
      }
    } catch {
      // skip this window
    }
  }

  return windows;
}

function parseEventToWindow(event: GammaEvent, duration: '5m' | '15m', windowStart: number): MarketWindow | null {
  const durationSec = duration === '5m' ? 300 : 900;
  const markets: ActiveMarket[] = [];

  for (const m of event.markets) {
    const parsed = parseMarket(m, event.id, event.slug);
    markets.push(...parsed);
  }

  if (markets.length === 0) {
    console.log(`[scanner] No parseable markets in event: ${event.slug}`);
    return null;
  }

  return {
    event,
    markets,
    startTime: windowStart * 1000,
    endTime: (windowStart + durationSec) * 1000,
    duration,
  };
}

/**
 * Parse a single Gamma market into Up + Down ActiveMarket entries.
 *
 * Polymarket structure:
 *   outcomes: '["Up", "Down"]'
 *   clobTokenIds: '["<upTokenId>", "<downTokenId>"]'
 *
 * Token 0 = Up outcome, Token 1 = Down outcome.
 */
function parseMarket(m: GammaMarket, eventId: string, eventSlug: string): ActiveMarket[] {
  let outcomes: string[];
  let tokenIds: string[];
  try {
    outcomes = JSON.parse(m.outcomes);
    tokenIds = JSON.parse(m.clobTokenIds);
  } catch {
    return [];
  }

  if (outcomes.length < 2 || tokenIds.length < 2) return [];

  const result: ActiveMarket[] = [];

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    let direction: 'Up' | 'Down';

    if (outcome.toLowerCase() === 'up') direction = 'Up';
    else if (outcome.toLowerCase() === 'down') direction = 'Down';
    else continue;

    result.push({
      eventId,
      eventSlug,
      direction,
      conditionId: m.conditionId,
      tokenId: tokenIds[i],
      question: m.question,
      endDate: new Date(m.endDate),
    });
  }

  return result;
}

/**
 * Extract strike price from event description or title.
 * The strike is the BTC price at the start of the window.
 * If not found, returns null (caller must use live snapshot).
 */
export function extractStrikePrice(event: GammaEvent): number | null {
  // Try parsing from description: "... starting price of $91,234.56 ..."
  const match = event.description?.match(/starting price of \$?([\d,]+\.?\d*)/i);
  if (match) {
    return parseFloat(match[1].replace(/,/g, ''));
  }
  return null;
}
