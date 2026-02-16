import 'server-only';

import { fetchMarkets, fetchEvents } from '@/lib/polymarket/gamma';
import { getEnv } from '@/lib/config/env';
import { getCryptoPrice, type CryptoSymbol } from '@/lib/polymarket/binance';
import type { GammaMarket } from '@/lib/types/polymarket';
import type { ArbLeg, ExploreData, Opportunity } from './types';

// ─── Helpers ────────────────────────────────────────────

interface OrderBookLevel { price: string; size: string }
interface OrderBookResponse { asks: OrderBookLevel[]; bids: OrderBookLevel[] }

async function fetchOrderBook(tokenId: string): Promise<{ bestAsk: number; bestBid: number; askDepth: number; bidDepth: number } | null> {
  try {
    const clobUrl = getEnv().CLOB_API_URL;
    const res = await fetch(`${clobUrl}/book?token_id=${tokenId}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const book: OrderBookResponse = await res.json();
    if (!book.asks || book.asks.length === 0) return null;

    // Sort asks ascending (lowest first) to find true best ask
    const sortedAsks = book.asks
      .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .sort((a, b) => a.price - b.price);

    const bestAsk = sortedAsks[0].price;
    let askDepth = 0;
    for (const level of sortedAsks) {
      if (level.price > bestAsk + 0.01) break;
      askDepth += level.price * level.size;
    }

    // Sort bids descending (highest first) to find true best bid
    const sortedBids = (book.bids || [])
      .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .sort((a, b) => b.price - a.price);

    const bestBid = sortedBids.length > 0 ? sortedBids[0].price : 0;
    let bidDepth = 0;
    for (const level of sortedBids) {
      if (level.price < bestBid - 0.01) break;
      bidDepth += level.price * level.size;
    }

    return { bestAsk, bestBid, askDepth, bidDepth };
  } catch {
    return null;
  }
}

interface ParsedMarket {
  conditionId: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  tokenIds: string[];
  outcomes: string[];
  volume24hr: number;
  liquidity: number;
  spread: number;
  hoursToExpiry: number;
}

function parseMarket(gm: GammaMarket): ParsedMarket | null {
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

const WINNER_FEE = 0.02;
const EFFECTIVE_PAYOUT = 1.0 - WINNER_FEE; // $0.98

// In-memory price history for momentum checks (shared across scanners)
const priceHistory = new Map<string, { price: number; timestamp: number }[]>();

function recordPrice(conditionId: string, price: number, maxAgeMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  const history = priceHistory.get(conditionId) || [];
  history.push({ price, timestamp: now });
  const cutoff = now - maxAgeMs;
  const filtered = history.filter((h) => h.timestamp >= cutoff);
  priceHistory.set(conditionId, filtered);
  return filtered;
}

// ─── Near-Expiry Scanner (Multi-Signal) ─────────────────

async function findNearExpiryOpps(markets: ParsedMarket[]): Promise<Opportunity[]> {
  const opps: Opportunity[] = [];
  for (const m of markets) {
    // Hard filters (shared)
    if (m.hoursToExpiry < 1 || m.hoursToExpiry > 8) continue;
    if (m.liquidity < 2000 || m.volume24hr < 5000 || m.spread > 0.02) continue;

    const priceSum = m.yesPrice + m.noPrice;
    if (Math.abs(priceSum - 1.0) > 0.02) continue;

    // Pick whichever side is in 90-94c range
    const prices = [m.yesPrice, m.noPrice];
    const targetIdx = prices.findIndex(p => p >= 0.90 && p <= 0.94);
    if (targetIdx === -1) continue;

    const targetPrice = prices[targetIdx];
    const opposingPrice = prices[1 - targetIdx];
    if (opposingPrice > 0.12) continue;

    // Net profit after fee
    const netProfitPerShare = EFFECTIVE_PAYOUT - targetPrice;
    if (netProfitPerShare <= 0.005) continue;

    // ── Multi-Signal Scoring ──
    let totalScore = 0;
    let confirmedSignals = 0;

    // Signal 1: Price Level (0-25 pts)
    const priceScore = ((targetPrice - 0.90) / 0.04) * 25;
    totalScore += Math.min(25, Math.max(0, priceScore));

    // Signal 2: Time Decay (0-25 pts)
    let timeScore = 0;
    if (m.hoursToExpiry <= 2) timeScore = 25;
    else if (m.hoursToExpiry <= 4) timeScore = 22;
    else if (m.hoursToExpiry <= 6) timeScore = 18;
    else timeScore = 12;
    totalScore += timeScore;
    if (timeScore >= 18) confirmedSignals++;

    // Signal 3: Momentum (0-20 pts) + reversal guard
    let momentumScore = 0;
    const history = priceHistory.get(`${m.conditionId}:${targetIdx}`) || [];
    if (history.length >= 2) {
      const oldestPrice = history[0].price;
      const priceDelta = targetPrice - oldestPrice;

      let hasReversal = false;
      for (let i = 1; i < history.length; i++) {
        if (history[i - 1].price - history[i].price >= 0.03) {
          hasReversal = true;
          break;
        }
      }
      if (hasReversal) continue;

      if (priceDelta < 0) momentumScore = 0;
      else if (priceDelta < 0.02) momentumScore = 5;
      else if (priceDelta < 0.05) momentumScore = 12;
      else momentumScore = 20;
      if (priceDelta > 0) confirmedSignals++;
    } else {
      momentumScore = 8;
    }
    totalScore += momentumScore;

    // Signal 4: Volume Conviction (0-15 pts)
    const volRatio = m.volume24hr / Math.max(1, m.liquidity);
    let volumeScore = 0;
    if (volRatio < 0.1) volumeScore = 0;
    else if (volRatio < 0.3) volumeScore = 5;
    else if (volRatio < 0.5) volumeScore = 10;
    else volumeScore = 15;
    totalScore += volumeScore;
    if (volRatio >= 0.3) confirmedSignals++;

    // Signal 5: Spread Tightness (0-15 pts)
    let spreadScore = 0;
    if (m.spread <= 0.005) spreadScore = 15;
    else if (m.spread <= 0.01) spreadScore = 12;
    else if (m.spread <= 0.015) spreadScore = 8;
    else spreadScore = 4;
    totalScore += spreadScore;
    if (m.spread <= 0.015) confirmedSignals++;

    // Gate: require 3 of 4 signals confirmed
    if (confirmedSignals < 3) continue;
    if (totalScore < 60) continue;

    const outcomeName = m.outcomes[targetIdx];
    opps.push({
      type: 'near-expiry',
      conditionId: m.conditionId,
      question: m.question,
      signal: 'BUY',
      tokenId: m.tokenIds[targetIdx],
      outcome: outcomeName,
      suggestedPrice: targetPrice,
      suggestedSize: 5,
      expectedProfit: netProfitPerShare * 5,
      confidence: Math.round(Math.min(95, totalScore)),
      reasoning: `${outcomeName} @ ${(targetPrice * 100).toFixed(0)}c, ${m.hoursToExpiry.toFixed(1)}h to expiry. Score ${totalScore.toFixed(0)}/100, signals ${confirmedSignals}/4.`,
      timeWindow: m.hoursToExpiry < 2 ? 'urgent' : 'hours',
      riskLevel: m.hoursToExpiry < 2 ? 'MEDIUM' : 'LOW',
      dataPoints: {
        targetPrice, opposingPrice, targetIdx, hoursToExpiry: m.hoursToExpiry, liquidity: m.liquidity,
        confirmedSignals, totalScore, momentumScore, volumeScore, spreadScore,
      },
      autoExecutable: false,
      strategyScore: totalScore,
    });
  }
  return opps;
}

// ─── Complement Arb Scanner (with scoring) ──────────────

async function findComplementArbOpps(markets: ParsedMarket[]): Promise<Opportunity[]> {
  const opps: Opportunity[] = [];

  for (const m of markets) {
    if (m.tokenIds.length < 2) continue;
    // Skip extreme sides
    if (m.yesPrice > 0.95 || m.noPrice > 0.95) continue;

    const [yesBook, noBook] = await Promise.all([
      fetchOrderBook(m.tokenIds[0]),
      fetchOrderBook(m.tokenIds[1]),
    ]);
    if (!yesBook || !noBook) continue;
    if (yesBook.bestAsk + noBook.bestAsk >= 0.975) continue;
    if (yesBook.askDepth < 50 || noBook.askDepth < 50) continue;

    const cost = yesBook.bestAsk + noBook.bestAsk;
    const grossProfit = 1 - cost;

    // Scoring from complement-arb strategy
    let score = 0;
    score += Math.min(40, (grossProfit / 0.03) * 40);                          // Profit margin
    const minDepth = Math.min(yesBook.askDepth, noBook.askDepth);
    score += Math.min(30, (minDepth / 500) * 30);                              // Depth
    score += Math.min(30, Math.log10(Math.max(1, m.volume24hr)) * 6);          // Volume
    if (score < 40) continue;

    const arbSize = 5;
    opps.push({
      type: 'complement-arb',
      conditionId: m.conditionId,
      question: m.question,
      signal: 'BUY',
      tokenId: m.tokenIds[0],
      outcome: 'Yes+No bundle',
      suggestedPrice: yesBook.bestAsk,
      suggestedSize: arbSize,
      expectedProfit: grossProfit * arbSize * 0.98,
      confidence: Math.round(Math.min(98, 70 + score * 0.3)),
      reasoning: `Yes ask ${yesBook.bestAsk} + No ask ${noBook.bestAsk} = ${cost.toFixed(4)}. Guaranteed profit ${(grossProfit * 100).toFixed(1)}c/share. Score ${score.toFixed(0)}.`,
      timeWindow: 'minutes',
      riskLevel: 'LOW',
      dataPoints: {
        yesBestAsk: yesBook.bestAsk, noBestAsk: noBook.bestAsk,
        combinedCost: cost, yesDepth: yesBook.askDepth, noDepth: noBook.askDepth,
        noTokenId: m.tokenIds[1], score,
      },
      autoExecutable: true,
      strategyScore: score,
      arbLegs: [{ conditionId: m.conditionId, tokenId: m.tokenIds[1], outcome: 'No', price: noBook.bestAsk, size: arbSize }],
    });
  }
  return opps;
}

// ─── Crypto Latency Scanner (with fair price) ───────────

function calcFairYesPrice(spotPrice: number, strikePrice: number): number {
  if (strikePrice <= 0) return 0.5;
  const pctFromStrike = (spotPrice - strikePrice) / strikePrice;
  const raw = 0.50 + pctFromStrike * 120;
  return Math.max(0.05, Math.min(0.95, raw));
}

async function findCryptoOpps(markets: ParsedMarket[]): Promise<Opportunity[]> {
  const opps: Opportunity[] = [];
  const spotPrices = new Map<CryptoSymbol, number>();

  for (const m of markets) {
    const detected = CRYPTO_ASSET_MAP.find(e => e.pattern.test(m.question));
    if (!detected) continue;
    const minutesToExpiry = m.hoursToExpiry * 60;
    if (minutesToExpiry < 2 || minutesToExpiry > 60) continue;

    if (!spotPrices.has(detected.symbol)) {
      try {
        spotPrices.set(detected.symbol, await getCryptoPrice(detected.symbol));
      } catch { continue; }
    }
    const spotPrice = spotPrices.get(detected.symbol)!;

    // Require explicit $ sign to avoid matching dates like "February 15" as strike
    const priceMatch = m.question.match(/\$([\d,]+(?:\.\d+)?)/);
    const strikePrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;
    if (strikePrice <= 0) continue;

    // Use fair price calculator from crypto-scalper strategy
    const fairYes = calcFairYesPrice(spotPrice, strikePrice);
    const fairNo = 1 - fairYes;
    const pctFromStrike = ((spotPrice - strikePrice) / strikePrice) * 100;

    // Determine which side is undervalued
    const yesDislocation = fairYes - m.yesPrice;
    const noDislocation = fairNo - m.noPrice;

    let signal: 'BUY' | 'SELL' = 'BUY';
    let tokenId = m.tokenIds[0];
    let outcome = m.outcomes[0];
    let targetPrice = m.yesPrice;
    let dislocation = 0;

    if (yesDislocation >= noDislocation && yesDislocation > 0.03) {
      tokenId = m.tokenIds[0];
      outcome = 'Yes';
      targetPrice = m.yesPrice;
      dislocation = yesDislocation;
    } else if (noDislocation > 0.03) {
      tokenId = m.tokenIds[1];
      outcome = 'No';
      targetPrice = m.noPrice;
      dislocation = noDislocation;
    } else {
      continue;
    }

    // Scoring (from crypto-scalper)
    let score = 0;
    score += Math.min(35, (dislocation / 0.15) * 35);
    const pctMove = Math.abs(pctFromStrike) / 100;
    score += Math.min(25, (pctMove / 0.005) * 25);
    if (minutesToExpiry >= 5 && minutesToExpiry <= 20) score += 20;
    else if (minutesToExpiry >= 3 && minutesToExpiry < 5) score += 12;
    else if (minutesToExpiry > 20 && minutesToExpiry <= 35) score += 15;
    else score += 8;
    score += Math.min(20, Math.log10(Math.max(1, m.volume24hr)) * 4);

    if (score < 40) continue;

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
      confidence: Math.min(95, Math.round(40 + score * 0.55)),
      reasoning: `${detected.asset} spot $${spotPrice.toFixed(2)} vs strike $${strikePrice}. Fair ${outcome}: ${(outcome === 'Yes' ? fairYes : fairNo).toFixed(2)}, market ${targetPrice.toFixed(2)}, gap ${(dislocation * 100).toFixed(0)}c. Score ${score.toFixed(0)}.`,
      timeWindow: minutesToExpiry < 10 ? 'urgent' : 'minutes',
      riskLevel: minutesToExpiry < 5 ? 'HIGH' : 'MEDIUM',
      dataPoints: {
        spotPrice, strikePrice, pctFromStrike, minutesToExpiry, asset: detected.asset,
        fairYes, fairNo, dislocation, score,
      },
      autoExecutable: false,
      strategyScore: score,
    });
  }
  return opps;
}

// ─── Multi-Outcome Arb Scanner ──────────────────────────

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

    if (!valid || legs.length < 3 || legs.length > 10 || gammaSum < 0.85 || gammaSum > 1.15) continue;

    const books = await Promise.all(legs.map(l => fetchOrderBook(l.yesTokenId)));
    if (books.some(b => !b)) continue;

    const bundleCost = books.reduce((sum, b) => sum + b!.bestAsk, 0);
    if (bundleCost >= 0.975) continue;
    if (books.some(b => b!.askDepth < 25)) continue;

    const bundleSize = 5;
    const additionalLegs: ArbLeg[] = legs.slice(1).map((l, i) => ({
      conditionId: l.conditionId,
      tokenId: l.yesTokenId,
      outcome: l.question,
      price: books[i + 1]!.bestAsk,
      size: bundleSize,
    }));

    opps.push({
      type: 'multi-outcome-arb',
      conditionId: legs[0].conditionId,
      question: event.title,
      signal: 'BUY',
      tokenId: legs[0].yesTokenId,
      outcome: 'Bundle (all YES)',
      suggestedPrice: books[0]!.bestAsk,
      suggestedSize: bundleSize,
      expectedProfit: (1 - bundleCost) * bundleSize * 0.98,
      confidence: Math.round(95 - (bundleCost * 100 - 95) * 20),
      reasoning: `${legs.length}-outcome event "${event.title}": bundle cost ${bundleCost.toFixed(4)}. Guaranteed profit ${((1 - bundleCost) * 100).toFixed(1)}c/share.`,
      timeWindow: 'minutes',
      riskLevel: 'LOW',
      dataPoints: { bundleCost, legCount: legs.length, legs: legs.map((l, i) => ({ ...l, bestAsk: books[i]!.bestAsk })) },
      autoExecutable: false, // multi-outcome legs may not be mutually exclusive — require Claude approval
      strategyScore: Math.round(95 - (bundleCost * 100 - 95) * 20),
      arbLegs: additionalLegs,
    });
  }
  return opps;
}

// ─── Value-Betting Scanner ──────────────────────────────

function findValueBettingOpps(markets: ParsedMarket[]): Opportunity[] {
  const opps: Opportunity[] = [];

  for (const m of markets) {
    if (m.hoursToExpiry < 6) continue;
    if (m.liquidity < 1000) continue;
    if (m.volume24hr < 5000) continue;
    if (m.spread > 0.05) continue;

    const dislocation = Math.abs(m.yesPrice - 0.5);

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

    const favoredIdx = m.yesPrice >= m.noPrice ? 0 : 1;
    const tokenId = m.tokenIds[favoredIdx];
    const outcome = m.outcomes[favoredIdx];
    const price = favoredIdx === 0 ? m.yesPrice : m.noPrice;

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
      autoExecutable: false,
      strategyScore: score,
    });
  }

  opps.sort((a, b) => b.confidence - a.confidence);
  return opps.slice(0, 10);
}

// ─── Panic Reversal Scanner ─────────────────────────────

function findPanicReversalOpps(markets: ParsedMarket[]): Opportunity[] {
  const opps: Opportunity[] = [];
  const MIN_DROP = 0.05;

  for (const m of markets) {
    if (m.volume24hr < 10000) continue;
    if (m.liquidity < 5000) continue;

    // Isolation check: price sum ≈ $1.00
    const priceSum = m.yesPrice + m.noPrice;
    if (Math.abs(priceSum - 1.0) > 0.05) continue;

    // Check both outcomes for panic-reversal candidate
    const prices = [m.yesPrice, m.noPrice];
    for (let idx = 0; idx < 2; idx++) {
      const targetPrice = prices[idx];
      if (targetPrice < 0.50 || targetPrice > 0.90) continue;

      const history = priceHistory.get(`${m.conditionId}:${idx}`) || [];
      if (history.length < 3) continue;

      // Drop detection: find 2h high
      const twoHourHigh = Math.max(...history.map((h) => h.price));
      const dropFromHigh = twoHourHigh - targetPrice;
      if (dropFromHigh < MIN_DROP) continue;

      // Recovery signal: current ≥ previous
      const prevPrice = history[history.length - 2].price;
      if (targetPrice < prevPrice) continue;

      // Scoring
      let score = 0;
      score += Math.min(30, (dropFromHigh / 0.15) * 30);
      score += Math.min(25, Math.log10(Math.max(1, m.volume24hr)) * 5);
      const recentBottom = Math.min(...history.slice(-5).map((h) => h.price));
      const recoveryAmount = targetPrice - recentBottom;
      score += Math.min(25, (recoveryAmount / 0.03) * 25);
      if (m.spread <= 0.01) score += 20;
      else if (m.spread <= 0.02) score += 15;
      else if (m.spread <= 0.03) score += 10;
      else if (m.spread <= 0.05) score += 5;

      if (score < 55) continue;

      opps.push({
        type: 'panic-reversal',
        conditionId: m.conditionId,
        question: m.question,
        signal: 'BUY',
        tokenId: m.tokenIds[idx],
        outcome: m.outcomes[idx],
        suggestedPrice: targetPrice,
        suggestedSize: 5,
        expectedProfit: (1 - targetPrice) * 5 * 0.98,
        confidence: Math.round(Math.min(90, 40 + score * 0.5)),
        reasoning: `Drop ${(dropFromHigh * 100).toFixed(0)}c from 2h high ${(twoHourHigh * 100).toFixed(0)}c, recovering +${(recoveryAmount * 100).toFixed(1)}c. Score ${score.toFixed(0)}.`,
        timeWindow: 'hours',
        riskLevel: 'MEDIUM',
        dataPoints: {
          twoHourHigh, dropFromHigh, recoveryAmount, score,
          volume24hr: m.volume24hr, liquidity: m.liquidity,
        },
        autoExecutable: false,
        strategyScore: score,
      });
    }
  }

  opps.sort((a, b) => b.confidence - a.confidence);
  return opps.slice(0, 5);
}

// ─── Micro-Scalp Scanner ────────────────────────────────

interface MicroScalpTier {
  name: string;
  minMinutes: number;
  maxMinutes: number;
  minPrice: number;
  maxPrice: number;
  maxSpread: number;
  minLiquidity: number;
  minVolume: number;
}

const MICRO_TIERS: MicroScalpTier[] = [
  { name: 'Sprint', minMinutes: 5, maxMinutes: 15, minPrice: 0.95, maxPrice: 0.97, maxSpread: 0.01, minLiquidity: 3000, minVolume: 8000 },
  { name: 'Dash',   minMinutes: 15, maxMinutes: 30, minPrice: 0.94, maxPrice: 0.97, maxSpread: 0.015, minLiquidity: 2500, minVolume: 6000 },
  { name: 'Quick',  minMinutes: 30, maxMinutes: 60, minPrice: 0.93, maxPrice: 0.96, maxSpread: 0.02, minLiquidity: 2000, minVolume: 5000 },
];

function findMicroScalpOpps(markets: ParsedMarket[]): Opportunity[] {
  const opps: Opportunity[] = [];

  for (const m of markets) {

    const minutesToExpiry = m.hoursToExpiry * 60;

    // Tier-specific filters (shared across both outcomes)
    if (m.spread > Math.max(...MICRO_TIERS.map(t => t.maxSpread))) continue;
    if (m.liquidity < Math.min(...MICRO_TIERS.map(t => t.minLiquidity))) continue;
    if (m.volume24hr < Math.min(...MICRO_TIERS.map(t => t.minVolume))) continue;

    // Price sum check
    const priceSum = m.yesPrice + m.noPrice;
    if (Math.abs(priceSum - 1.0) > 0.02) continue;

    // Check both outcomes for micro-scalp candidate
    const prices = [m.yesPrice, m.noPrice];
    for (let idx = 0; idx < 2; idx++) {
      const targetPrice = prices[idx];
      const opposingPrice = prices[1 - idx];

      // Find matching tier for this outcome
      const tier = MICRO_TIERS.find(
        (t) => minutesToExpiry >= t.minMinutes && minutesToExpiry < t.maxMinutes
          && targetPrice >= t.minPrice && targetPrice <= t.maxPrice,
      );
      if (!tier) continue;

      // Tier-specific filters
      if (m.spread > tier.maxSpread) continue;
      if (m.liquidity < tier.minLiquidity) continue;
      if (m.volume24hr < tier.minVolume) continue;

      // Opposing must be low
      if (opposingPrice >= 0.10) continue;

      // Net profit ≥ 1c after fee
      const netProfit = EFFECTIVE_PAYOUT - targetPrice;
      if (netProfit < 0.01) continue;

      // Momentum guard (2c+ drop = reject)
      const history = priceHistory.get(`${m.conditionId}:${idx}`) || [];
      let priceRising = false;
      let momentumStable = true;

      if (history.length >= 2) {
        const oldestPrice = history[0].price;
        const priceDelta = targetPrice - oldestPrice;

        for (let i = 1; i < history.length; i++) {
          if (history[i - 1].price - history[i].price >= 0.02) {
            momentumStable = false;
            break;
          }
        }
        if (!momentumStable) continue;
        if (priceDelta > 0) priceRising = true;
        if (priceDelta < -0.005) continue;
      }

      // Confidence scoring
      let confidence = 0;
      if (minutesToExpiry <= 10) confidence += 30;
      else if (minutesToExpiry <= 20) confidence += 25;
      else if (minutesToExpiry <= 40) confidence += 20;
      else confidence += 15;

      confidence += Math.min(21, Math.max(0, (targetPrice - 0.90) * 300));

      if (m.spread <= 0.005) confidence += 20;
      else if (m.spread <= 0.01) confidence += 15;
      else if (m.spread <= 0.015) confidence += 10;
      else confidence += 5;

      const volRatio = m.volume24hr / Math.max(1, m.liquidity);
      if (volRatio >= 0.5) confidence += 15;
      else if (volRatio >= 0.3) confidence += 10;
      else confidence += 5;

      if (priceRising) confidence += 10;
      else if (momentumStable) confidence += 5;

      if (confidence < 60) continue;

      opps.push({
        type: 'micro-scalp',
        conditionId: m.conditionId,
        question: m.question,
        signal: 'BUY',
        tokenId: m.tokenIds[idx],
        outcome: m.outcomes[idx],
        suggestedPrice: targetPrice,
        suggestedSize: 5,
        expectedProfit: netProfit * 5,
        confidence: Math.round(Math.min(95, confidence)),
        reasoning: `[${tier.name}] ${m.outcomes[idx]} @ ${(targetPrice * 100).toFixed(0)}c, ${minutesToExpiry.toFixed(0)}min to expiry. Conf ${confidence.toFixed(0)}/100.`,
        timeWindow: 'urgent',
        riskLevel: minutesToExpiry < 15 ? 'MEDIUM' : 'LOW',
        dataPoints: {
          tier: tier.name, minutesToExpiry, confidence,
          volume24hr: m.volume24hr, liquidity: m.liquidity, spread: m.spread,
        },
        autoExecutable: false,
        strategyScore: confidence,
      });
    }
  }

  opps.sort((a, b) => b.confidence - a.confidence);
  return opps.slice(0, 5);
}

// ─── Explore Result Cache ────────────────────────────────
// Prevents redundant scans when both skill-engine and Claude call explore()
// within the same interval.

let exploreCache: { data: ExploreData; timestamp: number; focus: string } | null = null;
const EXPLORE_CACHE_TTL_MS = 20_000; // 20s — shorter than 30s scan interval

// ─── Main Explorer ──────────────────────────────────────

export async function explore(focus: string = 'all'): Promise<ExploreData> {
  // Return cached result if fresh enough and same focus
  if (
    exploreCache &&
    exploreCache.focus === focus &&
    Date.now() - exploreCache.timestamp < EXPLORE_CACHE_TTL_MS
  ) {
    return exploreCache.data;
  }
  // Fetch two sets of markets in parallel:
  // 1. Top volume markets (for value-betting, panic-reversal, arb)
  // 2. Soonest-expiring markets (for crypto-latency, micro-scalp, near-expiry)
  const [volumeMarkets, expiryMarkets] = await Promise.all([
    fetchMarkets({
      active: true, closed: false, limit: 100, order: 'volume24hr', ascending: false,
    }),
    fetchMarkets({
      active: true, closed: false, limit: 100, order: 'endDate', ascending: true,
      endDateMin: new Date().toISOString(), noCache: true,
    }),
  ]);

  // Merge and deduplicate by conditionId, pre-parse once
  const seen = new Set<string>();
  const allParsed: ParsedMarket[] = [];
  const expiryParsed: ParsedMarket[] = [];

  for (const gm of volumeMarkets) {
    if (seen.has(gm.conditionId)) continue;
    seen.add(gm.conditionId);
    const m = parseMarket(gm);
    if (m) allParsed.push(m);
  }
  for (const gm of expiryMarkets) {
    const m = parseMarket(gm);
    if (!m) continue;
    expiryParsed.push(m);
    if (!seen.has(gm.conditionId)) {
      seen.add(gm.conditionId);
      allParsed.push(m);
    }
  }

  // Record prices per outcome (shared across scanners)
  for (const m of allParsed) {
    recordPrice(`${m.conditionId}:0`, m.yesPrice);
    recordPrice(`${m.conditionId}:1`, m.noPrice);
  }

  const allOpps: Opportunity[] = [];

  // Run scans based on focus — scanners receive pre-parsed markets
  const tasks: Promise<Opportunity[]>[] = [];

  if (focus === 'all' || focus === 'value') {
    tasks.push(Promise.resolve(findValueBettingOpps(allParsed)));
  }
  if (focus === 'all' || focus === 'expiry') {
    tasks.push(findNearExpiryOpps(expiryParsed));
  }
  if (focus === 'all' || focus === 'arb') {
    tasks.push(findComplementArbOpps(allParsed.slice(0, 30)));
    tasks.push(findMultiOutcomeArbOpps());
  }
  if (focus === 'all' || focus === 'crypto') {
    tasks.push(findCryptoOpps(expiryParsed));
  }
  if (focus === 'all' || focus === 'panic') {
    tasks.push(Promise.resolve(findPanicReversalOpps(allParsed)));
  }
  if (focus === 'all' || focus === 'scalp') {
    tasks.push(Promise.resolve(findMicroScalpOpps(expiryParsed)));
  }

  const results = await Promise.all(tasks);
  for (const result of results) {
    allOpps.push(...result);
  }

  // Sort by confidence desc, then expected profit
  allOpps.sort((a, b) => b.confidence - a.confidence || b.expectedProfit - a.expectedProfit);

  // Market conditions summary
  const avgSpread = allParsed.length > 0
    ? allParsed.reduce((s, m) => s + m.spread, 0) / allParsed.length
    : 0;

  const result: ExploreData = {
    opportunities: allOpps.slice(0, 30),
    marketConditions: {
      totalActiveMarkets: allParsed.length,
      avgSpread: Math.round(avgSpread * 10000) / 10000,
      topVolumeMarkets: volumeMarkets.slice(0, 5).map(m => m.question),
    },
  };

  // Cache result for deduplication
  exploreCache = { data: result, timestamp: Date.now(), focus };

  return result;
}
