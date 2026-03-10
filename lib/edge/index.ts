// Edge detection system — 5m Crypto Up/Down Bot
export { EdgeEngine, getActiveEngine, setActiveEngine } from './engine';
export type { EngineConfig, UpDownMarket } from './engine';
export {
  calculateEdge,
  evaluateLatencyArb,
  evaluateExpirySniper,
  kellySize,
  estimateVolatility,
} from './math';
export type { EdgeResult, LatencyArbSignal, ExpirySignal } from './math';
export {
  logTradeSignal,
  logTradeResult,
  logOrderPlaced,
  getTradeStats,
  getConfidenceBuckets,
  getRecentTrades,
  getAdaptiveThresholds,
} from './trade-logger';
export type { TradeLogEntry, TradeStats, TradeStrategy, TradeOutcome } from './trade-logger';
export { scanUpDownMarkets, getNext5mSlug } from './market-scanner';
export { startRunner, stopRunner, getRunnerState } from './cycle-runner';
export { generateCycleReport, formatReportText } from './reporter';
export type { CycleReport, Improvement } from './reporter';
