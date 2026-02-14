import 'server-only';

import { fetchMarkets, fetchEvents } from '@/lib/polymarket/gamma';
import { getEnv } from '@/lib/config/env';
import { getCryptoPrice, type CryptoSymbol } from '@/lib/polymarket/binance';
import type { GammaMarket } from '@/lib/types/polymarket';
import type { ExploreData, Opportunity } from './types';

// ─── Helpers ────────────────────────────────────────────

interface OrderBookLevel { price: string; size: string }
interface OrderBookResponse { asks: OrderBookLevel[]; bids: OrderBookLevel[] }

async function fetchOrderBook(tokenId: string): Promise<{ bestAsk: number; askDepth: number } | null> {
  try {
    const clobUrl = getEnv().CLOB_API_URL;
    const res = await fetch(`${clobUrl}/book?token_id=${tokenId}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const book: OrderBookResponse = await res.json();
    if (!book.asks || book.asks.length === 0) return null;
    const bestAsk = parseFloat(book.asks[0].price);
    let askDepth = 0;
    for (const level of book.asks) {
      if (parseFloat(level.price) > bestAsk + 0.01) break;
      askDepth += parseFloat(level.price) * parseFloat(level.size);
    }
    return { bestAsk, askDepth };
  } catch {
    return null;
  }
}

function parseMarket(gm: GammaMarket) {
  try {
    const rawPrices: (string | number)[] = JSON.parse(gm.outcomePrices || '[]');
    const outcomes: string[] = JSON.parse(gm.outcomes || '[]');
    const tokenIds: string[] = JSON.parse(gm.clobTokenIds || '[]');
    if (rawPrices.length < 2 || outcomes.length < 2 || tokenIds.length < 2) return null;
    const yesPrice = parseFloat(String(rawPrices[0])) || 0;
    const noPrice = parseFloat(String(rawPrices[1])) || 0;
    if (yesPrice === 0 && noPrice === 0) return null;
    const endDate = new Date(gm.endDate);
    const hoursToExpiry = Math.max(0, (endDate.getTime() - Date.now()) / (1000 * 60 * 60));
    return {
      conditionId: gm.conditionId, question: gm.question,
      yesPrice, noPrice, tokenIds, outcomes,
      volume24hr: parseFloat(gm.volume24hr || '0'),
      liquidity: parseFloat(gm.liquidity || '0'),
      spread: parseFloat(gm.spread || '0'),
      hoursToExpiry,
    };
  } catch { return null; }
}

const CRYPTO_ASSET_MAP: { pattern: RegExp; symbol: CryptoSymbol; asset: string }[] = [
  { pattern: /\b(btc|bitcoin)\b/i, symbol: 'BTCUSDT', asset: 'BTC' },
  { pattern: /\b(eth|ethereum)\b/i, symbol: 'ETHUSDT', asset: 'ETH' },
  { pattern: /\b(sol|solana)\b/i, symbol: 'SOLUSDT', asset: 'SOL' },
  { pattern: /\bxrp\b/i, symbol: 'XRPUSDT', asset: 'XRP' },
];

// ─── Opportunity Scanners ───────────────────────────────

async function findNearExpiryOpps(markets: GammaMarket[]): Promise<Opportunity[]> {
  const opps: Opportunity[] = [];
  for (const gm of markets) {
    const m = parseMarket(gm);
    if (!m) continue;
    if (m.hoursToExpiry < 1 || m.hoursToExpiry > 8) continue;
    if (m.yesPrice < 0.90 || m.yesPrice > 0.94) continue;
    if (m.liquidity < 2000 || m.volume24hr < 5000 || m.spread > 0.02) continue;

    opps.push({
      type: 'near-expiry',
      conditionId: m.conditionId,
      question: m.question,
      signal: 'BUY',
      tokenId: m.tokenIds[0],
      outcome: m.outcomes[0],
      suggestedPrice: m.yesPrice,
      suggestedSize: 5,
      expectedProfit: (1 - m.yesPrice) * 5 * 0.98,
      confidence: Math.round(70 + (m.yesPrice - 0.90) * 500),
      reasoning: `${m.outcomes[0]} @ ${m.yesPrice}c, expires in ${m.hoursToExpiry.toFixed(1)}h. High probability token near resolution.`,
      timeWindow: m.hoursToExpiry < 2 ? 'urgent' : 'hours',
      riskLevel: m.hoursToExpiry < 2 ? 'MEDIUM' : 'LOW',
      dataPoints: { yesPrice: m.yesPrice, hoursToExpiry: m.hoursToExpiry, liquidity: m.liquidity },
    });
  }
  return opps;
}

async function findComplementArbOpps(markets: GammaMarket[]): Promise<Opportunity[]> {
  const opps: Opportunity[] = [];

  for (const gm of markets) {
    const m = parseMarket(gm);
    if (!m || m.tokenIds.length < 2) continue;

    const [yesBook, noBook] = await Promise.all([
      fetchOrderBook(m.tokenIds[0]),
      fetchOrderBook(m.tokenIds[1]),
    ]);
    if (!yesBook || !noBook) continue;
    if (yesBook.bestAsk + noBook.bestAsk >= 0.975) continue;
    if (yesBook.askDepth < 50 || noBook.askDepth < 50) continue;

    const cost = yesBook.bestAsk + noBook.bestAsk;
    const profit = (1 - cost) * 5;

    opps.push({
      type: 'complement-arb',
      conditionId: m.conditionId,
      question: m.question,
      signal: 'BUY',
      tokenId: m.tokenIds[0],
      outcome: 'Yes+No bundle',
      suggestedPrice: yesBook.bestAsk,
      suggestedSize: 5,
      expectedProfit: profit * 0.98,
      confidence: Math.round(90 - (cost * 100 - 95) * 10),
      reasoning: `Yes ask ${yesBook.bestAsk} + No ask ${noBook.bestAsk} = ${cost.toFixed(4)}. Guaranteed profit of ${((1 - cost) * 100).toFixed(1)}c per share.`,
      timeWindow: 'minutes',
      riskLevel: 'LOW',
      dataPoints: {
        yesBestAsk: yesBook.bestAsk, noBestAsk: noBook.bestAsk,
        combinedCost: cost, yesDepth: yesBook.askDepth, noDepth: noBook.askDepth,
      },
    });
  }
  return opps;
}

async function findCryptoOpps(markets: GammaMarket[]): Promise<Opportunity[]> {
  const opps: Opportunity[] = [];
  const spotPrices = new Map<CryptoSymbol, number>();

  for (const gm of markets) {
    const detected = CRYPTO_ASSET_MAP.find(e => e.pattern.test(gm.question));
    if (!detected) continue;

    const m = parseMarket(gm);
    if (!m) continue;
    const minutesToExpiry = m.hoursToExpiry * 60;
    if (minutesToExpiry < 2 || minutesToExpiry > 60) continue;

    if (!spotPrices.has(detected.symbol)) {
      try {
        spotPrices.set(detected.symbol, await getCryptoPrice(detected.symbol));
      } catch { continue; }
    }
    const spotPrice = spotPrices.get(detected.symbol)!;

    const priceMatch = gm.question.match(/\$?([\d,]+(?:\.\d+)?)/);
    const strikePrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;

    if (strikePrice <= 0) continue;

    const pctFromStrike = ((spotPrice - strikePrice) / strikePrice) * 100;
    const isAbove = spotPrice > strikePrice;

    // Signal: if spot is above strike and YES is cheap, or below and NO is cheap
    let signal: 'BUY' | 'SELL' = 'BUY';
    let tokenId = m.tokenIds[0];
    let outcome = m.outcomes[0];
    let targetPrice = m.yesPrice;

    if (isAbove && m.yesPrice < 0.80) {
      signal = 'BUY';
      tokenId = m.tokenIds[0];
      outcome = 'Yes';
      targetPrice = m.yesPrice;
    } else if (!isAbove && m.noPrice < 0.80) {
      signal = 'BUY';
      tokenId = m.tokenIds[1];
      outcome = 'No';
      targetPrice = m.noPrice;
    } else {
      continue;
    }

    opps.push({
      type: 'crypto-latency',
      conditionId: m.conditionId,
      question: m.question,
      signal,
      tokenId,
      outcome,
      suggestedPrice: targetPrice,
      suggestedSize: 5,
      expectedProfit: (1 - targetPrice) * 5 * 0.98,
      confidence: Math.min(95, Math.round(50 + Math.abs(pctFromStrike) * 20)),
      reasoning: `${detected.asset} spot $${spotPrice.toFixed(2)} vs strike $${strikePrice}. ${pctFromStrike > 0 ? 'Above' : 'Below'} by ${Math.abs(pctFromStrike).toFixed(2)}%. ${outcome} token at ${targetPrice.toFixed(2)}c looks underpriced.`,
      timeWindow: minutesToExpiry < 10 ? 'urgent' : 'minutes',
      riskLevel: minutesToExpiry < 5 ? 'HIGH' : 'MEDIUM',
      dataPoints: { spotPrice, strikePrice, pctFromStrike, minutesToExpiry, asset: detected.asset },
    });
  }
  return opps;
}

async function findMultiOutcomeArbOpps(): Promise<Opportunity[]> {
  const opps: Opportunity[] = [];
  const events = await fetchEvents({
    active: true, closed: false, limit: 30, order: 'volume', ascending: false,
  });

  for (const event of events) {
    const activeMarkets = event.markets.filter(m => m.active && !m.closed);
    if (activeMarkets.length < 3) continue;

    const legs: { conditionId: string; question: string; yesTokenId: string; yesPrice: number }[] = [];
    let gammaSum = 0;
    let valid = true;

    for (const gm of activeMarkets) {
      try {
        const prices: number[] = JSON.parse(gm.outcomePrices || '[]');
        const tokenIds: string[] = JSON.parse(gm.clobTokenIds || '[]');
        if (prices.length < 1 || tokenIds.length < 1) { valid = false; break; }
        gammaSum += prices[0] || 0;
        legs.push({ conditionId: gm.conditionId, question: gm.question, yesTokenId: tokenIds[0], yesPrice: prices[0] || 0 });
      } catch { valid = false; break; }
    }

    if (!valid || legs.length < 3 || gammaSum < 0.85 || gammaSum > 1.15) continue;

    const books = await Promise.all(legs.map(l => fetchOrderBook(l.yesTokenId)));
    if (books.some(b => !b)) continue;

    const bundleCost = books.reduce((sum, b) => sum + b!.bestAsk, 0);
    if (bundleCost >= 0.975) continue;
    if (books.some(b => b!.askDepth < 25)) continue;

    opps.push({
      type: 'multi-outcome-arb',
      conditionId: legs[0].conditionId,
      question: event.title,
      signal: 'BUY',
      tokenId: legs[0].yesTokenId,
      outcome: 'Bundle (all YES)',
      suggestedPrice: books[0]!.bestAsk,
      suggestedSize: 5,
      expectedProfit: (1 - bundleCost) * 5 * 0.98,
      confidence: Math.round(95 - (bundleCost * 100 - 95) * 20),
      reasoning: `${legs.length}-outcome event "${event.title}": bundle cost ${bundleCost.toFixed(4)}. Guaranteed profit ${((1 - bundleCost) * 100).toFixed(1)}c/share.`,
      timeWindow: 'minutes',
      riskLevel: 'LOW',
      dataPoints: { bundleCost, legCount: legs.length, legs: legs.map((l, i) => ({ ...l, bestAsk: books[i]!.bestAsk })) },
    });
  }
  return opps;
}

// ─── Value-Betting Scanner ──────────────────────────────

function findValueBettingOpps(markets: GammaMarket[]): Opportunity[] {
  const opps: Opportunity[] = [];

  for (const gm of markets) {
    const m = parseMarket(gm);
    if (!m) continue;

    // Value-betting filters (from scanner.ts scoreMarket logic)
    if (m.hoursToExpiry < 6) continue;
    if (m.liquidity < 1000) continue;
    if (m.volume24hr < 5000) continue;
    if (m.spread > 0.05) continue;

    const dislocation = Math.abs(m.yesPrice - 0.5);

    // Score (simplified from scanner.ts)
    let score = 0;
    score += Math.min(30, Math.log10(Math.max(1, m.volume24hr)) * 6);
    score += Math.min(20, Math.log10(Math.max(1, m.liquidity)) * 4);
    score += 20 - Math.min(20, m.spread * 200);
    if (dislocation >= 0.05 && dislocation <= 0.35) {
      score += 15 * (1 - Math.abs(dislocation - 0.2) / 0.2);
    }
    if (m.hoursToExpiry > 24 && m.hoursToExpiry < 720) score += 15;
    else if (m.hoursToExpiry > 6 && m.hoursToExpiry <= 24) score += 10;

    if (score < 50) continue;

    // Pick the favored side
    const favoredIdx = m.yesPrice >= m.noPrice ? 0 : 1;
    const tokenId = m.tokenIds[favoredIdx];
    const outcome = m.outcomes[favoredIdx];
    const price = favoredIdx === 0 ? m.yesPrice : m.noPrice;

    // Skip extreme prices (not interesting for value)
    if (price < 0.15 || price > 0.85) continue;

    opps.push({
      type: 'value-betting',
      conditionId: m.conditionId,
      question: m.question,
      signal: 'BUY',
      tokenId,
      outcome,
      suggestedPrice: price,
      suggestedSize: 5,
      expectedProfit: (1 - price) * 5 * 0.98,
      confidence: Math.round(Math.min(85, 40 + score * 0.5)),
      reasoning: `Score ${score.toFixed(0)}: vol $${m.volume24hr.toFixed(0)}, liq $${m.liquidity.toFixed(0)}, spread ${(m.spread * 100).toFixed(1)}c. ${outcome} @ ${price.toFixed(2)} with ${m.hoursToExpiry.toFixed(0)}h to expiry.`,
      timeWindow: 'hours',
      riskLevel: price > 0.7 ? 'LOW' : 'MEDIUM',
      dataPoints: { score, dislocation, volume24hr: m.volume24hr, liquidity: m.liquidity, hoursToExpiry: m.hoursToExpiry },
    });
  }

  // Sort by score (confidence) desc
  opps.sort((a, b) => b.confidence - a.confidence);
  return opps.slice(0, 10);
}

// ─── Main Explorer ──────────────────────────────────────

export async function explore(focus: string = 'all'): Promise<ExploreData> {
  const gammaMarkets = await fetchMarkets({
    active: true, closed: false, limit: 100, order: 'volume24hr', ascending: false,
  });

  const allOpps: Opportunity[] = [];

  // Run scans based on focus
  const tasks: Promise<Opportunity[]>[] = [];

  if (focus === 'all' || focus === 'value') {
    tasks.push(Promise.resolve(findValueBettingOpps(gammaMarkets)));
  }
  if (focus === 'all' || focus === 'expiry') {
    tasks.push(findNearExpiryOpps(gammaMarkets));
  }
  if (focus === 'all' || focus === 'arb') {
    tasks.push(findComplementArbOpps(gammaMarkets.slice(0, 30)));
    tasks.push(findMultiOutcomeArbOpps());
  }
  if (focus === 'all' || focus === 'crypto') {
    tasks.push(findCryptoOpps(gammaMarkets));
  }

  const results = await Promise.all(tasks);
  for (const result of results) {
    allOpps.push(...result);
  }

  // Sort by confidence desc, then expected profit
  allOpps.sort((a, b) => b.confidence - a.confidence || b.expectedProfit - a.expectedProfit);

  // Market conditions summary
  const validMarkets = gammaMarkets.filter(gm => {
    try { return JSON.parse(gm.outcomePrices || '[]').length >= 2; } catch { return false; }
  });
  const avgSpread = validMarkets.length > 0
    ? validMarkets.reduce((s, m) => s + parseFloat(m.spread || '0'), 0) / validMarkets.length
    : 0;

  return {
    opportunities: allOpps.slice(0, 20),
    marketConditions: {
      totalActiveMarkets: gammaMarkets.length,
      avgSpread: Math.round(avgSpread * 10000) / 10000,
      topVolumeMarkets: gammaMarkets.slice(0, 5).map(m => m.question),
    },
  };
}
