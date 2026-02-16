# Auto Poly Bet Bot -- Frontend Architecture Plan

> Comprehensive frontend blueprint for a Polymarket betting bot dashboard.
> Stack: Next.js 15 (App Router) | Tailwind CSS 3 | HeroUI v2 | Zustand 4 | TypeScript 5

---

## Table of Contents

1. [UX Patterns for Trading / Betting Platforms](#1-ux-patterns-for-trading--betting-platforms)
2. [Core UI Components](#2-core-ui-components)
3. [TypeScript Component Architecture](#3-typescript-component-architecture)
4. [Performance Optimization](#4-performance-optimization)
5. [Key Libraries](#5-key-libraries)
6. [Recommended File / Folder Structure](#6-recommended-file--folder-structure)

---

## 1. UX Patterns for Trading / Betting Platforms

### 1.1 Lessons from Leading Platforms

| Platform | Key UX Pattern | Applicable Takeaway |
|---|---|---|
| **Polymarket** | Binary outcome cards with YES/NO price bars; inline order entry | Our market cards should show both YES and NO prices side-by-side with one-click trade entry |
| **Robinhood** | Radical simplification -- single big number, one-tap buy, confetti feedback | Keep the primary action (place bet) to at most 2 clicks; use micro-animations for order confirmation |
| **TradingView** | Dense multi-panel layout with resizable widgets; dark-first theme | Offer a "pro" layout mode with resizable panes; default to a dark theme to reduce eye strain during extended sessions |
| **Betfair** | Depth ladder showing back/lay prices across 3 price levels; live in-play indicators | Show order-book depth for each market; use pulsing/color-flash to indicate live price movement |

### 1.2 Real-Time Data Display Patterns

**Price Tickers with Flash-on-Change**
```
  ┌────────────────────────────┐
  │  "Will BTC hit $100k?"     │
  │  YES  0.63 ▲ (+0.04)      │  ← green flash on uptick
  │  NO   0.37 ▼ (-0.04)      │  ← red flash on downtick
  └────────────────────────────┘
```

Best practices:
- **Flash-on-change**: When a price updates, briefly flash the cell green (up) or red (down), then fade back. Use `framer-motion` `animate` with a 300ms color transition.
- **Stale indicator**: If WebSocket drops or data is > 5s old, show a yellow dot / "stale" badge.
- **Sparkline**: Embed a 48-point inline sparkline next to each price for at-a-glance trend.
- **Formatted timestamps**: Use relative time ("2s ago", "1m ago") via `date-fns/formatDistanceToNowStrict`.

**P&L Display**
- Always show both *unrealized* and *realized* P&L.
- Color-code: green for profit, red for loss, muted gray for zero.
- Show percentage return alongside absolute dollar amount.
- Provide a toggle between "since inception" and "today" views.

### 1.3 Desktop-First with Responsive Breakpoints

A betting bot dashboard is an *operator console* -- users will primarily monitor on a desktop or laptop while their bot runs. Therefore:

- **Desktop-first** approach: Design the full dashboard at `lg` (1024px+) and `xl` (1280px+) first.
- **Responsive down** to `md` (768px) for tablet monitoring.
- **Mobile (`sm`, < 640px)**: Show a simplified status view -- portfolio summary, bot status, notifications. Full trading should require at least tablet width.

Breakpoint strategy:
```
xl (1280px+)  : 3-column layout -- sidebar | main content | right panel (order entry / positions)
lg (1024px)   : 2-column layout -- sidebar collapses to icons | main content + stacked right panel
md (768px)    : Single column with tab-based navigation
sm (< 640px)  : Bot status card + portfolio summary only; link out to full dashboard
```

### 1.4 Accessibility Considerations

| Concern | Implementation |
|---|---|
| **Color alone** | Never rely solely on red/green. Use directional arrows (▲ / ▼), plus/minus signs, and pattern fills for charts. |
| **Keyboard navigation** | Every interactive element must be focusable. Order entry form should work entirely via Tab + Enter. TradingView also uses arrow keys for chart navigation. |
| **Screen readers** | Use `aria-live="polite"` on price tickers so updates are announced. Use `role="status"` on bot status indicators. Use `aria-label` on icon-only buttons (already done in `Header.tsx`). |
| **Contrast** | Both light and dark themes must meet WCAG 2.2 AA (4.5:1 for normal text, 3:1 for large text). Test with Axe or Lighthouse. |
| **Reduced motion** | Respect `prefers-reduced-motion`: disable flash-on-change animations and chart transitions for users who request it. |
| **Focus management** | After placing an order, return focus to the order form or show a focus-trapped confirmation dialog. |

---

## 2. Core UI Components

### 2.1 Market Browser / Explorer

**Purpose**: Discover, search, and filter Polymarket events and markets.

```
┌─────────────────────────────────────────────────────────────┐
│ [🔍 Search markets...]   [Category ▾] [Sort ▾] [Status ▾]  │
├─────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Will BTC hit $100k by March?       Vol: $2.4M          │ │
│ │ YES 0.63 (+0.04)   NO 0.37 (-0.04)   Expires: Mar 31  │ │
│ │ [Buy YES] [Buy NO]                                     │ │
│ ├─────────────────────────────────────────────────────────┤ │
│ │ Will ETH hit $5k by June?          Vol: $890K          │ │
│ │ YES 0.28 (+0.01)   NO 0.72 (-0.01)   Expires: Jun 30  │ │
│ │ [Buy YES] [Buy NO]                                     │ │
│ └─────────────────────────────────────────────────────────┘ │
│            [ Load More ]  or virtualized infinite scroll    │
└─────────────────────────────────────────────────────────────┘
```

Key behaviors:
- Debounced search (300ms) with `useTransition` for non-blocking filtering.
- Filters: category (crypto, politics, sports, etc.), status (active, resolved, upcoming), volume range, liquidity threshold.
- Sort: volume, liquidity, newest, ending soon, price change.
- Each market card shows: question, YES/NO prices with change indicators, volume, expiry date, inline CTA buttons.
- Clicking a card navigates to the Market Detail page.

HeroUI components to use: `Input` (search), `Select` / `Dropdown` (filters), `Card` (market items), `Chip` (tags/categories), `Pagination` or infinite scroll.

### 2.2 Order Entry Form

**Purpose**: Place buy/sell orders on YES or NO outcome shares.

```
┌─────────────────────────────────┐
│       ORDER ENTRY                │
│ ┌─────────┐  ┌─────────┐       │
│ │  YES ✓  │  │   NO    │       │  ← toggle outcome side
│ └─────────┘  └─────────┘       │
│                                  │
│ Type:  [Market ▾ | Limit]       │
│                                  │
│ Shares:  [ 100        ]        │
│ Price:   [ 0.63       ]  (Limit)│
│                                  │
│ ─── Order Preview ───           │
│ Cost:       $63.00              │
│ Potential:  $100.00             │
│ Max Profit: $37.00 (58.7%)     │
│ Fee:        $0.00               │
│                                  │
│ [ Place Order ]                 │
└─────────────────────────────────┘
```

Key behaviors:
- Outcome toggle: YES (green accent) or NO (red accent). Selected state clearly distinguished.
- Order type: Market (execute at best available) or Limit (specify price). Limit shows price input; Market auto-fills current best price.
- Real-time cost calculation: `shares * price` for cost; `shares * 1.0 - cost` for potential profit.
- Validation: price must be 0.01-0.99 for binary markets; shares must be positive integer; insufficient balance warning.
- Keyboard shortcut: `Ctrl+Enter` to submit.
- Confirmation step: brief summary modal before execution (can be toggled off in settings for power users).

HeroUI components: `ButtonGroup` (YES/NO toggle), `Input` (shares, price), `Select` (order type), `Button` (submit), `Modal` (confirmation).

Form management: `react-hook-form` + `zod` for validation schema.

### 2.3 Position Tracker

**Purpose**: Display all open positions with real-time P&L.

```
┌────────────────────────────────────────────────────────────────────────┐
│ POSITIONS (3 open)                                      [Expand All]  │
├──────────┬──────┬───────┬──────────┬─────────┬──────────┬────────────┤
│ Market   │ Side │ Shares│ Avg Cost │ Current │ P&L      │ Actions    │
├──────────┼──────┼───────┼──────────┼─────────┼──────────┼────────────┤
│ BTC 100k │ YES  │   200 │   $0.55  │  $0.63  │ +$16.00  │ [Sell]     │
│ ETH 5k   │ NO   │   150 │   $0.68  │  $0.72  │ +$6.00   │ [Sell]     │
│ SOL 300  │ YES  │   500 │   $0.40  │  $0.38  │ -$10.00  │ [Sell]     │
└──────────┴──────┴───────┴──────────┴─────────┴──────────┴────────────┘
```

Key behaviors:
- Real-time price updates via WebSocket. P&L recalculated on every tick.
- Color-coded P&L cells (green/red).
- Expandable rows showing detailed trade history for that position.
- "Sell" button opens pre-filled order entry form.
- Sortable by any column (market name, P&L, size, etc.).

Use TanStack Table for sortable, filterable, virtualizable rows.

### 2.4 Portfolio Overview

**Purpose**: Aggregate statistics across all positions and historical performance.

```
┌──────────────────────────────────────────────────────────────┐
│                     PORTFOLIO OVERVIEW                        │
│                                                              │
│   Balance         Total Invested    Unrealized P&L            │
│   $1,247.50       $850.00           +$47.50 (+5.6%)          │
│                                                              │
│   Realized P&L    Win Rate          Open Positions            │
│   +$312.80        67%               3                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │            Portfolio Value Over Time                  │    │
│  │  $1400 ─                              ╱──            │    │
│  │  $1200 ─                    ╱────────╱               │    │
│  │  $1000 ─     ╱─────────────╱                         │    │
│  │   $800 ─────╱                                        │    │
│  │         Jan    Feb    Mar    Apr    May               │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Category Breakdown:  [Crypto 45%] [Politics 30%] [Sports 25%]│
└──────────────────────────────────────────────────────────────┘
```

Key behaviors:
- Top-level KPI cards using HeroUI `Card` components.
- Portfolio value line chart (area chart with gradient fill).
- Category/sector allocation pie or donut chart.
- Time range selector: 1D, 1W, 1M, 3M, ALL.
- All values update in real-time as positions change.

### 2.5 Trade History / Activity Feed

**Purpose**: Chronological log of all executed trades and bot actions.

```
┌──────────────────────────────────────────────────────────────────┐
│ TRADE HISTORY                             [Export CSV] [Filter]  │
├─────────┬───────────┬──────┬───────┬───────┬─────────┬──────────┤
│ Time    │ Market    │ Side │ Type  │ Shares│ Price   │ Total    │
├─────────┼───────────┼──────┼───────┼───────┼─────────┼──────────┤
│ 2m ago  │ BTC 100k  │ BUY  │ YES   │  100  │ $0.63   │ $63.00   │
│ 15m ago │ ETH 5k    │ SELL │ NO    │   50  │ $0.72   │ $36.00   │
│ 1h ago  │ SOL 300   │ BUY  │ YES   │  500  │ $0.40   │ $200.00  │
└─────────┴───────────┴──────┴───────┴───────┴─────────┴──────────┘
│                    [Load More Trades]                             │
└──────────────────────────────────────────────────────────────────┘
```

Key behaviors:
- Reverse-chronological by default. Filterable by market, side, date range.
- Relative timestamps ("2m ago") with tooltip showing absolute time.
- CSV export for tax/reporting purposes.
- Infinite scroll with cursor-based pagination (Polymarket trades API supports `before`/`after` timestamps).
- New trades animate in from top with `framer-motion` `AnimatePresence`.

### 2.6 Real-Time Price Charts

**Purpose**: Visualize price history for binary market outcomes.

Two chart types:
1. **Line/Area chart**: Default for binary markets. X-axis = time, Y-axis = price (0.00-1.00). Shaded area under the line for visual weight.
2. **Candlestick chart**: Optional for power users who want OHLC data on longer timeframes.

```
┌──────────────────────────────────────────────────────────┐
│  "Will BTC hit $100k?"                                   │
│  [1m] [1h] [6h] [1d] [1w] [Max]   ← interval selector  │
│                                                          │
│  1.00 ─                                                  │
│  0.80 ─                              ╱──                 │
│  0.60 ─                    ╱────────╱    ← YES price     │
│  0.40 ─     ╱─────────────╱                              │
│  0.20 ─────╱                                             │
│  0.00 ─                                                  │
│        Jan 1   Jan 15   Feb 1   Feb 15   Mar 1           │
│                                                          │
│  Crosshair: Feb 10, 2026  Price: 0.63  Vol: $45K        │
└──────────────────────────────────────────────────────────┘
```

Implementation: TradingView `lightweight-charts` library.
- Line series for YES price; optionally overlay NO price (which is `1 - YES`).
- Crosshair with tooltip showing date, price, and volume.
- Time interval selector maps to Polymarket timeseries API intervals: `1m`, `1h`, `6h`, `1d`, `1w`, `max`.
- Chart must dynamically import (`next/dynamic`) to avoid SSR issues since `lightweight-charts` requires the DOM.

### 2.7 Alert / Notification System

**Purpose**: Surface strategy signals, order fills, price alerts, and bot errors.

```
┌──────────────────────────────────────────┐
│  🔔 Notifications (3 new)               │
├──────────────────────────────────────────┤
│  ● Order filled: BUY 100 YES @ $0.63    │  ← success (green dot)
│  ● Price alert: BTC 100k YES > $0.60    │  ← info (blue dot)
│  ● Bot error: Strategy "momentum"        │  ← error (red dot)
│    failed to execute                     │
│  ○ Order placed: SELL 50 NO @ $0.72     │  ← read (gray dot)
├──────────────────────────────────────────┤
│  [Mark all as read]   [Settings]         │
└──────────────────────────────────────────┘
```

Key behaviors:
- Toast notifications for immediate feedback (order fills, errors) using a custom toast system or HeroUI's built-in patterns.
- Notification panel in header dropdown for historical alerts.
- Severity levels: success, info, warning, error.
- Configurable alert rules: price thresholds, volume spikes, bot state changes.
- Persist to Zustand store; mark as read/unread.
- Desktop push notifications (via Notification API) for critical alerts when tab is not focused.

### 2.8 Bot Status Dashboard

**Purpose**: Monitor automated trading strategies and their performance.

```
┌───────────────────────────────────────────────────────────────────┐
│ BOT STATUS                                          [+ New Bot]   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Strategy: "Momentum Alpha"                                       │
│  Status: ● Running          Uptime: 4h 23m                       │
│  Markets Tracked: 12        Orders Today: 47                      │
│  P&L Today: +$23.50 (+3.1%)                                      │
│  Win Rate: 72%              Avg Trade: $12.40                     │
│  [Pause] [Stop] [Edit Config] [View Logs]                        │
│                                                                   │
│  Strategy: "Mean Reversion"                                       │
│  Status: ○ Paused           Last Run: 2h ago                     │
│  Markets Tracked: 5         Orders Today: 0                       │
│  P&L Today: $0.00                                                 │
│  [Resume] [Stop] [Edit Config] [View Logs]                       │
│                                                                   │
├───────────────────────────────────────────────────────────────────┤
│  SYSTEM HEALTH                                                    │
│  WebSocket:  ● Connected      API:  ● Healthy                    │
│  Rate Limit: 85/100 (85%)     Last Heartbeat: 2s ago             │
└───────────────────────────────────────────────────────────────────┘
```

Key behaviors:
- Each strategy card shows: name, status (running/paused/stopped/error), key metrics, and action buttons.
- System health indicators: WebSocket connection status, API health, rate limit usage.
- Log viewer: scrollable, filterable log output for each strategy (uses virtualized list for performance).
- Strategy configuration form: market filters, position sizing, stop-loss, take-profit, custom parameters.

---

## 3. TypeScript Component Architecture

### 3.1 Component Hierarchy

```
app/
├── layout.tsx                          # Root layout: HeroUIProvider, ThemeProvider, Header, Sidebar
├── page.tsx                            # Dashboard (portfolio overview + bot status)
├── markets/
│   ├── page.tsx                        # Market browser / explorer
│   └── [marketId]/
│       └── page.tsx                    # Market detail: chart + order entry + book
├── positions/
│   └── page.tsx                        # Position tracker + P&L
├── history/
│   └── page.tsx                        # Trade history + activity feed
├── bots/
│   ├── page.tsx                        # Bot status dashboard
│   └── [botId]/
│       └── page.tsx                    # Individual bot detail + logs
└── settings/
    └── page.tsx                        # Configuration (API keys, preferences, alerts)
```

Component dependency tree:
```
RootLayout
  ├── Header
  │     ├── ThemeToggle
  │     ├── NotificationBell → NotificationPanel
  │     └── ConnectionStatus
  ├── Sidebar
  │     └── NavItem[]
  └── PageContent
        ├── Dashboard (/)
        │     ├── PortfolioSummaryCards
        │     ├── PortfolioChart
        │     ├── BotStatusList
        │     │     └── BotStatusCard[]
        │     └── RecentTradesFeed
        ├── MarketBrowser (/markets)
        │     ├── MarketSearchBar
        │     ├── MarketFilters
        │     └── MarketList
        │           └── MarketCard[]
        ├── MarketDetail (/markets/[id])
        │     ├── MarketHeader
        │     ├── PriceChart
        │     ├── OrderBook
        │     ├── OrderEntryForm
        │     └── MarketTrades
        ├── Positions (/positions)
        │     ├── PositionSummary
        │     └── PositionTable
        │           └── PositionRow[]
        ├── TradeHistory (/history)
        │     ├── TradeFilters
        │     └── TradeTable
        └── BotDashboard (/bots)
              ├── SystemHealthBar
              └── BotCard[]
                    ├── BotMetrics
                    ├── BotActions
                    └── BotLogViewer
```

### 3.2 Type Definitions for Polymarket Data

These types are derived from the Polymarket CLOB API, Gamma API, and RTDS WebSocket message formats.

```typescript
// ─── types/market.ts ───

/** Polymarket market from the Gamma API */
export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  description: string;
  category: string;
  endDate: string;                    // ISO 8601
  image: string;
  icon: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  liquidity: number;
  volume: number;
  volume24hr: number;
  outcomePrices: string;              // JSON stringified: e.g. "[0.63, 0.37]"
  outcomes: string;                   // JSON stringified: e.g. '["Yes","No"]'
  clobTokenIds: string;               // JSON stringified: e.g. '["token_yes_id","token_no_id"]'
  tags: GammaTag[];
  events: GammaEvent[];
}

export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  category: string;
  startDate: string;
  endDate: string;
  image: string;
  markets: GammaMarket[];
}

export interface GammaTag {
  id: string;
  label: string;
  slug: string;
}

/** Parsed market for internal use */
export interface Market {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  description: string;
  category: string;
  endDate: Date;
  image: string;
  active: boolean;
  closed: boolean;
  liquidity: number;
  volume: number;
  volume24hr: number;
  outcomes: MarketOutcome[];
  tags: string[];
}

export interface MarketOutcome {
  name: string;                       // "Yes" or "No"
  tokenId: string;                    // CLOB token ID
  price: number;                      // 0.00 - 1.00
  priceChange24hr: number;
}

// ─── types/order.ts ───

export type OrderSide = 'BUY' | 'SELL';
export type OutcomeSide = 'YES' | 'NO';
export type OrderType = 'MARKET' | 'LIMIT';
export type OrderTimeInForce = 'GTC' | 'GTD' | 'FOK' | 'FAK';
export type OrderStatus = 'LIVE' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'EXPIRED';

export interface OrderRequest {
  marketId: string;
  tokenId: string;
  side: OrderSide;
  outcomeSide: OutcomeSide;
  type: OrderType;
  price: number;                      // 0.01 - 0.99 for limit orders
  size: number;                       // number of shares
  timeInForce?: OrderTimeInForce;
  expiration?: number;                // unix timestamp for GTD
}

export interface Order {
  id: string;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  outcomeSide: OutcomeSide;
  type: OrderType;
  price: number;
  originalSize: number;
  remainingSize: number;
  filledSize: number;
  status: OrderStatus;
  timeInForce: OrderTimeInForce;
  createdAt: Date;
  updatedAt: Date;
  transactionHash?: string;
}

export interface OrderResponse {
  success: boolean;
  errorMsg?: string;
  orderId?: string;
  transactionHashes?: string[];
  status?: OrderStatus;
  takingAmount?: string;
  makingAmount?: string;
}

// ─── types/trade.ts ───

export interface Trade {
  id: string;
  takerOrderId: string;
  market: string;                     // condition ID
  assetId: string;                    // token ID
  side: OrderSide;
  size: number;
  price: number;
  feeRateBps: number;
  status: string;
  matchTime: Date;
  lastUpdate: Date;
  outcome: string;                    // human-readable
  makerAddress: string;
  owner: string;
  transactionHash: string;
  bucketIndex: number;
  type: 'TAKER' | 'MAKER';
  makerOrders?: MakerOrder[];
}

export interface MakerOrder {
  orderId: string;
  makerAddress: string;
  matchedAmount: string;
  price: string;
}

export interface TradeFilter {
  market?: string;
  side?: OrderSide;
  before?: number;                    // unix timestamp
  after?: number;                     // unix timestamp
  limit?: number;
  cursor?: string;
}

// ─── types/position.ts ───

export interface Position {
  marketId: string;
  market: Market;                     // denormalized for display
  outcomeSide: OutcomeSide;
  tokenId: string;
  size: number;                       // number of shares held
  avgCostBasis: number;               // average price paid per share
  currentPrice: number;               // real-time price
  unrealizedPnl: number;             // (currentPrice - avgCostBasis) * size
  unrealizedPnlPercent: number;      // unrealizedPnl / (avgCostBasis * size) * 100
  realizedPnl: number;
}

export interface PortfolioSummary {
  totalBalance: number;
  totalInvested: number;
  totalUnrealizedPnl: number;
  totalUnrealizedPnlPercent: number;
  totalRealizedPnl: number;
  winRate: number;                    // 0-100
  totalTrades: number;
  openPositionCount: number;
}

// ─── types/timeseries.ts ───

export type TimeInterval = '1m' | '1h' | '6h' | '1d' | '1w' | 'max';

export interface PricePoint {
  t: number;                          // UTC timestamp (seconds)
  p: number;                          // price (0.00 - 1.00)
}

export interface TimeseriesRequest {
  tokenId: string;
  interval?: TimeInterval;
  startTs?: number;                   // unix timestamp
  endTs?: number;                     // unix timestamp
  fidelity?: number;                  // resolution in minutes
}

export interface TimeseriesResponse {
  history: PricePoint[];
}

// ─── types/bot.ts ───

export type BotStatus = 'running' | 'paused' | 'stopped' | 'error';

export interface BotStrategy {
  id: string;
  name: string;
  description: string;
  status: BotStatus;
  startedAt: Date;
  uptime: number;                     // seconds
  config: BotConfig;
  metrics: BotMetrics;
}

export interface BotConfig {
  marketFilters: {
    categories?: string[];
    minLiquidity?: number;
    minVolume?: number;
    maxMarkets?: number;
  };
  positionSizing: {
    maxPositionSize: number;          // max shares per position
    maxTotalExposure: number;         // max total invested
    kellyFraction?: number;           // Kelly criterion fraction (0-1)
  };
  riskManagement: {
    stopLossPercent?: number;
    takeProfitPercent?: number;
    maxDailyLoss?: number;
    maxDrawdownPercent?: number;
  };
  customParams: Record<string, unknown>;
}

export interface BotMetrics {
  totalTrades: number;
  tradesToday: number;
  winRate: number;
  pnlToday: number;
  pnlTotal: number;
  avgTradeSize: number;
  marketsTracked: number;
  sharpeRatio?: number;
}

export interface BotLogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  data?: Record<string, unknown>;
}

// ─── types/notification.ts ───

export type NotificationType = 'order_fill' | 'price_alert' | 'bot_signal' | 'bot_error' | 'system';
export type NotificationSeverity = 'success' | 'info' | 'warning' | 'error';

export interface Notification {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  timestamp: Date;
  read: boolean;
  data?: Record<string, unknown>;     // contextual payload (order details, etc.)
}

// ─── types/websocket.ts ───

export type WSConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface WSSubscription {
  topic: string;
  type: string;
  filters?: string;                   // JSON stringified filter object
}

export interface WSMessage<T = unknown> {
  topic: string;
  type: string;
  timestamp: number;                  // milliseconds
  payload: T;
}

/** CLOB WebSocket channels */
export interface WSMarketUpdate {
  market: string;
  asset_id: string;
  price: number;
  timestamp: number;
}

export interface WSOrderBookUpdate {
  market: string;
  asset_id: string;
  bids: [price: number, size: number][];
  asks: [price: number, size: number][];
  timestamp: number;
}

/** RTDS activity subscription payloads */
export interface WSTradeActivity {
  asset: string;
  conditionId: string;
  eventSlug: string;
  outcome: string;
  price: number;
  side: string;
  size: number;
  timestamp: number;
  transactionHash: string;
}

// ─── types/api.ts ───

export interface ApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  next_cursor?: string;
  limit: number;
  count: number;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
```

### 3.3 Zustand Store Design

Split the store into domain-specific slices using Zustand's slice pattern for maintainability and selective re-rendering.

```typescript
// ─── store/slices/marketSlice.ts ───

import { StateCreator } from 'zustand';

export interface MarketSlice {
  // State
  markets: Map<string, Market>;
  filteredMarketIds: string[];
  searchQuery: string;
  activeFilters: MarketFilters;
  selectedMarketId: string | null;
  marketsLoading: boolean;

  // Actions
  setMarkets: (markets: Market[]) => void;
  updateMarketPrice: (marketId: string, tokenId: string, price: number) => void;
  setSearchQuery: (query: string) => void;
  setActiveFilters: (filters: Partial<MarketFilters>) => void;
  setSelectedMarket: (marketId: string | null) => void;
}

interface MarketFilters {
  categories: string[];
  status: 'all' | 'active' | 'closed' | 'upcoming';
  sortBy: 'volume' | 'liquidity' | 'newest' | 'endingSoon' | 'priceChange';
  sortOrder: 'asc' | 'desc';
  minVolume?: number;
  minLiquidity?: number;
}

export const createMarketSlice: StateCreator<MarketSlice> = (set, get) => ({
  markets: new Map(),
  filteredMarketIds: [],
  searchQuery: '',
  activeFilters: {
    categories: [],
    status: 'active',
    sortBy: 'volume',
    sortOrder: 'desc',
  },
  selectedMarketId: null,
  marketsLoading: false,

  setMarkets: (markets) => {
    const map = new Map(markets.map((m) => [m.id, m]));
    set({ markets: map });
    // Trigger re-filter
    get().setSearchQuery(get().searchQuery);
  },

  updateMarketPrice: (marketId, tokenId, price) =>
    set((state) => {
      const market = state.markets.get(marketId);
      if (!market) return state;
      const updatedOutcomes = market.outcomes.map((o) =>
        o.tokenId === tokenId ? { ...o, price } : o
      );
      const updatedMarket = { ...market, outcomes: updatedOutcomes };
      const newMap = new Map(state.markets);
      newMap.set(marketId, updatedMarket);
      return { markets: newMap };
    }),

  setSearchQuery: (query) => set({ searchQuery: query }),
  setActiveFilters: (filters) =>
    set((state) => ({
      activeFilters: { ...state.activeFilters, ...filters },
    })),
  setSelectedMarket: (marketId) => set({ selectedMarketId: marketId }),
});


// ─── store/slices/orderSlice.ts ───

export interface OrderSlice {
  openOrders: Order[];
  orderHistory: Order[];
  pendingOrder: OrderRequest | null;
  orderSubmitting: boolean;

  setOpenOrders: (orders: Order[]) => void;
  addOrder: (order: Order) => void;
  updateOrder: (orderId: string, updates: Partial<Order>) => void;
  removeOrder: (orderId: string) => void;
  setPendingOrder: (order: OrderRequest | null) => void;
  setOrderSubmitting: (submitting: boolean) => void;
}


// ─── store/slices/positionSlice.ts ───

export interface PositionSlice {
  positions: Position[];
  portfolioSummary: PortfolioSummary;

  setPositions: (positions: Position[]) => void;
  updatePositionPrice: (tokenId: string, price: number) => void;
  recalculatePortfolio: () => void;
}


// ─── store/slices/tradeSlice.ts ───

export interface TradeSlice {
  trades: Trade[];
  tradesLoading: boolean;
  tradesCursor: string | null;

  setTrades: (trades: Trade[]) => void;
  appendTrades: (trades: Trade[], cursor: string | null) => void;
  prependTrade: (trade: Trade) => void;
}


// ─── store/slices/botSlice.ts ───

export interface BotSlice {
  strategies: BotStrategy[];
  selectedBotId: string | null;
  botLogs: Map<string, BotLogEntry[]>;

  setStrategies: (strategies: BotStrategy[]) => void;
  updateBotStatus: (botId: string, status: BotStatus) => void;
  updateBotMetrics: (botId: string, metrics: Partial<BotMetrics>) => void;
  appendBotLog: (botId: string, entry: BotLogEntry) => void;
  setSelectedBot: (botId: string | null) => void;
}


// ─── store/slices/notificationSlice.ts ───

export interface NotificationSlice {
  notifications: Notification[];
  unreadCount: number;

  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read'>) => void;
  markAsRead: (notificationId: string) => void;
  markAllAsRead: () => void;
  removeNotification: (notificationId: string) => void;
  clearAll: () => void;
}


// ─── store/slices/connectionSlice.ts ───

export interface ConnectionSlice {
  wsStatus: WSConnectionStatus;
  apiHealthy: boolean;
  lastHeartbeat: Date | null;
  rateLimitUsage: number;             // 0-100

  setWsStatus: (status: WSConnectionStatus) => void;
  setApiHealthy: (healthy: boolean) => void;
  setLastHeartbeat: (time: Date) => void;
  setRateLimitUsage: (usage: number) => void;
}


// ─── store/useStore.ts ─── (combined store)

import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';

export type AppStore = MarketSlice &
  OrderSlice &
  PositionSlice &
  TradeSlice &
  BotSlice &
  NotificationSlice &
  ConnectionSlice &
  UISlice;

// UISlice is the existing useAppStore (theme, sidebar) renamed

export const useStore = create<AppStore>()(
  devtools(
    subscribeWithSelector((...args) => ({
      ...createMarketSlice(...args),
      ...createOrderSlice(...args),
      ...createPositionSlice(...args),
      ...createTradeSlice(...args),
      ...createBotSlice(...args),
      ...createNotificationSlice(...args),
      ...createConnectionSlice(...args),
      ...createUISlice(...args),
    })),
    { name: 'auto-poly-bet-bot' }
  )
);
```

**Key Zustand patterns used:**
- `subscribeWithSelector` -- enables fine-grained subscriptions so components only re-render when their specific slice of state changes.
- `devtools` -- enables Redux DevTools inspection in development.
- `Map<string, Market>` for markets -- O(1) lookups by ID during real-time price updates.
- Slice pattern -- each domain has its own state creator, composed into a single store.

### 3.4 WebSocket Integration Patterns

```typescript
// ─── lib/websocket/polymarketWS.ts ───

import { useStore } from '@/store/useStore';
import type { WSConnectionStatus, WSSubscription } from '@/types/websocket';

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com';
const PING_INTERVAL = 5000;   // 5 seconds as recommended by Polymarket docs
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]; // exponential backoff

class PolymarketWebSocket {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private subscriptions: WSSubscription[] = [];
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect() {
    useStore.getState().setWsStatus('connecting');

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      useStore.getState().setWsStatus('connected');

      // Re-subscribe to previous subscriptions on reconnect
      this.subscriptions.forEach((sub) => this.sendSubscribe(sub));

      // Start keep-alive ping
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL);
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      useStore.getState().setLastHeartbeat(new Date());
      this.handleMessage(data);
    };

    this.ws.onclose = () => {
      this.cleanup();
      useStore.getState().setWsStatus('disconnected');
      this.attemptReconnect();
    };

    this.ws.onerror = () => {
      this.cleanup();
      useStore.getState().setWsStatus('disconnected');
    };
  }

  subscribe(subscription: WSSubscription) {
    this.subscriptions.push(subscription);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(subscription);
    }
  }

  unsubscribe(topic: string, type: string) {
    this.subscriptions = this.subscriptions.filter(
      (s) => !(s.topic === topic && s.type === type)
    );
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'unsubscribe', topic, type }));
    }
  }

  disconnect() {
    this.cleanup();
    this.subscriptions = [];
    this.ws?.close();
    this.ws = null;
  }

  private sendSubscribe(sub: WSSubscription) {
    this.ws?.send(
      JSON.stringify({
        action: 'subscribe',
        topic: sub.topic,
        type: sub.type,
        ...(sub.filters && { filters: sub.filters }),
      })
    );
  }

  private handleMessage(data: WSMessage) {
    const store = useStore.getState();

    switch (data.topic) {
      case 'market':
        store.updateMarketPrice(
          data.payload.market,
          data.payload.asset_id,
          data.payload.price
        );
        break;
      case 'activity':
        if (data.type === 'trades') {
          store.prependTrade(parseWSTradeToTrade(data.payload));
        }
        break;
      case 'crypto_prices':
      case 'equity_prices':
        // Handle reference price updates if needed
        break;
    }
  }

  private attemptReconnect() {
    const delay = RECONNECT_DELAYS[
      Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
    ];
    useStore.getState().setWsStatus('reconnecting');
    this.reconnectAttempt++;

    setTimeout(() => this.connect(), delay);
  }

  private cleanup() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

// Singleton instances
export const clobWS = new PolymarketWebSocket(CLOB_WS_URL);
export const rtdsWS = new PolymarketWebSocket(RTDS_WS_URL);
```

**React integration hook:**

```typescript
// ─── hooks/useWebSocket.ts ───

import { useEffect, useRef } from 'react';
import { clobWS, rtdsWS } from '@/lib/websocket/polymarketWS';
import { useStore } from '@/store/useStore';

/**
 * Manages WebSocket lifecycle. Mount once at the app root.
 */
export function useWebSocketConnection() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    clobWS.connect();
    rtdsWS.connect();

    // Subscribe to global activity feed
    rtdsWS.subscribe({ topic: 'activity', type: 'trades' });

    return () => {
      clobWS.disconnect();
      rtdsWS.disconnect();
    };
  }, []);
}

/**
 * Subscribe to price updates for a specific market.
 * Automatically unsubscribes on unmount.
 */
export function useMarketSubscription(tokenIds: string[]) {
  useEffect(() => {
    tokenIds.forEach((tokenId) => {
      clobWS.subscribe({
        topic: 'market',
        type: 'price',
        filters: JSON.stringify({ asset_id: tokenId }),
      });
    });

    return () => {
      tokenIds.forEach((tokenId) => {
        clobWS.unsubscribe('market', 'price');
      });
    };
  }, [tokenIds]);
}
```

### 3.5 Custom Hooks

```typescript
// ─── hooks/useMarketData.ts ───

import { useCallback, useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { fetchMarkets, fetchMarketById } from '@/lib/api/markets';
import type { Market, MarketFilters } from '@/types/market';

/** Fetch and cache the market catalog */
export function useMarkets() {
  const markets = useStore((s) => s.markets);
  const marketsLoading = useStore((s) => s.marketsLoading);
  const setMarkets = useStore((s) => s.setMarkets);
  const searchQuery = useStore((s) => s.searchQuery);
  const activeFilters = useStore((s) => s.activeFilters);

  const loadMarkets = useCallback(async () => {
    const data = await fetchMarkets({
      query: searchQuery,
      ...activeFilters,
    });
    setMarkets(data);
  }, [searchQuery, activeFilters, setMarkets]);

  useEffect(() => {
    loadMarkets();
  }, [loadMarkets]);

  return {
    markets: Array.from(markets.values()),
    loading: marketsLoading,
    refetch: loadMarkets,
  };
}

/** Fetch a single market by ID with timeseries data */
export function useMarketDetail(marketId: string) {
  const market = useStore((s) => s.markets.get(marketId));

  useEffect(() => {
    if (!market) {
      fetchMarketById(marketId).then((m) => {
        if (m) useStore.getState().setMarkets([m]);
      });
    }
  }, [marketId, market]);

  return { market };
}


// ─── hooks/useTimeseries.ts ───

import { useState, useEffect, useCallback } from 'react';
import { fetchTimeseries } from '@/lib/api/timeseries';
import type { PricePoint, TimeInterval } from '@/types/timeseries';

export function useTimeseries(tokenId: string, interval: TimeInterval = '1d') {
  const [data, setData] = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchTimeseries({ tokenId, interval });
      setData(res.history);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch timeseries'));
    } finally {
      setLoading(false);
    }
  }, [tokenId, interval]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, refetch: load };
}


// ─── hooks/usePortfolio.ts ───

import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import type { PortfolioSummary } from '@/types/position';

export function usePortfolio(): PortfolioSummary {
  const positions = useStore((s) => s.positions);
  const trades = useStore((s) => s.trades);

  return useMemo(() => {
    const totalInvested = positions.reduce(
      (sum, p) => sum + p.avgCostBasis * p.size,
      0
    );
    const totalUnrealizedPnl = positions.reduce(
      (sum, p) => sum + p.unrealizedPnl,
      0
    );
    const totalRealizedPnl = positions.reduce(
      (sum, p) => sum + p.realizedPnl,
      0
    );
    const wins = trades.filter(
      (t) => /* calculate if trade was profitable */ true
    ).length;

    return {
      totalBalance: totalInvested + totalUnrealizedPnl + totalRealizedPnl,
      totalInvested,
      totalUnrealizedPnl,
      totalUnrealizedPnlPercent:
        totalInvested > 0 ? (totalUnrealizedPnl / totalInvested) * 100 : 0,
      totalRealizedPnl,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      totalTrades: trades.length,
      openPositionCount: positions.length,
    };
  }, [positions, trades]);
}


// ─── hooks/useOrderEntry.ts ───

import { useCallback, useState } from 'react';
import { useStore } from '@/store/useStore';
import { submitOrder } from '@/lib/api/orders';
import type { OrderRequest, OrderResponse } from '@/types/order';

export function useOrderEntry() {
  const [submitting, setSubmitting] = useState(false);
  const [lastResponse, setLastResponse] = useState<OrderResponse | null>(null);
  const addNotification = useStore((s) => s.addNotification);

  const placeOrder = useCallback(async (request: OrderRequest) => {
    setSubmitting(true);
    try {
      const response = await submitOrder(request);
      setLastResponse(response);

      if (response.success) {
        addNotification({
          type: 'order_fill',
          severity: 'success',
          title: 'Order Placed',
          message: `${request.side} ${request.size} ${request.outcomeSide} shares @ $${request.price.toFixed(2)}`,
          data: { orderId: response.orderId },
        });
      } else {
        addNotification({
          type: 'order_fill',
          severity: 'error',
          title: 'Order Failed',
          message: response.errorMsg || 'Unknown error',
        });
      }

      return response;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Network error';
      addNotification({
        type: 'order_fill',
        severity: 'error',
        title: 'Order Error',
        message: errorMsg,
      });
      throw err;
    } finally {
      setSubmitting(false);
    }
  }, [addNotification]);

  return { placeOrder, submitting, lastResponse };
}


// ─── hooks/usePriceFlash.ts ───

import { useEffect, useRef, useState } from 'react';

type FlashDirection = 'up' | 'down' | null;

/**
 * Returns a flash direction ('up' | 'down' | null) that resets after 300ms.
 * Used to trigger green/red flash animations on price changes.
 */
export function usePriceFlash(price: number): FlashDirection {
  const prevPrice = useRef(price);
  const [flash, setFlash] = useState<FlashDirection>(null);

  useEffect(() => {
    if (price !== prevPrice.current) {
      setFlash(price > prevPrice.current ? 'up' : 'down');
      prevPrice.current = price;

      const timer = setTimeout(() => setFlash(null), 300);
      return () => clearTimeout(timer);
    }
  }, [price]);

  return flash;
}
```

---

## 4. Performance Optimization

### 4.1 Virtualized Lists for Large Market Catalogs

Polymarket has hundreds to thousands of active markets. Rendering them all to the DOM at once would cause severe layout jank.

**Approach**: Use `@tanstack/react-virtual` for windowed rendering.

```typescript
// ─── components/markets/MarketList.tsx (pattern) ───

import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { MarketCard } from './MarketCard';

export function MarketList({ markets }: { markets: Market[] }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: markets.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,           // estimated row height in px
    overscan: 5,                       // render 5 extra items above/below viewport
  });

  return (
    <div ref={parentRef} className="h-[calc(100vh-200px)] overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            style={{
              position: 'absolute',
              top: 0,
              transform: `translateY(${virtualRow.start}px)`,
              width: '100%',
            }}
          >
            <MarketCard market={markets[virtualRow.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 4.2 Efficient Re-Rendering Strategies for Real-Time Data

**Problem**: WebSocket can push dozens of price updates per second. Naive state updates would cause cascade re-renders.

**Solutions**:

1. **Selector isolation**: Always use narrow Zustand selectors so only the component displaying that specific price re-renders:
```typescript
// GOOD -- only re-renders when this specific market's data changes
const price = useStore((s) => s.markets.get(marketId)?.outcomes[0].price);

// BAD -- re-renders on ANY market change
const markets = useStore((s) => s.markets);
```

2. **Batched updates**: Zustand batches state changes within the same synchronous callback by default. For WebSocket messages arriving in rapid succession, batch multiple price updates into a single state mutation:
```typescript
// In WebSocket handler, collect updates and apply as batch
let pendingUpdates: Array<{ marketId: string; tokenId: string; price: number }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queuePriceUpdate(marketId: string, tokenId: string, price: number) {
  pendingUpdates.push({ marketId, tokenId, price });
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      const updates = pendingUpdates;
      pendingUpdates = [];
      flushTimer = null;

      useStore.setState((state) => {
        const newMarkets = new Map(state.markets);
        for (const { marketId, tokenId, price } of updates) {
          const market = newMarkets.get(marketId);
          if (market) {
            const updatedOutcomes = market.outcomes.map((o) =>
              o.tokenId === tokenId ? { ...o, price } : o
            );
            newMarkets.set(marketId, { ...market, outcomes: updatedOutcomes });
          }
        }
        return { markets: newMarkets };
      });
    }, 16);  // ~60fps frame budget
  }
}
```

3. **`React.memo` with custom comparators**: Wrap `MarketCard` and `PositionRow` components that receive objects as props:
```typescript
const MarketCard = React.memo(
  function MarketCard({ market }: { market: Market }) { /* render */ },
  (prev, next) =>
    prev.market.id === next.market.id &&
    prev.market.outcomes[0].price === next.market.outcomes[0].price &&
    prev.market.outcomes[1].price === next.market.outcomes[1].price
);
```

4. **`useRef` for non-visual data**: Store data that does not need to trigger re-renders (like the previous price for flash calculation) in `useRef`, not `useState`.

### 4.3 Data Caching and Stale-While-Revalidate

Use a layered caching approach:

| Layer | Tool | Purpose |
|---|---|---|
| **API cache** | Custom fetch wrapper or `swr` / `@tanstack/react-query` | Cache HTTP responses with stale-while-revalidate semantics |
| **Zustand store** | Zustand | Authoritative client state; hydrated from API + WebSocket |
| **Browser cache** | Service Worker (optional) | Offline access to static assets and market metadata |

Pattern for API fetching with SWR-like behavior:

```typescript
// ─── lib/api/fetcher.ts ───

const cache = new Map<string, { data: unknown; timestamp: number }>();
const STALE_TIME = 30_000;    // 30 seconds
const CACHE_TIME = 300_000;   // 5 minutes

export async function cachedFetch<T>(
  url: string,
  options?: RequestInit
): Promise<T> {
  const key = `${url}:${JSON.stringify(options?.body || '')}`;
  const cached = cache.get(key);
  const now = Date.now();

  // Return cached data if fresh
  if (cached && now - cached.timestamp < STALE_TIME) {
    return cached.data as T;
  }

  // Fetch fresh data
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data: T = await res.json();

  cache.set(key, { data, timestamp: now });

  // Evict stale entries
  for (const [k, v] of cache.entries()) {
    if (now - v.timestamp > CACHE_TIME) cache.delete(k);
  }

  return data;
}
```

For a more robust setup, consider adding `@tanstack/react-query` alongside Zustand:
- React Query for **server state** (API data fetching, caching, refetching).
- Zustand for **client state** (UI state, WebSocket-driven real-time data, bot configuration).

### 4.4 Bundle Optimization with Dynamic Imports

```typescript
// ─── Lazy-load the charting library (heavyweight, DOM-dependent) ───
import dynamic from 'next/dynamic';

const PriceChart = dynamic(() => import('@/components/charts/PriceChart'), {
  ssr: false,      // lightweight-charts requires browser APIs
  loading: () => <ChartSkeleton />,
});

// ─── Lazy-load the bot log viewer (only needed on bot detail page) ───
const BotLogViewer = dynamic(() => import('@/components/bots/BotLogViewer'), {
  loading: () => <div className="animate-pulse h-64 bg-gray-200 dark:bg-gray-700 rounded" />,
});

// ─── Lazy-load heavy table library only on pages that need it ───
const PositionTable = dynamic(() => import('@/components/positions/PositionTable'), {
  loading: () => <TableSkeleton rows={5} />,
});
```

Additional bundle optimizations:
- **Tree-shaking HeroUI**: Import individual components, not the entire library: `import { Button } from '@heroui/react'` (HeroUI v2 supports this).
- **Analyze bundle**: Add `@next/bundle-analyzer` to identify large dependencies.
- **Font optimization**: Use `next/font` for self-hosted fonts to eliminate layout shift.
- **Image optimization**: Use `next/image` for market icons and event images.

---

## 5. Key Libraries

### 5.1 Recommended Dependencies

| Category | Library | Why |
|---|---|---|
| **Charting** | `lightweight-charts` (^4.x) | TradingView's open-source charting library. 45KB gzipped. Native candlestick, line, area, histogram series. Perfect for binary market price visualization. Must `dynamic import` with `ssr: false`. |
| **Tables / Data Grid** | `@tanstack/react-table` (^8.x) | Headless, type-safe table with sorting, filtering, pagination, column resizing. Pairs perfectly with HeroUI styling. |
| **Virtualization** | `@tanstack/react-virtual` (^3.x) | Windowed rendering for market lists (1000+ items). Works with both lists and tables. |
| **Animation** | `framer-motion` (already installed, ^11.x) | Flash-on-change price animations, page transitions, notification toasts, `AnimatePresence` for list additions/removals. |
| **Forms** | `react-hook-form` (^7.x) + `zod` (^3.x) | Type-safe form validation for order entry and settings. `@hookform/resolvers/zod` for schema integration. |
| **Date handling** | `date-fns` (^3.x) | Lightweight (tree-shakeable). `formatDistanceToNowStrict` for relative timestamps, `format` for absolute. |
| **Icons** | `lucide-react` | Tree-shakeable icon set. Replaces inline SVGs currently in `Header.tsx` and `Sidebar.tsx`. Provides trading-relevant icons (TrendingUp, TrendingDown, Activity, Bot, etc.). |
| **Server state** | `@tanstack/react-query` (^5.x) | Optional but recommended. Handles API caching, background refetching, error retry, pagination. Complements Zustand for server-state concerns. |
| **Number formatting** | `Intl.NumberFormat` (built-in) | No library needed. Use for currency, percentages, compact notation. |

### 5.2 Charting Implementation Strategy

For binary prediction markets, two chart types are needed:

**1. Line / Area Chart (default)**
```typescript
// ─── components/charts/PriceChart.tsx (conceptual) ───

'use client';

import { createChart, IChartApi, ISeriesApi, LineData } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';

interface PriceChartProps {
  data: Array<{ t: number; p: number }>;
  height?: number;
}

export default function PriceChart({ data, height = 400 }: PriceChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const theme = useAppStore((s) => s.theme);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const isDark = theme === 'dark';

    const chart = createChart(chartContainerRef.current, {
      height,
      layout: {
        background: { color: isDark ? '#1a1a2e' : '#ffffff' },
        textColor: isDark ? '#d1d5db' : '#374151',
      },
      grid: {
        vertLines: { color: isDark ? '#2d2d44' : '#e5e7eb' },
        horzLines: { color: isDark ? '#2d2d44' : '#e5e7eb' },
      },
      rightPriceScale: {
        borderColor: isDark ? '#2d2d44' : '#e5e7eb',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: isDark ? '#2d2d44' : '#e5e7eb',
        timeVisible: true,
      },
      crosshair: {
        mode: 0,   // Normal crosshair
      },
    });

    const series = chart.addAreaSeries({
      lineColor: '#3b82f6',
      topColor: 'rgba(59, 130, 246, 0.4)',
      bottomColor: 'rgba(59, 130, 246, 0.0)',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    const chartData: LineData[] = data.map((point) => ({
      time: point.t as any,
      value: point.p,
    }));

    series.setData(chartData);
    chart.timeScale().fitContent();

    chartRef.current = chart;
    seriesRef.current = series;

    // Resize observer for responsive charts
    const resizeObserver = new ResizeObserver(() => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
        });
      }
    });
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [data, theme, height]);

  return <div ref={chartContainerRef} className="w-full" />;
}
```

**2. Real-time update via WebSocket**
```typescript
// Append new price points as they arrive
useEffect(() => {
  const unsub = useStore.subscribe(
    (s) => s.markets.get(marketId)?.outcomes[0].price,
    (price) => {
      if (price !== undefined && seriesRef.current) {
        seriesRef.current.update({
          time: Math.floor(Date.now() / 1000) as any,
          value: price,
        });
      }
    }
  );
  return unsub;
}, [marketId]);
```

### 5.3 Form Validation Schema (Order Entry)

```typescript
// ─── lib/validation/orderSchema.ts ───

import { z } from 'zod';

export const orderSchema = z.object({
  outcomeSide: z.enum(['YES', 'NO']),
  type: z.enum(['MARKET', 'LIMIT']),
  size: z
    .number({ required_error: 'Number of shares is required' })
    .int('Shares must be a whole number')
    .min(1, 'Minimum 1 share')
    .max(100_000, 'Maximum 100,000 shares'),
  price: z
    .number()
    .min(0.01, 'Minimum price is $0.01')
    .max(0.99, 'Maximum price is $0.99')
    .optional(),                       // only required for LIMIT orders
}).refine(
  (data) => data.type === 'MARKET' || data.price !== undefined,
  { message: 'Price is required for limit orders', path: ['price'] }
);

export type OrderFormData = z.infer<typeof orderSchema>;
```

---

## 6. Recommended File / Folder Structure

```
auto-poly-bet-bot/
├── app/                                # Next.js App Router
│   ├── layout.tsx                      # Root layout (providers, shell)
│   ├── page.tsx                        # Dashboard home
│   ├── markets/
│   │   ├── page.tsx                    # Market browser / explorer
│   │   └── [marketId]/
│   │       └── page.tsx                # Market detail (chart + order entry)
│   ├── positions/
│   │   └── page.tsx                    # Position tracker
│   ├── history/
│   │   └── page.tsx                    # Trade history
│   ├── bots/
│   │   ├── page.tsx                    # Bot status dashboard
│   │   └── [botId]/
│   │       └── page.tsx                # Bot detail + log viewer
│   ├── settings/
│   │   └── page.tsx                    # App settings (API keys, preferences)
│   ├── globals.css                     # Tailwind directives + custom CSS
│   └── error.tsx                       # Global error boundary
│
├── components/
│   ├── layout/                         # Shell and navigation
│   │   ├── Header.tsx
│   │   ├── Sidebar.tsx
│   │   ├── ThemeProvider.tsx
│   │   ├── ConnectionStatus.tsx        # WS/API health indicator
│   │   └── NotificationBell.tsx        # Header notification dropdown
│   │
│   ├── dashboard/                      # Dashboard page components
│   │   ├── PortfolioSummaryCards.tsx
│   │   ├── PortfolioChart.tsx
│   │   ├── RecentTradesFeed.tsx
│   │   └── QuickStats.tsx
│   │
│   ├── markets/                        # Market browser components
│   │   ├── MarketSearchBar.tsx
│   │   ├── MarketFilters.tsx
│   │   ├── MarketList.tsx              # Virtualized list container
│   │   ├── MarketCard.tsx              # Individual market card
│   │   └── MarketDetail/
│   │       ├── MarketHeader.tsx
│   │       ├── MarketInfo.tsx
│   │       └── OrderBook.tsx
│   │
│   ├── charts/                         # Chart components
│   │   ├── PriceChart.tsx              # Area/line chart (lightweight-charts)
│   │   ├── CandlestickChart.tsx        # OHLC chart (lightweight-charts)
│   │   ├── ChartTimeSelector.tsx       # Interval toggle (1m, 1h, 1d, etc.)
│   │   ├── PortfolioAreaChart.tsx      # Portfolio value over time
│   │   ├── Sparkline.tsx              # Inline mini-chart for market cards
│   │   └── ChartSkeleton.tsx          # Loading placeholder
│   │
│   ├── orders/                         # Order entry components
│   │   ├── OrderEntryForm.tsx          # Main order form
│   │   ├── OutcomeToggle.tsx           # YES/NO selector
│   │   ├── OrderTypeSelector.tsx       # Market/Limit toggle
│   │   ├── OrderPreview.tsx            # Cost/profit calculation display
│   │   └── OrderConfirmModal.tsx       # Confirmation dialog
│   │
│   ├── positions/                      # Position management
│   │   ├── PositionTable.tsx           # TanStack Table implementation
│   │   ├── PositionRow.tsx             # Expandable row with trade detail
│   │   ├── PositionSummary.tsx         # Aggregate P&L header
│   │   └── PnLDisplay.tsx             # Color-coded profit/loss display
│   │
│   ├── trades/                         # Trade history
│   │   ├── TradeTable.tsx
│   │   ├── TradeFilters.tsx
│   │   └── TradeExportButton.tsx
│   │
│   ├── bots/                           # Bot management
│   │   ├── BotStatusCard.tsx
│   │   ├── BotMetrics.tsx
│   │   ├── BotActions.tsx              # Start/stop/pause controls
│   │   ├── BotConfigForm.tsx           # Strategy configuration
│   │   ├── BotLogViewer.tsx            # Virtualized log output
│   │   └── SystemHealthBar.tsx         # Rate limit, uptime, connectivity
│   │
│   ├── notifications/                  # Alert system
│   │   ├── NotificationPanel.tsx       # Dropdown list of notifications
│   │   ├── NotificationItem.tsx
│   │   ├── ToastContainer.tsx          # Floating toast notifications
│   │   └── Toast.tsx
│   │
│   └── ui/                             # Shared / generic UI primitives
│       ├── PriceDisplay.tsx            # Formatted price with flash animation
│       ├── PercentChange.tsx           # +/-% with color and arrow
│       ├── StatusDot.tsx               # Colored status indicator
│       ├── EmptyState.tsx              # "No data" placeholder
│       ├── ErrorBoundary.tsx           # Component-level error boundary
│       ├── TableSkeleton.tsx           # Loading skeleton for tables
│       └── RelativeTime.tsx            # "2m ago" timestamp component
│
├── hooks/                              # Custom React hooks
│   ├── useWebSocket.ts                 # WebSocket lifecycle + subscriptions
│   ├── useMarketData.ts                # Market fetching + caching
│   ├── useTimeseries.ts                # Price history fetching
│   ├── usePortfolio.ts                 # Portfolio calculations (memoized)
│   ├── useOrderEntry.ts                # Order submission + notifications
│   ├── usePositions.ts                 # Position fetching + real-time updates
│   ├── useTrades.ts                    # Trade history with pagination
│   ├── usePriceFlash.ts                # Flash-on-change animation hook
│   ├── useDebounce.ts                  # Debounced value (for search)
│   └── useMediaQuery.ts               # Responsive breakpoint detection
│
├── store/                              # Zustand state management
│   ├── useStore.ts                     # Combined store (all slices)
│   ├── useAppStore.ts                  # (existing) UI state -- rename to slices/uiSlice.ts
│   └── slices/
│       ├── uiSlice.ts                  # Theme, sidebar, layout preferences
│       ├── marketSlice.ts              # Markets Map + filters + search
│       ├── orderSlice.ts               # Open orders + pending order
│       ├── positionSlice.ts            # Positions + portfolio summary
│       ├── tradeSlice.ts               # Trade history + pagination cursor
│       ├── botSlice.ts                 # Bot strategies + logs
│       ├── notificationSlice.ts        # Notifications + unread count
│       └── connectionSlice.ts          # WS status, API health, heartbeat
│
├── lib/                                # Non-React utilities and services
│   ├── api/                            # API client layer
│   │   ├── client.ts                   # Base fetch wrapper (auth, error handling)
│   │   ├── markets.ts                  # Gamma API calls (fetchMarkets, fetchMarketById)
│   │   ├── orders.ts                   # CLOB API calls (submitOrder, cancelOrder)
│   │   ├── trades.ts                   # CLOB API calls (fetchTrades)
│   │   ├── timeseries.ts              # CLOB API calls (fetchTimeseries)
│   │   └── positions.ts               # Data API calls (fetchPositions)
│   ├── websocket/
│   │   ├── polymarketWS.ts            # WebSocket client class
│   │   └── messageParser.ts           # Parse raw WS messages into typed objects
│   ├── validation/
│   │   ├── orderSchema.ts             # Zod schema for order entry form
│   │   ├── settingsSchema.ts          # Zod schema for settings form
│   │   └── botConfigSchema.ts         # Zod schema for bot configuration
│   ├── utils/
│   │   ├── format.ts                  # formatCurrency, formatPercent, formatPrice
│   │   ├── calculations.ts            # P&L, cost basis, Kelly criterion
│   │   └── constants.ts               # API URLs, intervals, defaults
│   └── transformers/
│       ├── marketTransformer.ts       # GammaMarket → Market conversion
│       └── tradeTransformer.ts        # API Trade → internal Trade conversion
│
├── types/                              # Shared TypeScript type definitions
│   ├── market.ts                       # Market, GammaMarket, GammaEvent, MarketOutcome
│   ├── order.ts                        # Order, OrderRequest, OrderResponse, OrderStatus
│   ├── trade.ts                        # Trade, MakerOrder, TradeFilter
│   ├── position.ts                     # Position, PortfolioSummary
│   ├── timeseries.ts                   # PricePoint, TimeInterval, TimeseriesRequest
│   ├── bot.ts                          # BotStrategy, BotConfig, BotMetrics, BotLogEntry
│   ├── notification.ts                 # Notification, NotificationType, NotificationSeverity
│   ├── websocket.ts                    # WSMessage, WSSubscription, WSConnectionStatus
│   └── api.ts                          # ApiCredentials, PaginatedResponse, ApiError
│
├── public/                             # Static assets
│   └── ...
│
├── tailwind.config.ts
├── tsconfig.json
├── next.config.js
├── package.json
└── .eslintrc.json
```

### 6.1 Migration Path from Current Codebase

The existing project has a minimal but solid foundation. Here is the migration path:

| Current | Target | Action |
|---|---|---|
| `components/Header.tsx` | `components/layout/Header.tsx` | Move and extend with `NotificationBell`, `ConnectionStatus` |
| `components/Sidebar.tsx` | `components/layout/Sidebar.tsx` | Move and extend with new nav items (Markets, Positions, History, Bots) |
| `components/ThemeProvider.tsx` | `components/layout/ThemeProvider.tsx` | Move as-is |
| `store/useAppStore.ts` | `store/slices/uiSlice.ts` + `store/useStore.ts` | Refactor into slice pattern; keep existing state; create combined store |
| `app/page.tsx` | `app/page.tsx` | Replace placeholder with PortfolioSummaryCards + BotStatusList + RecentTradesFeed |
| `app/bets/page.tsx` | `app/positions/page.tsx` | Rename "bets" to "positions" (trading terminology); replace static table with TanStack Table |
| `app/settings/page.tsx` | `app/settings/page.tsx` | Extend with react-hook-form + zod; add sections for API keys, alerts, bot defaults |

### 6.2 New Dependencies to Install

```bash
yarn add lightweight-charts @tanstack/react-table @tanstack/react-virtual \
       react-hook-form @hookform/resolvers zod date-fns lucide-react

# Optional but recommended
yarn add @tanstack/react-query
```

---

## Appendix: Quick Reference

### Polymarket API Endpoints

| API | Base URL | Purpose |
|---|---|---|
| **Gamma API** | `https://gamma-api.polymarket.com` | Market discovery, event metadata, tags |
| **CLOB API** | `https://clob.polymarket.com` | Order placement, trades, order book, timeseries |
| **Data API** | `https://data-api.polymarket.com` | User positions, trade history |
| **CLOB WebSocket** | `wss://ws-subscriptions-clob.polymarket.com` | Real-time order book, price updates (`/ws/market`, `/ws/user`) |
| **RTDS WebSocket** | `wss://ws-live-data.polymarket.com` | Real-time activity feed, crypto/equity prices |

### Polymarket Timeseries Intervals

| Interval | API Value | Best For |
|---|---|---|
| 1 minute | `1m` | Intraday scalping view |
| 1 hour | `1h` | Day trading view |
| 6 hours | `6h` | Swing trading view |
| 1 day | `1d` | Default overview |
| 1 week | `1w` | Long-term trend |
| Maximum | `max` | Full market history |

### Color System Recommendations

```
// Tailwind classes for consistent trading semantics:

Profit / Up / YES:   text-emerald-500 dark:text-emerald-400   bg-emerald-500/10
Loss / Down / NO:    text-red-500 dark:text-red-400           bg-red-500/10
Neutral / Flat:      text-gray-500 dark:text-gray-400         bg-gray-500/10
Active / Running:    text-blue-500 dark:text-blue-400         bg-blue-500/10
Warning:             text-amber-500 dark:text-amber-400       bg-amber-500/10
```

---

*This plan is designed to be implemented incrementally. Start with the Zustand store refactor and type definitions (Phase 1), then build the Market Browser and Order Entry (Phase 2), followed by Positions/Portfolio and Charts (Phase 3), and finally the Bot Dashboard and Notification System (Phase 4).*
