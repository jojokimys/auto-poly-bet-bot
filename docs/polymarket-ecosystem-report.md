# Polymarket Ecosystem: Comprehensive Report for Betting Operations

**Compiled: February 2026**
**Purpose: Reference guide for building a profitable prediction market trading operation**

---

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [Fee Structure](#2-fee-structure-critical-for-profitability)
3. [CLOB Mechanics](#3-clob-central-limit-order-book-mechanics)
4. [Liquidity Landscape](#4-liquidity-landscape)
5. [Market Categories & Opportunities](#5-market-categories--opportunities)
6. [Regulatory & Legal Considerations](#6-regulatory--legal-considerations)
7. [Ecosystem Tools & Resources](#7-ecosystem-tools--resources)
8. [Competitive Landscape](#8-competitive-landscape)
9. [Key Numbers for Financial Modeling](#9-key-numbers-for-financial-modeling)

---

## 1. Platform Overview

### How Polymarket Works

Polymarket is the world's largest prediction market platform, operating as a hybrid-decentralized exchange for binary outcome contracts. At its core:

- **Binary Markets**: Every market resolves to either YES or NO. Shares are priced between $0.00 and $1.00, where the price represents the market's implied probability of the event occurring.
- **Complementary Tokens**: For every market, YES + NO shares always sum to $1.00. If YES trades at $0.65, NO implicitly trades at $0.35.
- **Settlement**: When a market resolves, winning shares pay out $1.00 each; losing shares pay $0.00.

**Example**: A market asks "Will Bitcoin exceed $100,000 by March 2026?" If YES trades at $0.72, the market implies a 72% probability. Buying YES at $0.72 yields a profit of $0.28 per share if correct, or a loss of $0.72 per share if wrong.

### Conditional Token Framework (CTF) on Polygon

Polymarket uses the **Gnosis Conditional Tokens Framework (CTF)** deployed on the Polygon PoS network:

- **ERC-1155 Tokens**: Each outcome (YES/NO) is a distinct ERC-1155 token tied to a parent condition.
- **Fully Collateralized**: Every pair of YES/NO tokens is backed 1:1 by USDC. One unit of USDC can be **split** into 1 YES + 1 NO token, and conversely, 1 YES + 1 NO can be **merged** back into 1 USDC.
- **On-Chain Settlement**: While order matching occurs off-chain, all settlements execute on-chain via Polymarket's custom Exchange smart contract (audited by Chainsecurity).
- **Polygon Benefits**: Gas costs on Polygon are negligible ($0.001-$0.05 per transaction), enabling high-frequency strategies that would be prohibitively expensive on Ethereum mainnet.

### USDC as Base Currency

- All collateral and settlements denominated in **USDC (USD Coin)** on Polygon.
- No native token or governance token (Polymarket has not launched a token as of February 2026).
- Deposits accepted via direct Polygon USDC transfers, Ethereum-to-Polygon bridges, credit/debit cards (via MoonPay at 3.5-4.5% fee), and direct exchange withdrawals to Polygon.

### Market Creation and Resolution

**Market Creation**:
- Polymarket's team curates and creates markets. Third-party market creation is not open to the public.
- Each market specifies resolution criteria, expiration date, and resolution source.
- Markets use the `prepareCondition` function on the CTF contract to initialize the condition.

**Market Resolution via UMA Optimistic Oracle**:

Resolution follows a multi-stage process:

| Stage | Description | Duration |
|-------|-------------|----------|
| **Initialization** | Market request sent to UMA's Optimistic Oracle automatically | At market creation |
| **Proposal** | Anyone can propose a resolution by posting a `proposalBond` | Ongoing |
| **Challenge Period** | If no dispute, the proposed answer is accepted | 2 hours |
| **First Dispute** | If disputed, a new request is created (ignoring the first dispute) | Resets 2-hour window |
| **Second Dispute (DVM)** | Escalated to UMA DVM for token-holder vote | 48-72 hours |

**Key properties**:
- No single party (including Polymarket) unilaterally controls resolution.
- The process is permissionless -- anyone can propose or dispute.
- The optimistic design assumes proposals are correct unless challenged, enabling fast resolution for uncontroversial outcomes.

---

## 2. Fee Structure (CRITICAL FOR PROFITABILITY)

### Fee Overview by Platform Version

Polymarket now operates two distinct platforms with different fee structures:

| Feature | Polymarket Global (Decentralized) | Polymarket US (CFTC-Regulated) |
|---------|-----------------------------------|-------------------------------|
| **Maker Fees** | 0% (all markets) | 0% |
| **Taker Fees (Standard Markets)** | 0% | 0.10% (10 bps) of total contract premium |
| **Taker Fees (15-min Crypto)** | Up to ~3.15% (dynamic, see below) | N/A (separate market set) |
| **Deposit Fees** | 0% (Polymarket itself) | 0% |
| **Withdrawal Fees** | 0% (Polymarket itself) | 0% |
| **Gas Fees** | ~$0.001-0.05 per tx (Polygon) | Abstracted away |

### Polymarket Global: Detailed Fee Breakdown

**Standard Markets (Politics, Sports, Entertainment, etc.)**:
- **Maker: 0%**
- **Taker: 0%**
- Completely fee-free for both sides of the order book.

**15-Minute Crypto Markets (BTC, ETH, SOL, XRP)**:
- **Maker: 0%** (plus eligible for rebates)
- **Taker: Dynamic, up to ~3.15%**

The taker fee varies based on the contract price (probability). Fees are highest near 50% and approach zero near the extremes:

| Contract Price | Effective Taker Fee Rate | Fee on $100 Trade |
|---------------|-------------------------|-------------------|
| $0.05 / $0.95 | ~0.12% | ~$0.12 |
| $0.10 / $0.90 | ~0.20% | ~$0.20 |
| $0.20 / $0.80 | ~0.50% | ~$0.50 |
| $0.30 / $0.70 | ~0.82% | ~$0.82 |
| $0.40 / $0.60 | ~1.25% | ~$1.25 |
| $0.50 | ~1.56% (maximum) | ~$1.56 |

**Fee Formula** (for the maker rebate equivalent calculation):
```
fee_equivalent = shares x price x 0.25 x (price x (1 - price))^2
```

The fee is symmetric: a contract at $0.30 pays the same fee rate as one at $0.70.

### Polymarket US (Regulated Exchange)

| Parameter | Value |
|-----------|-------|
| Taker Fee | 0.10% (10 bps) of total contract premium |
| Maker Fee | 0% |
| Minimum Fee | $0.001 (10 bps floor) |
| Rounding | Nearest 10 basis points (0.1%) |

**Fee Calculation Examples (Polymarket US)**:

| Contracts | Price | Premium | Fee (0.10%) |
|-----------|-------|---------|-------------|
| 1,000 | $0.65 | $650.00 | $0.65 |
| 100 | $0.01 | $1.00 | $0.001 |
| 500 | $0.50 | $250.00 | $0.25 |
| 10,000 | $0.90 | $9,000.00 | $9.00 |

### Hidden Costs & Slippage

Beyond explicit fees, traders face:

| Cost Type | Typical Range | Notes |
|-----------|--------------|-------|
| **Bid-Ask Spread** | 1-5% (liquid markets) to 30%+ (illiquid) | Primary hidden cost for takers |
| **Slippage** | 0.1-2% (liquid) to 10%+ (illiquid) | Depends on order size vs. book depth |
| **Polygon Gas** | $0.001-$0.05/tx | Negligible for most strategies |
| **Bridge Costs** | $10-20 (ETH to Polygon) | One-time cost; use direct Polygon withdrawals |
| **MoonPay (card deposit)** | 3.5-4.5% | Avoid for trading operations |
| **Price Impact** | Variable | Large orders move the market |

### Break-Even Analysis: Required Edge by Strategy

| Strategy Type | Effective Cost per Round-Trip | Min Edge Required | Notes |
|--------------|------------------------------|-------------------|-------|
| **Long-term (Global, standard)** | ~Spread only (1-5%) | >1-5% | Fee-free; spread is the only cost |
| **Short-term (Global, 15-min crypto)** | 1.5-3% + spread | >3-5% | Dynamic taker fees apply |
| **Market Making (Global)** | Earn rebates | Positive EV from spread capture | Makers earn from rebate program |
| **Long-term (US regulated)** | 0.20% + spread | >1-3% | 0.10% each side |
| **High-frequency (US regulated)** | 0.20% x N trades + spread | >0.5-1% per trade | Fees compound with frequency |
| **Arbitrage (cross-platform)** | Fees on both platforms + spread | >Combined fees + spreads | Typically 2-5% minimum edge |

**Key Takeaway**: On Polymarket Global for standard markets, the only cost is the bid-ask spread. This makes it one of the lowest-cost prediction market venues in the world, and strategies that can capture spread or exploit informational edge face minimal friction.

---

## 3. CLOB (Central Limit Order Book) Mechanics

### Architecture

Polymarket's CLOB (also called "BLOB" -- Binary Limit Order Book) is a hybrid-decentralized system:

```
[User Signs EIP-712 Order] --> [Off-chain Operator Matches] --> [On-chain Exchange Contract Settles]
```

- **Off-chain**: The operator collects, validates, and matches orders. The operator cannot set prices or execute unauthorized trades.
- **On-chain**: The Exchange contract executes atomic swaps between outcome tokens and USDC. Users can cancel orders on-chain independently of the operator.
- **Non-custodial**: Funds remain in user wallets or the Exchange contract. The operator never takes custody.

### Order Types

| Order Type | Code | Behavior |
|-----------|------|----------|
| **Good-Til-Cancelled (GTC)** | `GTC` | Remains active until filled or manually cancelled |
| **Good-Til-Date (GTD)** | `GTD` | Expires at a specified UTC timestamp |
| **Fill-Or-Kill (FOK)** | `FOK` | Must fill entirely and immediately, or cancel entirely |
| **Fill-And-Kill (FAK)** | `FAK` | Fills whatever is available immediately, cancels the rest |

All orders are expressed as **limit orders** (which can be marketable if priced aggressively). There is no native "market order" type -- to execute a market order, submit a limit order at a price that crosses the spread.

### Order Matching

- **Price-Time Priority**: Orders are matched first by best price, then by arrival time at the same price level.
- **One Maker, Multiple Takers**: A single maker order can be matched against one or more taker orders.
- **Price Improvement**: When a taker order crosses the spread at a better price than the resting maker order, the price improvement benefits the taker.
- **Unified Book**: YES and NO shares trade on a unified order book. Buying YES at $0.60 is equivalent to selling NO at $0.40.

### Tick Sizes

Markets have variable minimum price increments:

| Tick Size | Typical Usage |
|-----------|--------------|
| `0.1` | Low-resolution markets |
| `0.01` | Standard markets (most common) |
| `0.001` | High-precision markets |
| `0.0001` | Ultra-precise markets |

**Special rule**: When the book price is > $0.96 or < $0.04, the minimum tick size changes (becomes finer) to allow trading near the extremes.

### Minimum Order Size

- Minimum order size is approximately **5 shares** per market (varies by market).
- No documented maximum order size, but large orders will face slippage.

### API Rate Limits

| Endpoint Category | Burst Limit (per 10s) | Sustained Limit | Notes |
|-------------------|----------------------|-----------------|-------|
| **POST /order** | 3,500 (350/s) | 60/min sustained | Primary trading endpoint |
| **DELETE /order** | 3,000 (300/s) | 50/min sustained | Order cancellation |
| **GET /book** | 1,500 | -- | Order book snapshots |
| **GET /price** | 1,500 | -- | Price queries |
| **GET /midprice** | 1,500 | -- | Midpoint queries |
| **Batch /books, /prices** | 500 | -- | Batch queries |
| **GAMMA /events** | 500 | -- | Event listings |
| **GAMMA /markets** | 300 | -- | Market listings |
| **GAMMA /search** | 350 | -- | Market search |
| **Data /trades** | 200 | -- | Trade history |
| **Data /positions** | 150 | -- | Position queries |
| **RELAYER** | -- | 25/min | On-chain relay |
| **Public general** | 15,000 | -- | General endpoints |

**Rate Limit Behavior**:
- Requests over the limit are **throttled/queued**, not dropped (via Cloudflare).
- Exceeding limits triggers HTTP 429 errors with exponential backoff required.
- Limits use sliding time windows (per 10s and per 10min).

**Impact on Strategies**:
- The 60 orders/min sustained limit is the binding constraint for high-frequency strategies.
- This equates to 1 order per second sustained, which is adequate for market-making across a handful of markets but restrictive for HFT across dozens of markets simultaneously.
- Burst capacity of 350/s allows rapid order placement/cancellation for inventory management.

---

## 4. Liquidity Landscape

### Overall Liquidity Statistics (from 290,000+ market data point analysis)

| Metric | Value |
|--------|-------|
| Total markets created (historical) | ~290,000+ |
| Markets with >$10M volume | 505 (account for 47% of total volume) |
| Markets with $100K-$10M volume | ~156,000 (7.54% of total volume) |
| Percentage of short-term markets with zero 24h volume | 63% |
| Average liquidity (long-term markets, >30 days) | ~$450,000 |
| Average liquidity (short-term markets, <1 day) | ~$10,000 |

### Liquidity by Market Category

| Category | Avg Volume (Long-term) | Avg Liquidity | Active Ratio | Notes |
|----------|----------------------|---------------|--------------|-------|
| **US Politics** | $28.17M | $811,000 | High | Deepest and most liquid category |
| **Sports (short-term)** | $1.32M | High | Very High | Highest short-term liquidity; ~40% of daily active users |
| **Sports (long-term)** | $16.59M | Very High | High | Championship/season-long markets |
| **Other/Pop Culture** | Variable | $420,000 | Moderate | Includes viral/social media topics |
| **Crypto (15-min)** | $44,000 | Low-Moderate | Moderate | Improving with maker rebates |
| **Geopolitics** | Variable | Growing | 29.7% (highest growth) | Fastest-growing category |
| **Niche/Tail** | <$10,000 | Very Low | Very Low | Extreme spreads (20-34%+) |

### Liquidity by Market Lifecycle

| Phase | Typical Spread | Depth | Notes |
|-------|---------------|-------|-------|
| **Just Created** | 10-30%+ | Minimal | Low awareness, few participants |
| **Building Momentum** | 3-10% | Growing | As news drives interest |
| **Peak Interest** | 1-3% | Deep | Major events, high volume |
| **Near Expiry (contested)** | 1-5% | Deep | High activity if outcome uncertain |
| **Near Expiry (clear outcome)** | 0.5-2% | Moderate | Price near $0.95+, less activity |
| **Post-Resolution** | N/A | N/A | Shares redeemed at $1 or $0 |

### Market Maker Incentive Programs

**Maker Rebates Program (15-minute crypto markets)**:
- Taker fees collected daily are redistributed to market makers as USDC rebates.
- Current rebate rate: **20% of collected taker fees** (reduced from initial 100% during launch period).
- Rebates are proportional to your share of executed maker liquidity in each eligible market.
- Rebate formula: `rebate = (your_fee_equivalent / total_fee_equivalent) x rebate_pool`

**Polymarket Rewards Program (all markets)**:
- Makers earn rewards for providing liquidity across all markets (separate from the 15-min crypto rebate program).
- Rewards based on order size, spread tightness, and duration of liquidity provision.
- Minimum share threshold applies for reward eligibility.

**Builders Program**:
- Over $2.5 million distributed in grants.
- $100 to $75,000 per project.
- Weekly USDC rewards based on volume generated.
- Gas subsidies covering all fees for builder code transactions.

---

## 5. Market Categories & Opportunities

### Category Breakdown

#### Politics (Highest Liquidity)
- **US Elections**: Presidential, congressional, gubernatorial races. By far the deepest markets on the platform.
- **Global Politics**: European elections, geopolitical events, policy outcomes.
- **Policy Outcomes**: Fed rate decisions, government shutdowns, legislative outcomes.
- **Edge Potential**: Moderate. Heavily traded by informed participants. Edge exists in understanding local/niche races, early information processing, and modeling complex conditional probabilities.

#### Sports (Highest Short-Term Volume)
- **Major Leagues**: NFL, NBA, MLB, soccer, MMA, tennis.
- **Event-Based**: Game outcomes, player props, championship futures.
- **Edge Potential**: Moderate-High. Sports data is abundant, and sophisticated models can find edges, especially in less popular markets. The 15-minute crypto model may expand to sports, changing the fee dynamics.

#### Crypto (15-Minute Markets)
- **Price Predictions**: Will BTC/ETH/SOL/XRP go up or down in the next 15 minutes?
- **Protocol Events**: Token launches, governance votes, network upgrades.
- **Edge Potential**: High for quantitative strategies. Short timeframes allow high-frequency approaches, but taker fees (up to 3.15%) create a significant hurdle. Market-making (earning rebates) is the more natural strategy here.

#### Entertainment / Pop Culture
- **Awards**: Oscars, Emmys, music awards.
- **Social Media**: Viral events, influencer actions.
- **Edge Potential**: High for niche expertise. These markets tend to be less liquid and less efficiently priced, meaning deep domain knowledge can provide meaningful edge.

#### Science & Technology
- **Space**: Rocket launches, Mars missions.
- **AI/Tech Milestones**: AGI timelines, product launches.
- **Climate**: Temperature records, policy milestones.
- **Edge Potential**: Moderate-High. Technical expertise combined with thin liquidity creates opportunity, but position sizes are limited by available liquidity.

#### Geopolitics (Fastest Growing)
- **Conflicts**: War outcomes, peace negotiations.
- **International Relations**: Trade agreements, sanctions.
- **Edge Potential**: High. Active ratio of 29.7% is the highest across categories, indicating growing but still under-served markets.

### Where the Most Edge Exists

| Factor | Best Categories | Reasoning |
|--------|----------------|-----------|
| **Informational Edge** | Niche politics, entertainment, science | Fewer sophisticated participants |
| **Quantitative Edge** | Sports, crypto (15-min) | Abundant data, modelable |
| **Liquidity to Exploit** | US politics, major sports | Enough depth to size positions |
| **Edge + Liquidity Sweet Spot** | Mid-tier sports, geopolitics | Moderate liquidity with less competition |
| **Market Making** | 15-min crypto | Direct rebate incentives |

---

## 6. Regulatory & Legal Considerations

### Polymarket's Regulatory History

| Date | Event |
|------|-------|
| **2020** | Polymarket launches as unregulated DeFi platform |
| **Jan 2022** | CFTC charges Polymarket for operating unregistered facility |
| **Jan 2022** | Polymarket pays $1.4M civil penalty; agrees to block US users |
| **2022-2025** | Operates globally (excluding US) as decentralized platform |
| **Jul 2025** | Polymarket acquires QCEX (CFTC-licensed exchange) for $112M |
| **Sep 2025** | CFTC clears Polymarket for US return |
| **Nov 2025** | CFTC grants Amended Order of Designation as intermediated contract market |
| **Dec 2025** | Polymarket US launches as CFTC-regulated platform |

### Current Regulatory Status (February 2026)

**Polymarket Global (Decentralized)**:
- Operates outside US jurisdiction.
- No formal regulatory license in most jurisdictions.
- Crypto-native: wallet-based access, no mandatory KYC for basic usage.
- US IP addresses are geo-blocked (though VPN usage is common and difficult to enforce).

**Polymarket US (CFTC-Regulated)**:
- Designated Contract Market (DCM) under CFTC oversight.
- Full KYC/AML requirements for all US users.
- Trades routed through approved brokers or FCMs (Futures Commission Merchants).
- Not available in all 50 states -- some states classify event contracts as gambling requiring separate state licensing.

### Geographic Restrictions

| Region | Access | Notes |
|--------|--------|-------|
| **United States** | Polymarket US only (KYC required) | Not all states; some block event contracts |
| **European Union** | Global version accessible | Regulatory clarity still evolving |
| **United Kingdom** | Global version accessible | FCA has not specifically addressed |
| **Canada** | Global version accessible | No specific regulation |
| **Sanctioned Countries** | Blocked | OFAC sanctions list applies |

### Legal Risks for Operating a Betting Fund

1. **Classification Uncertainty**: Prediction markets exist in a gray area between financial derivatives, gambling, and information markets. The legal classification affects licensing, tax treatment, and operational requirements.

2. **Fund Structure Risks**: A fund that trades prediction markets may need to register as a commodity pool (if classified as derivatives) or comply with gambling regulations (if classified as betting).

3. **US Nexus**: Any US investors, US-based operations, or US-targeted marketing could trigger CFTC jurisdiction even for global platform activity.

4. **Anti-Manipulation Rules**: Both CFTC and state regulators have anti-manipulation authority over event contracts. Large position manipulation (as seen in some contested Polymarket markets) is a real legal risk.

5. **Cross-Border Complexity**: Operating across jurisdictions without clear regulatory frameworks creates compliance risk.

### Tax Implications

Tax treatment of prediction market profits is **unsettled** as of February 2026:

| Classification | Tax Treatment | Deductibility of Losses |
|---------------|---------------|------------------------|
| **Capital Gains** | Short-term: up to 37%; Long-term: 0-20% | Yes, against capital gains + $3K ordinary income |
| **Gambling Income** | Ordinary income rates (up to 37%) | Only against gambling winnings (if itemizing) |
| **Ordinary Income** | Ordinary income rates (up to 37%) | As business expenses (if trading as business) |

**Critical Notes**:
- Polymarket does **not** issue 1099 forms.
- Blockchain activity is visible and auditable -- do not assume anonymity.
- Professional traders should consider electing Section 475(f) mark-to-market treatment.
- Consult a tax professional specializing in crypto/derivatives taxation.

---

## 7. Ecosystem Tools & Resources

### Official Polymarket Resources

| Resource | URL | Purpose |
|----------|-----|---------|
| **Polymarket Docs** | docs.polymarket.com | API reference, guides, SDK |
| **Python SDK** | github.com/Polymarket/py-clob-client | Official Python CLOB client |
| **JS/TS SDK** | github.com/Polymarket/clob-client | Official JavaScript CLOB client |
| **CTF Examples** | github.com/Polymarket/conditional-token-examples | Conditional token interaction examples |
| **Agents Framework** | github.com/Polymarket/agents | Official AI agent framework |
| **Subgraph (Goldsky)** | Via GraphQL | Real-time on-chain data indexing |
| **Discord** | discord.gg/polymarket | #devs channel for developer support |
| **Polymarket News** | news.polymarket.com | Official blog and newsletters |

### Key Third-Party Analytics & Trading Tools

| Tool | Category | Key Feature |
|------|----------|-------------|
| **Betmoar** | Trading Terminal | $110M+ cumulative volume; official Discord bot |
| **Stand.trade** | Trading Terminal | Professional terminal with automation |
| **Polymtrade** | Mobile Terminal | First mobile-dedicated terminal (iOS/Android) |
| **Polysights** | Analytics | AI-powered with 30+ custom metrics; arbitrage detection |
| **HashDive** | Analytics | Smart Scores (-100 to 100) rating trader performance |
| **Polymarket Analytics** | Dashboard | Updates every 5 minutes; comprehensive trader data |
| **PredictFolio** | Portfolio Tracking | Free portfolio tracking and performance analysis |
| **Polyburg** | Whale Tracking | Monitors hundreds of profitable wallets |
| **PolyAlertHub** | Alerts | Whale tracking, AI analytics, custom notifications |
| **ArbBets** | Arbitrage | Auto-arbitrage between Polymarket and Kalshi |
| **EventArb** | Arbitrage | Free calculators factoring fees and spreads |
| **Matchr** | Aggregator | Searches 1,500+ markets for best prices |
| **Oddpool** | Aggregator | "Bloomberg for prediction markets" |
| **Dome** | API/Data | Unified APIs with historical and real-time access |
| **PolyRouter** | API/Data | Normalized data from multiple prediction markets |
| **Tremor.live** | Volatility Detection | Detects unusual volatility and momentum anomalies |

### On-Chain Data Sources

| Source | URL | Data Available |
|--------|-----|----------------|
| **Dune Analytics** | dune.com/filarm/polymarket-activity | Volume, activity, user metrics |
| **Goldsky Subgraph** | Via GraphQL | Real-time trade, volume, position data |
| **PolygonScan** | polygonscan.com | Raw contract interactions |
| **Bitquery** | docs.bitquery.io | Structured Polymarket API for prices, trades |
| **DefiLlama** | defillama.com/protocol/polymarket | TVL, volume tracking |
| **Token Terminal** | tokenterminal.com | Trading volume metrics |

### Community & Information

| Resource | Platform | Focus |
|----------|----------|-------|
| **Polymarket Discord** | Discord | Official community, #devs channel |
| **@Polymarket** | X (Twitter) | Official announcements |
| **@UMAprotocol** | X (Twitter) | Oracle and resolution updates |
| **PolyNoob** | Web | Education platform with 110+ trader profiles |
| **PolymarketGuide** | GitBook | Beginner-friendly documentation |
| **Polymark.et** | Web | Most complete apps directory of ecosystem |

---

## 8. Competitive Landscape

### Platform Comparison

| Feature | Polymarket Global | Polymarket US | Kalshi | Manifold Markets | Metaculus |
|---------|------------------|---------------|--------|-----------------|-----------|
| **Type** | Decentralized | CFTC-Regulated DCM | CFTC-Regulated DCM | Play money | Forecasting (no real money) |
| **Currency** | USDC (Polygon) | USD | USD | Mana (play) | Reputation points |
| **2025 Volume** | ~$12-24B* | Launched Dec 2025 | ~$27.3B | N/A | N/A |
| **Maker Fees** | 0% | 0% | Rebates up to 1% | 0% | N/A |
| **Taker Fees** | 0% (standard) / up to 3% (15-min) | 0.10% | Variable (prob-weighted) | 0% | N/A |
| **KYC Required** | No (Global) | Yes | Yes | No | No |
| **US Access** | Blocked (geo-fence) | Yes (state-dependent) | Yes (most states) | Yes | Yes |
| **Market Variety** | Very High | Growing | High | Very High | Moderate |
| **API Quality** | Excellent | New | Good | Good | Good |
| **Settlement** | On-chain (Polygon) | Centralized | Centralized | Centralized | N/A |

*Note: Polymarket's reported ~$21.5B figure has been shown to be double-counted. Actual volume is estimated at $10-12B for 2025.

### Accuracy Comparison

| Platform | Reported Accuracy | Methodology |
|----------|------------------|-------------|
| **PredictIt** | ~93% | Historical US politics |
| **Kalshi** | ~78% | 2024 US election markets |
| **Polymarket** | ~67% | 2024 US election markets |
| **Metaculus** | Brier Score: 0.084 | Cross-category forecasting |
| **Manifold** | Brier Score: 0.107 | Cross-category forecasting |

Note: Accuracy varies significantly by market type and liquidity. High-liquidity Polymarket markets (1,000+ daily contracts) achieve 88-93% calibration accuracy.

### Arbitrage Opportunities Between Platforms

**Polymarket vs. Kalshi**:
- Both list overlapping political and economic markets.
- Price discrepancies of 1-5% are common on lower-liquidity markets.
- Tools like ArbBets and EventArb automate detection.
- Between April 2024 and April 2025, an estimated **$40 million in arbitrage profits** were extracted across the ecosystem.
- Friction: different settlement (crypto vs. USD), different KYC requirements, timing differences.

**Polymarket vs. Bookmakers (Sports)**:
- Polymarket sports markets can diverge from traditional sportsbook odds.
- Opportunity exists especially in niche markets where bookmaker lines are sharper.
- Friction: Polymarket uses shares ($0-$1) while bookmakers use odds; conversion is straightforward but execution across platforms is manual.

### Polymarket's Advantages

1. **Zero fees on standard markets** (Global) -- unmatched in the industry.
2. **24/7/365 operation** -- no exchange hours limitation.
3. **Non-custodial** -- users maintain control of funds.
4. **Excellent API** -- well-documented, SDK support in Python and JS.
5. **Deepest liquidity** on high-profile markets.
6. **Programmable** -- smart contract settlement enables composability.
7. **No position limits** -- can size aggressively (double-edged).

### Polymarket's Disadvantages

1. **Volume double-counting** in public metrics creates misleading data.
2. **Geo-restrictions** -- US users cannot access Global platform; US platform is new.
3. **Whale manipulation risk** -- no position limits means single actors can move markets.
4. **Resolution disputes** -- UMA oracle disputes have occasionally caused prolonged uncertainty.
5. **Crypto-native friction** -- requires USDC on Polygon; onboarding is more complex than Kalshi.
6. **No formal investor protections** (Global) -- no SIPC or equivalent coverage.
7. **Liquidity concentration** -- 63% of short-term markets have zero volume.

---

## 9. Key Numbers for Financial Modeling

### Volume & Activity Metrics

| Metric | Value | Notes |
|--------|-------|-------|
| **2025 Reported Volume** | ~$21.5B | Double-counted; actual ~$10-12B |
| **2025 Corrected Monthly Avg** | ~$1.0-1.25B/month | After correction |
| **Peak Daily Volume (2026)** | Up to $700M (all platforms) | During major events |
| **Total On-Chain Transactions (2025)** | 95M+ | Includes all contract interactions |
| **Daily Active Users (Sports)** | ~8,698 | ~40% of total DAU |
| **Markets with >$10M Volume** | 505 | 47% of total volume |
| **Polymarket Valuation** | ~$9B | Following ICE investment |

### Typical Spreads by Market Type

| Market Type | Typical Bid-Ask Spread | Best Case | Worst Case |
|-------------|----------------------|-----------|------------|
| **Major US Politics** | 1-2% | 0.5% | 5% |
| **Major Sports Events** | 1-3% | 0.5% | 5% |
| **Popular Crypto (15-min)** | 2-5% | 1% | 8% |
| **Geopolitics** | 3-8% | 2% | 15% |
| **Entertainment/Awards** | 3-10% | 2% | 20% |
| **Science/Technology** | 5-15% | 3% | 30%+ |
| **Niche/Tail Markets** | 10-34%+ | 5% | 50%+ |

**Note**: If the spread exceeds $0.10, Polymarket displays the last traded price instead of the midpoint.

### Calibration & Accuracy

| Price Range | Observed Outcome Frequency | Calibration Error |
|-------------|---------------------------|-------------------|
| 10% priced | ~12% actual | +2% |
| 30% priced | ~28% actual | -2% |
| 50% priced | ~49% actual | -1% |
| 70% priced | ~68-72% actual | -0-2% |
| 90% priced | ~88% actual | -2% |

**Important caveat**: These calibration numbers apply to **liquid markets** (1,000+ daily contracts, 88-93% calibration). Thin markets (<500 daily contracts) show only 70-80% calibration, meaning prices are less reliable as probability estimates.

### Maker/Taker Volume Split

| Market Type | Est. Maker % | Est. Taker % | Notes |
|-------------|-------------|-------------|-------|
| **Standard Markets** | ~40-50% | ~50-60% | Even split; no fee incentive to prefer one |
| **15-min Crypto** | ~30-40% | ~60-70% | Taker-heavy; maker incentivized by rebates |

### Position Sizing Reference

| Market Liquidity Tier | Comfortable Position Size | Max Before Major Impact |
|----------------------|--------------------------|------------------------|
| **Top Tier ($10M+ volume)** | $10,000 - $100,000 | $500,000+ |
| **Mid Tier ($100K-$10M)** | $1,000 - $10,000 | $50,000 |
| **Low Tier ($10K-$100K)** | $100 - $1,000 | $5,000 |
| **Illiquid (<$10K)** | $10 - $100 | $500 |

### Cost Model for a $100,000 Monthly Trading Operation

| Scenario | Platform | Trades/Month | Avg Size | Total Fees | Spread Cost | Total Cost | Cost % |
|----------|----------|-------------|----------|-----------|-------------|------------|--------|
| **Long-term value** | Global (standard) | 50 | $2,000 | $0 | ~$1,500 | ~$1,500 | 1.5% |
| **Active trading** | Global (standard) | 200 | $500 | $0 | ~$3,000 | ~$3,000 | 3.0% |
| **15-min crypto MM** | Global (15-min) | 1,000 | $100 | Earn rebates | ~$2,000 | Net positive | N/A |
| **US regulated active** | US | 200 | $500 | $100 | ~$3,000 | ~$3,100 | 3.1% |
| **Cross-platform arb** | Global + Kalshi | 100 | $1,000 | ~$100 (Kalshi) | ~$4,000 | ~$4,100 | 4.1% |

---

## Appendix A: Quick Reference - Fee Formulas

### Polymarket Global Fee Calculation (15-min Crypto Only)

**Taker Fee (buying outcome tokens)**:
```
feeBase = baseRate x min(price, 1-price) x size / price
```

**Taker Fee (selling outcome tokens)**:
```
feeQuote = baseRate x min(price, 1-price) x size
```

**Maker Rebate Equivalent**:
```
fee_equivalent = shares x price x 0.25 x (price x (1 - price))^2
```

**Daily Rebate**:
```
rebate = (your_fee_equivalent / total_fee_equivalent) x rebate_pool
```

### Polymarket US Fee Calculation

```
fee = contracts x price_per_contract x 0.001
minimum_fee = $0.001
```

---

## Appendix B: Key Contract Addresses (Polygon)

| Contract | Address |
|----------|---------|
| **Conditional Tokens (CTF)** | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| **Exchange Contract** | See Polymarket docs for latest |
| **USDC on Polygon** | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |

---

## Appendix C: Sources

### Official Documentation
- [Polymarket Documentation](https://docs.polymarket.com/)
- [Polymarket Trading Fees](https://docs.polymarket.com/polymarket-learn/trading/fees)
- [Maker Rebates Program](https://docs.polymarket.com/polymarket-learn/trading/maker-rebates-program)
- [CLOB Introduction](https://docs.polymarket.com/developers/CLOB/introduction)
- [API Rate Limits](https://docs.polymarket.com/quickstart/introduction/rate-limits)
- [CTF Overview](https://docs.polymarket.com/developers/CTF/overview)
- [UMA Resolution](https://docs.polymarket.com/developers/resolution/UMA)
- [Market Maker Trading](https://docs.polymarket.com/developers/market-makers/trading)
- [Polymarket US Fees & Hours](https://www.polymarketexchange.com/fees-hours.html)

### Research & Analysis
- [Polymarket Volume Is Being Double-Counted - Paradigm](https://www.paradigm.xyz/2025/12/polymarket-volume-is-being-double-counted)
- [Deep Dive into 290,000 Market Data Points - PANews](https://www.panewslab.com/en/articles/d886495b-90ba-40bc-90a8-49419a956701)
- [Exploring Decentralized Prediction Markets - SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5910522)
- [Polymarket Accuracy Page](https://polymarket.com/accuracy)

### Ecosystem & Competitive
- [Definitive Guide to the Polymarket Ecosystem (170+ Tools) - DeFi Prime](https://defiprime.com/definitive-guide-to-the-polymarket-ecosystem)
- [Kalshi vs Polymarket Comparison - CryptoNews](https://cryptonews.com/cryptocurrency/kalshi-vs-polymarket/)
- [Polymarket and Kalshi Hit Record $40B Volume - Phemex](https://phemex.com/news/article/polymarket-and-kalshi-achieve-record-40b-trading-volume-in-2025-49434)

### Regulatory
- [CFTC Orders Polymarket $1.4M Penalty (2022)](https://www.cftc.gov/PressRoom/PressReleases/8478-22)
- [Polymarket Secures CFTC Approval - CoinDesk](https://www.coindesk.com/business/2025/11/25/polymarket-secures-cftc-approval-for-regulated-u-s-return/)
- [Is Polymarket Legal in the US - Gambling Insider](https://www.gamblinginsider.com/in-depth/106291/is-polymarket-legal-in-the-us)
- [Prediction Market Regulation Guide - Heitner Legal](https://heitnerlegal.com/2025/10/22/prediction-market-regulation-legal-compliance-guide-for-polymarket-kalshi-and-event-contract-startups/)

### Tax
- [Prediction Markets Taxation - CNBC](https://www.cnbc.com/2025/12/23/prediction-markets-trading-income-taxes-gains-losses.html)
- [Prediction Market Taxes Explained - Camuso CPA](https://camusocpa.com/prediction-market-taxes-reporting/)
- [Polymarket Tax Guide - PolyTax](https://www.polymarket.tax/polymarket-tax)

### Developer & Tools
- [Polymarket GitHub - Agents Framework](https://github.com/Polymarket/agents)
- [Polymarket GitHub - py-clob-client](https://github.com/Polymarket/py-clob-client)
- [NautilusTrader Polymarket Integration](https://nautilustrader.io/docs/latest/integrations/polymarket/)
- [UMA Optimistic Oracle Documentation](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work)
