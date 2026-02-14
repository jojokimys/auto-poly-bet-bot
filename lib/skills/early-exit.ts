import 'server-only';

import { prisma } from '@/lib/db/prisma';
import { getEnv } from '@/lib/config/env';
import {
  getClientForProfile,
  getProfileBalance,
  placeProfileOrder,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';
import { trackClobCall, trackClobAuthCall } from '@/lib/bot/api-tracker';
import type { EarlyExitCandidate, EarlyExitResult } from './types';

// ─── Config ─────────────────────────────────────────────

/** Minimum token mid-price to consider for early exit (90%) */
const DEFAULT_THRESHOLD = 0.90;

/** Minimum net position size to bother selling */
const MIN_SELL_SIZE = 1;

// ─── Helpers ────────────────────────────────────────────

async function loadProfile(profileId: string): Promise<ProfileCredentials | null> {
  const p = await prisma.botProfile.findUnique({ where: { id: profileId } });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    privateKey: p.privateKey,
    funderAddress: p.funderAddress,
    signatureType: p.signatureType,
    apiKey: p.apiKey,
    apiSecret: p.apiSecret,
    apiPassphrase: p.apiPassphrase,
  };
}

interface TradeEntry {
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  asset_id: string;
  outcome: string;
  market: string; // conditionId
}

/** Fetch all trades for a profile and compute net positions */
async function getNetPositions(profile: ProfileCredentials): Promise<Map<string, {
  tokenId: string;
  outcome: string;
  conditionId: string;
  netSize: number;
  avgEntryPrice: number;
  totalCost: number;
}>> {
  trackClobAuthCall();
  const client = getClientForProfile(profile);
  const rawTrades = await client.getTrades() as any[];

  const positions = new Map<string, {
    tokenId: string;
    outcome: string;
    conditionId: string;
    bought: number;
    sold: number;
    totalCost: number;
  }>();

  for (const t of rawTrades) {
    const assetId = t.asset_id;
    const side = t.side as 'BUY' | 'SELL';
    const price = parseFloat(t.price);
    const size = parseFloat(t.size);

    let pos = positions.get(assetId);
    if (!pos) {
      pos = {
        tokenId: assetId,
        outcome: t.outcome || '',
        conditionId: t.market || '',
        bought: 0,
        sold: 0,
        totalCost: 0,
      };
      positions.set(assetId, pos);
    }

    if (side === 'BUY') {
      pos.bought += size;
      pos.totalCost += price * size;
    } else {
      pos.sold += size;
    }
  }

  // Filter to positions with net holding > MIN_SELL_SIZE
  const result = new Map<string, {
    tokenId: string;
    outcome: string;
    conditionId: string;
    netSize: number;
    avgEntryPrice: number;
    totalCost: number;
  }>();

  for (const [assetId, pos] of positions) {
    const netSize = pos.bought - pos.sold;
    if (netSize < MIN_SELL_SIZE) continue;

    const avgEntryPrice = pos.bought > 0 ? pos.totalCost / pos.bought : 0;
    result.set(assetId, {
      tokenId: pos.tokenId,
      outcome: pos.outcome,
      conditionId: pos.conditionId,
      netSize: Math.round(netSize * 100) / 100,
      avgEntryPrice: Math.round(avgEntryPrice * 10000) / 10000,
      totalCost: pos.totalCost,
    });
  }

  return result;
}

interface BookLevel { price: string; size: string }

/** Fetch orderbook and return best bid with depth, properly sorted */
async function fetchBestBid(tokenId: string): Promise<{
  bestBid: number;
  bidDepth: number;
} | null> {
  try {
    const clobUrl = getEnv().CLOB_API_URL;
    trackClobCall();
    const res = await fetch(`${clobUrl}/book?token_id=${tokenId}`, { cache: 'no-store' });
    if (!res.ok) return null;

    const book: { bids: BookLevel[]; asks: BookLevel[] } = await res.json();
    if (!book.bids || book.bids.length === 0) return null;

    // Sort bids descending by price to find true best bid
    const sortedBids = book.bids
      .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .sort((a, b) => b.price - a.price);

    const bestBid = sortedBids[0].price;

    // Sum depth within 1 cent of best bid
    let bidDepth = 0;
    for (const level of sortedBids) {
      if (level.price < bestBid - 0.01) break;
      bidDepth += level.price * level.size;
    }

    return { bestBid, bidDepth };
  } catch {
    return null;
  }
}

/** Try to get market question from CLOB API */
async function fetchMarketQuestion(conditionId: string): Promise<string> {
  try {
    const clobUrl = getEnv().CLOB_API_URL;
    trackClobCall();
    const res = await fetch(`${clobUrl}/markets/${conditionId}`, { cache: 'no-store' });
    if (!res.ok) return conditionId;
    const data = await res.json();
    return data.question || conditionId;
  } catch {
    return conditionId;
  }
}

// ─── Public API ──────────────────────────────────────────

/**
 * Scan for positions eligible for early exit (near-confirmed winners).
 * Returns candidates without executing any trades.
 */
export async function scanForEarlyExits(
  profileId: string,
  threshold = DEFAULT_THRESHOLD,
): Promise<EarlyExitResult> {
  const profile = await loadProfile(profileId);
  if (!profile) {
    return {
      profileId,
      candidates: [],
      executed: [],
      summary: { totalCandidates: 0, totalExecuted: 0, totalProceeds: 0, capitalFreed: 0 },
    };
  }

  const positions = await getNetPositions(profile);
  const candidates: EarlyExitCandidate[] = [];

  // Check each position's orderbook
  for (const [, pos] of positions) {
    const bidData = await fetchBestBid(pos.tokenId);
    if (!bidData) continue;

    // Only consider positions where best bid >= threshold
    if (bidData.bestBid < threshold) continue;

    // Sell price = best bid (the order will fill at best bid or better)
    const sellPrice = bidData.bestBid;
    const estimatedProceeds = sellPrice * pos.netSize;
    const estimatedPnl = (sellPrice - pos.avgEntryPrice) * pos.netSize;

    // Look up market question (best effort)
    const question = await fetchMarketQuestion(pos.conditionId);

    candidates.push({
      conditionId: pos.conditionId,
      tokenId: pos.tokenId,
      outcome: pos.outcome,
      question,
      netSize: pos.netSize,
      avgEntryPrice: pos.avgEntryPrice,
      currentBestBid: bidData.bestBid,
      sellPrice,
      estimatedProceeds: Math.round(estimatedProceeds * 100) / 100,
      estimatedPnl: Math.round(estimatedPnl * 100) / 100,
      bidDepthAtPrice: Math.round(bidData.bidDepth * 100) / 100,
    });
  }

  // Sort by best bid descending (most confirmed first)
  candidates.sort((a, b) => b.currentBestBid - a.currentBestBid);

  return {
    profileId,
    candidates,
    executed: [],
    summary: {
      totalCandidates: candidates.length,
      totalExecuted: 0,
      totalProceeds: candidates.reduce((s, c) => s + c.estimatedProceeds, 0),
      capitalFreed: 0,
    },
  };
}

/**
 * Execute early exits: scan and sell near-confirmed winners.
 * Places SELL limit orders at the best bid price.
 */
export async function executeEarlyExits(
  profileId: string,
  options?: { threshold?: number; maxSells?: number },
): Promise<EarlyExitResult> {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const maxSells = options?.maxSells ?? 10;

  const scanResult = await scanForEarlyExits(profileId, threshold);
  if (scanResult.candidates.length === 0) return scanResult;

  const profile = await loadProfile(profileId);
  if (!profile) return scanResult;

  const executed: EarlyExitResult['executed'] = [];
  let capitalFreed = 0;

  for (const candidate of scanResult.candidates.slice(0, maxSells)) {
    try {
      const result = await placeProfileOrder(profile, {
        tokenId: candidate.tokenId,
        side: 'SELL',
        price: candidate.sellPrice,
        size: candidate.netSize,
      });

      const orderId = (result as any)?.orderID || (result as any)?.id || 'unknown';

      executed.push({
        tokenId: candidate.tokenId,
        outcome: candidate.outcome,
        size: candidate.netSize,
        price: candidate.sellPrice,
        orderId,
        success: true,
        message: `Sold ${candidate.netSize}x ${candidate.outcome} @ $${candidate.sellPrice}`,
      });

      capitalFreed += candidate.estimatedProceeds;

      // Log to BotLog
      await prisma.botLog.create({
        data: {
          profileId,
          level: 'trade',
          event: 'early-exit',
          message: `Early exit: SELL ${candidate.netSize}x ${candidate.outcome} @ $${candidate.sellPrice} (entry: $${candidate.avgEntryPrice}, PnL: $${candidate.estimatedPnl.toFixed(2)})`,
          data: JSON.stringify({
            conditionId: candidate.conditionId,
            tokenId: candidate.tokenId,
            orderId,
            bestBid: candidate.currentBestBid,
            avgEntry: candidate.avgEntryPrice,
            pnl: candidate.estimatedPnl,
          }),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sell failed';
      executed.push({
        tokenId: candidate.tokenId,
        outcome: candidate.outcome,
        size: candidate.netSize,
        price: candidate.sellPrice,
        orderId: '',
        success: false,
        message,
      });

      await prisma.botLog.create({
        data: {
          profileId,
          level: 'error',
          event: 'early-exit-error',
          message: `Early exit failed: ${candidate.outcome} — ${message}`,
          data: JSON.stringify({ conditionId: candidate.conditionId, error: message }),
        },
      });
    }
  }

  return {
    profileId,
    candidates: scanResult.candidates,
    executed,
    summary: {
      totalCandidates: scanResult.candidates.length,
      totalExecuted: executed.filter(e => e.success).length,
      totalProceeds: scanResult.summary.totalProceeds,
      capitalFreed: Math.round(capitalFreed * 100) / 100,
    },
  };
}
