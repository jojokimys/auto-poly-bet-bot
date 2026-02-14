import 'server-only';

import { fetchMarkets, fetchEvents } from '@/lib/polymarket/gamma';
import { getEnv } from '@/lib/config/env';
import { getBtcPrice, getCryptoPrice, type CryptoSymbol } from '@/lib/polymarket/binance';
import type { GammaMarket } from '@/lib/types/polymarket';
import type { BotConfig, ScoredOpportunity } from './types';
import { trackGammaCall } from './api-tracker';

// ─── CLOB Order Book Helper ─────────────────────────────

interface OrderBookLevel {
  price: string;
  size: string;
}

interface OrderBookResponse {
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
}

/**
 * Fetch CLOB order book for a given token ID.
 * Returns best ask price and dollar depth at best ask.
 */
async function fetchOrderBook(
  tokenId: string,
): Promise<{ bestAsk: number; askDepth: number } | null> {
  try {
    const clobUrl = getEnv().CLOB_API_URL;
    const res = await fetch(`${clobUrl}/book?token_id=${tokenId}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;

    const book: OrderBookResponse = await res.json();
    if (!book.asks || book.asks.length === 0) return null;

    // Asks are sorted ascending by price
    const bestAsk = parseFloat(book.asks[0].price);
    // Calculate dollar depth at best ask level
    let askDepth = 0;
    for (const level of book.asks) {
      if (parseFloat(level.price) > bestAsk + 0.01) break; // within 1c of best
      askDepth += parseFloat(level.price) * parseFloat(level.size);
    }

    return { bestAsk, askDepth };
  } catch {
    return null;
  }
}

/**
 * Score a market for trading opportunity.
 * Adapted from scripts/market-scanner.ts to use lib modules.
 */
function scoreMarket(gm: GammaMarket): ScoredOpportunity | null {
  const volume24hr = parseFloat(gm.volume24hr || '0');
  const liquidity = parseFloat(gm.liquidity) || 0;
  const spread = parseFloat(gm.spread || '0');

  let yesPrice = 0;
  let noPrice = 0;
  let outcomes: string[] = [];
  let tokenIds: string[] = [];

  try {
    const prices: number[] = JSON.parse(gm.outcomePrices || '[]');
    outcomes = JSON.parse(gm.outcomes || '[]');
    tokenIds = JSON.parse(gm.clobTokenIds || '[]');
    yesPrice = prices[0] || 0;
    noPrice = prices[1] || 0;
  } catch {
    return null;
  }

  if (yesPrice === 0 && noPrice === 0) return null;
  if (outcomes.length < 2 || tokenIds.length < 2) return null;

  const dislocation = Math.abs(yesPrice - 0.5);

  const endDate = new Date(gm.endDate);
  const hoursToExpiry = Math.max(
    0,
    (endDate.getTime() - Date.now()) / (1000 * 60 * 60)
  );

  // Scoring formula (same as scripts/market-scanner.ts):
  let score = 0;

  // Volume score (log scale, 0-30 pts)
  score += Math.min(30, Math.log10(Math.max(1, volume24hr)) * 6);

  // Liquidity score (0-20 pts)
  score += Math.min(20, Math.log10(Math.max(1, liquidity)) * 4);

  // Spread score (tighter = better, 0-20 pts)
  const spreadPenalty = Math.min(20, spread * 200);
  score += 20 - spreadPenalty;

  // Dislocation score (moderate preferred, 0-15 pts)
  if (dislocation >= 0.05 && dislocation <= 0.35) {
    score += 15 * (1 - Math.abs(dislocation - 0.2) / 0.2);
  }

  // Time decay score (0-15 pts)
  if (hoursToExpiry > 24 && hoursToExpiry < 720) {
    score += 15;
  } else if (hoursToExpiry > 6 && hoursToExpiry <= 24) {
    score += 10;
  } else if (hoursToExpiry >= 720 && hoursToExpiry < 2160) {
    score += 8;
  }

  // Determine the favored outcome (higher probability side)
  const favoredIdx = yesPrice >= noPrice ? 0 : 1;

  return {
    conditionId: gm.conditionId,
    question: gm.question,
    tokenId: tokenIds[favoredIdx],
    outcome: outcomes[favoredIdx],
    price: favoredIdx === 0 ? yesPrice : noPrice,
    yesPrice,
    noPrice,
    volume24hr,
    liquidity,
    spread,
    dislocation,
    hoursToExpiry,
    score,
  };
}

/**
 * Scan markets and return scored opportunities filtered by bot config thresholds.
 */
export async function scanMarkets(
  config: BotConfig,
  limit = 100
): Promise<ScoredOpportunity[]> {
  trackGammaCall();
  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit,
    order: 'volume24hr',
    ascending: false,
  });

  const scored: ScoredOpportunity[] = [];

  for (const gm of gammaMarkets) {
    const opp = scoreMarket(gm);
    if (!opp) continue;

    // Apply config filters
    if (opp.liquidity < config.minLiquidity) continue;
    if (opp.volume24hr < config.minVolume) continue;
    if (opp.spread > config.maxSpread) continue;
    if (opp.score < config.minScore) continue;

    // Skip markets expiring in < 6 hours (too risky)
    if (opp.hoursToExpiry < 6) continue;

    scored.push(opp);
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored;
}

/**
 * Scan specifically for near-expiry sniper opportunities.
 * Differs from the value-betting scanner:
 *   - Includes markets with hoursToExpiry 1-72 (scanner excludes <6)
 *   - Includes prices 0.90-0.97 (value-betting excludes >0.85)
 *   - Lower liquidity/volume thresholds (we're taking small positions)
 *   - Sorted by end date ascending (soonest-expiring first)
 */
export async function scanNearExpiryMarkets(
  config: BotConfig,
  limit = 100
): Promise<ScoredOpportunity[]> {
  trackGammaCall();
  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit,
    order: 'endDate',
    ascending: true,
  });

  const scored: ScoredOpportunity[] = [];

  for (const gm of gammaMarkets) {
    const opp = scoreMarket(gm);
    if (!opp) continue;

    // Near-expiry specific filters (tightened based on accuracy research)
    if (opp.hoursToExpiry < 1 || opp.hoursToExpiry > 8) continue;
    if (opp.price < 0.90 || opp.price > 0.94) continue;
    if (opp.liquidity < 2000) continue;
    if (opp.volume24hr < 5000) continue;
    if (opp.spread > 0.02) continue;

    scored.push(opp);
  }

  // Sort by hours to expiry (most urgent first), then by score
  scored.sort((a, b) => {
    if (Math.abs(a.hoursToExpiry - b.hoursToExpiry) > 2) {
      return a.hoursToExpiry - b.hoursToExpiry;
    }
    return b.score - a.score;
  });

  return scored;
}

/**
 * Scan specifically for micro-scalp opportunities.
 * Targets markets expiring in 5-60 minutes with high-probability outcomes (93-97c).
 *   - Sorted by end date ascending (most urgent first)
 *   - Filters: 5-60 min to expiry, price 93-97c, liquidity ≥$2000, volume ≥$5000, spread ≤2c
 */
export async function scanMicroScalpMarkets(
  _config: BotConfig,
  limit = 100
): Promise<ScoredOpportunity[]> {
  trackGammaCall();
  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit,
    order: 'endDate',
    ascending: true,
  });

  const scored: ScoredOpportunity[] = [];

  for (const gm of gammaMarkets) {
    const opp = scoreMarket(gm);
    if (!opp) continue;

    // Micro-scalp filters (broad pass — strategy does tier-specific filtering)
    const minutesToExpiry = opp.hoursToExpiry * 60;
    if (minutesToExpiry < 5 || minutesToExpiry > 60) continue;
    if (opp.price < 0.93 || opp.price > 0.97) continue;
    if (opp.liquidity < 2000) continue;
    if (opp.volume24hr < 5000) continue;
    if (opp.spread > 0.02) continue;

    scored.push(opp);
  }

  // Sort by minutes to expiry (most urgent first)
  scored.sort((a, b) => a.hoursToExpiry - b.hoursToExpiry);

  return scored;
}

/**
 * Scan for complement arb opportunities.
 * Fetches CLOB order books for both YES and NO tokens,
 * looking for combined ask < $0.975 (guaranteed profit after fees).
 */
export async function scanComplementArbMarkets(
  _config: BotConfig,
  limit = 100,
): Promise<ScoredOpportunity[]> {
  trackGammaCall();
  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit,
    order: 'volume24hr',
    ascending: false,
  });

  const scored: ScoredOpportunity[] = [];

  for (const gm of gammaMarkets) {
    const opp = scoreMarket(gm);
    if (!opp) continue;

    // Must be a binary market with 2 tokens
    let tokenIds: string[] = [];
    try {
      tokenIds = JSON.parse(gm.clobTokenIds || '[]');
    } catch {
      continue;
    }
    if (tokenIds.length < 2) continue;

    const yesTokenId = tokenIds[0];
    const noTokenId = tokenIds[1];

    // Fetch order books for both sides
    const [yesBook, noBook] = await Promise.all([
      fetchOrderBook(yesTokenId),
      fetchOrderBook(noTokenId),
    ]);

    if (!yesBook || !noBook) continue;

    // Filter: combined ask must be < $0.975
    if (yesBook.bestAsk + noBook.bestAsk >= 0.975) continue;

    // Filter: sufficient depth on both sides (≥$50)
    if (yesBook.askDepth < 50 || noBook.askDepth < 50) continue;

    scored.push({
      ...opp,
      yesTokenId,
      noTokenId,
      yesBestAsk: yesBook.bestAsk,
      noBestAsk: noBook.bestAsk,
      askDepthYes: yesBook.askDepth,
      askDepthNo: noBook.askDepth,
    });
  }

  // Sort by combined cost ascending (cheapest = most profitable first)
  scored.sort((a, b) => {
    const costA = (a.yesBestAsk ?? 1) + (a.noBestAsk ?? 1);
    const costB = (b.yesBestAsk ?? 1) + (b.noBestAsk ?? 1);
    return costA - costB;
  });

  return scored;
}

/**
 * Scan for panic reversal opportunities.
 * Targets high-volume active markets where prices might dip.
 * The strategy itself handles drop detection via price history.
 */
export async function scanPanicReversalMarkets(
  _config: BotConfig,
  limit = 100,
): Promise<ScoredOpportunity[]> {
  trackGammaCall();
  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit,
    order: 'volume24hr',
    ascending: false,
  });

  const scored: ScoredOpportunity[] = [];

  for (const gm of gammaMarkets) {
    const opp = scoreMarket(gm);
    if (!opp) continue;

    // Broad pass — strategy does the hard filtering with price history
    if (opp.price < 0.50 || opp.price > 0.90) continue;
    if (opp.volume24hr < 10000) continue;
    if (opp.liquidity < 5000) continue;

    scored.push(opp);
  }

  // Sort by volume descending (highest activity = most likely to have panic events)
  scored.sort((a, b) => b.volume24hr - a.volume24hr);

  return scored;
}

// Crypto keyword patterns for market question matching
const CRYPTO_KEYWORDS = /\b(btc|bitcoin|crypto)\b/i;

/**
 * Scan for crypto latency arb opportunities.
 * Finds short-duration crypto markets and compares with Binance spot price.
 */
export async function scanCryptoLatencyMarkets(
  _config: BotConfig,
  limit = 100,
): Promise<ScoredOpportunity[]> {
  trackGammaCall();
  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit,
    order: 'endDate',
    ascending: true,
  });

  // Fetch Binance BTC price once
  let btcPrice: number;
  try {
    btcPrice = await getBtcPrice();
  } catch {
    return []; // Can't proceed without spot price
  }

  const scored: ScoredOpportunity[] = [];

  for (const gm of gammaMarkets) {
    // Must match crypto keywords
    if (!CRYPTO_KEYWORDS.test(gm.question)) continue;

    const opp = scoreMarket(gm);
    if (!opp) continue;

    // Must be short-duration (< 1 hour to expiry)
    if (opp.hoursToExpiry > 1) continue;
    // Must have at least 2 minutes remaining
    if (opp.hoursToExpiry * 60 < 2) continue;

    // Extract token IDs for directional trading
    let tokenIds: string[] = [];
    try {
      tokenIds = JSON.parse(gm.clobTokenIds || '[]');
    } catch {
      continue;
    }
    if (tokenIds.length < 2) continue;

    // Try to extract opening price from question (e.g., "Will BTC be above $97,500 at 3:00 PM?")
    const priceMatch = gm.question.match(/\$?([\d,]+(?:\.\d+)?)/);
    const openingPrice = priceMatch
      ? parseFloat(priceMatch[1].replace(/,/g, ''))
      : 0;

    scored.push({
      ...opp,
      yesTokenId: tokenIds[0],
      noTokenId: tokenIds[1],
      spotPrice: btcPrice,
      openingPrice,
    });
  }

  // Sort by time remaining ascending (most urgent first)
  scored.sort((a, b) => a.hoursToExpiry - b.hoursToExpiry);

  return scored;
}

/**
 * Scan for multi-outcome bundle arb opportunities.
 * Fetches events with 3+ markets (winner-take-all), checks if buying
 * one YES share of each outcome costs less than $0.98 (guaranteed profit).
 */
export async function scanMultiOutcomeArbMarkets(
  _config: BotConfig,
  limit = 50,
): Promise<ScoredOpportunity[]> {
  trackGammaCall();
  const events = await fetchEvents({
    active: true,
    closed: false,
    limit,
    order: 'volume',
    ascending: false,
  });

  const scored: ScoredOpportunity[] = [];

  for (const event of events) {
    // Must have 3+ markets (multi-outcome)
    const activeMarkets = event.markets.filter((m) => m.active && !m.closed);
    if (activeMarkets.length < 3) continue;

    // Parse each market's YES price and token ID
    const legs: {
      conditionId: string;
      question: string;
      yesTokenId: string;
      yesGammaPrice: number;
      volume24hr: number;
      liquidity: number;
    }[] = [];

    let gammaSum = 0;
    let validEvent = true;

    for (const gm of activeMarkets) {
      try {
        const prices: number[] = JSON.parse(gm.outcomePrices || '[]');
        const tokenIds: string[] = JSON.parse(gm.clobTokenIds || '[]');
        const outcomes: string[] = JSON.parse(gm.outcomes || '[]');

        if (prices.length < 1 || tokenIds.length < 1 || outcomes.length < 1) {
          validEvent = false;
          break;
        }

        const yesPrice = prices[0] || 0;
        gammaSum += yesPrice;

        legs.push({
          conditionId: gm.conditionId,
          question: gm.question,
          yesTokenId: tokenIds[0],
          yesGammaPrice: yesPrice,
          volume24hr: parseFloat(gm.volume24hr || '0'),
          liquidity: parseFloat(gm.liquidity || '0'),
        });
      } catch {
        validEvent = false;
        break;
      }
    }

    if (!validEvent || legs.length < 3) continue;

    // Validate winner-take-all: sum of YES prices should be roughly 0.85-1.15
    if (gammaSum < 0.85 || gammaSum > 1.15) continue;

    // Quick check: if Gamma sum already >= 0.975, CLOB asks won't be cheaper
    // (Gamma prices are usually mid-market; asks are higher)
    // Skip this check to be safe — CLOB asks can sometimes be lower than Gamma mid
    // Just proceed to fetch order books

    // Fetch CLOB order books for all YES tokens in parallel
    const bookResults = await Promise.all(
      legs.map((leg) => fetchOrderBook(leg.yesTokenId)),
    );

    // Check that all books are available
    const allBooksValid = bookResults.every((b) => b !== null);
    if (!allBooksValid) continue;

    const books = bookResults as { bestAsk: number; askDepth: number }[];

    // Sum all YES best asks
    const bundleCost = books.reduce((sum, b) => sum + b.bestAsk, 0);

    // Must be under $0.975 for profitable arb (net 0.5c+ after 2% winner fee)
    if (bundleCost >= 0.975) continue;

    // Every leg must have at least $25 ask depth
    if (books.some((b) => b.askDepth < 25)) continue;

    // Build bundle legs data
    const bundleLegs = legs.map((leg, i) => ({
      tokenId: leg.yesTokenId,
      outcome: 'Yes',
      marketQuestion: leg.question,
      bestAsk: books[i].bestAsk,
      askDepth: books[i].askDepth,
    }));

    // Total event volume and liquidity
    const totalVolume = legs.reduce((s, l) => s + l.volume24hr, 0);
    const totalLiquidity = legs.reduce((s, l) => s + l.liquidity, 0);

    // Use the first market as the "primary" for ScoredOpportunity compatibility
    const primary = legs[0];

    scored.push({
      conditionId: primary.conditionId,
      question: event.title,
      tokenId: primary.yesTokenId,
      outcome: 'Yes',
      price: books[0].bestAsk,
      yesPrice: primary.yesGammaPrice,
      noPrice: 1 - primary.yesGammaPrice,
      volume24hr: totalVolume,
      liquidity: totalLiquidity,
      spread: 0,
      dislocation: 0,
      hoursToExpiry: 0,
      score: 0, // Strategy will compute its own score
      bundleEventId: event.id,
      bundleEventTitle: event.title,
      bundleLegs,
      bundleCost,
    });
  }

  // Sort by bundle cost ascending (cheapest = most profitable)
  scored.sort((a, b) => (a.bundleCost ?? 1) - (b.bundleCost ?? 1));

  return scored;
}

// ─── Crypto Scalper Scanner ──────────────────────────────

/** Maps question keywords to Binance symbols */
const CRYPTO_ASSET_MAP: { pattern: RegExp; symbol: CryptoSymbol; asset: string }[] = [
  { pattern: /\b(btc|bitcoin)\b/i, symbol: 'BTCUSDT', asset: 'BTC' },
  { pattern: /\b(eth|ethereum)\b/i, symbol: 'ETHUSDT', asset: 'ETH' },
  { pattern: /\b(sol|solana)\b/i, symbol: 'SOLUSDT', asset: 'SOL' },
  { pattern: /\bxrp\b/i, symbol: 'XRPUSDT', asset: 'XRP' },
];

function detectCryptoAsset(question: string): { symbol: CryptoSymbol; asset: string } | null {
  for (const entry of CRYPTO_ASSET_MAP) {
    if (entry.pattern.test(question)) {
      return { symbol: entry.symbol, asset: entry.asset };
    }
  }
  return null;
}

function extractStrikePrice(question: string): number | null {
  const match = question.match(/\$?([\d,]+(?:\.\d+)?)/);
  return match ? parseFloat(match[1].replace(/,/g, '')) : null;
}

/**
 * Scan for crypto scalper (dislocation) opportunities.
 * Broad sweep of crypto markets across BTC, ETH, SOL, XRP.
 * Attaches spot price and detected crypto asset for the strategy.
 */
export async function scanCryptoScalperMarkets(
  _config: BotConfig,
  limit = 100,
): Promise<ScoredOpportunity[]> {
  trackGammaCall();
  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit,
    order: 'endDate',
    ascending: true,
  });

  // Group markets by asset, fetch spot prices once per asset
  const spotPrices = new Map<CryptoSymbol, number>();

  const scored: ScoredOpportunity[] = [];

  for (const gm of gammaMarkets) {
    const detected = detectCryptoAsset(gm.question);
    if (!detected) continue;

    const opp = scoreMarket(gm);
    if (!opp) continue;

    // Expiry: 2 min to 60 min range
    const minutesToExpiry = opp.hoursToExpiry * 60;
    if (minutesToExpiry < 2 || minutesToExpiry > 60) continue;

    // Extract token IDs
    let tokenIds: string[] = [];
    try {
      tokenIds = JSON.parse(gm.clobTokenIds || '[]');
    } catch {
      continue;
    }
    if (tokenIds.length < 2) continue;

    // Fetch spot price (cached per symbol)
    if (!spotPrices.has(detected.symbol)) {
      try {
        const price = await getCryptoPrice(detected.symbol);
        spotPrices.set(detected.symbol, price);
      } catch {
        continue; // Skip if price fetch fails
      }
    }
    const spotPrice = spotPrices.get(detected.symbol)!;

    const strikePrice = extractStrikePrice(gm.question);

    scored.push({
      ...opp,
      yesTokenId: tokenIds[0],
      noTokenId: tokenIds[1],
      spotPrice,
      openingPrice: strikePrice ?? 0,
      cryptoAsset: detected.asset,
    });
  }

  // Sort by time remaining ascending (most urgent first)
  scored.sort((a, b) => a.hoursToExpiry - b.hoursToExpiry);

  return scored;
}
