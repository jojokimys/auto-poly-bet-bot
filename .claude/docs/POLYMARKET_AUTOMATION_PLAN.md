# Polymarket Automated Betting Bot - Comprehensive TypeScript Plan

## Table of Contents

1. [Polymarket API & SDK Overview](#1-polymarket-api--sdk-overview)
2. [Core Automation Scripts](#2-core-automation-scripts)
3. [Key TypeScript Interfaces & Types](#3-key-typescript-interfaces--types)
4. [Blockchain Integration](#4-blockchain-integration)
5. [Script Architecture Patterns](#5-script-architecture-patterns)
6. [Backtesting Framework](#6-backtesting-framework)
7. [Example Script Skeletons](#7-example-script-skeletons)
8. [Recommended npm Packages](#8-recommended-npm-packages)

---

## 1. Polymarket API & SDK Overview

### 1.1 System Architecture

Polymarket operates a **hybrid-decentralized** Central Limit Order Book (CLOB). An off-chain operator handles order matching and sequencing, while settlement executes on-chain on Polygon via signed EIP-712 order messages. This means orders are non-custodial -- the exchange never holds your funds without your cryptographic consent.

### 1.2 API Endpoints & Base URLs

| Service | URL | Purpose |
|---------|-----|---------|
| CLOB API | `https://clob.polymarket.com` | Trading, orders, order books, prices |
| Gamma API | `https://gamma-api.polymarket.com` | Market metadata, events, categories, volume |
| CLOB WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/{channel}` | Real-time order book, user orders/trades |
| Real-Time Data WS | `wss://ws-live-data.polymarket.com` | Live trades, comments, price feeds |

### 1.3 Authentication: L1 and L2

Polymarket uses a **two-level authentication** system:

#### Level 1 (L1) -- Private Key Signing

Used to create or derive API credentials. Signs EIP-712 typed data proving wallet ownership.

**EIP-712 Domain:**
```
Domain: "ClobAuthDomain", version "1", chainId 137
Types: ClobAuth { address, timestamp, nonce, message }
Message: "This message attests that I control the given wallet"
```

**Required REST Headers for L1:**
| Header | Value |
|--------|-------|
| `POLY_ADDRESS` | Your Polygon signer address |
| `POLY_SIGNATURE` | EIP-712 signature |
| `POLY_TIMESTAMP` | Current UNIX timestamp |
| `POLY_NONCE` | Nonce (default 0) |

**L1 Endpoints:**
- `POST /auth/api-key` -- Create new API credentials
- `GET /auth/derive-api-key` -- Derive existing credentials using original nonce

**Response:**
```json
{
  "apiKey": "uuid-format-string",
  "secret": "base64-encoded-string",
  "passphrase": "random-string"
}
```

#### Level 2 (L2) -- HMAC-SHA256 API Key Auth

Used for all trading operations. Signs each request with HMAC-SHA256 using the `secret` from L1.

**Required REST Headers for L2:**
| Header | Value |
|--------|-------|
| `POLY_ADDRESS` | Your Polygon signer address |
| `POLY_SIGNATURE` | HMAC-SHA256 signature of the request |
| `POLY_TIMESTAMP` | Current UNIX timestamp |
| `POLY_API_KEY` | Your apiKey |
| `POLY_PASSPHRASE` | Your passphrase |

#### Signature Types

| Type | ID | Use Case |
|------|-----|----------|
| EOA | `0` | Standard Ethereum wallets (MetaMask, etc.) |
| POLY_PROXY | `1` | Magic Link / email login with exported private key |
| POLY_GNOSIS_SAFE | `2` | Gnosis Safe proxy wallets (most common for new users) |

### 1.4 REST API Endpoints

#### CLOB API -- Market Data (Public, No Auth)
```
GET /markets                    -- List all markets
GET /market/{conditionId}       -- Get single market
GET /simplified-markets         -- Simplified market list
GET /sampling-markets           -- Sampling markets
GET /book                       -- Order book for a token
GET /books                      -- Multiple order books
GET /price                      -- Price for a token + side
GET /prices                     -- Multiple prices
GET /midpoint                   -- Midpoint price
GET /midpoints                  -- Multiple midpoints
GET /spread                     -- Spread for a token
GET /spreads                    -- Multiple spreads
GET /last-trade-price           -- Last trade price
GET /last-trades-prices         -- Multiple last trade prices
GET /prices-history             -- Historical prices
```

#### CLOB API -- Trading (L2 Auth Required)
```
POST   /order                   -- Place a single order
POST   /orders                  -- Place batch orders (up to 15)
DELETE /order/{orderId}         -- Cancel a single order
DELETE /orders                  -- Cancel multiple orders
DELETE /cancel-all              -- Cancel all open orders
GET    /open-orders             -- List open orders
GET    /order/{orderId}         -- Get order by ID
GET    /trades                  -- Get trade history
GET    /balance-allowance       -- Check balance and allowance
POST   /balance-allowance       -- Update balance/allowance
```

#### Gamma API -- Market Metadata (Public, No Auth)
```
GET /events                     -- List events with filtering
GET /events/{id}                -- Single event
GET /markets                    -- List markets with filtering
GET /markets/{id}               -- Single market
```

### 1.5 WebSocket Feeds

#### CLOB WebSocket Channels

**Market Channel** (no auth required):
```typescript
// Connect to: wss://ws-subscriptions-clob.polymarket.com/ws/market
const subscriptionMessage = {
  type: "market",
  assets_ids: ["<YES_TOKEN_ID>", "<NO_TOKEN_ID>"],
  initial_dump: true,
};
```

**User Channel** (L2 auth required):
```typescript
// Connect to: wss://ws-subscriptions-clob.polymarket.com/ws/user
const subscriptionMessage = {
  auth: {
    apiKey: "<your-api-key>",
    secret: "<your-secret>",
    passphrase: "<your-passphrase>",
  },
  type: "user",
  markets: ["<CONDITION_ID>"],
};
```

**Dynamic subscription/unsubscription after connection:**
```typescript
ws.send(JSON.stringify({
  assets_ids: ["<NEW_TOKEN_ID>"],
  operation: "subscribe", // or "unsubscribe"
}));
```

**Keepalive:** Send `"PING"` every 50 seconds to maintain the connection.

#### Real-Time Data Client Topics

| Topic | Type | Auth | Description |
|-------|------|------|-------------|
| `activity` | `trades` | No | Live trade feed |
| `activity` | `orders_matched` | No | Matched orders |
| `comments` | `comment_created` | No | New comments |
| `crypto_prices` | `update` | No | BTC, ETH, SOL, etc. |
| `equity_prices` | `update` | No | AAPL, TSLA, NVDA, etc. |
| `rfq` | `request_created` | No | RFQ requests |
| `rfq` | `quote_created` | No | RFQ quotes |
| `clob_user` | `*` | Yes | User's orders and trades |

### 1.6 The @polymarket/clob-client Package

**Installation:**
```bash
npm install @polymarket/clob-client ethers@5
```

**Key Dependencies (from the package):**
- `@ethersproject/wallet` ^5.7.0
- `@ethersproject/providers` ^5.7.2
- `@polymarket/order-utils` ^3.0.1
- `ethers` ^5.7.1
- `axios` ^1.0.0

**Current Version:** 5.2.1 (as of January 2026)

**Client Initialization (two-step):**

```typescript
import { ClobClient, ApiKeyCreds, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

const host = "https://clob.polymarket.com";
const chainId = 137; // Polygon mainnet

// Step 1: Create a temporary client and derive API keys
const signer = new Wallet("<YOUR_PRIVATE_KEY>");
const tempClient = new ClobClient(host, chainId, signer);
const creds: ApiKeyCreds = await tempClient.createOrDeriveApiKey();

// Step 2: Initialize the full trading client
const signatureType = 2; // POLY_GNOSIS_SAFE for most users
const funder = "<YOUR_POLYMARKET_DEPOSIT_ADDRESS>";
const clobClient = new ClobClient(
  host,
  chainId,
  signer,
  creds,
  signatureType,
  funder,
);
```

**Key Client Methods:**

| Method | Auth | Description |
|--------|------|-------------|
| `getMarkets()` | None | Fetch all markets |
| `getMarket(conditionId)` | None | Fetch single market |
| `getOrderBook(tokenId)` | None | Fetch order book |
| `getPrice(tokenId, side)` | None | Get price |
| `getMidpoint(tokenId)` | None | Get midpoint |
| `getSpread(tokenId)` | None | Get spread |
| `createApiKey()` | L1 | Create new API key |
| `deriveApiKey()` | L1 | Derive existing API key |
| `createOrDeriveApiKey()` | L1 | Create or derive API key |
| `createOrder(params)` | L2 | Build signed order locally |
| `postOrder(order, orderType)` | L2 | Submit order to exchange |
| `createAndPostOrder(params, options, type)` | L2 | Build and submit in one call |
| `getOpenOrders()` | L2 | Get all open orders |
| `cancelOrder(orderId)` | L2 | Cancel specific order |
| `cancelAll()` | L2 | Cancel all orders |
| `getTrades()` | L2 | Get trade history |
| `getBalanceAllowance(params)` | L2 | Check balances |

### 1.7 Rate Limits

All limits use sliding windows and Cloudflare throttling (requests are delayed/queued, not dropped).

#### CLOB API Limits
| Endpoint | Burst (per 10s) | Sustained (per 10min) |
|----------|-----------------|----------------------|
| `POST /order` | 3,500 | 36,000 |
| `DELETE /order` | 3,000 | 30,000 |
| `POST /orders` (batch) | 1,000 | 15,000 |
| `DELETE /cancel-all` | 250 | 6,000 |
| `/book`, `/price`, `/midprice` | 1,500 | -- |
| `/books`, `/prices`, `/midprices` | 500 | -- |
| Auth endpoints | 100 | -- |
| Balance checks | 200 | -- |

#### Gamma API Limits
| Endpoint | Rate (per 10s) |
|----------|----------------|
| General | 4,000 |
| `/events` | 500 |
| `/markets` | 300 |
| Search | 350 |

#### Data API Limits
| Endpoint | Rate (per 10s) |
|----------|----------------|
| General | 1,000 |
| `/trades` | 200 |
| `/positions` | 150 |

### 1.8 Best Practices

1. **Use WebSockets for real-time data** -- avoid polling REST endpoints.
2. **Always derive keys** instead of creating new ones -- use `createOrDeriveApiKey()`.
3. **Implement exponential backoff** when throttled.
4. **Cache market metadata** from Gamma API -- it changes infrequently.
5. **Use batch endpoints** (`/orders`, `/books`, `/prices`) to reduce request count.
6. **Keep WebSocket connections alive** with periodic `PING` messages every 50s.
7. **Track your rate limit consumption** and implement client-side throttling.

---

## 2. Core Automation Scripts

### 2.1 Market Scanner

**Purpose:** Fetch and filter all active markets, identify opportunities based on configurable criteria (volume, spread, time to resolution, mispricing).

**Design:**
```
[Gamma API] --> [Market Fetcher] --> [Filter Pipeline] --> [Opportunity Ranker] --> [Alert System]
```

**Key Logic:**
- Poll Gamma API `/events` and `/markets` at intervals (respecting rate limits)
- Filter by: active status, minimum volume, minimum liquidity, time-to-expiry
- Calculate spread, implied probability, and cross-market correlations
- Rank opportunities by a composite score
- Emit events for downstream consumers (order placer, dashboard)

**Filter Criteria Examples:**
- Markets where YES + NO prices deviate significantly from $1.00
- Markets with abnormally wide spreads (market-making opportunity)
- Newly listed markets with growing volume
- Markets approaching resolution with high-confidence pricing

### 2.2 Order Placer

**Purpose:** Place limit and marketable-limit orders for YES/NO shares with proper validation.

**Design:**
```
[Strategy Signal] --> [Order Builder] --> [Validation] --> [CLOB Client] --> [Confirmation Handler]
```

**Key Logic:**
- Accept signals with `tokenId`, `side`, `price`, `size`, `orderType`
- Validate against balance/allowance before submission
- Handle all three order types: GTC (Good-Till-Cancelled), GTD (Good-Till-Date), FOK (Fill-Or-Kill)
- Support `postOnly` flag for maker-only orders
- Track order IDs and statuses after submission
- Retry on transient failures with exponential backoff

**Order Types Explained:**
- **GTC**: Remains active until filled or manually cancelled
- **GTD**: Active until a specified UTC timestamp (min 1 minute in future)
- **FOK**: Must fill entirely and immediately, or the entire order is cancelled (market order behavior)

### 2.3 Position Monitor

**Purpose:** Track all open positions, calculate unrealized P&L, cost basis, and exposure.

**Design:**
```
[CLOB Client] --> [Position Tracker] --> [P&L Calculator] --> [Dashboard/Alerts]
     |                                        |
[Trade History] -------> [Cost Basis Engine] --+
```

**Key Logic:**
- Periodically fetch open orders and trade history
- Subscribe to user WebSocket channel for real-time trade confirmations
- Calculate weighted average cost basis per position
- Compute unrealized P&L using current midpoint prices
- Track total exposure, margin usage, and portfolio Greeks equivalent
- Emit alerts when positions exceed configurable thresholds

### 2.4 Auto-Rebalancer

**Purpose:** Automatically adjust positions based on strategy signals, target allocations, and portfolio constraints.

**Design:**
```
[Strategy Engine] --> [Target Calculator] --> [Delta Engine] --> [Order Placer]
                           |                       |
                    [Current Positions] ----> [Size Calculator]
```

**Key Logic:**
- Accept target allocation map: `{ [tokenId]: targetPercentage }`
- Compare current positions vs. targets
- Calculate required trades to reach target (buy or sell deltas)
- Apply position sizing rules: max position %, max single trade size
- Execute rebalancing orders with configurable aggression (passive limit vs. FOK)
- Implement deadband to avoid over-trading on small deviations

### 2.5 Stop-Loss / Take-Profit

**Purpose:** Automated risk management triggers that close or reduce positions when price thresholds are breached.

**Design:**
```
[WebSocket Price Feed] --> [Trigger Monitor] --> [Order Placer]
                                |
                         [Position Store]
```

**Key Logic:**
- Maintain a registry of triggers: `{ tokenId, triggerPrice, direction, action, size }`
- Subscribe to market WebSocket for real-time price updates
- Compare current price against triggers on every tick
- Execute FOK orders immediately on trigger breach
- Support trailing stops: dynamically adjust trigger price as price moves favorably
- Log all triggered actions for audit trail

### 2.6 Market Maker Bot

**Purpose:** Place and manage two-sided quotes (bid + ask) to earn the spread.

**Design:**
```
[Order Book Feed] --> [Quote Calculator] --> [Order Manager] --> [CLOB Client]
       |                     |                     |
  [Inventory] -----> [Skew Adjuster] -------> [Cancel/Replace]
```

**Key Logic:**
- Continuously quote bid and ask around the midpoint
- Apply inventory-based skew: shift quotes away from side with excess inventory
- Configure: spread width, quote size, max inventory, refresh interval
- Cancel and replace stale quotes when midpoint moves beyond threshold
- Track fill rate, inventory, and realized spread P&L
- Implement circuit breakers for abnormal market conditions
- Use batch order endpoints to minimize request count

### 2.7 Arbitrage Scanner

**Purpose:** Detect pricing inefficiencies across related markets and within binary market pairs.

**Design:**
```
[Multi-Market Feed] --> [Arb Detector] --> [Opportunity Validator] --> [Execution Engine]
```

**Key Logic:**
- **Binary Pair Arb:** YES price + NO price should equal ~$1.00. Detect when sum deviates.
- **NegRisk Event Arb:** In negative-risk events, cross-outcome pricing must be consistent.
- **Cross-Event Correlation:** Related markets (e.g., "Will X happen by March?" vs. "Will X happen by June?") must be logically consistent -- the shorter-dated cannot exceed the longer-dated.
- **Execution:** When arb detected, simultaneously buy the underpriced and sell the overpriced.
- Account for fees (currently 0 bps maker/taker) and slippage in profitability calculation.
- Minimum profit threshold to avoid trading on noise.

---

## 3. Key TypeScript Interfaces & Types

```typescript
// ============================================================
// WALLET & CREDENTIALS
// ============================================================

export interface WalletConfig {
  /** Private key (hex string with 0x prefix) */
  privateKey: string;
  /** Polymarket deposit/proxy address (funder) */
  funderAddress: string;
  /** 0 = EOA, 1 = POLY_PROXY, 2 = POLY_GNOSIS_SAFE */
  signatureType: 0 | 1 | 2;
  /** Polygon RPC URL */
  rpcUrl: string;
}

export interface APICredentials {
  key: string;
  secret: string;
  passphrase: string;
}

// ============================================================
// MARKET DATA
// ============================================================

export interface Market {
  condition_id: string;
  question_id: string;
  tokens: MarketToken[];
  rewards: MarketReward;
  minimum_order_size: number;
  minimum_tick_size: string; // "0.01" or "0.001"
  description: string;
  category: string;
  end_date_iso: string;
  game_start_time: string;
  question: string;
  market_slug: string;
  min_incentive_size: string;
  max_incentive_spread: string;
  active: boolean;
  closed: boolean;
  seconds_delay: number;
  icon: string;
  fpmm: string;
  neg_risk: boolean;
}

export interface MarketToken {
  token_id: string;
  outcome: "Yes" | "No";
  price: number;
  winner: boolean;
}

export interface MarketReward {
  min_size: number;
  max_spread: number;
  event_start_date: string;
  event_end_date: string;
  in_game_multiplier: number;
}

export interface GammaEvent {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description: string;
  start_date: string;
  end_date: string;
  neg_risk: boolean;
  markets: GammaMarket[];
  series: string;
  category: string;
  tags: string[];
  volume: number;
  liquidity: number;
  competitive: number;
}

export interface GammaMarket {
  id: number;
  question: string;
  condition_id: string;
  slug: string;
  tokens: GammaToken[];
  end_date_iso: string;
  description: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  volume: number;
  volume_num: number;
  liquidity: number;
  neg_risk: boolean;
}

export interface GammaToken {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

// ============================================================
// ORDER BOOK
// ============================================================

export interface OrderBookSummary {
  market: string;
  asset_id: string;
  timestamp: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  min_order_size: number;
  tick_size: string;
  neg_risk: boolean;
  hash: string;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

// ============================================================
// ORDERS
// ============================================================

export enum OrderSide {
  BUY = "BUY",
  SELL = "SELL",
}

export enum OrderType {
  GTC = "GTC",   // Good-Till-Cancelled
  GTD = "GTD",   // Good-Till-Date
  FOK = "FOK",   // Fill-Or-Kill (market order)
}

export enum OrderStatus {
  LIVE = "live",
  MATCHED = "matched",
  DELAYED = "delayed",
  UNMATCHED = "unmatched",
  CANCELLED = "cancelled",
}

export interface OrderRequest {
  tokenID: string;
  price: number;
  size: number;
  side: OrderSide;
  expiration?: number;      // Unix timestamp, required for GTD
  feeRateBps?: string;      // Fee rate in basis points
  nonce?: string;
}

export interface OrderOptions {
  tickSize: "0.01" | "0.001";
  negRisk: boolean;
}

export interface SignedOrder {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: string;
  signatureType: number;
  signature: string;
}

export interface OrderResponse {
  success: boolean;
  errorMsg: string;
  orderId: string;
  orderHashes: string[];
  status: OrderStatus;
}

export interface OpenOrder {
  id: string;
  status: OrderStatus;
  owner: string;
  market: string;
  asset_id: string;
  side: OrderSide;
  original_size: string;
  size_matched: string;
  price: string;
  created_at: number;
  expiration: string;
  type: OrderType;
  associate_trades: string[];
}

// ============================================================
// TRADES & POSITIONS
// ============================================================

export interface Trade {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: OrderSide;
  size: string;
  fee_rate_bps: string;
  price: string;
  status: string;
  match_time: string;
  last_update: string;
  outcome: string;
  bucket_index: number;
  owner: string;
  maker_address: string;
  transaction_hash: string;
  trader_side: OrderSide;
}

export interface Position {
  asset_id: string;
  condition_id: string;
  market_slug: string;
  outcome: string;
  size: number;
  avg_cost: number;
  current_price: number;
  unrealized_pnl: number;
  realized_pnl: number;
  total_cost: number;
}

export interface PortfolioSummary {
  total_value: number;
  total_cost: number;
  unrealized_pnl: number;
  realized_pnl: number;
  positions: Position[];
  usdc_balance: number;
}

// ============================================================
// BALANCE & ALLOWANCE
// ============================================================

export enum AssetType {
  COLLATERAL = "COLLATERAL",
  CONDITIONAL = "CONDITIONAL",
}

export interface BalanceAllowanceParams {
  asset_type: AssetType;
  token_id?: string; // Required for CONDITIONAL
}

export interface BalanceAllowance {
  balance: string;
  allowance: string;
}

// ============================================================
// STRATEGY
// ============================================================

export enum StrategyType {
  MARKET_MAKING = "MARKET_MAKING",
  ARBITRAGE = "ARBITRAGE",
  TREND_FOLLOWING = "TREND_FOLLOWING",
  MEAN_REVERSION = "MEAN_REVERSION",
  COPY_TRADING = "COPY_TRADING",
  CUSTOM = "CUSTOM",
}

export interface StrategyConfig {
  name: string;
  type: StrategyType;
  enabled: boolean;
  /** Markets this strategy operates on (condition IDs) */
  markets: string[];
  /** Max USDC to allocate */
  maxCapital: number;
  /** Max single position as fraction of capital */
  maxPositionPct: number;
  /** Min profit threshold to act */
  minProfitThreshold: number;
  /** Strategy-specific parameters */
  params: Record<string, unknown>;
}

export interface StrategySignal {
  timestamp: number;
  strategy: string;
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  confidence: number;   // 0.0 - 1.0
  reason: string;
  orderType: OrderType;
}

// ============================================================
// RISK MANAGEMENT
// ============================================================

export enum TriggerType {
  STOP_LOSS = "STOP_LOSS",
  TAKE_PROFIT = "TAKE_PROFIT",
  TRAILING_STOP = "TRAILING_STOP",
}

export interface RiskTrigger {
  id: string;
  tokenId: string;
  triggerType: TriggerType;
  triggerPrice: number;
  currentStopPrice?: number;  // For trailing stops
  trailAmount?: number;       // For trailing stops
  side: OrderSide;
  size: number;               // Size to close
  active: boolean;
  createdAt: number;
}

// ============================================================
// WEBSOCKET MESSAGES
// ============================================================

export interface WSSubscriptionMessage {
  auth?: {
    apiKey: string;
    secret: string;
    passphrase: string;
  };
  type: "user" | "market";
  markets?: string[];       // Condition IDs for user channel
  assets_ids?: string[];    // Token IDs for market channel
  initial_dump?: boolean;
}

export interface WSDynamicSubscription {
  assets_ids?: string[];
  markets?: string[];
  operation: "subscribe" | "unsubscribe";
}

export interface WSTradeMessage {
  asset: string;
  conditionId: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: string;
  price: string;
  side: "BUY" | "SELL";
  size: string;
  timestamp: string;
  transactionHash: string;
}
```

---

## 4. Blockchain Integration

### 4.1 Contract Addresses (Polygon Mainnet)

| Contract | Address |
|----------|---------|
| Conditional Tokens (CTF) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| Neg Risk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |
| USDC.e (Bridged USDC) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |

### 4.2 USDC Approval Flow

Before trading, three approvals must be set on-chain:

```typescript
import { ethers, constants } from "ethers";

// 1. Approve USDC spending by the CTF contract (for minting conditional tokens)
const usdcContract = new ethers.Contract(USDC_ADDRESS, usdcAbi, wallet);
await usdcContract.approve(CTF_ADDRESS, constants.MaxUint256, {
  gasPrice: 100_000_000_000,  // 100 gwei
  gasLimit: 200_000,
});

// 2. Approve USDC spending by the Exchange contract (for buying shares)
await usdcContract.approve(EXCHANGE_ADDRESS, constants.MaxUint256, {
  gasPrice: 100_000_000_000,
  gasLimit: 200_000,
});

// 3. Approve the Exchange to transfer conditional tokens (for selling shares)
const ctfContract = new ethers.Contract(CTF_ADDRESS, ctfAbi, wallet);
await ctfContract.setApprovalForAll(EXCHANGE_ADDRESS, true, {
  gasPrice: 100_000_000_000,
  gasLimit: 200_000,
});
```

For **NegRisk markets**, additional approvals are needed for the NegRisk Exchange and Adapter:

```typescript
// 4. Approve USDC for NegRisk Exchange
await usdcContract.approve(NEG_RISK_EXCHANGE_ADDRESS, constants.MaxUint256, {
  gasPrice: 100_000_000_000,
  gasLimit: 200_000,
});

// 5. Approve CTF for NegRisk Exchange
await ctfContract.setApprovalForAll(NEG_RISK_EXCHANGE_ADDRESS, true, {
  gasPrice: 100_000_000_000,
  gasLimit: 200_000,
});

// 6. Approve CTF for NegRisk Adapter
await ctfContract.setApprovalForAll(NEG_RISK_ADAPTER_ADDRESS, true, {
  gasPrice: 100_000_000_000,
  gasLimit: 200_000,
});
```

**Alternatively, use the CLOB client helpers:**
```typescript
// The clob-client provides built-in methods
await clobClient.setAllowances();             // Standard markets
await clobClient.setNegRiskAllowances();      // NegRisk markets
await clobClient.updateBalanceAllowance();    // Sync with server
```

### 4.3 Conditional Token Framework (CTF)

Polymarket uses Gnosis CTF -- an ERC1155 token standard for conditional outcomes.

**Key Concepts:**
- **ConditionId**: Derived from `getConditionId(oracle, questionId, outcomeSlotCount)` -- identifies the market.
- **CollectionId**: Derived from `getCollectionId(parentCollectionId, conditionId, indexSet)` -- identifies a specific outcome set.
- **PositionId (TokenId)**: Derived from `getPositionId(collateralToken, collectionId)` -- the ERC1155 token representing a specific outcome share.

**Minting and Redemption:**
- **Split**: Deposit USDC to mint equal quantities of YES and NO tokens.
- **Merge**: Burn equal quantities of YES and NO to redeem USDC.
- **Redeem**: After resolution, burn winning tokens for USDC at $1.00 each.

### 4.4 Wallet Management with ethers.js

```typescript
import { ethers } from "ethers";
import { Wallet } from "@ethersproject/wallet";

// Create provider
const provider = new ethers.providers.JsonRpcProvider(
  `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`
);

// Create wallet from private key
const wallet = new Wallet(PRIVATE_KEY, provider);

// Check USDC balance
const usdc = new ethers.Contract(USDC_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
const balance = await usdc.balanceOf(wallet.address);
console.log(`USDC Balance: ${ethers.utils.formatUnits(balance, 6)}`);

// Check POL (formerly MATIC) balance for gas
const polBalance = await provider.getBalance(wallet.address);
console.log(`POL Balance: ${ethers.utils.formatEther(polBalance)}`);
```

### 4.5 Gas Optimization Strategies

1. **Set gas price dynamically** using the network's gas oracle:
   ```typescript
   const gasPrice = await provider.getGasPrice();
   const adjustedGas = gasPrice.mul(110).div(100); // 10% buffer
   ```
2. **Batch approvals** -- set `MaxUint256` allowances once rather than per-trade.
3. **Most trading is off-chain** -- gas is only needed for approvals, deposits, and withdrawals. The CLOB handles order matching off-chain.
4. **Keep a small POL balance** (0.1-1.0 POL) on the signer address for occasional on-chain transactions.
5. **Use EIP-1559 transactions** on Polygon for more predictable gas costs:
   ```typescript
   const tx = await usdcContract.approve(EXCHANGE_ADDRESS, constants.MaxUint256, {
     maxFeePerGas: ethers.utils.parseUnits("50", "gwei"),
     maxPriorityFeePerGas: ethers.utils.parseUnits("30", "gwei"),
     gasLimit: 200_000,
   });
   ```

---

## 5. Script Architecture Patterns

### 5.1 Event-Driven Architecture

```typescript
import { EventEmitter } from "events";

// Central event bus for all bot components
class BotEventBus extends EventEmitter {
  // Type-safe event emission
  emitSignal(signal: StrategySignal): boolean {
    return this.emit("strategy:signal", signal);
  }

  emitTrade(trade: Trade): boolean {
    return this.emit("trade:executed", trade);
  }

  emitPriceUpdate(tokenId: string, price: number): boolean {
    return this.emit("price:update", { tokenId, price });
  }

  emitError(component: string, error: Error): boolean {
    return this.emit("bot:error", { component, error, timestamp: Date.now() });
  }
}

// Usage across components
const bus = new BotEventBus();

// Strategy engine emits signals
bus.emitSignal({
  timestamp: Date.now(),
  strategy: "mean-reversion",
  tokenId: "71321...",
  side: OrderSide.BUY,
  price: 0.45,
  size: 100,
  confidence: 0.85,
  reason: "Price 2 stddev below 24h mean",
  orderType: OrderType.GTC,
});

// Order placer listens for signals
bus.on("strategy:signal", async (signal: StrategySignal) => {
  if (signal.confidence >= 0.7) {
    await orderPlacer.execute(signal);
  }
});

// Risk manager listens for trades
bus.on("trade:executed", (trade: Trade) => {
  riskManager.updatePosition(trade);
});
```

### 5.2 Retry Logic and Error Handling

```typescript
import { AxiosError } from "axios";

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: number[];
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
};

async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  context: string = "unknown",
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const isRetryable = status
        ? config.retryableStatuses.includes(status)
        : axiosError.code === "ECONNRESET" || axiosError.code === "ETIMEDOUT";

      if (!isRetryable || attempt === config.maxRetries) {
        throw error;
      }

      const delay = Math.min(
        config.baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
        config.maxDelayMs,
      );

      console.warn(
        `[${context}] Attempt ${attempt + 1}/${config.maxRetries} failed ` +
        `(status=${status}). Retrying in ${Math.round(delay)}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
```

### 5.3 Rate Limiter Implementation

```typescript
class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    const now = Date.now();

    // Remove timestamps outside the window
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      const oldestInWindow = this.timestamps[0];
      const waitTime = this.windowMs - (now - oldestInWindow) + 10;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.acquire(); // Recurse after waiting
    }

    this.timestamps.push(now);
  }

  get remaining(): number {
    const now = Date.now();
    const activeCount = this.timestamps.filter((t) => now - t < this.windowMs).length;
    return Math.max(0, this.maxRequests - activeCount);
  }
}

// Create limiters per endpoint category
const orderLimiter = new SlidingWindowRateLimiter(3500, 10_000);  // 3500/10s
const bookLimiter = new SlidingWindowRateLimiter(1500, 10_000);   // 1500/10s
const gammaLimiter = new SlidingWindowRateLimiter(4000, 10_000);  // 4000/10s

// Wrap API calls
async function placeOrder(order: SignedOrder): Promise<OrderResponse> {
  await orderLimiter.acquire();
  return clobClient.postOrder(order, OrderType.GTC);
}
```

### 5.4 Logging with Winston

```typescript
import winston from "winston";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: "poly-bot" },
  transports: [
    // Console with colorized output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : "";
          return `${timestamp} [${service}] ${level}: ${message} ${metaStr}`;
        }),
      ),
    }),
    // File transport for full JSON logs
    new winston.transports.File({
      filename: "logs/bot-error.log",
      level: "error",
      maxsize: 10_000_000,  // 10MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: "logs/bot-combined.log",
      maxsize: 50_000_000,  // 50MB
      maxFiles: 10,
    }),
  ],
});

// Create child loggers for each component
const orderLogger = logger.child({ component: "order-placer" });
const wsLogger = logger.child({ component: "websocket" });
const strategyLogger = logger.child({ component: "strategy" });
```

### 5.5 Configuration Management

```typescript
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

// Validate all configuration with Zod
const EnvSchema = z.object({
  // Wallet
  PRIVATE_KEY: z.string().startsWith("0x").length(66),
  FUNDER_ADDRESS: z.string().startsWith("0x").length(42),
  SIGNATURE_TYPE: z.coerce.number().int().min(0).max(2).default(2),

  // API
  CLOB_API_URL: z.string().url().default("https://clob.polymarket.com"),
  CLOB_API_KEY: z.string().uuid().optional(),
  CLOB_SECRET: z.string().optional(),
  CLOB_PASSPHRASE: z.string().optional(),

  // RPC
  RPC_URL: z.string().url().default("https://polygon-rpc.com"),
  ALCHEMY_KEY: z.string().optional(),

  // WebSocket
  WS_URL: z
    .string()
    .url()
    .default("wss://ws-subscriptions-clob.polymarket.com"),

  // Bot Settings
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  DRY_RUN: z.coerce.boolean().default(true),
  MAX_CAPITAL_USDC: z.coerce.number().positive().default(100),
  MAX_POSITION_PCT: z.coerce.number().min(0).max(1).default(0.1),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(): AppConfig {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Configuration validation failed:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}
```

### 5.6 Graceful Shutdown Handling

```typescript
class GracefulShutdown {
  private shutdownCallbacks: Array<{ name: string; fn: () => Promise<void> }> = [];
  private isShuttingDown = false;

  constructor() {
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("uncaughtException", (err) => {
      logger.error("Uncaught exception", { error: err.message, stack: err.stack });
      this.shutdown("uncaughtException");
    });
    process.on("unhandledRejection", (reason) => {
      logger.error("Unhandled rejection", { reason });
      this.shutdown("unhandledRejection");
    });
  }

  register(name: string, fn: () => Promise<void>): void {
    this.shutdownCallbacks.push({ name, fn });
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info(`Received ${signal}. Starting graceful shutdown...`);

    // Cancel all open orders first
    try {
      logger.info("Cancelling all open orders...");
      await clobClient.cancelAll();
      logger.info("All orders cancelled.");
    } catch (err) {
      logger.error("Failed to cancel orders during shutdown", { error: err });
    }

    // Run registered cleanup callbacks in reverse order
    for (const cb of [...this.shutdownCallbacks].reverse()) {
      try {
        logger.info(`Shutting down: ${cb.name}`);
        await Promise.race([
          cb.fn(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 5000),
          ),
        ]);
      } catch (err) {
        logger.error(`Shutdown error in ${cb.name}`, { error: err });
      }
    }

    logger.info("Graceful shutdown complete.");
    process.exit(0);
  }
}

// Usage
const shutdown = new GracefulShutdown();
shutdown.register("websocket", async () => ws.close());
shutdown.register("database", async () => db.close());
shutdown.register("metrics", async () => metricsServer.close());
```

---

## 6. Backtesting Framework

### 6.1 Historical Data Collection

```typescript
import { ClobClient } from "@polymarket/clob-client";
import fs from "fs/promises";

interface HistoricalTick {
  timestamp: number;
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  midpoint: number;
  volume: number;
}

class DataCollector {
  private client: ClobClient;
  private buffer: HistoricalTick[] = [];
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(client: ClobClient) {
    this.client = client;
  }

  async startCollection(tokenIds: string[], intervalMs: number = 60_000): Promise<void> {
    // Periodic snapshot collection
    this.flushInterval = setInterval(async () => {
      for (const tokenId of tokenIds) {
        try {
          const book = await this.client.getOrderBook(tokenId);
          const midpoint = await this.client.getMidpoint(tokenId);

          this.buffer.push({
            timestamp: Date.now(),
            tokenId,
            bestBid: book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0,
            bestAsk: book.asks.length > 0 ? parseFloat(book.asks[0].price) : 0,
            midpoint: parseFloat(midpoint),
            volume: 0, // Calculated from trade diffs
          });
        } catch (err) {
          logger.error(`Data collection error for ${tokenId}`, { error: err });
        }
      }
    }, intervalMs);

    // Flush to disk every 5 minutes
    setInterval(() => this.flush(), 300_000);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const data = [...this.buffer];
    this.buffer = [];

    const dateStr = new Date().toISOString().split("T")[0];
    const filePath = `data/ticks_${dateStr}.jsonl`;
    const lines = data.map((tick) => JSON.stringify(tick)).join("\n") + "\n";
    await fs.appendFile(filePath, lines);
    logger.info(`Flushed ${data.length} ticks to ${filePath}`);
  }

  stop(): void {
    if (this.flushInterval) clearInterval(this.flushInterval);
  }
}
```

### 6.2 Backtesting Engine

```typescript
interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  strategy: StrategyConfig;
  dataPath: string;
  slippageBps: number;
  feeBps: number;
}

interface BacktestResult {
  trades: BacktestTrade[];
  equity_curve: { timestamp: number; equity: number }[];
  metrics: PerformanceMetrics;
}

interface BacktestTrade {
  timestamp: number;
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  pnl: number;
  equity_after: number;
}

class BacktestEngine {
  private config: BacktestConfig;
  private positions: Map<string, { size: number; avgCost: number }> = new Map();
  private equity: number;
  private trades: BacktestTrade[] = [];
  private equityCurve: { timestamp: number; equity: number }[] = [];

  constructor(config: BacktestConfig) {
    this.config = config;
    this.equity = config.initialCapital;
  }

  async run(strategy: (tick: HistoricalTick, engine: BacktestEngine) => StrategySignal | null): Promise<BacktestResult> {
    const ticks = await this.loadData();

    for (const tick of ticks) {
      // Let strategy generate signals
      const signal = strategy(tick, this);

      if (signal) {
        this.executeTrade(signal, tick);
      }

      // Update equity curve
      const positionValue = this.calculatePositionValue(tick);
      this.equityCurve.push({
        timestamp: tick.timestamp,
        equity: this.equity + positionValue,
      });
    }

    return {
      trades: this.trades,
      equity_curve: this.equityCurve,
      metrics: this.calculateMetrics(),
    };
  }

  private executeTrade(signal: StrategySignal, tick: HistoricalTick): void {
    const slippage = signal.price * (this.config.slippageBps / 10_000);
    const fee = signal.price * signal.size * (this.config.feeBps / 10_000);

    const executionPrice =
      signal.side === OrderSide.BUY
        ? signal.price + slippage
        : signal.price - slippage;

    const cost = executionPrice * signal.size + fee;
    const position = this.positions.get(signal.tokenId) || { size: 0, avgCost: 0 };

    let pnl = 0;
    if (signal.side === OrderSide.BUY) {
      const newSize = position.size + signal.size;
      position.avgCost = (position.avgCost * position.size + cost) / newSize;
      position.size = newSize;
      this.equity -= cost;
    } else {
      pnl = (executionPrice - position.avgCost) * signal.size - fee;
      position.size -= signal.size;
      this.equity += executionPrice * signal.size - fee;
    }

    this.positions.set(signal.tokenId, position);
    this.trades.push({
      timestamp: tick.timestamp,
      tokenId: signal.tokenId,
      side: signal.side,
      price: executionPrice,
      size: signal.size,
      pnl,
      equity_after: this.equity,
    });
  }

  private calculatePositionValue(tick: HistoricalTick): number {
    let total = 0;
    for (const [tokenId, position] of this.positions.entries()) {
      if (tokenId === tick.tokenId) {
        total += position.size * tick.midpoint;
      }
    }
    return total;
  }

  private async loadData(): Promise<HistoricalTick[]> {
    const files = await fs.readdir(this.config.dataPath);
    const allTicks: HistoricalTick[] = [];

    for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
      const content = await fs.readFile(`${this.config.dataPath}/${file}`, "utf-8");
      const lines = content.trim().split("\n");
      for (const line of lines) {
        const tick = JSON.parse(line) as HistoricalTick;
        if (tick.timestamp >= this.config.startDate.getTime() &&
            tick.timestamp <= this.config.endDate.getTime()) {
          allTicks.push(tick);
        }
      }
    }

    return allTicks.sort((a, b) => a.timestamp - b.timestamp);
  }

  private calculateMetrics(): PerformanceMetrics {
    // Implemented in next section
    return calculatePerformanceMetrics(this.equityCurve, this.trades, this.config.initialCapital);
  }
}
```

### 6.3 Performance Metrics

```typescript
interface PerformanceMetrics {
  totalReturn: number;
  totalReturnPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  totalTrades: number;
  avgTradesPerDay: number;
  calmarRatio: number;
}

function calculatePerformanceMetrics(
  equityCurve: { timestamp: number; equity: number }[],
  trades: BacktestTrade[],
  initialCapital: number,
): PerformanceMetrics {
  // Returns
  const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? initialCapital;
  const totalReturn = finalEquity - initialCapital;
  const totalReturnPct = totalReturn / initialCapital;

  // Daily returns for Sharpe/Sortino
  const dailyReturns: number[] = [];
  const msPerDay = 86_400_000;
  let prevEquity = initialCapital;

  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i].timestamp - equityCurve[i - 1].timestamp >= msPerDay) {
      const ret = (equityCurve[i].equity - prevEquity) / prevEquity;
      dailyReturns.push(ret);
      prevEquity = equityCurve[i].equity;
    }
  }

  const avgReturn = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
  const stdDev = Math.sqrt(
    dailyReturns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) /
    (dailyReturns.length || 1),
  );
  const downDev = Math.sqrt(
    dailyReturns.filter((r) => r < 0).reduce((s, r) => s + r * r, 0) /
    (dailyReturns.filter((r) => r < 0).length || 1),
  );

  // Sharpe Ratio (annualized, assuming 0 risk-free rate)
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(365) : 0;
  const sortinoRatio = downDev > 0 ? (avgReturn / downDev) * Math.sqrt(365) : 0;

  // Max Drawdown
  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const drawdown = peak - point.equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  const maxDrawdownPct = peak > 0 ? maxDrawdown / peak : 0;

  // Win/Loss analysis
  const closedTrades = trades.filter((t) => t.side === OrderSide.SELL);
  const wins = closedTrades.filter((t) => t.pnl > 0);
  const losses = closedTrades.filter((t) => t.pnl <= 0);
  const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Duration
  const durationDays = equityCurve.length > 1
    ? (equityCurve[equityCurve.length - 1].timestamp - equityCurve[0].timestamp) / msPerDay
    : 1;

  return {
    totalReturn,
    totalReturnPct,
    sharpeRatio,
    sortinoRatio,
    maxDrawdown,
    maxDrawdownPct,
    winRate,
    profitFactor,
    avgWin,
    avgLoss,
    totalTrades: trades.length,
    avgTradesPerDay: trades.length / durationDays,
    calmarRatio: maxDrawdownPct > 0 ? totalReturnPct / maxDrawdownPct : 0,
  };
}
```

### 6.4 Paper Trading Mode

```typescript
class PaperTradingClient {
  private positions: Map<string, { size: number; avgCost: number }> = new Map();
  private balance: number;
  private trades: Trade[] = [];
  private readonly logger: winston.Logger;

  constructor(initialBalance: number) {
    this.balance = initialBalance;
    this.logger = logger.child({ component: "paper-trading" });
  }

  async simulateOrder(
    tokenId: string,
    side: OrderSide,
    price: number,
    size: number,
  ): Promise<OrderResponse> {
    const cost = price * size;

    if (side === OrderSide.BUY && cost > this.balance) {
      return { success: false, errorMsg: "Insufficient balance", orderId: "", orderHashes: [], status: OrderStatus.CANCELLED };
    }

    const position = this.positions.get(tokenId) || { size: 0, avgCost: 0 };

    if (side === OrderSide.SELL && size > position.size) {
      return { success: false, errorMsg: "Insufficient position", orderId: "", orderHashes: [], status: OrderStatus.CANCELLED };
    }

    // Simulate fill
    if (side === OrderSide.BUY) {
      const newSize = position.size + size;
      position.avgCost = (position.avgCost * position.size + cost) / newSize;
      position.size = newSize;
      this.balance -= cost;
    } else {
      position.size -= size;
      this.balance += cost;
    }

    this.positions.set(tokenId, position);

    const orderId = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.logger.info("Paper trade executed", {
      orderId,
      tokenId,
      side,
      price,
      size,
      balance: this.balance,
    });

    return { success: true, errorMsg: "", orderId, orderHashes: [], status: OrderStatus.MATCHED };
  }

  getPortfolio(): PortfolioSummary {
    const positions: Position[] = [];
    for (const [tokenId, pos] of this.positions.entries()) {
      if (pos.size > 0) {
        positions.push({
          asset_id: tokenId,
          condition_id: "",
          market_slug: "",
          outcome: "",
          size: pos.size,
          avg_cost: pos.avgCost,
          current_price: 0, // Requires live price lookup
          unrealized_pnl: 0,
          realized_pnl: 0,
          total_cost: pos.avgCost * pos.size,
        });
      }
    }

    return {
      total_value: this.balance,
      total_cost: 0,
      unrealized_pnl: 0,
      realized_pnl: 0,
      positions,
      usdc_balance: this.balance,
    };
  }
}

// Toggle between paper and live trading via config
function createOrderClient(config: AppConfig): OrderClient {
  if (config.DRY_RUN) {
    return new PaperTradingClient(config.MAX_CAPITAL_USDC);
  }
  return new LiveOrderClient(clobClient);
}
```

---

## 7. Example Script Skeletons

### 7.1 Full Bot Initialization

```typescript
// src/index.ts
import { ClobClient, ApiKeyCreds, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { ethers } from "ethers";
import dotenv from "dotenv";
import { loadConfig } from "./config";
import { logger } from "./logger";
import { GracefulShutdown } from "./shutdown";
import { BotEventBus } from "./events";

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfig();
  const shutdown = new GracefulShutdown();
  const bus = new BotEventBus();

  logger.info("Starting Polymarket Bot", {
    dryRun: config.DRY_RUN,
    maxCapital: config.MAX_CAPITAL_USDC,
  });

  // --------------------------------------------------
  // 1. Initialize wallet and CLOB client
  // --------------------------------------------------
  const provider = new ethers.providers.JsonRpcProvider(config.RPC_URL);
  const wallet = new Wallet(config.PRIVATE_KEY, provider);
  logger.info(`Wallet address: ${wallet.address}`);
  logger.info(`Funder address: ${config.FUNDER_ADDRESS}`);

  // Step 1: Derive API credentials
  const tempClient = new ClobClient(config.CLOB_API_URL, 137, wallet);
  let creds: ApiKeyCreds;

  if (config.CLOB_API_KEY && config.CLOB_SECRET && config.CLOB_PASSPHRASE) {
    creds = {
      key: config.CLOB_API_KEY,
      secret: config.CLOB_SECRET,
      passphrase: config.CLOB_PASSPHRASE,
    };
    logger.info("Using existing API credentials from environment");
  } else {
    creds = await tempClient.createOrDeriveApiKey();
    logger.info("Derived new API credentials", { apiKey: creds.key });
    logger.warn("Save these to your .env file:");
    logger.warn(`  CLOB_API_KEY=${creds.key}`);
    logger.warn(`  CLOB_SECRET=${creds.secret}`);
    logger.warn(`  CLOB_PASSPHRASE=${creds.passphrase}`);
  }

  // Step 2: Create the full trading client
  const clobClient = new ClobClient(
    config.CLOB_API_URL,
    137,
    wallet,
    creds,
    config.SIGNATURE_TYPE,
    config.FUNDER_ADDRESS,
  );

  // --------------------------------------------------
  // 2. Verify connectivity and balances
  // --------------------------------------------------
  const serverTime = await clobClient.getServerTime();
  logger.info(`Server time: ${serverTime}`);

  const collateral = await clobClient.getBalanceAllowance({
    asset_type: "COLLATERAL" as any,
  });
  logger.info(`USDC Balance: ${collateral.balance}, Allowance: ${collateral.allowance}`);

  // --------------------------------------------------
  // 3. Register shutdown handler
  // --------------------------------------------------
  shutdown.register("cancel-orders", async () => {
    logger.info("Cancelling all open orders on shutdown...");
    await clobClient.cancelAll();
  });

  // --------------------------------------------------
  // 4. Start components (customize per strategy)
  // --------------------------------------------------
  logger.info("Bot initialized successfully. Ready to trade.");

  // Keep the process alive
  await new Promise(() => {}); // Runs until shutdown signal
}

main().catch((err) => {
  logger.error("Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
```

### 7.2 Place an Order

```typescript
// src/scripts/place-order.ts
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

async function placeOrder(clobClient: ClobClient): Promise<void> {
  // Example: Buy 50 YES shares at $0.45 on a specific market
  const tokenId = "71321045679252212594626385532706912750332728571942532289631379312455583992563";

  // Option A: Two-step (create then post)
  const order = await clobClient.createOrder({
    tokenID: tokenId,
    price: 0.45,
    side: Side.BUY,
    size: 50,
    feeRateBps: "0",
    nonce: "0",
  });
  const response = await clobClient.postOrder(order, OrderType.GTC);

  console.log("Order placed:", response);
  // { success: true, orderId: "0xabc...", status: "live" }

  // Option B: One-step (create and post combined)
  const response2 = await clobClient.createAndPostOrder(
    {
      tokenID: tokenId,
      price: 0.45,
      side: Side.BUY,
      size: 50,
    },
    {
      tickSize: "0.01",  // or "0.001" depending on market
      negRisk: false,
    },
    OrderType.GTC,
    false,  // deferExec
    false,  // postOnly
  );

  console.log("Order placed:", response2);

  // GTD Order (expires at specific time)
  const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
  const gtdResponse = await clobClient.createAndPostOrder(
    {
      tokenID: tokenId,
      price: 0.40,
      side: Side.BUY,
      size: 25,
      expiration: expiresAt,
    },
    { tickSize: "0.01", negRisk: false },
    OrderType.GTD,
  );

  // FOK Order (fill immediately or cancel entirely)
  const fokResponse = await clobClient.createAndPostOrder(
    {
      tokenID: tokenId,
      price: 0.50,   // Price high enough to match existing asks
      side: Side.BUY,
      size: 100,
    },
    { tickSize: "0.01", negRisk: false },
    OrderType.FOK,
  );

  // Cancel an order
  await clobClient.cancelOrder("order-id-here");

  // Cancel all orders
  await clobClient.cancelAll();
}
```

### 7.3 WebSocket Market Data Subscription

```typescript
// src/scripts/ws-market-feed.ts
import WebSocket from "ws";
import { ApiKeyCreds } from "@polymarket/clob-client";

interface MarketFeedConfig {
  tokenIds: string[];
  conditionIds?: string[];
  onOrderBookUpdate: (data: any) => void;
  onUserTrade?: (data: any) => void;
  credentials?: ApiKeyCreds;
}

class MarketWebSocketFeed {
  private ws: WebSocket | null = null;
  private config: MarketFeedConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(config: MarketFeedConfig) {
    this.config = config;
  }

  connect(): void {
    const wsUrl = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      logger.info("WebSocket connected to market channel");
      this.reconnectAttempts = 0;

      // Send subscription message
      const subMsg = {
        type: "market",
        assets_ids: this.config.tokenIds,
        initial_dump: true,
      };
      this.ws!.send(JSON.stringify(subMsg));

      // Start keepalive pings
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send("PING");
        }
      }, 50_000);
    });

    this.ws.on("message", (data: Buffer) => {
      const msg = data.toString();
      if (msg === "PONG") return;

      try {
        const parsed = JSON.parse(msg);
        this.config.onOrderBookUpdate(parsed);
      } catch (err) {
        logger.warn("Failed to parse WS message", { raw: msg });
      }
    });

    this.ws.on("error", (err) => {
      logger.error("WebSocket error", { error: err.message });
    });

    this.ws.on("close", (code, reason) => {
      logger.warn("WebSocket disconnected", { code, reason: reason.toString() });
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.reconnect();
    });
  }

  private reconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error("Max reconnection attempts reached. Giving up.");
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

    setTimeout(() => this.connect(), delay);
  }

  subscribe(tokenIds: string[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        assets_ids: tokenIds,
        operation: "subscribe",
      }));
    }
  }

  unsubscribe(tokenIds: string[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        assets_ids: tokenIds,
        operation: "unsubscribe",
      }));
    }
  }

  disconnect(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}

// Usage
const feed = new MarketWebSocketFeed({
  tokenIds: [
    "71321045679252212594626385532706912750332728571942532289631379312455583992563",
    "52114319501245915516055106046884209969926127482827954674443846427813813222426",
  ],
  onOrderBookUpdate: (data) => {
    console.log("Order book update:", JSON.stringify(data).slice(0, 200));
  },
});

feed.connect();
```

### 7.4 User Channel WebSocket (Authenticated)

```typescript
// src/scripts/ws-user-feed.ts
import WebSocket from "ws";

function connectUserChannel(creds: APICredentials, conditionIds: string[]): WebSocket {
  const wsUrl = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    const subMsg = {
      auth: {
        apiKey: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      },
      type: "user",
      markets: conditionIds,
    };
    ws.send(JSON.stringify(subMsg));

    // Keepalive
    setInterval(() => ws.send("PING"), 50_000);
  });

  ws.on("message", (data: Buffer) => {
    const msg = data.toString();
    if (msg === "PONG") return;

    try {
      const parsed = JSON.parse(msg);
      // Handle user events: order fills, cancellations, etc.
      if (parsed.type === "trade") {
        logger.info("Trade executed", parsed);
        bus.emitTrade(parsed);
      } else if (parsed.type === "order") {
        logger.info("Order update", parsed);
      }
    } catch {
      // Ignore non-JSON messages
    }
  });

  return ws;
}
```

### 7.5 Market Scanner Script

```typescript
// src/scripts/market-scanner.ts
import axios from "axios";

const GAMMA_API = "https://gamma-api.polymarket.com";

interface ScanResult {
  conditionId: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  spread: number;
  volume: number;
  priceDislocation: number;  // |yesPrice + noPrice - 1.0|
  endDate: string;
  negRisk: boolean;
  tickSize: string;
}

async function scanMarkets(): Promise<ScanResult[]> {
  // Fetch active markets from Gamma API
  const { data: events } = await axios.get(`${GAMMA_API}/events`, {
    params: {
      active: true,
      closed: false,
      limit: 100,
      order: "volume",
      ascending: false,
    },
  });

  const results: ScanResult[] = [];

  for (const event of events) {
    for (const market of event.markets || []) {
      if (!market.active || market.closed) continue;

      const yesToken = market.tokens?.find((t: any) => t.outcome === "Yes");
      const noToken = market.tokens?.find((t: any) => t.outcome === "No");

      if (!yesToken || !noToken) continue;

      const yesPrice = yesToken.price || 0;
      const noPrice = noToken.price || 0;
      const dislocation = Math.abs(yesPrice + noPrice - 1.0);

      results.push({
        conditionId: market.condition_id,
        question: market.question,
        yesPrice,
        noPrice,
        spread: Math.abs(yesPrice - (1 - noPrice)),
        volume: market.volume_num || 0,
        priceDislocation: dislocation,
        endDate: market.end_date_iso,
        negRisk: market.neg_risk || false,
        tickSize: "0.01", // Default; fetch actual from CLOB if needed
      });
    }
  }

  // Sort by dislocation (potential arb) then volume
  return results.sort((a, b) => {
    if (b.priceDislocation !== a.priceDislocation) {
      return b.priceDislocation - a.priceDislocation;
    }
    return b.volume - a.volume;
  });
}

// Run scanner on a cron schedule
import cron from "node-cron";

cron.schedule("*/5 * * * *", async () => {
  logger.info("Running market scan...");
  const opportunities = await scanMarkets();

  const highValue = opportunities.filter(
    (o) => o.priceDislocation > 0.02 || o.spread > 0.05,
  );

  for (const opp of highValue.slice(0, 10)) {
    logger.info("Opportunity found", {
      question: opp.question.slice(0, 60),
      yesPrice: opp.yesPrice,
      noPrice: opp.noPrice,
      dislocation: opp.priceDislocation.toFixed(4),
      volume: opp.volume,
    });
  }
});
```

### 7.6 Simple Market Maker Skeleton

```typescript
// src/scripts/market-maker.ts

interface MMConfig {
  tokenId: string;
  complementTokenId: string;
  spreadBps: number;        // Target spread in basis points (e.g., 200 = 2%)
  quoteSize: number;        // Size per side
  maxInventory: number;     // Max position before skewing
  refreshIntervalMs: number;
  tickSize: "0.01" | "0.001";
  negRisk: boolean;
}

class SimpleMarketMaker {
  private config: MMConfig;
  private client: ClobClient;
  private inventory = 0;
  private activeOrders: string[] = [];
  private running = false;

  constructor(config: MMConfig, client: ClobClient) {
    this.config = config;
    this.client = client;
  }

  async start(): Promise<void> {
    this.running = true;
    logger.info("Market maker started", { tokenId: this.config.tokenId });

    while (this.running) {
      try {
        await this.cycle();
      } catch (err) {
        logger.error("Market maker cycle error", { error: err });
      }
      await new Promise((r) => setTimeout(r, this.config.refreshIntervalMs));
    }
  }

  private async cycle(): Promise<void> {
    // 1. Cancel stale orders
    for (const orderId of this.activeOrders) {
      try {
        await this.client.cancelOrder(orderId);
      } catch { /* order may already be filled */ }
    }
    this.activeOrders = [];

    // 2. Get current midpoint
    const midpoint = parseFloat(await this.client.getMidpoint(this.config.tokenId));
    if (isNaN(midpoint) || midpoint <= 0 || midpoint >= 1) {
      logger.warn("Invalid midpoint, skipping cycle", { midpoint });
      return;
    }

    // 3. Calculate inventory skew
    const inventoryRatio = this.inventory / this.config.maxInventory;
    const skewBps = inventoryRatio * (this.config.spreadBps / 2);

    // 4. Calculate bid/ask prices
    const halfSpreadBps = this.config.spreadBps / 2;
    const bidPrice = Math.max(0.01, midpoint * (1 - (halfSpreadBps + skewBps) / 10_000));
    const askPrice = Math.min(0.99, midpoint * (1 + (halfSpreadBps - skewBps) / 10_000));

    // 5. Round to tick size
    const tick = parseFloat(this.config.tickSize);
    const roundedBid = Math.floor(bidPrice / tick) * tick;
    const roundedAsk = Math.ceil(askPrice / tick) * tick;

    // 6. Place orders
    if (this.inventory < this.config.maxInventory) {
      const bidResp = await this.client.createAndPostOrder(
        { tokenID: this.config.tokenId, price: roundedBid, side: Side.BUY, size: this.config.quoteSize },
        { tickSize: this.config.tickSize, negRisk: this.config.negRisk },
        OrderType.GTC,
        false,
        true, // postOnly -- important for market makers
      );
      if (bidResp.success) this.activeOrders.push(bidResp.orderId);
    }

    if (this.inventory > -this.config.maxInventory) {
      const askResp = await this.client.createAndPostOrder(
        { tokenID: this.config.tokenId, price: roundedAsk, side: Side.SELL, size: this.config.quoteSize },
        { tickSize: this.config.tickSize, negRisk: this.config.negRisk },
        OrderType.GTC,
        false,
        true, // postOnly
      );
      if (askResp.success) this.activeOrders.push(askResp.orderId);
    }

    logger.debug("Quotes placed", {
      midpoint,
      bid: roundedBid,
      ask: roundedAsk,
      inventory: this.inventory,
      skewBps: skewBps.toFixed(1),
    });
  }

  stop(): void {
    this.running = false;
  }
}
```

---

## 8. Recommended npm Packages

### Core Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@polymarket/clob-client` | ^5.2.1 | Official Polymarket CLOB TypeScript client |
| `ethers` | ^5.7.1 | Ethereum wallet, signing, contract interactions |
| `@ethersproject/wallet` | ^5.7.0 | Wallet management (peer dep of clob-client) |
| `@ethersproject/providers` | ^5.7.2 | JSON-RPC provider for Polygon |

### Networking & WebSocket

| Package | Version | Purpose |
|---------|---------|---------|
| `ws` | ^8.11.0 | WebSocket client for Node.js |
| `axios` | ^1.6.0 | HTTP client (also used internally by clob-client) |

### Bot Infrastructure

| Package | Version | Purpose |
|---------|---------|---------|
| `dotenv` | ^16.3.0 | Load environment variables from .env file |
| `zod` | ^3.22.0 | Runtime schema validation for config and API responses |
| `winston` | ^3.11.0 | Structured logging with multiple transports |
| `node-cron` | ^3.0.3 | Cron-based scheduling for periodic tasks |

### Development & Types

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.3.0 | TypeScript compiler |
| `tsx` | ^4.7.0 | TypeScript execution without compilation |
| `@types/ws` | ^8.5.10 | WebSocket type definitions |
| `@types/node` | ^20.11.0 | Node.js type definitions |
| `@types/node-cron` | ^3.0.11 | node-cron type definitions |

### Testing & Quality

| Package | Version | Purpose |
|---------|---------|---------|
| `vitest` | ^1.2.0 | Fast unit testing framework |
| `eslint` | ^8.56.0 | Code linting |
| `prettier` | ^3.2.0 | Code formatting |

### Optional / Advanced

| Package | Version | Purpose |
|---------|---------|---------|
| `prom-client` | ^15.1.0 | Prometheus metrics for monitoring |
| `ioredis` | ^5.3.0 | Redis client for state persistence |
| `better-sqlite3` | ^9.4.0 | Local SQLite for trade history |
| `p-queue` | ^8.0.0 | Promise-based concurrent queue |
| `eventemitter3` | ^5.0.1 | High-performance event emitter |

### Suggested package.json scripts section

```json
{
  "scripts": {
    "bot": "tsx src/index.ts",
    "scanner": "tsx src/scripts/market-scanner.ts",
    "paper": "DRY_RUN=true tsx src/index.ts",
    "collect-data": "tsx src/scripts/data-collector.ts",
    "backtest": "tsx src/scripts/backtest.ts",
    "approve": "tsx src/scripts/approve-allowances.ts",
    "test": "vitest",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  }
}
```

---

## Appendix: Suggested Project Structure

```
auto-poly-bet-bot/
  src/
    index.ts                    # Main entry point
    config.ts                   # Zod-validated configuration
    logger.ts                   # Winston logger setup
    events.ts                   # BotEventBus
    shutdown.ts                 # GracefulShutdown handler

    clients/
      clob.ts                   # ClobClient wrapper with retry logic
      gamma.ts                  # Gamma API client
      websocket.ts              # WebSocket feed manager

    strategies/
      base.ts                   # Abstract strategy interface
      market-maker.ts           # Market making strategy
      arbitrage.ts              # Arbitrage detection
      mean-reversion.ts         # Mean reversion strategy

    scripts/
      market-scanner.ts         # Standalone market scanner
      place-order.ts            # CLI order placement
      approve-allowances.ts     # On-chain approval script
      data-collector.ts         # Historical data collection
      backtest.ts               # Backtesting runner

    risk/
      position-monitor.ts       # Position tracking
      stop-loss.ts              # Stop-loss / take-profit triggers
      rebalancer.ts             # Auto-rebalancing engine

    types/
      market.ts                 # Market-related types
      order.ts                  # Order-related types
      strategy.ts               # Strategy types
      websocket.ts              # WebSocket message types

    utils/
      rate-limiter.ts           # Sliding window rate limiter
      retry.ts                  # Retry with exponential backoff
      paper-trading.ts          # Paper trading simulator
      metrics.ts                # Performance metrics calculator

    backtest/
      engine.ts                 # Backtest engine
      data-loader.ts            # Historical data loader
      reporter.ts               # Backtest report generator

  data/                         # Historical tick data (gitignored)
  logs/                         # Log files (gitignored)
  .env                          # Environment variables (gitignored)
  .env.example                  # Example environment file
  package.json
  tsconfig.json
```

---

## Sources

- [Polymarket CLOB Introduction](https://docs.polymarket.com/developers/CLOB/introduction)
- [Polymarket Authentication](https://docs.polymarket.com/developers/CLOB/authentication)
- [Polymarket Quickstart](https://docs.polymarket.com/developers/CLOB/quickstart)
- [Polymarket Client Methods Overview](https://docs.polymarket.com/developers/CLOB/clients/methods-overview)
- [Polymarket Orders Documentation](https://docs.polymarket.com/developers/CLOB/orders/orders)
- [Polymarket Place Order](https://docs.polymarket.com/developers/CLOB/orders/create-order)
- [Polymarket WebSocket Overview](https://docs.polymarket.com/developers/CLOB/websocket/wss-overview)
- [Polymarket API Rate Limits](https://docs.polymarket.com/quickstart/introduction/rate-limits)
- [Polymarket CTF Overview](https://docs.polymarket.com/developers/CTF/overview)
- [Polymarket Gamma API Overview](https://docs.polymarket.com/developers/gamma-markets-api/overview)
- [@polymarket/clob-client on npm](https://www.npmjs.com/package/@polymarket/clob-client)
- [Polymarket clob-client GitHub Repository](https://github.com/Polymarket/clob-client)
- [Polymarket Real-Time Data Client](https://github.com/Polymarket/real-time-data-client)
- [Polymarket clob-client Examples](https://github.com/Polymarket/clob-client/tree/main/examples)
- [CTF Exchange on PolygonScan](https://polygonscan.com/address/0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e)
- [Conditional Tokens on PolygonScan](https://polygonscan.com/address/0x4d97dcd97ec945f40cf65f87097ace5ea0476045)
- [Neg Risk CTF Exchange on PolygonScan](https://polygonscan.com/address/0xc5d563a36ae78145c45a50134d48a1215220f80a)
