# Near-Expiry Sniper Strategy

**Version:** 1.0
**Date:** February 2026
**Capital Allocation:** ~$100 USDC
**Strategy Class:** Settlement-focused, high-certainty harvesting
**Complementary To:** Value Betting Strategy (existing)

---

## Table of Contents

1. [Strategy Overview](#1-strategy-overview)
2. [Market Research & Empirical Data](#2-market-research--empirical-data)
3. [Entry Criteria (Quantitative Thresholds)](#3-entry-criteria-quantitative-thresholds)
4. [Multi-Signal Confirmation System](#4-multi-signal-confirmation-system)
5. [Position Sizing Formula](#5-position-sizing-formula)
6. [Exit Rules](#6-exit-rules)
7. [Risk Management](#7-risk-management)
8. [Expected Returns Analysis](#8-expected-returns-analysis)
9. [API Cost Awareness & Optimization](#9-api-cost-awareness--optimization)
10. [Implementation Pseudocode](#10-implementation-pseudocode)
11. [Comparison: Near-Expiry Sniper vs. Value Betting](#11-comparison-near-expiry-sniper-vs-value-betting)
12. [Backtesting Considerations](#12-backtesting-considerations)
13. [Known Failure Modes & Mitigations](#13-known-failure-modes--mitigations)
14. [Daily Operations Checklist](#14-daily-operations-checklist)
15. [Kill Switch Criteria](#15-kill-switch-criteria)
16. [Sources & References](#16-sources--references)

---

## 1. Strategy Overview

The **Near-Expiry Sniper** buys outcome tokens priced between 90-99 cents in markets expiring within 1-72 hours, where the outcome is nearly certain. It captures the residual 1-10% discount as profit when the market resolves to $1.00 (minus the 2% winner fee).

This is the prediction market equivalent of buying a Treasury bill at a discount and holding it to maturity. The edge is not informational -- it is structural: most traders do not bother harvesting 2-8% returns on near-certain outcomes, creating persistent small discounts that compound into meaningful daily returns when systematically captured.

### Core Thesis

1. Markets trading at 90-99 cents with <72 hours to expiry have an empirically measured ~94% accuracy rate (Polymarket's own data shows 94.2% accuracy 4 hours before resolution).
2. The 2% winner fee means our effective payout is $0.98 per share, not $1.00. Therefore, we only profit on tokens bought below $0.98.
3. By requiring multiple confirmation signals (price momentum, volume, spread, time decay), we filter out the ~6% of cases where "near-certain" outcomes reverse, pushing our effective accuracy toward 97-99%.

### How It Differs From "Bond Strategy" (Strategy 8.3 in STRATEGY_REPORT.md)

The existing Bond Strategy targets 93-98 cent tokens with 1-4 week hold times. The Near-Expiry Sniper is a **time-compressed variant** optimized for:
- Shorter hold periods (hours, not weeks) for faster capital recycling
- Higher price floor (90 cents, not 93 cents) for a safer entry range
- More aggressive signal confirmation to compensate for the narrower time window
- Multiple positions per day instead of weekly rebalancing

---

## 2. Market Research & Empirical Data

### 2.1 Polymarket Accuracy by Time-to-Resolution

Source: [Polymarket Accuracy Page](https://polymarket.com/accuracy) and [Bitget News Analysis](https://www.bitget.com/news/detail/12560604659412)

| Time Before Resolution | Platform Accuracy |
|------------------------|-------------------|
| 1 month                | 90.5%            |
| 1 week                 | 89.2%            |
| 1 day (24 hours)       | 88.6%            |
| 12 hours               | 90.2%            |
| 4 hours                | **94.2%**        |

**Key insight:** Accuracy actually *dips* at 24 hours before rising sharply at 4 hours. This suggests that our sweet spot is **under 12 hours to resolution**, where the market has converged on the correct outcome with high confidence.

**Calibration caveat:** A December 2025 study ([DL News](https://www.dlnews.com/articles/markets/polymarket-kalshi-prediction-markets-not-so-reliable-says-study/)) found Polymarket's overall accuracy may be lower (67%) across all markets. However, this includes low-probability markets and early-stage markets. For markets already priced >90 cents within hours of resolution, the accuracy is significantly higher -- the 94.2% figure at 4 hours specifically applies to our target range.

### 2.2 90-99 Cent Token Success Rate (Estimated)

No public dataset provides exact success rates by price bucket. However, we can derive estimates:

| Price Bucket | Implied Probability | Estimated Actual Success Rate | Notes |
|-------------|--------------------|-----------------------------|-------|
| 90-92 cents | 90-92%             | ~88-91%                     | Slight overconfidence bias at this level |
| 93-95 cents | 93-95%             | ~92-94%                     | More reliable; approaching consensus |
| 96-98 cents | 96-98%             | ~95-97%                     | High consensus; spread usually tight |
| 98-99 cents | 98-99%             | ~97-99%                     | Near-certain; very thin margin |

**Overconfidence adjustment:** Research shows Polymarket prices slightly overstate probabilities (predicted probability is "almost always slightly higher than the actual frequency"). We apply a 1-2% haircut to implied probabilities as a safety margin.

### 2.3 Market Resolution Frequency

Based on Polymarket ecosystem analysis:
- The platform hosts **hundreds of active markets** at any time across politics, crypto, sports, entertainment, and geopolitics
- Markets with defined end dates (sports events, scheduled announcements, deadline-based questions) typically close within **24-48 hours** of their event
- Recurring markets (daily crypto price markets, weekly economic data) provide a **steady pipeline** of near-expiry opportunities
- Conservative estimate: **5-15 markets per day** enter the 1-72 hour expiry window with prices in the 90-99 cent range

### 2.4 Common Failure Modes

Source: [CryptoSlate](https://cryptoslate.com/polymarket-faces-major-credibility-crisis-after-whales-forced-a-yes-ufo-vote-without-evidence/), [Medium](https://medium.com/@balajibal/why-are-polymarket-betters-losing-money-af3cc506fd9a)

| Failure Mode | Frequency | Description | Impact |
|-------------|-----------|-------------|--------|
| **Whale manipulation** | Rare but devastating | Single large player moves price to 95+ cents on a false narrative, then the market resolves against | 100% loss on position |
| **Ambiguous resolution criteria** | Occasional | Market wording is subjective; UMA oracle disputes can flip expected outcome | 100% loss on position |
| **Delayed resolution** | Common (10-20% of markets) | Market doesn't resolve on expected date; capital locked for days/weeks | Opportunity cost, not capital loss |
| **Surprise reversal** | Rare at >90 cents (<6%) | Genuine late-breaking news changes outcome after price has converged | 100% loss on position |
| **Oracle dispute** | Rare (<2%) | UMA Optimistic Oracle proposal is challenged during 2-hour window | Delayed resolution, usually correct outcome prevails |
| **58% negative serial correlation** | Common in volatile markets | Price spikes are reversed next day (noise trading/overreaction) | Less relevant at >90 cents where directional conviction is strong |

---

## 3. Entry Criteria (Quantitative Thresholds)

A market qualifies for the Near-Expiry Sniper if and only if ALL of the following criteria are met:

### 3.1 Hard Filters (Binary Pass/Fail)

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| **Outcome price** | 0.90 <= price <= 0.97 | Below 0.90 is too uncertain. Above 0.97, the net profit after 2% fee is <1 cent -- not worth the risk |
| **Hours to expiry** | 1 <= hours <= 72 | Under 1 hour has fill risk. Over 72 hours has too much reversal risk |
| **Market is active** | active === true, closed === false | Must be tradeable |
| **Minimum liquidity** | >= $500 | Need enough depth to fill our small orders |
| **Minimum 24hr volume** | >= $1,000 | Volume validates that price discovery is real, not a stale market |
| **Maximum spread** | <= 0.04 (4 cents) | Wide spread = no consensus, potential for manipulation |
| **Opposing outcome price** | <= 0.12 | If Yes = 0.93 but No = 0.12 (sum = 1.05), the spread is abnormal. Both sides should approximately sum to ~1.00 |

### 3.2 Soft Scoring Criteria (Weighted Score)

Markets passing hard filters are scored on a 0-100 scale:

| Signal | Weight | Scoring Logic |
|--------|--------|---------------|
| **Price level** | 25 pts | Higher price = higher certainty. Score = (price - 0.90) / 0.07 * 25 |
| **Time decay** | 25 pts | Closer to expiry = more certainty. Score = max(0, 25 - (hours / 72 * 25)) |
| **Price momentum** | 20 pts | Price trending toward $1 over last 24h. Score based on price delta |
| **Volume spike** | 15 pts | 24hr volume above average = conviction. Score = min(15, log10(vol/1000) * 5) |
| **Spread tightness** | 15 pts | Tighter spread = stronger consensus. Score = max(0, 15 - spread * 375) |

**Minimum qualifying score: 60 out of 100**

### 3.3 Effective Profit Range

Given the 2% winner fee, our actual profit per share is:

```
net_profit_per_share = $0.98 - entry_price

At 90 cents: $0.98 - $0.90 = $0.08 (8.9% return)
At 93 cents: $0.98 - $0.93 = $0.05 (5.4% return)
At 95 cents: $0.98 - $0.95 = $0.03 (3.2% return)
At 97 cents: $0.98 - $0.97 = $0.01 (1.0% return)
```

The sweet spot is **93-96 cents** -- enough margin to justify the risk, but high enough certainty to expect resolution in our favor.

---

## 4. Multi-Signal Confirmation System

Each signal is computed independently. We require at least 3 of 4 signals to confirm before entering.

### 4.1 Price Momentum Signal

**Question:** Has the price been steadily climbing toward $1?

```
momentum_signal = TRUE if:
  - current_price > price_12h_ago  (price is rising)
  - current_price > price_24h_ago  (sustained trend)
  - No single candle dropped more than 3 cents in the last 24h (no sudden reversals)

Momentum score (0-20):
  price_delta_24h = current_price - price_24h_ago
  if price_delta_24h < 0: score = 0 (FAIL -- price declining)
  if price_delta_24h >= 0 and price_delta_24h < 0.02: score = 5
  if price_delta_24h >= 0.02 and price_delta_24h < 0.05: score = 12
  if price_delta_24h >= 0.05: score = 20
```

**Implementation note:** We approximate this using Gamma API's `outcomePrices` field at scan time versus a cached price from the previous scan. For the initial version, we store the last 24 hours of scanned prices in a Map keyed by conditionId.

### 4.2 Volume Spike Signal

**Question:** Is there high conviction from other traders?

```
volume_signal = TRUE if:
  - volume_24hr > $2,000  (above minimum threshold)
  - volume_24hr > liquidity * 0.3  (volume is material relative to market depth)

Volume score (0-15):
  vol_ratio = volume_24hr / max(1, liquidity)
  if vol_ratio < 0.1: score = 0
  if vol_ratio >= 0.1 and vol_ratio < 0.3: score = 5
  if vol_ratio >= 0.3 and vol_ratio < 0.5: score = 10
  if vol_ratio >= 0.5: score = 15
```

### 4.3 Time Decay Signal

**Question:** Is the market close enough to expiry that the outcome is nearly determined?

```
time_signal = TRUE if:
  - hoursToExpiry <= 24  (within 1 day)
  - OR (hoursToExpiry <= 48 AND price >= 0.95)  (2 days but very high confidence)

Time decay score (0-25):
  if hoursToExpiry <= 4: score = 25  (highest certainty window per research)
  if hoursToExpiry <= 12: score = 22
  if hoursToExpiry <= 24: score = 18
  if hoursToExpiry <= 48: score = 12
  if hoursToExpiry <= 72: score = 6
```

### 4.4 Spread Analysis Signal

**Question:** Is there strong market consensus?

```
spread_signal = TRUE if:
  - spread <= 0.03 (3 cents or tighter)
  - AND (yes_price + no_price) is between 0.97 and 1.03  (healthy market)

Spread score (0-15):
  if spread <= 0.01: score = 15  (razor-tight, strong consensus)
  if spread <= 0.02: score = 12
  if spread <= 0.03: score = 8
  if spread <= 0.04: score = 4
  if spread > 0.04: score = 0  (hard-filtered out, but listed for completeness)
```

### 4.5 Confirmation Gate

```
confirmed_signals = count([momentum_signal, volume_signal, time_signal, spread_signal])
PASS if confirmed_signals >= 3
```

If only 2 signals confirm, the opportunity is logged but skipped. If all 4 confirm, the position size receives a 20% bonus (see Section 5).

---

## 5. Position Sizing Formula

### 5.1 Base Position Size

```
max_per_trade = portfolio_balance * 0.05    // 5% of portfolio per trade
                                             // For $100 balance: $5 per trade

// Confidence-adjusted sizing
confidence = min(1.0, total_score / 80)     // Score of 80+ gets full allocation
base_cost = max_per_trade * confidence

// All-signals bonus: if all 4 signals confirm, allow up to 7% per trade
if confirmed_signals == 4:
    base_cost = min(base_cost * 1.2, portfolio_balance * 0.07)

// Compute share count
shares = base_cost / entry_price

// Round down to 2 decimal places for CLOB compatibility
shares = floor(shares * 100) / 100
```

### 5.2 Worked Example

```
Portfolio: $100 USDC
Market: "Will the Fed announce rates by Feb 15?" -- Yes trading at $0.94
Score: 72 / 100
Confirmed signals: 3 of 4

max_per_trade = $100 * 0.05 = $5.00
confidence = min(1.0, 72 / 80) = 0.9
base_cost = $5.00 * 0.9 = $4.50
shares = $4.50 / $0.94 = 4.78 shares

If wins: 4.78 * $0.98 = $4.68 payout, minus $4.50 cost = $0.18 profit (4.0%)
If loses: 4.78 * $0.00 = $0.00, loss = $4.50 (-100% of position, -4.5% of portfolio)
```

### 5.3 Maximum Simultaneous Positions

```
max_open_positions = 8               // Allow more positions than value-betting since
                                     // these are smaller and resolve faster
max_portfolio_exposure = 0.35        // 35% of balance tied up at any time
                                     // For $100: max $35 deployed across all sniper positions
```

---

## 6. Exit Rules

### 6.1 Primary Exit: Resolution (Auto-Settlement)

The primary exit is **no action required**. When the market resolves:
- If our outcome wins: We receive $0.98 per share (after 2% winner fee) automatically via on-chain settlement
- If our outcome loses: Shares become worthless ($0.00)

**Settlement timing:** Resolution typically occurs within 2-4 hours after the market's end condition is met. The UMA Optimistic Oracle has a 2-hour challenge period. Capital is locked during this period.

### 6.2 Stop-Loss Exit

```
stop_loss_trigger = entry_price - 0.03    // 3 cent stop-loss

// Example: bought at $0.94, stop-loss at $0.91
// If price drops to $0.91, immediately place SELL order at market

// Implementation: check price on each scan cycle
if current_price <= stop_loss_trigger:
    place_sell_order(token_id, shares, current_price)
    log("STOP-LOSS triggered", { entry: entry_price, exit: current_price, loss_pct })
```

**Why 3 cents:** A 3-cent drop from a 94-cent position represents a ~3.2% loss on the position and a ~0.16% loss on the portfolio (with 5% position sizing). This is tight enough to prevent catastrophic losses while loose enough to avoid being stopped out by normal spread fluctuations.

### 6.3 Time-Based Exit

```
// If market hasn't resolved within 48 hours after expected end date, exit
if hours_since_end_date > 48 AND market_still_active:
    // Market resolution is delayed -- capital is stuck
    // Sell at current price to free up capital for other opportunities
    place_sell_order(token_id, shares, current_bid_price)
    log("TIME-EXIT: resolution delayed", { expected: end_date, hours_overdue: 48 })
```

### 6.4 Reversal Exit

```
// If price drops by 5+ cents from our entry within 2 hours, this is a strong reversal signal
if current_price <= entry_price - 0.05 AND hours_since_entry <= 2:
    // Emergency exit -- something fundamentally changed
    place_sell_order(token_id, shares, current_bid_price)
    log("REVERSAL-EXIT: rapid price drop", { entry: entry_price, current: current_price })
```

---

## 7. Risk Management

### 7.1 Position-Level Controls

| Control | Threshold | Action |
|---------|-----------|--------|
| Max cost per trade | 5% of portfolio ($5 for $100) | Hard cap on order size |
| Stop-loss per trade | Entry price minus 3 cents | Sell at market |
| Max loss per trade | ~$5 (entire position) | Accepted risk per position |
| Never buy below | 85 cents | Hard filter (our floor is actually 90 cents) |
| Never buy above | 97 cents (net profit <1% after fee) | Hard filter |

### 7.2 Portfolio-Level Controls

| Control | Threshold | Action |
|---------|-----------|--------|
| Max open positions | 8 | Skip new opportunities until positions resolve |
| Max portfolio exposure | 35% ($35 for $100) | Skip new opportunities |
| Max daily loss | 5% of portfolio ($5 for $100) | Pause sniper for remainder of day |
| Max weekly loss | 10% of portfolio ($10 for $100) | Pause sniper for remainder of week |
| Max per-market category | 50% of exposure | Diversify across categories |

### 7.3 Blacklist Rules

Skip markets that match any of the following:

1. **Subjective resolution criteria** -- Markets with words like "significantly", "major", "effectively" in their resolution description (require human judgment, prone to disputes)
2. **First-of-kind markets** -- No historical precedent for how the market resolves (higher oracle dispute risk)
3. **Known controversial markets** -- Markets with active comment threads disputing resolution criteria
4. **Markets with recent 5%+ reversal** -- If the price dropped from 98 cents to 90 cents in the last 24 hours, skip it (the reversal itself is the signal that certainty was overstated)
5. **Markets with >2 cent sum deviation** -- If yes_price + no_price deviates from 1.00 by more than 2 cents in either direction, the market has structural issues

---

## 8. Expected Returns Analysis

### 8.1 Per-Trade Economics

```
Assumptions:
  - Average entry price: $0.94 (mid-range of 90-97 cent target)
  - Win rate: 96% (conservative, filtered population)
  - Average position size: $4.50 (90% of $5 max)
  - Average shares per trade: 4.50 / 0.94 = 4.79 shares

Per winning trade:
  Revenue: 4.79 * $0.98 = $4.69
  Cost: $4.50
  Profit: $0.19 (4.3% return on position)

Per losing trade:
  Revenue: $0.00
  Cost: $4.50 (or less if stop-loss triggers at ~$4.36)
  Loss: -$4.36 to -$4.50

Expected value per trade:
  EV = 0.96 * $0.19 + 0.04 * (-$4.36) = $0.182 - $0.174 = $0.008
  EV per trade ~ +$0.01 to +$0.02 (0.1-0.4% of portfolio)
```

**Critical observation:** The expected value per trade is *razor thin*. The strategy's profitability depends entirely on maintaining a >95% win rate. Below 95.5%, the strategy becomes EV-negative.

### 8.2 Daily Return Projections

| Scenario | Trades/Day | Win Rate | Daily Profit | Daily Return | Monthly Return |
|----------|-----------|----------|-------------|-------------|----------------|
| **Conservative** | 2 | 96% | $0.02 | 0.02% | 0.6% |
| **Base case** | 4 | 97% | $0.12 | 0.12% | 3.6% |
| **Optimistic** | 6 | 98% | $0.30 | 0.30% | 9.0% |
| **Best case** | 8 | 99% | $0.60 | 0.60% | 18.0% |

**Reality check for $100 capital:** At 4 trades per day with 97% win rate, expect approximately **$0.10-$0.15 daily profit** ($3-4.50 per month, 3-4.5% monthly return). This is modest but compounds meaningfully:

```
Starting: $100
After 1 month: $103.60
After 3 months: $111.16
After 6 months: $123.58
After 12 months: $152.73
```

### 8.3 Worst-Case Scenario

```
Day with 2 losing trades out of 4:
  Losses: 2 * $4.36 = -$8.72
  Wins: 2 * $0.19 = +$0.38
  Net: -$8.34 (8.3% portfolio drawdown in one day)

This would trigger the daily 5% loss limit after the first loss + part of the second,
pausing the strategy for the rest of the day. Actual maximum daily loss: ~$5-6.
```

### 8.4 Break-Even Win Rate

```
With average entry at $0.94:
  Profit per win = $0.98 - $0.94 = $0.04
  Loss per loss (with stop-loss) = $0.94 - $0.91 = $0.03 (best case)
  Loss per loss (full loss) = $0.94 (worst case)

Break-even (with stop-loss): WR * 0.04 = (1-WR) * 0.03 --> WR = 42.9%
Break-even (no stop-loss):   WR * 0.04 = (1-WR) * 0.94 --> WR = 95.9%

The stop-loss dramatically improves our break-even win rate from 95.9% to 42.9%.
HOWEVER: in practice, if the stop-loss triggers at 91 cents on a market that
ultimately resolves YES, we've converted a winning trade into a 3-cent loss.
Stop-loss should only trigger on genuine reversals, not temporary dips.
```

---

## 9. API Cost Awareness & Optimization

### 9.1 API Call Budget

The strategy uses the existing Gamma API and CLOB API infrastructure. Key optimization:

| Operation | Frequency | Calls/Day | API |
|-----------|-----------|-----------|-----|
| Market scan (fetch active markets) | Every 3 minutes | 480 | Gamma |
| Price check (open positions) | Every 3 minutes | 480 * N_positions | CLOB |
| Order book check (before entry) | Per opportunity | ~10-20 | CLOB |
| Place order | Per trade | ~4-8 | CLOB (auth) |
| Balance check | Every 3 minutes | 480 | CLOB (auth) |

**Total estimated daily calls: ~1,500-2,500**

### 9.2 Optimization Techniques

1. **Batch market scans:** The Gamma API supports `limit=100` in a single call. We fetch 100 markets sorted by volume and filter client-side, rather than making multiple targeted queries.

2. **Scan interval tuning:** Near-expiry markets don't need second-by-second monitoring. A 3-minute scan interval provides sufficient granularity while keeping API calls under 500/day for the scan loop.

3. **Cache last-known prices:** Store `Map<conditionId, { price, timestamp }>` in memory. Only fetch fresh order book data for markets that pass the hard filter and score above 50.

4. **Skip redundant checks:** If a market was scored on the previous cycle and rejected, don't re-score it unless its price changed by >1 cent (use cached price comparison).

5. **Piggyback on value-betting scans:** If the value-betting strategy is also running, share the market fetch results. Both strategies can evaluate the same fetched markets in a single cycle.

### 9.3 Scan Interval by Time-to-Expiry

```
if hoursToExpiry > 48:  scan every 10 minutes  (low urgency)
if hoursToExpiry > 12:  scan every 5 minutes   (moderate urgency)
if hoursToExpiry > 4:   scan every 3 minutes   (high urgency)
if hoursToExpiry <= 4:  scan every 2 minutes   (critical window -- highest accuracy)
```

---

## 10. Implementation Pseudocode

### 10.1 The `evaluate()` Function

This follows the existing `Strategy` interface defined in `lib/bot/types.ts`:

```typescript
// Strategy interface (existing):
// evaluate(opp: ScoredOpportunity, config: BotConfig, balance: number, openPositionCount: number): StrategySignal | null

/**
 * Near-Expiry Sniper Strategy
 *
 * Targets markets expiring within 1-72 hours where one outcome is
 * priced 90-97 cents. Buys near-certain outcomes and holds to
 * resolution for 1-8% returns per trade in hours.
 */

// In-memory price history for momentum calculation
const priceHistory: Map<string, { price: number; timestamp: number }[]> = new Map();

const WINNER_FEE = 0.02;
const EFFECTIVE_PAYOUT = 1.0 - WINNER_FEE; // $0.98

export const nearExpirySniperStrategy: Strategy = {
  name: 'near-expiry-sniper',

  evaluate(
    opp: ScoredOpportunity,
    config: BotConfig,
    balance: number,
    openPositionCount: number
  ): StrategySignal | null {

    // ============================================
    // STAGE 1: Hard Filters (fast rejection)
    // ============================================

    // Only target high-probability outcomes (90-97 cents)
    if (opp.price < 0.90 || opp.price > 0.97) return null;

    // Only target near-expiry markets (1-72 hours)
    if (opp.hoursToExpiry < 1 || opp.hoursToExpiry > 72) return null;

    // Minimum liquidity and volume
    if (opp.liquidity < 500) return null;
    if (opp.volume24hr < 1000) return null;

    // Maximum spread (consensus check)
    if (opp.spread > 0.04) return null;

    // Sum check: yes + no should be approximately 1.00
    const priceSum = opp.yesPrice + opp.noPrice;
    if (Math.abs(priceSum - 1.0) > 0.02) return null;

    // Opposing outcome must be low (consistency check)
    const opposingPrice = opp.outcome === 'Yes' ? opp.noPrice : opp.yesPrice;
    if (opposingPrice > 0.12) return null;

    // Net profit must be positive after winner fee
    const netProfitPerShare = EFFECTIVE_PAYOUT - opp.price;
    if (netProfitPerShare <= 0.005) return null; // Less than half a cent -- not worth it

    // ============================================
    // STAGE 2: Signal Scoring (multi-factor)
    // ============================================

    let totalScore = 0;
    let confirmedSignals = 0;

    // --- Signal 1: Price Level (0-25 pts) ---
    const priceScore = ((opp.price - 0.90) / 0.07) * 25;
    totalScore += Math.min(25, Math.max(0, priceScore));

    // --- Signal 2: Time Decay (0-25 pts) ---
    let timeScore = 0;
    if (opp.hoursToExpiry <= 4)        timeScore = 25;
    else if (opp.hoursToExpiry <= 12)  timeScore = 22;
    else if (opp.hoursToExpiry <= 24)  timeScore = 18;
    else if (opp.hoursToExpiry <= 48)  timeScore = 12;
    else                                timeScore = 6;
    totalScore += timeScore;

    if (timeScore >= 18) confirmedSignals++; // Time signal confirmed if <= 24h

    // --- Signal 3: Price Momentum (0-20 pts) ---
    let momentumScore = 0;
    const history = priceHistory.get(opp.conditionId) || [];
    const now = Date.now();

    // Store current price for future momentum calculations
    history.push({ price: opp.price, timestamp: now });
    // Keep only last 24 hours of data
    const cutoff = now - 24 * 60 * 60 * 1000;
    const recentHistory = history.filter(h => h.timestamp >= cutoff);
    priceHistory.set(opp.conditionId, recentHistory);

    if (recentHistory.length >= 2) {
      const oldestPrice = recentHistory[0].price;
      const priceDelta = opp.price - oldestPrice;

      // Check for sudden reversals (any 3+ cent drop in history)
      let hasReversal = false;
      for (let i = 1; i < recentHistory.length; i++) {
        if (recentHistory[i - 1].price - recentHistory[i].price >= 0.03) {
          hasReversal = true;
          break;
        }
      }

      if (hasReversal) {
        // HARD REJECT: sudden reversal detected
        return null;
      }

      if (priceDelta < 0)         momentumScore = 0;  // Declining
      else if (priceDelta < 0.02) momentumScore = 5;
      else if (priceDelta < 0.05) momentumScore = 12;
      else                        momentumScore = 20;

      if (priceDelta > 0) confirmedSignals++; // Momentum signal confirmed
    } else {
      // No history yet -- neutral score
      momentumScore = 8;
    }
    totalScore += momentumScore;

    // --- Signal 4: Volume Conviction (0-15 pts) ---
    let volumeScore = 0;
    const volRatio = opp.volume24hr / Math.max(1, opp.liquidity);
    if (volRatio < 0.1)      volumeScore = 0;
    else if (volRatio < 0.3) volumeScore = 5;
    else if (volRatio < 0.5) volumeScore = 10;
    else                     volumeScore = 15;
    totalScore += volumeScore;

    if (volRatio >= 0.3) confirmedSignals++; // Volume signal confirmed

    // --- Signal 5: Spread Tightness (0-15 pts) ---
    let spreadScore = 0;
    if (opp.spread <= 0.01)      spreadScore = 15;
    else if (opp.spread <= 0.02) spreadScore = 12;
    else if (opp.spread <= 0.03) spreadScore = 8;
    else                         spreadScore = 4;
    totalScore += spreadScore;

    if (opp.spread <= 0.03) confirmedSignals++; // Spread signal confirmed

    // ============================================
    // STAGE 3: Confirmation Gate
    // ============================================

    // Require at least 3 of 4 signals to confirm
    if (confirmedSignals < 3) return null;

    // Minimum total score threshold
    if (totalScore < 60) return null;

    // ============================================
    // STAGE 4: Position Sizing
    // ============================================

    const maxPerTrade = balance * 0.05; // 5% of portfolio

    // Confidence-based sizing
    const confidence = Math.min(1.0, totalScore / 80);
    let targetCost = maxPerTrade * confidence;

    // All-signals bonus
    if (confirmedSignals === 4) {
      targetCost = Math.min(targetCost * 1.2, balance * 0.07);
    }

    // Place limit order at current price (market is near consensus, no discount hunting)
    // For near-expiry, we want fills, not better prices
    const limitPrice = opp.price;
    const size = Math.floor((targetCost / limitPrice) * 100) / 100;

    // Expected return
    const expectedReturn = ((EFFECTIVE_PAYOUT - limitPrice) / limitPrice) * 100;

    return {
      action: 'BUY',
      tokenId: opp.tokenId,
      outcome: opp.outcome,
      conditionId: opp.conditionId,
      question: opp.question,
      price: limitPrice,
      size,
      reason: [
        `NearExpiry: ${opp.outcome} @ ${(opp.price * 100).toFixed(0)}c`,
        `expiry ${opp.hoursToExpiry.toFixed(1)}h`,
        `score ${totalScore.toFixed(0)}/100`,
        `signals ${confirmedSignals}/4`,
        `return ~${expectedReturn.toFixed(1)}%`,
      ].join(', '),
      score: totalScore,
    };
  },
};
```

### 10.2 Scanner Integration

The existing `scanMarkets()` function in `lib/bot/scanner.ts` filters out markets with `hoursToExpiry < 6` and rejects prices above `0.85`. The Near-Expiry Sniper needs a **dedicated scanner** or a modified scan that includes the near-expiry, high-price range:

```typescript
/**
 * Scan specifically for near-expiry sniper opportunities.
 * Differs from the value-betting scanner:
 *   - Includes markets with hoursToExpiry 1-72 (scanner excludes <6)
 *   - Includes prices 0.90-0.97 (value-betting excludes >0.85)
 *   - Lower liquidity/volume thresholds (we're taking small positions)
 */
export async function scanNearExpiryMarkets(
  config: BotConfig,
  limit = 100
): Promise<ScoredOpportunity[]> {
  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit,
    order: 'endDate',    // Sort by end date ascending (soonest-expiring first)
    ascending: true,
  });

  const scored: ScoredOpportunity[] = [];

  for (const gm of gammaMarkets) {
    const opp = scoreMarket(gm);  // Reuse existing scoreMarket()
    if (!opp) continue;

    // Near-expiry specific filters (different from value-betting scanner)
    if (opp.hoursToExpiry < 1 || opp.hoursToExpiry > 72) continue;
    if (opp.price < 0.90 || opp.price > 0.97) continue;
    if (opp.liquidity < 500) continue;
    if (opp.volume24hr < 1000) continue;
    if (opp.spread > 0.04) continue;

    scored.push(opp);
  }

  // Sort by hours to expiry (most urgent first), then by score
  scored.sort((a, b) => {
    if (a.hoursToExpiry !== b.hoursToExpiry) {
      return a.hoursToExpiry - b.hoursToExpiry;
    }
    return b.score - a.score;
  });

  return scored;
}
```

### 10.3 Strategy Registration

Add to `lib/bot/strategies/index.ts`:

```typescript
import { nearExpirySniperStrategy } from './near-expiry-sniper';

strategies.set(nearExpirySniperStrategy.name, nearExpirySniperStrategy);

// Update getDefaultStrategy() or add strategy selection to engine
export function getStrategy(name: string): Strategy | undefined {
  return strategies.get(name);
}
```

### 10.4 Stop-Loss Monitoring Loop

```typescript
// Track active near-expiry positions
interface SniperPosition {
  conditionId: string;
  tokenId: string;
  entryPrice: number;
  shares: number;
  enteredAt: number;      // timestamp
  stopLossPrice: number;  // entry - 0.03
}

const activePositions: Map<string, SniperPosition> = new Map();

async function checkStopLosses(): Promise<void> {
  for (const [id, pos] of activePositions) {
    const currentPrice = await getMidpoint(pos.tokenId);

    // Stop-loss check
    if (currentPrice <= pos.stopLossPrice) {
      await placeOrder({
        tokenId: pos.tokenId,
        side: 'SELL',
        price: currentPrice,
        size: pos.shares,
      });
      activePositions.delete(id);
      log('warn', 'sniper-stop-loss', `Stop-loss triggered for ${id}`, {
        entry: pos.entryPrice,
        exit: currentPrice,
        loss: ((pos.entryPrice - currentPrice) * pos.shares).toFixed(4),
      });
    }

    // Rapid reversal check (5+ cent drop within 2 hours)
    const hoursSinceEntry = (Date.now() - pos.enteredAt) / (1000 * 60 * 60);
    if (hoursSinceEntry <= 2 && currentPrice <= pos.entryPrice - 0.05) {
      await placeOrder({
        tokenId: pos.tokenId,
        side: 'SELL',
        price: currentPrice,
        size: pos.shares,
      });
      activePositions.delete(id);
      log('error', 'sniper-reversal', `Emergency reversal exit for ${id}`);
    }
  }
}
```

---

## 11. Comparison: Near-Expiry Sniper vs. Value Betting

| Dimension | Near-Expiry Sniper | Value Betting (Existing) |
|-----------|-------------------|-------------------------|
| **Target price range** | 90-97 cents | 15-85 cents |
| **Time to expiry** | 1-72 hours | 24 hours - 30 days |
| **Avg hold time** | 2-24 hours | Days to weeks |
| **Return per trade** | 1-8% | 5-50%+ |
| **Win rate (target)** | 96-99% | 55-70% |
| **Risk per trade** | Low (near-certain) | Medium (uncertain) |
| **Trades per day** | 4-8 | 1-3 |
| **Capital turnover** | Very high | Low-medium |
| **Edge source** | Time decay + structural discount | Mispriced probabilities |
| **Key risk** | Rare catastrophic loss (95-cent token resolves NO) | Frequent small losses |
| **Stop-loss** | 3 cents below entry | N/A (relies on position expiry) |
| **Limit price strategy** | At market (want fills) | Below market (want better price) |
| **Scanner sort order** | By end date (soonest first) | By volume (most liquid first) |
| **Min score** | 60 | 60 |
| **Max position size** | 5-7% of portfolio | 5% of portfolio |
| **Max open positions** | 8 | 5 |
| **Scan interval** | 2-10 minutes (varies by urgency) | 5 minutes (fixed) |
| **Complementary?** | Yes -- targets opposite end of the price/time spectrum | Yes |

### Running Both Strategies Simultaneously

The two strategies are highly complementary and can share the same portfolio with isolated risk budgets:

```
Total portfolio: $100 USDC

Value Betting allocation: 60% ($60)
  - Max exposure: $18 (30% of $60)
  - Max per trade: $3 (5% of $60)
  - 5 open positions max

Near-Expiry Sniper allocation: 40% ($40)
  - Max exposure: $14 (35% of $40)
  - Max per trade: $2 (5% of $40)
  - 8 open positions max

Shared reserve: 0% (both strategies maintain their own reserve within allocation)
```

The value-betting strategy provides occasional larger wins to grow the portfolio, while the near-expiry sniper provides steady small gains to compound daily. If either strategy hits its drawdown limit, capital is not reallocated to the other -- it stays idle until the next reset period.

---

## 12. Backtesting Considerations

### 12.1 Data Requirements

To backtest this strategy, you need:

1. **Historical market data from Gamma API:**
   - All resolved markets from the past 6-12 months
   - Fields: conditionId, question, outcomePrices (time series), endDate, volume24hr, liquidity, spread, outcomes, resolution outcome
   - Approximate data: 10,000-50,000 resolved markets

2. **Price snapshots at regular intervals:**
   - The Gamma API does not provide historical price time series directly
   - Approach: Build a data collector that snapshots all active markets every 5 minutes and stores to database
   - Alternative: Use Dune Analytics or community datasets for historical Polymarket price data

3. **Resolution outcomes:**
   - Which outcome won for each resolved market
   - Available via Gamma API (`closed: true` markets) or on-chain data

### 12.2 Backtesting Methodology

```
for each resolved market in historical_data:
    // Simulate the scanner finding this market at each snapshot
    for each price_snapshot in market_snapshots:
        hours_to_expiry = (end_date - snapshot_time) / 3600

        // Would the strategy have entered?
        if would_enter(price_snapshot, hours_to_expiry, volume, liquidity, spread):
            record_entry(market_id, entry_price, snapshot_time)

    // Simulate resolution
    for each recorded_entry in entries:
        if market_resolved_in_favor_of_entry:
            record_profit(0.98 - entry_price)
        elif stop_loss_would_have_triggered(price_history_after_entry):
            record_loss(entry_price - stop_loss_price)
        else:
            record_loss(entry_price)  // Full loss

// Compute aggregate metrics
win_rate = wins / total_entries
avg_profit = sum(profits) / wins
avg_loss = sum(losses) / losses_count
sharpe = mean(daily_returns) / std(daily_returns) * sqrt(365)
max_drawdown = max_peak_to_trough(cumulative_returns)
```

### 12.3 Key Metrics to Track

| Metric | Target | Red Flag |
|--------|--------|----------|
| Win rate | > 96% | < 94% |
| Average profit per win | > $0.15 | < $0.08 |
| Average loss per loss | < $3.00 (with stop-loss) | > $4.00 |
| Profit factor | > 2.0 | < 1.2 |
| Max drawdown | < 10% | > 15% |
| Daily Sharpe ratio | > 1.0 | < 0.5 |
| Trades per day | 3-8 | < 1 (insufficient opportunity flow) |
| Capital utilization | 20-35% | > 50% (over-concentrated) |

### 12.4 Survivorship Bias Warning

Historical Gamma API data only shows markets that successfully resolved. It may undercount:
- Markets that were cancelled or voided (no resolution)
- Markets with disputed resolutions (delayed, potentially resolved incorrectly)
- Markets where oracle disputes changed the expected outcome

Adjust backtest win rate downward by 1-2% to account for these invisible failure modes.

---

## 13. Known Failure Modes & Mitigations

### Failure Mode 1: "Sure Thing" That Isn't

**Description:** A market is priced at 95 cents for YES, but the actual event outcome is NO.

**Historical example:** The "Will Polymarket U.S. go live in 2025?" market resolved YES on a technicality (invite-only counted as "live"), despite many traders expecting it would resolve NO.

**Mitigation:**
- Never allocate >5% of portfolio to a single position
- Diversify across market categories (politics, sports, crypto)
- Read the resolution criteria carefully (automated: flag markets with subjective language)

### Failure Mode 2: Delayed Resolution

**Description:** Market end date passes but resolution takes days or weeks. Capital is locked.

**Mitigation:**
- Time-based exit: sell after 48 hours past expected resolution if no settlement
- Factor capital lockup into opportunity cost calculations
- Prefer markets with clear, objective resolution criteria (sports scores, official announcements)

### Failure Mode 3: Liquidity Dry-Up

**Description:** You enter a position but when you need to exit (stop-loss), there are no bids.

**Mitigation:**
- Minimum liquidity threshold ($500)
- Small position sizes relative to market depth
- Prefer markets with consistent two-sided order books

### Failure Mode 4: Oracle Manipulation

**Description:** A whale proposes an incorrect resolution to the UMA Oracle, and the 2-hour challenge period expires before the community notices.

**Frequency:** Very rare (UMA's $750 bond deters casual manipulation), but has occurred.

**Mitigation:**
- Monitor UMA Oracle proposals for markets where you have exposure
- If a dispute is raised on your market, consider exiting immediately (price uncertainty spikes)

### Failure Mode 5: Fee Structure Changes

**Description:** Polymarket changes the 2% winner fee, reducing or eliminating the strategy's margin.

**Mitigation:**
- Monitor Polymarket announcements and docs for fee changes
- Parameterize `WINNER_FEE` in the strategy code (currently hardcoded at 0.02)
- If fee increases above 5%, the strategy becomes unviable at current price ranges

### Failure Mode 6: Systematic Overconfidence

**Description:** Markets in the 90-97 cent range are systematically overpriced (actual probability is lower than market price implies).

**Evidence:** Research suggests Polymarket prices are "almost always slightly higher than the actual frequency." A 95-cent token might only resolve YES 93% of the time.

**Mitigation:**
- Apply a 2% overconfidence haircut when computing expected value
- Prefer the 93-95 cent range (more margin to absorb calibration error)
- Track actual win rate meticulously and shut down if it drops below 94%

---

## 14. Daily Operations Checklist

### Morning (Start of Day)

- [ ] Check portfolio balance and open positions
- [ ] Review any markets that resolved overnight (confirm P&L)
- [ ] Check for new markets entering the 1-72 hour expiry window
- [ ] Verify API keys and connectivity
- [ ] Check Polymarket status page for platform issues

### During Trading Hours

- [ ] Monitor bot logs for entries and stop-loss triggers
- [ ] Every 2 hours: review active positions and confirm prices are stable
- [ ] Flag any markets where the price has dropped 2+ cents since entry
- [ ] Check news for events that could affect open positions

### End of Day

- [ ] Record daily P&L: wins, losses, net profit
- [ ] Record actual win rate vs. target (rolling 7-day window)
- [ ] Calculate capital utilization rate
- [ ] Review any stop-loss triggers and analyze root cause
- [ ] Decide whether to adjust position size or scoring thresholds for tomorrow

### Weekly Review

- [ ] Compare actual returns to base case projection
- [ ] Check if win rate is above 95% threshold
- [ ] Review maximum drawdown for the week
- [ ] Analyze category distribution of trades (are we over-concentrated?)
- [ ] Check for patterns in losing trades (specific market types, times of day)

---

## 15. Kill Switch Criteria

The strategy should be **immediately paused** if any of the following occur:

| Trigger | Threshold | Action |
|---------|-----------|--------|
| Single-day loss | > 5% of portfolio | Pause for 24 hours |
| Weekly loss | > 10% of portfolio | Pause for 1 week |
| Win rate (7-day rolling) | < 90% | Pause and investigate |
| Win rate (30-day rolling) | < 94% | Shut down permanently (strategy is EV-negative) |
| Consecutive losses | 3 in a row | Pause for 24 hours, review |
| Polymarket platform issues | Any reported | Pause until resolved |
| Fee structure change | Winner fee > 3% | Re-evaluate all thresholds |
| API errors | > 5 failed scans in a row | Pause and investigate |

**Manual override:** The user can always force-pause the strategy via the dashboard settings page.

---

## 16. Sources & References

### Polymarket Accuracy & Calibration
- [Polymarket Accuracy Page](https://polymarket.com/accuracy) -- Official accuracy statistics
- [How Accurate Is Polymarket? Research Shows a 90% Success Rate (Bitget)](https://www.bitget.com/news/detail/12560604659412) -- 94.2% accuracy at 4 hours pre-resolution
- [How Accurate Is Polymarket? (CryptoPotato)](https://cryptopotato.com/how-accurate-is-polymarket-research-shows-a-90-success-rate/) -- Multi-timeframe accuracy analysis
- [Polymarket is Up to 94% Accurate In Predicting Outcomes (The Defiant)](https://thedefiant.io/news/research-and-opinion/polymarket-is-up-to-94-accurate-in-predicting-outcomes-analysis) -- Independent analysis
- [Are Polymarket and Kalshi as reliable as they say? (DL News)](https://www.dlnews.com/articles/markets/polymarket-kalshi-prediction-markets-not-so-reliable-says-study/) -- December 2025 study with more critical findings

### Failure Modes & Risk
- [Polymarket faces major credibility crisis (CryptoSlate)](https://cryptoslate.com/polymarket-faces-major-credibility-crisis-after-whales-forced-a-yes-ufo-vote-without-evidence/) -- Whale manipulation case study
- [Why Are Polymarket Betters Losing Money? (Medium)](https://medium.com/@balajibal/why-are-polymarket-betters-losing-money-af3cc506fd9a) -- Common loss patterns
- [Prediction Laundering: The Illusion of Neutrality (arXiv)](https://arxiv.org/html/2602.05181v1) -- Academic critique of prediction market reliability
- [Polymarket misses 2025 US release (Yogonet)](https://www.yogonet.com/international/news/2026/01/05/116954-polymarket-misses-2025-public-us-release-after-reentry-approval) -- Resolution ambiguity case study

### Arbitrage & Strategy Research
- [Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets (IMDEA)](https://arxiv.org/abs/2508.03474) -- $40M in documented arbitrage profits
- [The Complete Polymarket Playbook (Medium)](https://medium.com/thecapital/the-complete-polymarket-playbook-finding-real-edges-in-the-9b-prediction-market-revolution-a2c1d0a47d9d) -- Comprehensive strategy overview
- [Prediction Market Arbitrage Guide: Strategies for 2026](https://newyorkcityservers.com/blog/prediction-market-arbitrage-guide) -- Updated strategy guide
- [Advanced Prediction Market Trading Strategies (MetaMask)](https://metamask.io/news/advanced-prediction-market-trading-strategies) -- Strategy taxonomy
- [How Prediction Market Arbitrage Works (Benzinga)](https://www.benzinga.com/Opinion/26/01/50121957/how-prediction-market-arbitrage-works-and-why-panic-creates-free-money) -- Panic-driven opportunities

### API & Technical
- [Polymarket CLOB Documentation](https://docs.polymarket.com/developers/CLOB/introduction) -- API reference
- [How Are Markets Resolved? (Polymarket Docs)](https://docs.polymarket.com/polymarket-learn/markets/how-are-markets-resolved) -- Resolution mechanics
- [Polymarket py-clob-client (GitHub)](https://github.com/Polymarket/py-clob-client) -- Python client reference
- [The Polymarket API: Architecture, Endpoints, and Use Cases (Medium)](https://medium.com/@gwrx2005/the-polymarket-api-architecture-endpoints-and-use-cases-f1d88fa6c1bf) -- API overview

### Calibration Research
- [Polymarket Historical Accuracy and Bias (Dune Analytics)](https://dune.com/alexmccullough/how-accurate-is-polymarket) -- On-chain accuracy metrics
- [Prediction Markets Are Very Accurate (Marginal Revolution)](https://marginalrevolution.com/?p=91721) -- Academic perspective
- [Exploring Decentralized Prediction Markets: Accuracy, Skill, and Bias on Polymarket (SSRN)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5910522) -- Peer-reviewed analysis

---

*This strategy document is for systematic evaluation purposes. The expected returns are thin for $100 capital -- approximately $0.10-$0.15 per day in the base case. The strategy's viability depends critically on maintaining a >95% win rate. Monitor daily, review weekly, and shut down without hesitation if the kill switch criteria are met.*
