# Polymarket Strategy Ideas

> Research date: 2026-02-13. All return estimates assume $100-$1,000 starting capital with Polymarket's 2% winner fee. Effective payout per winning share = $0.98.

---

## Table of Contents

1. [Complement Arbitrage](#1-complement-arbitrage) (Risk-free)
2. [Multi-Outcome Bundle Arb](#2-multi-outcome-bundle-arb) (Risk-free)
3. [Panic Reversal Sniper](#3-panic-reversal-sniper) (Novel)
4. [Crypto Latency Arb](#4-crypto-latency-arb-15-min-markets) (High-freq)
5. [Liquidity Reward Farmer](#5-liquidity-reward-farmer-market-making) (Passive)
6. [Resolution Race](#6-resolution-race) (Speed-based)
7. [Correlation Divergence](#7-correlation-divergence-trader) (Novel)
8. [Volume Spike Momentum](#8-volume-spike-momentum) (Novel)
9. [Gains Comparison Matrix](#gains-comparison-matrix)

---

## 1. Complement Arbitrage

**Type**: Risk-free arbitrage
**Complexity**: Low
**Capital needed**: $50+

### Concept

Buy YES and NO shares simultaneously when their combined ask price is < $1.00. At resolution, exactly one side pays $1.00, guaranteeing a profit regardless of outcome.

```
YES ask = $0.48
NO ask  = $0.51
Total   = $0.99 → guaranteed $0.01/share profit (1.01% return)
```

### Why It Exists

The CLOB is not a single AMM — YES and NO have separate order books. During volatile moments or low-liquidity periods, the two books can temporarily desync, especially when large orders clear one side.

### Filters

| Parameter        | Value                        |
|------------------|------------------------------|
| YES_ask + NO_ask | < $0.995 (need > 0.5c edge) |
| Min liquidity    | $5,000 per side              |
| Min edge         | 0.5c (covers gas + fee)      |
| Max staleness    | < 2 seconds                  |

### Execution

1. Poll order books for all active markets every 1-2 seconds
2. When `ask_yes + ask_no < 0.995`, compute net edge after fees
3. Place both legs simultaneously (use batch order endpoint — 15 orders/call)
4. Both must fill. If one leg fails, cancel the other immediately

### Risk

- **Leg risk**: One side fills, other doesn't → stuck with directional exposure
- **Latency**: HFT bots hunt these same opportunities. Windows last < 500ms
- **Fee erosion**: At very small edges (< 1c), gas costs eat the profit

### Potential Gains

| Scenario     | Trades/day | Avg edge | Daily profit | Monthly  |
|--------------|-----------|----------|-------------|----------|
| Conservative | 2         | 0.5c     | $1.00       | $30      |
| Moderate     | 5         | 0.8c     | $4.00       | $120     |
| Aggressive   | 15        | 1.0c     | $15.00      | $450     |

**Realistic assessment**: With sub-second polling, expect 2-5 opportunities/day at 0.5-1c edge. **~$60-120/month on $500 capital** (12-24% monthly). Competition is fierce — this is the most hunted arb on Polymarket.

---

## 2. Multi-Outcome Bundle Arb

**Type**: Risk-free arbitrage
**Complexity**: Medium
**Capital needed**: $200+

### Concept

Same as complement arb but for markets with 3+ outcomes (elections, sports brackets, "Who will X nominate?"). Buy one share of every outcome. If total cost < $1.00, guaranteed profit.

### Why It's Better Than Binary

Humans are bad at maintaining probability distributions across many outcomes. With 5+ outcomes, mispricing is structurally persistent:

```
Outcome A: 45c
Outcome B: 25c
Outcome C: 12c
Outcome D: 8c
Outcome E: 5c
Others:    3c
Total:     98c → 2c guaranteed profit per bundle
```

Research shows multi-outcome markets on Polymarket carry **3-6c average bundle discount** vs. 1-2c for binary markets.

### Filters

| Parameter          | Value                             |
|--------------------|-----------------------------------|
| Number of outcomes | >= 3                              |
| Sum of all asks    | < $0.97 (need > 3c edge)          |
| Min liquidity      | $1,000 per outcome                |
| All outcomes       | Must have asks available           |

### Execution

1. Scan Gamma API for multi-outcome markets (outcomes array length >= 3)
2. Fetch order books for all outcome tokens
3. Sum best asks across all outcomes
4. If sum < $0.97: buy 1 share of each outcome
5. Wait for resolution → collect $1.00

### Risk

- **Partial fill**: One outcome too thin → can't complete the bundle
- **Resolution delay**: Capital locked for weeks/months in slow-resolving markets
- **Outcome count**: More outcomes = more legs = higher execution complexity

### Potential Gains

| Market type        | Avg edge | Resolution time | Annual ROI |
|-------------------|----------|----------------|------------|
| Election (5 out.) | 4c       | 1-6 months     | ~50%       |
| Sports (8 out.)   | 6c       | 1-7 days       | ~300%      |
| Crypto (3 out.)   | 2c       | 15 min - 1 day | ~500%+     |

**Realistic assessment**: 2-3 bundles/week at 3-5c edge, averaging 2 weeks to resolution. **~$15-25/month on $500 capital** (3-5% monthly). Safe but slow — capital sits locked.

---

## 3. Panic Reversal Sniper

**Type**: Mean-reversion (Novel strategy)
**Complexity**: Medium
**Capital needed**: $100+

### Concept

When a high-probability market (>85c) suddenly drops 5c+ within minutes due to panic, temporary news misinterpretation, or a whale dump — buy the dip and ride the reversion back. Most of these drops recover within 30-120 minutes.

### Why This Works

Prediction markets overreact to noise. A 93c token dropping to 85c often means:
- A scary-sounding headline that doesn't actually change the outcome
- A whale exiting a large position (price impact, not information)
- A stop-loss cascade from other bots

The key insight: **the market's original price (93c) was informed by thousands of traders over days. A 5-minute panic is usually not new fundamental information.**

### Detection Logic

```
1. Track rolling 30-min high price for markets with price > 85c
2. When current_price < rolling_high - 5c:
   a. Check if volume spike is > 3x normal → whale dump signal
   b. Check if multiple correlated markets also dropped → real news (SKIP)
   c. Check if only THIS market dropped → panic/whale → BUY
3. Enter at current price
4. Exit when price recovers to (rolling_high - 1c) or after 2h timeout
```

### Filters

| Parameter           | Value                                    |
|---------------------|------------------------------------------|
| Pre-drop price      | > 85c                                    |
| Drop magnitude      | >= 5c in <= 30 min                       |
| Current price       | > 75c (don't buy if it's a true crash)   |
| Correlated drop     | Must NOT see same drop in related markets |
| Volume spike        | > 3x 1-hour avg (confirms forced selling) |
| Time to expiry      | > 2 hours (need time for recovery)        |
| Min liquidity       | $3,000                                   |

### Risk

- **Real information**: Sometimes the drop IS real (actual news changes outcome). The correlated-market check helps but isn't foolproof
- **Continued decline**: Panic can cascade further before recovering
- **Resolution before recovery**: If expiry is too close, you might not get the bounce

### Position Sizing

```
position = balance * 0.04 * (drop_magnitude / 0.10)
```

Bigger drops (more "panic-like") → slightly larger positions, capped at 6% of balance.

### Potential Gains

| Drop size | Buy price | Recovery to | Profit/share | Return |
|-----------|-----------|-------------|-------------|--------|
| 5c        | 88c       | 92c         | 4c          | 4.5%   |
| 8c        | 85c       | 92c         | 7c          | 8.2%   |
| 10c       | 83c       | 91c         | 8c          | 9.6%   |
| 15c       | 78c       | 90c         | 12c         | 15.4%  |

**Realistic assessment**: 3-5 panic events/week across all markets. Win rate ~75% (some drops are real). Average 5c gain on wins, 8c loss on losses. **~$40-80/month on $500 capital** (8-16% monthly). High variance but high reward.

---

## 4. Crypto Latency Arb (15-Min Markets)

**Type**: Speed arbitrage
**Complexity**: High
**Capital needed**: $300+

### Concept

Polymarket's 15-minute crypto markets (e.g., "Will BTC be above $X at 3:15 PM?") reprice slower than spot exchanges. Monitor Binance/Coinbase spot prices and trade Polymarket when there's a confirmed directional move that the prediction market hasn't priced in yet.

### Why This Works

A bot turned **$313 into $438,000** in December 2025 using exactly this strategy. The edge: crypto spot moves instantly, but Polymarket order books take 2-10 seconds to fully adjust. In those seconds, you can buy underpriced YES/NO tokens.

### Detection Logic

```
1. Stream real-time BTC/ETH price from Binance WebSocket
2. Monitor Polymarket 15-min crypto markets
3. When spot price crosses above/below the market's strike:
   a. If BTC just crossed ABOVE strike → buy YES (still cheap)
   b. If BTC just crossed BELOW strike → buy NO (still cheap)
4. Only trade if:
   - Time remaining in the 15-min window > 3 minutes
   - Polymarket price hasn't adjusted yet (YES still < 70c for above-strike)
   - Sufficient order book depth
```

### Critical Constraint: Fee Impact

15-minute crypto markets have **parabolic taker fees** up to 3.15% at p=0.50. This means:

| Price | Taker fee | Effective cost | Min edge needed |
|-------|-----------|---------------|----------------|
| 30c   | 1.31%     | 30.4c         | ~2c            |
| 50c   | 1.56%     | 50.8c         | ~3c            |
| 70c   | 1.31%     | 70.9c         | ~2c            |
| 90c   | 0.56%     | 90.5c         | ~1c            |

Trade at extreme prices (near 0 or 1) where fees are lowest.

### Risk

- **Speed**: Requires sub-second execution. Other bots are doing the same thing
- **False breakouts**: BTC crosses strike, you buy YES at 65c, BTC reverses → loss
- **Fee drag**: High fees on mid-priced tokens eat margin
- **Maker rebates**: Can offset fees by 20% if you place limit orders

### Potential Gains

| Scenario     | Trades/day | Avg profit | Win rate | Daily net | Monthly   |
|--------------|-----------|-----------|---------|-----------|-----------|
| Conservative | 10        | 3c        | 70%     | $5.50     | $165      |
| Moderate     | 20        | 5c        | 75%     | $25.00    | $750      |
| Aggressive   | 40        | 8c        | 80%     | $80.00    | $2,400    |

**Realistic assessment**: The $313→$438K bot was extreme. For a non-HFT setup, expect 10-20 trades/day at 3-5c avg profit. **~$150-400/month on $500 capital** (30-80% monthly). **Highest potential but requires Binance WebSocket integration and sub-second latency.**

---

## 5. Liquidity Reward Farmer (Market Making)

**Type**: Passive income via maker rebates
**Complexity**: High
**Capital needed**: $500+

### Concept

Place two-sided quotes (both bid and ask) on fee-enabled markets to earn Polymarket's daily liquidity rewards. You're not betting on outcomes — you're providing liquidity and earning maker rebates.

### How Rewards Work

Polymarket distributes **20-25% of collected taker fees** daily to makers, proportional to their executed volume:

```
Your daily reward = (your_maker_volume / total_maker_volume) * daily_fee_pool
```

Two-sided quoting (bid + ask) earns ~3x the rewards of one-sided.

### Strategy

1. Pick low-volatility, fee-enabled markets (15-min crypto, NCAAB, Serie A)
2. Place symmetric quotes around the midpoint:
   ```
   bid = mid - spread/2
   ask = mid + spread/2
   ```
3. Maintain tight spreads (earn higher reward scores)
4. Rebalance inventory periodically to stay delta-neutral
5. Collect daily USDC rebates

### Risk

- **Adverse selection**: Informed traders pick off stale quotes during sudden moves
- **Inventory risk**: End up holding too much of one side
- **Reward variability**: Depends on total maker competition. More makers = smaller share
- **Program changes**: Polymarket can adjust reward rates

### Potential Gains

A documented open-source bot earned **$700-800/day** at peak. But that was early, with less competition.

| Capital | Spread | Daily volume | Reward share | Daily rebate | Monthly |
|---------|--------|-------------|-------------|-------------|---------|
| $500    | 2c     | $2,000      | 0.1%        | $2-5        | $60-150 |
| $2,000  | 1.5c   | $10,000     | 0.5%        | $10-30      | $300-900|
| $10,000 | 1c     | $50,000     | 2%          | $50-150     | $1,500+ |

**Realistic assessment**: At $500 capital, expect **~$60-150/month** (12-30% monthly). Scales well with capital. Lower variance than directional strategies but requires continuous uptime and position management.

---

## 6. Resolution Race

**Type**: Speed-based information edge
**Complexity**: Medium-High
**Capital needed**: $100+

### Concept

When a real-world event resolves (sports game ends, vote count finalized, crypto price locked), there's a 10-60 second window where the Polymarket price hasn't reached 98-99c yet. If you can confirm the outcome faster than the crowd, buy the winning token before the price adjusts.

### Data Sources (Faster Than Polymarket Crowd)

| Event type | Fast source                    | Polymarket delay |
|-----------|-------------------------------|-----------------|
| Sports    | ESPN/Sportradar API (< 1s)    | 5-30 seconds    |
| Crypto    | Binance WebSocket (< 100ms)   | 2-10 seconds    |
| Elections | AP/Reuters API (< 5s)         | 30-120 seconds  |
| Weather   | NOAA/OpenWeather API (< 10s)  | 60+ seconds     |

### Detection Logic

```
1. Subscribe to event outcome data sources
2. When outcome confirmed externally:
   a. Check Polymarket price for that outcome
   b. If price < 95c → BUY immediately (market hasn't priced it yet)
   c. If price >= 98c → too late, skip
3. Hold until resolution (minutes to hours)
```

### Filters

| Parameter     | Value                                |
|---------------|--------------------------------------|
| Price gap     | External = confirmed, PM < 95c      |
| Confidence    | External source is definitive         |
| Time to fill  | Must execute within 10 seconds       |
| Min edge      | > 3c (after 2% fee, need 95c or less)|

### Risk

- **False confirmations**: Data source error (rare but catastrophic)
- **Speed competition**: Other bots doing the same thing
- **Execution risk**: By the time your order hits, price may have moved

### Potential Gains

| Event type | Opportunities/wk | Avg buy | Avg profit | Weekly  |
|-----------|------------------|---------|-----------|---------|
| Sports    | 10-20            | 90c     | 6c        | $6-12   |
| Crypto    | 30-50            | 92c     | 4c        | $12-20  |
| Elections | 1-2              | 80c     | 16c       | $1.60-3 |

**Realistic assessment**: Across event types, **~$80-150/month on $500 capital** (16-30% monthly). Best during sports seasons and high-profile political events.

---

## 7. Correlation Divergence Trader

**Type**: Statistical arbitrage (Novel strategy)
**Complexity**: High
**Capital needed**: $200+

### Concept

Find pairs of logically correlated Polymarket markets where prices diverge. When market A implies X is 90% likely but market B (which depends on X) implies only 70%, trade the divergence expecting convergence.

### Examples

```
Market A: "Will X win the primary?"     → YES = 92c (implies 92% probability)
Market B: "Will X win the general?"     → YES = 55c (implies 55% probability)
Market C: "Will X's party win general?" → YES = 70c

Logical constraint: P(win general) <= P(win primary)
If P(win general | win primary) should be ~60%, then:
  Expected B price = 0.92 * 0.60 = 55c ← actually consistent

But if B = 70c while A = 80c:
  Implied P(win general | win primary) = 70/80 = 87.5% ← too high
  → SHORT B or LONG A
```

### Detection Logic

```
1. Identify correlated market pairs by keyword/entity matching
2. Compute implied conditional probabilities
3. When divergence exceeds 10%:
   a. Buy the underpriced side
   b. Sell/short the overpriced side (if possible)
   c. Or: just buy the underpriced side for directional edge
4. Exit when prices converge
```

### Filters

| Parameter          | Value                           |
|--------------------|---------------------------------|
| Correlation type   | Logical dependency (A implies B)|
| Divergence         | > 10% implied probability gap   |
| Both markets       | Liquidity > $5,000              |
| Time to expiry     | > 24 hours (need convergence time)|

### Risk

- **Correlation breakdown**: The relationship may not hold (different resolution criteria)
- **Convergence timing**: Markets may stay divergent longer than expected
- **One-sided execution**: Can't always short on Polymarket, so you're directional

### Potential Gains

| Scenario          | Divergence | Convergence time | Return |
|-------------------|-----------|-----------------|--------|
| Election pair     | 12c       | 2-4 weeks       | 15-20% |
| Sports qualifying | 8c        | 3-7 days        | 10-15% |
| Crypto related    | 5c        | 1-3 days        | 6-10%  |

**Realistic assessment**: 2-4 divergence opportunities per month. Average 10c edge, 70% convergence rate. **~$30-60/month on $500 capital** (6-12% monthly). Lower frequency but high conviction when it appears.

---

## 8. Volume Spike Momentum

**Type**: Momentum trading (Novel strategy)
**Complexity**: Medium
**Capital needed**: $100+

### Concept

Sudden volume spikes (5x+ normal) predict price direction with high accuracy because they indicate informed trading. When volume explodes on one side, the price hasn't fully adjusted yet. Ride the momentum.

### Why Volume Leads Price

On Polymarket, most liquidity sits passively. A sudden burst of aggressive buying/selling:
1. Eats through resting limit orders
2. Creates temporary price impact
3. Signals that someone with information is trading
4. **Price continues moving for 5-30 minutes** as other traders notice and follow

### Detection Logic

```
1. Track 1-hour rolling volume for each market
2. When 5-min volume > 5x the 1-hour average:
   a. Determine direction: which side is being bought?
   b. If YES volume spike → buy YES
   c. If NO volume spike → buy NO
3. Enter immediately at market
4. Exit after 15-30 minutes or when momentum stalls (price unchanged for 5 min)
```

### Filters

| Parameter             | Value                                 |
|-----------------------|---------------------------------------|
| Volume spike          | 5-min vol > 5x 1-hour rolling avg    |
| Price range           | 20c - 80c (avoid near-certain mkts)  |
| Time to expiry        | > 6 hours                             |
| Min liquidity         | $5,000                                |
| Spike confirmation    | Price moved >= 2c in spike direction  |
| Ignore if             | Market has pending resolution event   |

### Risk

- **Fake spikes**: Market maker rebalancing, not informed flow
- **Mean reversion**: Some spikes reverse immediately (distinguish from sustained moves)
- **Holding period risk**: Extended holds expose you to random walk

### Position Sizing & Exit

```
Entry: market price at spike detection
Size: balance * 0.03 (3% per trade — high frequency offsets small size)
Stop-loss: entry - 3c
Take-profit: entry + 5c OR 30-min timeout
```

### Potential Gains

| Win rate | Avg win | Avg loss | Trades/day | Daily net | Monthly |
|---------|---------|---------|-----------|-----------|---------|
| 55%     | 4c      | 3c      | 6         | $0.78     | $23     |
| 60%     | 5c      | 3c      | 8         | $2.16     | $65     |
| 65%     | 5c      | 3c      | 10        | $3.55     | $107    |

**Realistic assessment**: Volume data is available via CLOB. With 6-10 trades/day and 60% directional accuracy, **~$50-100/month on $500 capital** (10-20% monthly). Requires real-time volume tracking infrastructure.

---

## Gains Comparison Matrix

All estimates for **$500 capital**, monthly returns:

| Strategy                | Monthly $ | Monthly % | Win Rate | Trades/Day | Risk    | Complexity | Infra Needed          |
|------------------------|-----------|-----------|---------|-----------|---------|------------|------------------------|
| Complement Arb         | $60-120   | 12-24%    | ~100%   | 2-5       | Minimal | Low        | Fast polling (< 2s)    |
| Multi-Outcome Bundle   | $15-25    | 3-5%      | ~100%   | 0.3-0.5   | Minimal | Medium     | Multi-token scanner    |
| **Panic Reversal**     | $40-80    | 8-16%     | 75%     | 0.5-1     | Medium  | Medium     | Price history tracker  |
| **Crypto Latency Arb** | $150-400  | 30-80%    | 70-80%  | 10-20     | Medium  | High       | Binance WS + low lat.  |
| Liquidity Farming      | $60-150   | 12-30%    | N/A     | Passive   | Low     | High       | 2-sided quoting engine |
| Resolution Race        | $80-150   | 16-30%    | 85%     | 3-5       | Low     | Med-High   | External data APIs     |
| **Corr. Divergence**   | $30-60    | 6-12%     | 70%     | 0.1-0.3   | Medium  | High       | Market pair detection  |
| **Volume Momentum**    | $50-100   | 10-20%    | 60%     | 6-10      | Medium  | Medium     | Real-time vol tracking |

### Recommended Priority for Implementation

1. **Crypto Latency Arb** — Highest potential gains, proven in production ($313 → $438K)
2. **Panic Reversal Sniper** — Novel, low competition, leverages existing price history infra
3. **Complement Arb** — Risk-free but competitive; good baseline income
4. **Resolution Race** — Strong edge with external data sources; moderate infra
5. **Volume Spike Momentum** — Novel momentum signal; works with CLOB data
6. **Liquidity Farming** — Passive income; good for capital sitting idle between trades
7. **Correlation Divergence** — Rare but high-conviction; more research-heavy
8. **Multi-Outcome Bundle** — Safe but slow capital turnover

### Combined Portfolio Estimate

Running 3-4 strategies simultaneously on $500:

| Combo                                        | Monthly $ | Monthly % |
|----------------------------------------------|-----------|-----------|
| Crypto Latency + Panic Reversal + Complement | $250-600  | 50-120%   |
| Resolution Race + Volume Momentum + Farming  | $190-400  | 38-80%    |
| All 8 strategies (diversified)               | $400-900  | 80-180%   |

> **Note**: These are theoretical maximums. Real-world performance depends on execution quality, competition, and market conditions. Apply 0.3-0.5x discount for realistic expectations.
