/**
 * Bonding Strategy — Market Scanner
 *
 * Finds markets approaching resolution:
 *   1. Fetch active markets near their endDate
 *   2. Check UMA oracle on-chain for proposed/confirmed resolutions
 *   3. Return markets where resolution is confirmed but tokens still trade < $1
 */

import 'server-only';

import { fetchMarkets } from '@/lib/polymarket/gamma';
import { isConditionResolved, getWinningSide } from '@/lib/polymarket/redeem';
import { takerFeePerShare } from '@/lib/fees';
import type { GammaMarket } from '@/lib/types/polymarket';

// ─── Types ──────────────────────────────────────────────

export interface BondingOpportunity {
  conditionId: string;
  question: string;
  slug: string;
  endDate: string;
  hoursToExpiry: number;
  /** 'YES' or 'NO' — the side confirmed by UMA */
  winningSide: 'YES' | 'NO';
  /** CLOB token ID of the winning outcome */
  winningTokenId: string;
  /** Current CLOB price of the winning token (0-1) */
  winningPrice: number;
  /** Discount = 1.00 - price (gross profit per share before fees) */
  discountCents: number;
  /** Net profit per share after taker fee */
  netProfitCents: number;
  /** Estimated ROI % */
  roi: number;
  negRisk: boolean;
  yesTokenId: string;
  noTokenId: string;
  liquidity: number;
  volume: number;
}

export interface ScanResult {
  opportunities: BondingOpportunity[];
  /** Markets near expiry but not yet resolved — candidates for active watching */
  watchCandidates: GammaMarket[];
  scannedCount: number;
  resolvedCount: number;
  timestamp: number;
}

// ─── Config ─────────────────────────────────────────────

const SCAN_CONFIG = {
  /** Max hours before endDate to start scanning */
  MAX_HOURS_BEFORE_EXPIRY: 48,
  /** Seconds threshold to promote a market to active watching */
  WATCH_SECONDS_THRESHOLD: 30,
  /** Minimum net profit (cents) to consider an opportunity */
  MIN_NET_PROFIT_CENTS: 1,
  /** Maximum price we'd pay for the winning token (don't buy at 0.99) */
  MAX_WINNING_PRICE: 0.97,
  /** Minimum price (skip if too cheap — might be wrong resolution) */
  MIN_WINNING_PRICE: 0.50,
  /** Max markets to check per scan */
  SCAN_BATCH_SIZE: 100,
};

// ─── Scanner ────────────────────────────────────────────

/**
 * Scan for bonding opportunities.
 *
 * Flow:
 *   1. Fetch markets ending within MAX_HOURS_BEFORE_EXPIRY
 *   2. For each, check on-chain if CTF condition is resolved
 *   3. If resolved, get winning side & compare to current CLOB price
 *   4. If price < 1.00 minus fees → opportunity exists
 */
export async function scanBondingOpportunities(): Promise<ScanResult> {
  const now = new Date();

  // Fetch active markets expiring soon
  const markets = await fetchMarkets({
    active: true,
    closed: false,
    limit: SCAN_CONFIG.SCAN_BATCH_SIZE,
    order: 'endDate',
    ascending: true,
    endDateMin: now.toISOString(),
    noCache: true,
  });

  // Filter to markets within our time window
  const nearExpiry = markets.filter((m) => {
    const end = new Date(m.endDate);
    const hoursLeft = (end.getTime() - now.getTime()) / (1000 * 60 * 60);
    return hoursLeft > 0 && hoursLeft <= SCAN_CONFIG.MAX_HOURS_BEFORE_EXPIRY;
  });

  const opportunities: BondingOpportunity[] = [];
  const watchCandidates: GammaMarket[] = [];
  let resolvedCount = 0;

  // Separate markets into watch candidates (< WATCH_SECONDS_THRESHOLD) and scan targets
  for (const m of nearExpiry) {
    const end = new Date(m.endDate);
    const secsLeft = (end.getTime() - now.getTime()) / 1000;
    if (secsLeft > 0 && secsLeft <= SCAN_CONFIG.WATCH_SECONDS_THRESHOLD) {
      watchCandidates.push(m);
    }
  }

  // Check each market for on-chain resolution
  // Process in parallel batches of 10 to avoid RPC rate limits
  const batchSize = 10;
  for (let i = 0; i < nearExpiry.length; i += batchSize) {
    const batch = nearExpiry.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((m) => checkMarketResolution(m, now)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        if (result.value.resolved) resolvedCount++;
        if (result.value.opportunity) {
          opportunities.push(result.value.opportunity);
        }
      }
    }
  }

  // Sort by net profit descending
  opportunities.sort((a, b) => b.netProfitCents - a.netProfitCents);

  return {
    opportunities,
    watchCandidates,
    scannedCount: nearExpiry.length,
    resolvedCount,
    timestamp: Date.now(),
  };
}

async function checkMarketResolution(
  market: GammaMarket,
  now: Date,
): Promise<{ resolved: boolean; opportunity: BondingOpportunity | null }> {
  const resolved = await isConditionResolved(market.conditionId);
  if (!resolved) return { resolved: false, opportunity: null };

  const winningSide = await getWinningSide(market.conditionId);
  if (!winningSide) return { resolved: true, opportunity: null };

  // Parse market data
  let tokenIds: string[];
  let prices: number[];
  try {
    tokenIds = JSON.parse(market.clobTokenIds);
    prices = JSON.parse(market.outcomePrices);
  } catch {
    return { resolved: true, opportunity: null };
  }

  if (tokenIds.length < 2 || prices.length < 2) {
    return { resolved: true, opportunity: null };
  }

  // Token 0 = Yes, Token 1 = No
  const yesTokenId = tokenIds[0];
  const noTokenId = tokenIds[1];
  const winIndex = winningSide === 'YES' ? 0 : 1;
  const winningTokenId = tokenIds[winIndex];
  const winningPrice = prices[winIndex];

  // Filter: price must be in profitable range
  if (
    winningPrice >= SCAN_CONFIG.MAX_WINNING_PRICE ||
    winningPrice <= SCAN_CONFIG.MIN_WINNING_PRICE
  ) {
    return { resolved: true, opportunity: null };
  }

  // Calculate profit
  const discountCents = (1.0 - winningPrice) * 100;
  const feeCents = takerFeePerShare(winningPrice) * 100;
  const netProfitCents = discountCents - feeCents;

  if (netProfitCents < SCAN_CONFIG.MIN_NET_PROFIT_CENTS) {
    return { resolved: true, opportunity: null };
  }

  const endDate = new Date(market.endDate);
  const hoursToExpiry = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60);

  return {
    resolved: true,
    opportunity: {
      conditionId: market.conditionId,
      question: market.question,
      slug: market.slug,
      endDate: market.endDate,
      hoursToExpiry,
      winningSide,
      winningTokenId,
      winningPrice,
      discountCents,
      netProfitCents,
      roi: (netProfitCents / (winningPrice * 100)) * 100,
      negRisk: market.negRisk ?? false,
      yesTokenId,
      noTokenId,
      liquidity: parseFloat(market.liquidity) || 0,
      volume: parseFloat(market.volume) || 0,
    },
  };
}
