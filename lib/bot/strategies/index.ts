import type { Strategy } from '../types';
import { valueBettingStrategy } from './value-betting';

const strategies = new Map<string, Strategy>();
strategies.set(valueBettingStrategy.name, valueBettingStrategy);

export function getStrategy(name: string): Strategy | undefined {
  return strategies.get(name);
}

export function getDefaultStrategy(): Strategy {
  return valueBettingStrategy;
}

export function listStrategies(): string[] {
  return [...strategies.keys()];
}
