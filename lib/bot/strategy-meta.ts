/** Shared strategy metadata — single source of truth for UI components. */

export const STRATEGY_META = [
  { key: 'value-betting', label: 'Value Betting', description: 'Undervalued markets with strong signals' },
  { key: 'near-expiry-sniper', label: 'Near Expiry Sniper', description: '90-94c tokens, 1-8h to expiry' },
  { key: 'micro-scalper', label: 'Micro Scalper', description: '93-97c tokens, 5-60min to expiry' },
  { key: 'complement-arb', label: 'Complement Arb', description: 'YES+NO < $0.975, auto-execute' },
  { key: 'panic-reversal', label: 'Panic Reversal', description: 'Buy sharp dips with recovery signals' },
  { key: 'crypto-latency', label: 'Crypto Latency Arb', description: 'Binance vs Polymarket lag' },
  { key: 'multi-outcome-arb', label: 'Multi-Outcome Arb', description: '3+ market bundle < $0.975' },
  { key: 'crypto-scalper', label: 'Crypto Scalper', description: 'Crypto market dislocation scalps' },
] as const;

export const STRATEGY_LABELS: Record<string, string> = Object.fromEntries(
  STRATEGY_META.map((s) => [s.key, s.label]),
);
