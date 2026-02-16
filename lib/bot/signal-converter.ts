import type { StrategySignal, ScoredOpportunity } from './types';
import type { StrategyEntry } from './strategy-registry';
import type { ArbLeg, Opportunity } from '@/lib/skills/types';

/**
 * Convert a StrategySignal (from bot engine strategies) into an Opportunity
 * (used by the skill engine's opportunity queue).
 */
export function signalToOpportunity(
  signal: StrategySignal,
  entry: StrategyEntry,
  sourceOpp: ScoredOpportunity,
): Opportunity {
  // Confidence: score 0-100 → min(95, 40 + score * 0.55)
  const confidence = Math.round(Math.min(95, 40 + signal.score * 0.55));

  // Risk level based on score
  const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' =
    signal.score >= 70 ? 'LOW' : signal.score >= 50 ? 'MEDIUM' : 'HIGH';

  // Time window from hours to expiry
  const timeWindow: 'urgent' | 'minutes' | 'hours' =
    sourceOpp.hoursToExpiry < 0.25
      ? 'urgent'
      : sourceOpp.hoursToExpiry < 1
        ? 'minutes'
        : entry.defaultTimeWindow;

  // Expected profit
  const expectedProfit = (1 - signal.price) * signal.size * 0.98;

  // Build arb legs from secondLeg + bundleLegs
  let arbLegs: ArbLeg[] | undefined;

  if (signal.secondLeg) {
    arbLegs = [
      {
        conditionId: signal.conditionId,
        tokenId: signal.secondLeg.tokenId,
        outcome: signal.secondLeg.outcome,
        price: signal.secondLeg.price,
        size: signal.secondLeg.size,
      },
    ];
  }

  if (signal.bundleLegs && signal.bundleLegs.length > 0) {
    const bundleArbLegs: ArbLeg[] = signal.bundleLegs.map((leg) => ({
      conditionId: signal.conditionId,
      tokenId: leg.tokenId,
      outcome: leg.outcome,
      price: leg.price,
      size: leg.size,
    }));
    arbLegs = arbLegs ? [...arbLegs, ...bundleArbLegs] : bundleArbLegs;
  }

  return {
    type: entry.name,
    conditionId: signal.conditionId,
    question: signal.question,
    signal: signal.action,
    tokenId: signal.tokenId,
    outcome: signal.outcome,
    suggestedPrice: signal.price,
    suggestedSize: signal.size,
    expectedProfit,
    confidence,
    reasoning: signal.reason,
    timeWindow,
    riskLevel,
    dataPoints: {
      strategyScore: signal.score,
      hoursToExpiry: sourceOpp.hoursToExpiry,
      volume24hr: sourceOpp.volume24hr,
      liquidity: sourceOpp.liquidity,
    },
    autoExecutable: signal.autoExecutable ?? entry.autoExecutable,
    strategyScore: signal.score,
    arbLegs,
  };
}
