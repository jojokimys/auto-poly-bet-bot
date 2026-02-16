import type { Strategy, ScoredOpportunity, BotConfig, StrategySignal } from '../types';

/**
 * Crypto Dislocation Scalper Strategy
 *
 * Stateful strategy that exploits price dislocations between Binance spot
 * prices and Polymarket crypto prediction markets.
 *
 * Key features:
 * - Per-profile position tracking (in-memory)
 * - BUY when market price is dislocated from fair price (undervalued)
 * - SELL when take-profit, stop-loss, time-exit, or dislocation-close triggers
 * - Only enters at extreme prices (≤15c or ≥85c) to minimize fee drag
 * - First strategy in the bot that generates SELL signals
 */

// ─── Position Tracker ────────────────────────────────────

interface TrackedPosition {
  tokenId: string;
  conditionId: string;
  outcome: string;
  entryPrice: number;
  entryTime: number;
  size: number;
  targetPrice: number; // take-profit
  stopPrice: number;   // stop-loss
}

/** profileId → (conditionId → TrackedPosition) */
const positionsByProfile = new Map<string, Map<string, TrackedPosition>>();

/** Get or create the positions map for a profile */
function getProfilePositions(profileId: string): Map<string, TrackedPosition> {
  let map = positionsByProfile.get(profileId);
  if (!map) {
    map = new Map();
    positionsByProfile.set(profileId, map);
  }
  return map;
}

/** Expose for testing / debugging */
export function getTrackedPositions(profileId?: string): ReadonlyMap<string, TrackedPosition> {
  if (profileId) {
    return getProfilePositions(profileId);
  }
  // Legacy: return first profile's positions or empty map
  const first = positionsByProfile.values().next().value;
  return first ?? new Map();
}

// ─── Fair Price Calculator ───────────────────────────────

function calcFairYesPrice(spotPrice: number, strikePrice: number): number {
  if (!Number.isFinite(spotPrice) || !Number.isFinite(strikePrice)) return 0.5;
  if (strikePrice <= 0) return 0.5;
  const pctFromStrike = (spotPrice - strikePrice) / strikePrice;
  // ±0.4% maps to ~0.02..0.98 range; scale factor 120 for sensitivity
  const raw = 0.50 + pctFromStrike * 120;
  return Math.max(0.05, Math.min(0.95, raw));
}

// ─── Strategy ────────────────────────────────────────────

export const cryptoScalperStrategy: Strategy = {
  name: 'crypto-scalper',

  evaluate(
    opp: ScoredOpportunity,
    _config: BotConfig,
    balance: number,
    _openPositionCount: number,
    profileId?: string,
  ): StrategySignal | null {
    // Must have crypto scalper data from scanner
    if (opp.spotPrice == null || opp.openingPrice == null) return null;
    if (opp.openingPrice <= 0) return null;
    if (!opp.cryptoAsset) return null;

    const pid = profileId ?? '_default';
    const positions = getProfilePositions(pid);

    const minutesToExpiry = opp.hoursToExpiry * 60;
    const fairYes = calcFairYesPrice(opp.spotPrice, opp.openingPrice);
    const fairNo = 1 - fairYes;

    // ── Check for EXIT on existing position ──────────────
    const existing = positions.get(opp.conditionId);
    if (existing) {
      return evaluateExit(opp, existing, fairYes, fairNo, minutesToExpiry, pid, positions);
    }

    // ── ENTRY Logic (no existing position) ───────────────
    return evaluateEntry(opp, balance, fairYes, fairNo, minutesToExpiry, pid, positions);
  },
};

// ─── Exit Logic ──────────────────────────────────────────

function evaluateExit(
  opp: ScoredOpportunity,
  pos: TrackedPosition,
  fairYes: number,
  fairNo: number,
  minutesToExpiry: number,
  profileId: string,
  positions: Map<string, TrackedPosition>,
): StrategySignal | null {
  // Determine current market price for the held token
  const currentPrice = pos.outcome === 'Yes' ? opp.yesPrice : opp.noPrice;
  const fairPrice = pos.outcome === 'Yes' ? fairYes : fairNo;
  const holdMinutes = (Date.now() - pos.entryTime) / (1000 * 60);

  let reason = '';

  // 1. Take profit
  if (currentPrice >= pos.targetPrice) {
    reason = `TakeProfit: ${(currentPrice * 100).toFixed(0)}c >= target ${(pos.targetPrice * 100).toFixed(0)}c`;
  }
  // 2. Stop loss
  else if (currentPrice <= pos.stopPrice) {
    reason = `StopLoss: ${(currentPrice * 100).toFixed(0)}c <= stop ${(pos.stopPrice * 100).toFixed(0)}c`;
  }
  // 3. Time-based exit (12+ minutes held)
  else if (holdMinutes >= 12) {
    reason = `TimeExit: held ${holdMinutes.toFixed(0)}min (max 12)`;
  }
  // 4. Dislocation closed (fair vs market < 2c)
  else if (Math.abs(fairPrice - currentPrice) < 0.02) {
    reason = `DislocationClosed: gap ${(Math.abs(fairPrice - currentPrice) * 100).toFixed(1)}c < 2c`;
  }
  // No exit trigger
  else {
    return null;
  }

  // Remove tracked position
  positions.delete(opp.conditionId);

  return {
    action: 'SELL',
    tokenId: pos.tokenId,
    outcome: pos.outcome,
    conditionId: opp.conditionId,
    question: opp.question,
    price: currentPrice,
    size: pos.size,
    reason: `CryptoScalper EXIT [${opp.cryptoAsset}]: ${reason}, ${minutesToExpiry.toFixed(0)}min left`,
    score: 80, // Exit signals are always high priority
  };
}

// ─── Entry Logic ─────────────────────────────────────────

function evaluateEntry(
  opp: ScoredOpportunity,
  balance: number,
  fairYes: number,
  fairNo: number,
  minutesToExpiry: number,
  profileId: string,
  positions: Map<string, TrackedPosition>,
): StrategySignal | null {
  // Hard filter: time window 3-45 minutes
  if (minutesToExpiry < 3 || minutesToExpiry > 45) return null;

  // Determine which side is undervalued
  const yesDislocation = fairYes - opp.yesPrice; // positive = YES undervalued
  const noDislocation = fairNo - opp.noPrice;     // positive = NO undervalued

  let targetTokenId: string;
  let targetOutcome: string;
  let targetPrice: number;
  let dislocation: number;
  let fairPrice: number;

  if (yesDislocation >= noDislocation && yesDislocation > 0) {
    targetTokenId = opp.yesTokenId ?? opp.tokenId;
    targetOutcome = 'Yes';
    targetPrice = opp.yesPrice;
    dislocation = yesDislocation;
    fairPrice = fairYes;
  } else if (noDislocation > 0) {
    targetTokenId = opp.noTokenId ?? opp.tokenId;
    targetOutcome = 'No';
    targetPrice = opp.noPrice;
    dislocation = noDislocation;
    fairPrice = fairNo;
  } else {
    return null; // No undervaluation found
  }

  // Hard filter: extreme prices only (≤15c or ≥85c) for low fees
  if (targetPrice > 0.15 && targetPrice < 0.85) return null;

  // Hard filter: minimum 5c dislocation
  if (dislocation < 0.05) return null;

  // ── Scoring (0-100) ───────────────────────────────────

  let score = 0;

  // Dislocation size (0-35 pts): bigger gap = better opportunity
  const dislocPts = Math.min(35, (dislocation / 0.15) * 35);
  score += dislocPts;

  // Spot move magnitude (0-25 pts): big spot move = stronger conviction
  const pctFromStrike = Math.abs(
    (opp.spotPrice! - opp.openingPrice!) / opp.openingPrice!,
  );
  const movePts = Math.min(25, (pctFromStrike / 0.005) * 25);
  score += movePts;

  // Time remaining (0-20 pts): 5-20 min is optimal
  let timePts = 0;
  if (minutesToExpiry >= 5 && minutesToExpiry <= 20) timePts = 20;
  else if (minutesToExpiry >= 3 && minutesToExpiry < 5) timePts = 12;
  else if (minutesToExpiry > 20 && minutesToExpiry <= 35) timePts = 15;
  else timePts = 8;
  score += timePts;

  // Volume (0-20 pts)
  const volPts = Math.min(20, Math.log10(Math.max(1, opp.volume24hr)) * 4);
  score += volPts;

  // Minimum confidence threshold
  if (score < 50) return null;

  // ── Position Sizing (conservative: 2-3% of balance) ───

  const confidence = Math.min(1.0, score / 80);
  const targetCost = balance * 0.025 * confidence;
  const size = Math.floor((targetCost / targetPrice) * 100) / 100;
  if (size <= 0) return null;

  // ── Calculate take-profit and stop-loss ────────────────

  const targetPriceTP = targetPrice + dislocation * 0.5; // 50% of dislocation
  const stopPrice = targetPrice - 0.03;                  // 3c adverse move

  // Track the position in memory
  const tracked: TrackedPosition = {
    tokenId: targetTokenId,
    conditionId: opp.conditionId,
    outcome: targetOutcome,
    entryPrice: targetPrice,
    entryTime: Date.now(),
    size,
    targetPrice: targetPriceTP,
    stopPrice,
  };
  positions.set(opp.conditionId, tracked);

  return {
    action: 'BUY',
    tokenId: targetTokenId,
    outcome: targetOutcome,
    conditionId: opp.conditionId,
    question: opp.question,
    price: targetPrice,
    size,
    reason: [
      `CryptoScalper ENTRY [${opp.cryptoAsset}]:`,
      `${targetOutcome} @ ${(targetPrice * 100).toFixed(0)}c`,
      `fair ${(fairPrice * 100).toFixed(0)}c`,
      `gap ${(dislocation * 100).toFixed(0)}c`,
      `TP ${(targetPriceTP * 100).toFixed(0)}c / SL ${(stopPrice * 100).toFixed(0)}c`,
      `${minutesToExpiry.toFixed(0)}min left`,
      `score ${score.toFixed(0)}/100`,
    ].join(', '),
    score,
  };
}
