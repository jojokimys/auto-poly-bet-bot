import type { Strategy } from '../types';
import { valueBettingStrategy } from './value-betting';
import { nearExpirySniperStrategy } from './near-expiry-sniper';
import { microScalperStrategy } from './micro-scalper';
import { complementArbStrategy } from './complement-arb';
import { panicReversalStrategy } from './panic-reversal';
import { cryptoLatencyStrategy } from './crypto-latency';
import { multiOutcomeArbStrategy } from './multi-outcome-arb';
import { cryptoScalperStrategy } from './crypto-scalper';

const strategies = new Map<string, Strategy>();
strategies.set(valueBettingStrategy.name, valueBettingStrategy);
strategies.set(nearExpirySniperStrategy.name, nearExpirySniperStrategy);
strategies.set(microScalperStrategy.name, microScalperStrategy);
strategies.set(complementArbStrategy.name, complementArbStrategy);
strategies.set(panicReversalStrategy.name, panicReversalStrategy);
strategies.set(cryptoLatencyStrategy.name, cryptoLatencyStrategy);
strategies.set(multiOutcomeArbStrategy.name, multiOutcomeArbStrategy);
strategies.set(cryptoScalperStrategy.name, cryptoScalperStrategy);

export function getStrategy(name: string): Strategy | undefined {
  return strategies.get(name);
}

export function getDefaultStrategy(): Strategy {
  return valueBettingStrategy;
}

export function listStrategies(): string[] {
  return [...strategies.keys()];
}
