import type { BotConfig, ScoredOpportunity, Strategy } from './types';
import { scanMarkets, scanNearExpiryMarkets, scanMicroScalpMarkets, scanComplementArbMarkets, scanPanicReversalMarkets, scanCryptoLatencyMarkets, scanMultiOutcomeArbMarkets, scanCryptoScalperMarkets } from './scanner';
import { valueBettingStrategy } from './strategies/value-betting';
import { nearExpirySniperStrategy } from './strategies/near-expiry-sniper';
import { microScalperStrategy } from './strategies/micro-scalper';
import { complementArbStrategy } from './strategies/complement-arb';
import { panicReversalStrategy } from './strategies/panic-reversal';
import { cryptoLatencyStrategy } from './strategies/crypto-latency';
import { multiOutcomeArbStrategy } from './strategies/multi-outcome-arb';
import { cryptoScalperStrategy } from './strategies/crypto-scalper';

export interface StrategyEntry {
  name: string;
  label: string;
  description: string;
  scan: (config: BotConfig) => Promise<ScoredOpportunity[]>;
  strategy: Strategy;
  autoExecutable: boolean;
  defaultTimeWindow: 'urgent' | 'minutes' | 'hours';
}

const registry: StrategyEntry[] = [
  {
    name: 'value-betting',
    label: 'Value Betting',
    description: 'Finds undervalued markets with strong volume and liquidity signals',
    scan: scanMarkets,
    strategy: valueBettingStrategy,
    autoExecutable: false,
    defaultTimeWindow: 'hours',
  },
  {
    name: 'near-expiry-sniper',
    label: 'Near Expiry Sniper',
    description: 'Targets 90-94c tokens in markets expiring within 1-8 hours',
    scan: scanNearExpiryMarkets,
    strategy: nearExpirySniperStrategy,
    autoExecutable: false,
    defaultTimeWindow: 'hours',
  },
  {
    name: 'micro-scalper',
    label: 'Micro Scalper',
    description: 'Quick trades on 93-97c tokens in 5-60 minute expiry markets',
    scan: scanMicroScalpMarkets,
    strategy: microScalperStrategy,
    autoExecutable: false,
    defaultTimeWindow: 'urgent',
  },
  {
    name: 'complement-arb',
    label: 'Complement Arb',
    description: 'Buys YES + NO when combined ask < $0.975 for guaranteed profit',
    scan: scanComplementArbMarkets,
    strategy: complementArbStrategy,
    autoExecutable: true,
    defaultTimeWindow: 'minutes',
  },
  {
    name: 'panic-reversal',
    label: 'Panic Reversal',
    description: 'Buys dips when prices drop sharply then show recovery signals',
    scan: scanPanicReversalMarkets,
    strategy: panicReversalStrategy,
    autoExecutable: false,
    defaultTimeWindow: 'hours',
  },
  {
    name: 'crypto-latency',
    label: 'Crypto Latency Arb',
    description: 'Exploits lag between Binance spot and Polymarket crypto markets',
    scan: scanCryptoLatencyMarkets,
    strategy: cryptoLatencyStrategy,
    autoExecutable: false,
    defaultTimeWindow: 'minutes',
  },
  {
    name: 'multi-outcome-arb',
    label: 'Multi-Outcome Arb',
    description: 'Buys all YES outcomes in 3+ market events when bundle cost < $0.975',
    scan: scanMultiOutcomeArbMarkets,
    strategy: multiOutcomeArbStrategy,
    autoExecutable: true,
    defaultTimeWindow: 'minutes',
  },
  {
    name: 'crypto-scalper',
    label: 'Crypto Scalper',
    description: 'Scalps crypto market dislocations across BTC, ETH, SOL, XRP',
    scan: scanCryptoScalperMarkets,
    strategy: cryptoScalperStrategy,
    autoExecutable: false,
    defaultTimeWindow: 'urgent',
  },
];

const registryMap = new Map<string, StrategyEntry>(
  registry.map((e) => [e.name, e]),
);

export function getStrategyEntry(name: string): StrategyEntry | undefined {
  return registryMap.get(name);
}

export function getAllStrategyEntries(): StrategyEntry[] {
  return registry;
}

export function getStrategyNames(): string[] {
  return registry.map((e) => e.name);
}
