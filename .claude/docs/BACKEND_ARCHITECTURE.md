# Auto Poly Bet Bot -- Backend Architecture Report

## Table of Contents

1. [Project Baseline & Polymarket API Surface](#1-project-baseline--polymarket-api-surface)
2. [Next.js API Routes Architecture](#2-nextjs-api-routes-architecture)
3. [Detailed API Endpoint Design](#3-detailed-api-endpoint-design)
4. [Server Actions](#4-server-actions)
5. [Database Integration (Prisma + PostgreSQL)](#5-database-integration-prisma--postgresql)
6. [Real-Time Features](#6-real-time-features)
7. [Background Jobs & Scheduling](#7-background-jobs--scheduling)
8. [Caching Strategy](#8-caching-strategy)
9. [Error Handling & Logging](#9-error-handling--logging)
10. [Authentication & Security](#10-authentication--security)
11. [Testing Strategy](#11-testing-strategy)

---

## 1. Project Baseline & Polymarket API Surface

### Current State

The project is a Next.js 15 App Router application with:

- **Framework**: Next.js 15.1.12 (App Router)
- **UI**: HeroUI v2.8.8, Tailwind CSS 3.4, Framer Motion
- **State**: Zustand 4.5
- **Pages**: Dashboard (`/`), Bets (`/bets`), Settings (`/settings`)
- **Components**: `Header`, `Sidebar`, `ThemeProvider`
- **Store**: `useAppStore` (theme + sidebar state)
- **No backend**: Zero API routes, no database, no auth

### Polymarket External API Surface

The bot must integrate with three distinct Polymarket services:

| Service | Base URL | Auth |
|---------|----------|------|
| CLOB (Trading) | `https://clob.polymarket.com` | L2 API Keys |
| Gamma (Market Data) | `https://gamma-api.polymarket.com` | None |
| Data API (Positions) | `https://data-api.polymarket.com` | API Keys |
| WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/` | WSS Auth |

**Key CLOB Trading Endpoints:**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/orders` | Place single order |
| POST | `/orders/batch` | Batch up to 15 orders |
| GET | `/orders` | Get active orders |
| GET | `/orders/{id}` | Get order details |
| POST | `/orders/{id}/cancel` | Cancel single order |
| POST | `/orders/cancel` | Cancel multiple orders |
| POST | `/orders/cancel-all` | Cancel all orders |
| GET | `/orderbook/{token}` | Order book summary |
| GET | `/price/{token}` | Current price |
| GET | `/price/{token}/history` | Price history |
| GET | `/midpoint/{token}` | Midpoint price |
| GET | `/spreads` | Bid-ask spreads |

**Key Gamma Market Data Endpoints:**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/events` | List events |
| GET | `/events/{id}` | Event details |
| GET | `/markets` | List markets |
| GET | `/markets/{id}` | Market details |

**Key Data API Endpoints:**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/user/positions` | Current positions |
| GET | `/user/trades` | User trades |
| GET | `/user/activity` | On-chain activity |
| GET | `/trades` | Trades across markets |

**WebSocket Channels:**

- `MARKET` channel: subscribe by `assets_ids` (token IDs) for order book and price updates
- `USER` channel: subscribe by `markets` (condition IDs) for order fill and trade updates

### Required New Dependencies

```json
{
  "dependencies": {
    "@polymarket/clob-client": "^5.2.1",
    "@prisma/client": "^6.3.0",
    "next-auth": "^5.0.0",
    "ioredis": "^5.4.0",
    "bullmq": "^5.30.0",
    "pino": "^9.6.0",
    "pino-pretty": "^13.0.0",
    "zod": "^3.24.0",
    "ethers": "^6.13.0",
    "@sentry/nextjs": "^9.0.0",
    "server-only": "^0.0.1"
  },
  "devDependencies": {
    "prisma": "^6.3.0",
    "@types/node": "^22.0.0",
    "vitest": "^3.0.0",
    "@playwright/test": "^1.50.0",
    "msw": "^2.7.0"
  }
}
```

---

## 2. Next.js API Routes Architecture

### Directory Structure

```
app/
  api/
    v1/
      markets/
        route.ts                    # GET: list/search markets
        [id]/
          route.ts                  # GET: market details + order book
          snapshots/
            route.ts                # GET: price history snapshots
      orders/
        route.ts                    # GET: list orders, POST: place order
        [id]/
          route.ts                  # GET: order detail, DELETE: cancel
        batch/
          route.ts                  # POST: batch order placement
      positions/
        route.ts                    # GET: current positions + P&L
      portfolio/
        route.ts                    # GET: aggregate portfolio stats
        history/
          route.ts                  # GET: historical portfolio value
      strategies/
        route.ts                    # GET: list, POST: create
        [id]/
          route.ts                  # GET: detail, PUT: update, DELETE: remove
          performance/
            route.ts                # GET: strategy performance metrics
          logs/
            route.ts                # GET: strategy execution logs
      bot/
        start/
          route.ts                  # POST: start bot engine
        stop/
          route.ts                  # POST: stop bot engine
        status/
          route.ts                  # GET: bot health and status
      alerts/
        route.ts                    # GET: list, POST: create alert rule
        [id]/
          route.ts                  # PUT: update, DELETE: dismiss
      auth/
        connect-wallet/
          route.ts                  # POST: connect Polymarket wallet
        session/
          route.ts                  # GET: current session
        api-keys/
          route.ts                  # GET: list, POST: create API key
          [id]/
            route.ts                # DELETE: revoke API key
      analytics/
        pnl/
          route.ts                  # GET: P&L analytics
        trades/
          route.ts                  # GET: trade analytics
      stream/
        prices/
          route.ts                  # GET: SSE price stream
        orders/
          route.ts                  # GET: SSE order updates
        portfolio/
          route.ts                  # GET: SSE portfolio updates
  actions/
    orders.ts                       # Server Actions for order placement
    strategies.ts                   # Server Actions for strategy CRUD
    settings.ts                     # Server Actions for settings forms
lib/
  polymarket/
    client.ts                       # Polymarket CLOB client wrapper
    gamma.ts                        # Gamma API client
    data-api.ts                     # Data API client
    websocket.ts                    # WebSocket manager
    types.ts                        # Polymarket-specific types
  db/
    prisma.ts                       # Prisma client singleton
    queries/
      markets.ts                    # Market query functions
      orders.ts                     # Order query functions
      strategies.ts                 # Strategy query functions
      portfolio.ts                  # Portfolio query functions
  auth/
    config.ts                       # Auth configuration
    wallet.ts                       # Wallet verification utilities
    session.ts                      # Session helpers
  cache/
    redis.ts                        # Redis client singleton
    keys.ts                         # Cache key definitions
    strategies.ts                   # Cache read/write/invalidate helpers
  jobs/
    queue.ts                        # BullMQ queue definitions
    workers/
      market-sync.ts                # Market data sync worker
      strategy-executor.ts          # Strategy execution worker
      pnl-calculator.ts             # P&L calculation worker
      alert-evaluator.ts            # Alert condition evaluator
  logging/
    logger.ts                       # Pino logger instance
    audit.ts                        # Audit log writer
  errors/
    api-error.ts                    # Typed API error classes
    handler.ts                      # Global error handler
  middleware/
    auth.ts                         # Auth verification middleware
    rate-limit.ts                   # Rate limiting middleware
    validate.ts                     # Zod validation middleware
  types/
    api.ts                          # Shared API request/response types
    domain.ts                       # Domain model types
middleware.ts                       # Next.js edge middleware (root)
```

### API Versioning Strategy

All API routes live under `/api/v1/`. The Next.js root `middleware.ts` handles version routing and provides a migration path:

```typescript
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Redirect unversioned /api/* calls to /api/v1/*
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/v1/')) {
    const newUrl = request.nextUrl.clone();
    newUrl.pathname = pathname.replace('/api/', '/api/v1/');
    return NextResponse.rewrite(newUrl);
  }

  // Add request ID for tracing
  const requestId = crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set('x-request-id', requestId);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('x-request-id', requestId);
  return response;
}

export const config = {
  matcher: '/api/:path*',
};
```

### Shared Route Handler Wrapper

Every route handler uses a wrapper that provides auth, validation, error handling, and rate limiting in a composable way:

```typescript
// lib/middleware/handler.ts
import { NextRequest, NextResponse } from 'next/server';
import { ZodSchema } from 'zod';
import { getServerSession } from '@/lib/auth/session';
import { rateLimit } from '@/lib/middleware/rate-limit';
import { ApiError, handleApiError } from '@/lib/errors/handler';
import { logger } from '@/lib/logging/logger';
import { auditLog } from '@/lib/logging/audit';

interface HandlerOptions<TBody = unknown> {
  auth?: boolean;                // Require authenticated session (default: true)
  rateLimit?: { max: number; window: string };
  bodySchema?: ZodSchema<TBody>;
  querySchema?: ZodSchema;
  audit?: {
    action: string;
    resource: string;
  };
}

type RouteHandler<TBody = unknown> = (
  req: NextRequest,
  ctx: {
    params: Record<string, string>;
    session: Awaited<ReturnType<typeof getServerSession>> | null;
    body: TBody;
    query: Record<string, string>;
    requestId: string;
  }
) => Promise<NextResponse | Response>;

export function createHandler<TBody = unknown>(
  handler: RouteHandler<TBody>,
  options: HandlerOptions<TBody> = {}
) {
  const { auth = true, bodySchema, querySchema } = options;

  return async (
    req: NextRequest,
    segmentData: { params: Promise<Record<string, string>> }
  ) => {
    const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
    const log = logger.child({ requestId, method: req.method, url: req.url });

    try {
      // Rate limiting
      if (options.rateLimit) {
        const ip = req.headers.get('x-forwarded-for') ?? 'unknown';
        const allowed = await rateLimit(ip, options.rateLimit);
        if (!allowed) {
          return NextResponse.json(
            { error: 'Too many requests' },
            { status: 429 }
          );
        }
      }

      // Authentication
      let session = null;
      if (auth) {
        session = await getServerSession();
        if (!session) {
          return NextResponse.json(
            { error: 'Unauthorized' },
            { status: 401 }
          );
        }
      }

      // Body validation
      let body = {} as TBody;
      if (bodySchema && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const raw = await req.json();
        const result = bodySchema.safeParse(raw);
        if (!result.success) {
          return NextResponse.json(
            { error: 'Validation failed', details: result.error.flatten() },
            { status: 400 }
          );
        }
        body = result.data;
      }

      // Query validation
      const query: Record<string, string> = {};
      req.nextUrl.searchParams.forEach((value, key) => {
        query[key] = value;
      });
      if (querySchema) {
        const result = querySchema.safeParse(query);
        if (!result.success) {
          return NextResponse.json(
            { error: 'Invalid query parameters', details: result.error.flatten() },
            { status: 400 }
          );
        }
      }

      const params = await segmentData.params;

      // Execute handler
      const response = await handler(req, {
        params,
        session,
        body,
        query,
        requestId,
      });

      // Audit logging
      if (options.audit && session) {
        await auditLog({
          userId: session.user.id,
          action: options.audit.action,
          resource: options.audit.resource,
          resourceId: params.id,
          requestId,
          metadata: { method: req.method },
        });
      }

      log.info({ status: (response as NextResponse).status }, 'Request completed');
      return response;
    } catch (error) {
      return handleApiError(error, requestId, log);
    }
  };
}
```

---

## 3. Detailed API Endpoint Design

### Shared Types

```typescript
// lib/types/api.ts
import { z } from 'zod';

// ──────────────────────────────────────────────
// Pagination
// ──────────────────────────────────────────────
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ──────────────────────────────────────────────
// Standard API Response Envelope
// ──────────────────────────────────────────────
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  requestId: string;
  timestamp: string;
}

export interface ApiErrorResponse {
  success: false;
  error: string;
  details?: unknown;
  requestId: string;
  timestamp: string;
}
```

### 3.1 Markets Endpoints

```typescript
// lib/types/markets.ts
import { z } from 'zod';

// --- Request Schemas ---
export const MarketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  category: z.string().optional(),
  status: z.enum(['active', 'closed', 'resolved']).optional(),
  sortBy: z.enum(['volume', 'liquidity', 'endDate', 'createdAt']).default('volume'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  minLiquidity: z.coerce.number().optional(),
});

// --- Response Types ---
export interface MarketSummary {
  id: string;
  conditionId: string;
  question: string;
  description: string;
  category: string;
  endDate: string;
  status: 'active' | 'closed' | 'resolved';
  outcomes: OutcomeSummary[];
  volume: number;
  liquidity: number;
  imageUrl: string | null;
  createdAt: string;
}

export interface OutcomeSummary {
  tokenId: string;
  outcome: string;       // e.g. "Yes" or "No"
  price: number;          // 0.00 - 1.00
  previousPrice: number;
}

export interface MarketDetail extends MarketSummary {
  slug: string;
  resolutionSource: string;
  tags: string[];
  orderBook: OrderBookSnapshot;
  priceHistory: PricePoint[];
  topHolders: HolderInfo[];
}

export interface OrderBookSnapshot {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: number;
  midpoint: number;
  lastUpdated: string;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface PricePoint {
  timestamp: string;
  price: number;
}

export interface HolderInfo {
  address: string;
  shares: number;
  percentage: number;
}
```

```typescript
// app/api/v1/markets/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import { MarketsQuerySchema, MarketSummary } from '@/lib/types/markets';
import { PaginatedResponse } from '@/lib/types/api';
import { searchMarkets } from '@/lib/db/queries/markets';

export const GET = createHandler(
  async (req, { query }) => {
    const filters = MarketsQuerySchema.parse(query);
    const result: PaginatedResponse<MarketSummary> = await searchMarkets(filters);
    return NextResponse.json({ success: true, data: result });
  },
  {
    auth: false,
    rateLimit: { max: 60, window: '1m' },
    querySchema: MarketsQuerySchema,
  }
);
```

```typescript
// app/api/v1/markets/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import { getMarketDetail } from '@/lib/db/queries/markets';

export const GET = createHandler(
  async (req, { params }) => {
    const market = await getMarketDetail(params.id);
    if (!market) {
      return NextResponse.json(
        { success: false, error: 'Market not found' },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, data: market });
  },
  {
    auth: false,
    rateLimit: { max: 120, window: '1m' },
  }
);
```

### 3.2 Orders Endpoints

```typescript
// lib/types/orders.ts
import { z } from 'zod';

// --- Request Schemas ---
export const CreateOrderSchema = z.object({
  marketId: z.string().min(1),
  tokenId: z.string().min(1),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['FOK', 'GTC', 'GTD']),
  price: z.number().min(0.01).max(0.99),
  size: z.number().positive(),
  expiration: z.string().datetime().optional(),   // required for GTD
  postOnly: z.boolean().default(false),
  strategyId: z.string().optional(),              // link to automated strategy
});

export const BatchOrderSchema = z.object({
  orders: z.array(CreateOrderSchema).min(1).max(15),
});

export const OrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['open', 'filled', 'partial', 'cancelled', 'expired', 'all']).default('all'),
  marketId: z.string().optional(),
  strategyId: z.string().optional(),
  side: z.enum(['BUY', 'SELL']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

// --- Response Types ---
export interface OrderResponse {
  id: string;
  polymarketOrderId: string;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  type: 'FOK' | 'GTC' | 'GTD';
  price: number;
  size: number;
  filledSize: number;
  remainingSize: number;
  averageFillPrice: number | null;
  status: 'open' | 'filled' | 'partial' | 'cancelled' | 'expired';
  postOnly: boolean;
  strategyId: string | null;
  createdAt: string;
  updatedAt: string;
  fills: OrderFill[];
}

export interface OrderFill {
  id: string;
  price: number;
  size: number;
  fee: number;
  timestamp: string;
  txHash: string | null;
}

export interface OrderPlacementResult {
  orderId: string;
  polymarketOrderId: string;
  status: 'open' | 'filled' | 'rejected';
  fills: OrderFill[];
  errorMsg: string | null;
}
```

```typescript
// app/api/v1/orders/route.ts
import { NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import {
  CreateOrderSchema,
  OrdersQuerySchema,
} from '@/lib/types/orders';
import { listOrders, placeOrder } from '@/lib/db/queries/orders';

export const GET = createHandler(
  async (req, { session, query }) => {
    const filters = OrdersQuerySchema.parse(query);
    const orders = await listOrders(session!.user.id, filters);
    return NextResponse.json({ success: true, data: orders });
  },
  { querySchema: OrdersQuerySchema }
);

export const POST = createHandler(
  async (req, { session, body }) => {
    const result = await placeOrder(session!.user.id, body);
    return NextResponse.json({ success: true, data: result }, { status: 201 });
  },
  {
    bodySchema: CreateOrderSchema,
    audit: { action: 'create', resource: 'order' },
  }
);
```

```typescript
// app/api/v1/orders/[id]/route.ts
import { NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import { getOrder, cancelOrder } from '@/lib/db/queries/orders';

export const GET = createHandler(async (req, { session, params }) => {
  const order = await getOrder(session!.user.id, params.id);
  if (!order) {
    return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true, data: order });
});

export const DELETE = createHandler(
  async (req, { session, params }) => {
    const result = await cancelOrder(session!.user.id, params.id);
    return NextResponse.json({ success: true, data: result });
  },
  { audit: { action: 'cancel', resource: 'order' } }
);
```

### 3.3 Positions Endpoint

```typescript
// lib/types/positions.ts
export interface Position {
  id: string;
  marketId: string;
  marketQuestion: string;
  tokenId: string;
  outcome: string;
  side: 'LONG' | 'SHORT';
  size: number;
  averageEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  realizedPnl: number;
  totalInvested: number;
  currentValue: number;
  createdAt: string;
  updatedAt: string;
}

export interface PositionsSummary {
  positions: Position[];
  totals: {
    totalValue: number;
    totalInvested: number;
    totalUnrealizedPnl: number;
    totalRealizedPnl: number;
    totalPnlPercent: number;
  };
}
```

```typescript
// app/api/v1/positions/route.ts
import { NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import { getPositions } from '@/lib/db/queries/portfolio';

export const GET = createHandler(async (req, { session }) => {
  const positions = await getPositions(session!.user.id);
  return NextResponse.json({ success: true, data: positions });
});
```

### 3.4 Portfolio Endpoints

```typescript
// lib/types/portfolio.ts
export interface PortfolioStats {
  totalValue: number;
  availableBalance: number;
  totalDeposited: number;
  totalWithdrawn: number;
  allTimePnl: number;
  allTimePnlPercent: number;
  todayPnl: number;
  todayPnlPercent: number;
  weekPnl: number;
  openPositions: number;
  totalTrades: number;
  winRate: number;
  averageReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  bestTrade: { marketQuestion: string; pnl: number } | null;
  worstTrade: { marketQuestion: string; pnl: number } | null;
}

export interface PortfolioHistoryPoint {
  timestamp: string;
  totalValue: number;
  deposited: number;
  pnl: number;
}

export interface PortfolioHistoryResponse {
  points: PortfolioHistoryPoint[];
  period: '1d' | '1w' | '1m' | '3m' | '1y' | 'all';
}
```

```typescript
// app/api/v1/portfolio/route.ts
import { NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import { getPortfolioStats } from '@/lib/db/queries/portfolio';

export const GET = createHandler(async (req, { session }) => {
  const stats = await getPortfolioStats(session!.user.id);
  return NextResponse.json({ success: true, data: stats });
});
```

```typescript
// app/api/v1/portfolio/history/route.ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createHandler } from '@/lib/middleware/handler';
import { getPortfolioHistory } from '@/lib/db/queries/portfolio';

const QuerySchema = z.object({
  period: z.enum(['1d', '1w', '1m', '3m', '1y', 'all']).default('1m'),
});

export const GET = createHandler(
  async (req, { session, query }) => {
    const { period } = QuerySchema.parse(query);
    const history = await getPortfolioHistory(session!.user.id, period);
    return NextResponse.json({ success: true, data: history });
  },
  { querySchema: QuerySchema }
);
```

### 3.5 Strategies Endpoints

```typescript
// lib/types/strategies.ts
import { z } from 'zod';

// --- Request Schemas ---
export const CreateStrategySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  type: z.enum([
    'market_making',
    'momentum',
    'mean_reversion',
    'arbitrage',
    'custom_rule',
  ]),
  config: z.object({
    marketIds: z.array(z.string()).min(1),
    maxPositionSize: z.number().positive(),
    maxOrderSize: z.number().positive(),
    stopLoss: z.number().min(0).max(1).optional(),
    takeProfit: z.number().min(0).max(1).optional(),
    // Market Making specific
    spreadBps: z.number().int().min(1).optional(),
    inventorySkew: z.number().min(0).max(1).optional(),
    // Momentum specific
    lookbackMinutes: z.number().int().positive().optional(),
    entryThreshold: z.number().optional(),
    exitThreshold: z.number().optional(),
    // Mean Reversion specific
    maBandPeriod: z.number().int().positive().optional(),
    deviationEntry: z.number().positive().optional(),
    // Custom Rule specific
    rules: z.array(z.object({
      condition: z.string(),
      action: z.enum(['BUY', 'SELL']),
      size: z.number().positive(),
    })).optional(),
  }),
  schedule: z.object({
    enabled: z.boolean().default(true),
    intervalSeconds: z.number().int().min(5).default(30),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
  }).optional(),
});

export const UpdateStrategySchema = CreateStrategySchema.partial().extend({
  status: z.enum(['running', 'paused', 'stopped']).optional(),
});

// --- Response Types ---
export interface Strategy {
  id: string;
  name: string;
  description: string | null;
  type: 'market_making' | 'momentum' | 'mean_reversion' | 'arbitrage' | 'custom_rule';
  status: 'draft' | 'running' | 'paused' | 'stopped' | 'error';
  config: StrategyConfig;
  schedule: StrategySchedule | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  totalRuns: number;
  totalOrders: number;
  totalPnl: number;
}

export interface StrategyConfig {
  marketIds: string[];
  maxPositionSize: number;
  maxOrderSize: number;
  stopLoss: number | null;
  takeProfit: number | null;
  [key: string]: unknown; // Type-specific params
}

export interface StrategySchedule {
  enabled: boolean;
  intervalSeconds: number;
  startTime: string | null;
  endTime: string | null;
}

export interface StrategyPerformance {
  strategyId: string;
  totalPnl: number;
  totalPnlPercent: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpeRatio: number;
  runs: StrategyRunSummary[];
  dailyPnl: { date: string; pnl: number }[];
}

export interface StrategyRunSummary {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'error';
  ordersPlaced: number;
  ordersFilled: number;
  pnl: number;
  error: string | null;
}
```

```typescript
// app/api/v1/strategies/route.ts
import { NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import { CreateStrategySchema } from '@/lib/types/strategies';
import { listStrategies, createStrategy } from '@/lib/db/queries/strategies';

export const GET = createHandler(async (req, { session }) => {
  const strategies = await listStrategies(session!.user.id);
  return NextResponse.json({ success: true, data: strategies });
});

export const POST = createHandler(
  async (req, { session, body }) => {
    const strategy = await createStrategy(session!.user.id, body);
    return NextResponse.json({ success: true, data: strategy }, { status: 201 });
  },
  {
    bodySchema: CreateStrategySchema,
    audit: { action: 'create', resource: 'strategy' },
  }
);
```

```typescript
// app/api/v1/strategies/[id]/route.ts
import { NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import { UpdateStrategySchema } from '@/lib/types/strategies';
import { getStrategy, updateStrategy, deleteStrategy } from '@/lib/db/queries/strategies';

export const GET = createHandler(async (req, { session, params }) => {
  const strategy = await getStrategy(session!.user.id, params.id);
  if (!strategy) {
    return NextResponse.json({ success: false, error: 'Strategy not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true, data: strategy });
});

export const PUT = createHandler(
  async (req, { session, params, body }) => {
    const strategy = await updateStrategy(session!.user.id, params.id, body);
    return NextResponse.json({ success: true, data: strategy });
  },
  {
    bodySchema: UpdateStrategySchema,
    audit: { action: 'update', resource: 'strategy' },
  }
);

export const DELETE = createHandler(
  async (req, { session, params }) => {
    await deleteStrategy(session!.user.id, params.id);
    return NextResponse.json({ success: true, data: null }, { status: 200 });
  },
  { audit: { action: 'delete', resource: 'strategy' } }
);
```

### 3.6 Bot Control Endpoints

```typescript
// lib/types/bot.ts
export interface BotStatus {
  state: 'running' | 'stopped' | 'starting' | 'stopping' | 'error';
  uptime: number | null;              // seconds
  startedAt: string | null;
  activeStrategies: number;
  totalOrdersToday: number;
  lastHeartbeat: string | null;
  workerStatus: {
    marketSync: 'running' | 'idle' | 'error';
    strategyExecutor: 'running' | 'idle' | 'error';
    pnlCalculator: 'running' | 'idle' | 'error';
    alertEvaluator: 'running' | 'idle' | 'error';
  };
  errors: { message: string; timestamp: string }[];
}

export interface BotStartResult {
  state: 'starting';
  message: string;
}

export interface BotStopResult {
  state: 'stopping';
  message: string;
  openOrdersCancelled: number;
}
```

```typescript
// app/api/v1/bot/status/route.ts
import { NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import { getBotStatus } from '@/lib/jobs/queue';

export const GET = createHandler(async () => {
  const status = await getBotStatus();
  return NextResponse.json({ success: true, data: status });
});
```

```typescript
// app/api/v1/bot/start/route.ts
import { NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import { startBot } from '@/lib/jobs/queue';

export const POST = createHandler(
  async (req, { session }) => {
    const result = await startBot(session!.user.id);
    return NextResponse.json({ success: true, data: result });
  },
  { audit: { action: 'start', resource: 'bot' } }
);
```

### 3.7 Alerts Endpoints

```typescript
// lib/types/alerts.ts
import { z } from 'zod';

export const CreateAlertSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['price_above', 'price_below', 'pnl_threshold', 'strategy_error', 'order_filled']),
  marketId: z.string().optional(),
  strategyId: z.string().optional(),
  threshold: z.number().optional(),
  enabled: z.boolean().default(true),
  channels: z.array(z.enum(['in_app', 'email', 'webhook'])).default(['in_app']),
  webhookUrl: z.string().url().optional(),
});

export interface Alert {
  id: string;
  name: string;
  type: string;
  marketId: string | null;
  strategyId: string | null;
  threshold: number | null;
  enabled: boolean;
  channels: string[];
  webhookUrl: string | null;
  lastTriggeredAt: string | null;
  triggerCount: number;
  createdAt: string;
}

export interface Notification {
  id: string;
  alertId: string;
  alertName: string;
  type: string;
  message: string;
  read: boolean;
  data: Record<string, unknown>;
  createdAt: string;
}
```

### 3.8 Auth Endpoints

```typescript
// lib/types/auth.ts
import { z } from 'zod';

export const ConnectWalletSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  signature: z.string(),
  message: z.string(),
  polymarketApiKey: z.string().optional(),
  polymarketApiSecret: z.string().optional(),
  polymarketPassphrase: z.string().optional(),
});

export interface SessionResponse {
  user: {
    id: string;
    address: string;
    displayName: string | null;
    walletConnected: boolean;
    polymarketLinked: boolean;
  };
  expiresAt: string;
}

export interface ConnectWalletResult {
  success: boolean;
  session: SessionResponse;
}
```

```typescript
// app/api/v1/auth/connect-wallet/route.ts
import { NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import { ConnectWalletSchema } from '@/lib/types/auth';
import { verifyWalletSignature, createSession } from '@/lib/auth/wallet';

export const POST = createHandler(
  async (req, { body }) => {
    const { address, signature, message } = body;

    const valid = await verifyWalletSignature(address, signature, message);
    if (!valid) {
      return NextResponse.json(
        { success: false, error: 'Invalid signature' },
        { status: 401 }
      );
    }

    const session = await createSession(body);
    return NextResponse.json({ success: true, data: session }, { status: 201 });
  },
  {
    auth: false,
    bodySchema: ConnectWalletSchema,
    rateLimit: { max: 10, window: '1m' },
  }
);
```

### 3.9 Analytics Endpoints

```typescript
// lib/types/analytics.ts
import { z } from 'zod';

export const AnalyticsQuerySchema = z.object({
  period: z.enum(['1d', '1w', '1m', '3m', '1y', 'all']).default('1m'),
  groupBy: z.enum(['hour', 'day', 'week', 'month']).default('day'),
  marketId: z.string().optional(),
  strategyId: z.string().optional(),
});

export interface PnlAnalytics {
  period: string;
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  netPnl: number;
  series: { timestamp: string; cumulativePnl: number; dailyPnl: number }[];
  byMarket: { marketId: string; question: string; pnl: number }[];
  byStrategy: { strategyId: string; name: string; pnl: number }[];
}

export interface TradeAnalytics {
  period: string;
  totalTrades: number;
  buyTrades: number;
  sellTrades: number;
  totalVolume: number;
  averageTradeSize: number;
  winRate: number;
  series: { timestamp: string; trades: number; volume: number }[];
}
```

```typescript
// app/api/v1/analytics/pnl/route.ts
import { NextResponse } from 'next/server';
import { createHandler } from '@/lib/middleware/handler';
import { AnalyticsQuerySchema } from '@/lib/types/analytics';
import { getPnlAnalytics } from '@/lib/db/queries/portfolio';

export const GET = createHandler(
  async (req, { session, query }) => {
    const filters = AnalyticsQuerySchema.parse(query);
    const analytics = await getPnlAnalytics(session!.user.id, filters);
    return NextResponse.json({ success: true, data: analytics });
  },
  { querySchema: AnalyticsQuerySchema }
);
```

---

## 4. Server Actions

### When to Use Server Actions vs API Routes

| Use Server Actions | Use API Routes |
|---|---|
| Form submissions (settings, strategy config) | External client consumption (mobile app, scripts) |
| Mutations triggered by UI components | SSE/streaming responses |
| Simple create/update from React components | Webhook receivers |
| Operations tied to a single page | Background job triggers (bot start/stop) |
| Progressive enhancement (works without JS) | Rate-limited public endpoints |

### Strategy Configuration via Server Actions

```typescript
// app/actions/strategies.ts
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getServerSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db/prisma';
import { CreateStrategySchema, UpdateStrategySchema } from '@/lib/types/strategies';
import { auditLog } from '@/lib/logging/audit';

export type ActionState = {
  success: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function createStrategyAction(
  prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: 'Unauthorized' };
  }

  const raw = {
    name: formData.get('name'),
    description: formData.get('description'),
    type: formData.get('type'),
    config: JSON.parse(formData.get('config') as string || '{}'),
    schedule: formData.get('schedule')
      ? JSON.parse(formData.get('schedule') as string)
      : undefined,
  };

  const result = CreateStrategySchema.safeParse(raw);
  if (!result.success) {
    return {
      success: false,
      error: 'Validation failed',
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const strategy = await prisma.strategy.create({
    data: {
      userId: session.user.id,
      name: result.data.name,
      description: result.data.description ?? null,
      type: result.data.type,
      status: 'draft',
      config: result.data.config as any,
      scheduleEnabled: result.data.schedule?.enabled ?? false,
      scheduleIntervalSeconds: result.data.schedule?.intervalSeconds ?? 30,
    },
  });

  await auditLog({
    userId: session.user.id,
    action: 'create',
    resource: 'strategy',
    resourceId: strategy.id,
    metadata: { name: strategy.name, type: strategy.type },
  });

  revalidatePath('/strategies');
  redirect(`/strategies/${strategy.id}`);
}

export async function updateStrategyAction(
  strategyId: string,
  prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: 'Unauthorized' };
  }

  const existing = await prisma.strategy.findFirst({
    where: { id: strategyId, userId: session.user.id },
  });
  if (!existing) {
    return { success: false, error: 'Strategy not found' };
  }

  const raw: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key === 'config' || key === 'schedule') {
      raw[key] = JSON.parse(value as string);
    } else {
      raw[key] = value;
    }
  }

  const result = UpdateStrategySchema.safeParse(raw);
  if (!result.success) {
    return {
      success: false,
      error: 'Validation failed',
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  await prisma.strategy.update({
    where: { id: strategyId },
    data: result.data as any,
  });

  await auditLog({
    userId: session.user.id,
    action: 'update',
    resource: 'strategy',
    resourceId: strategyId,
    metadata: { changes: Object.keys(result.data) },
  });

  revalidatePath(`/strategies/${strategyId}`);
  return { success: true };
}

export async function toggleStrategyAction(
  strategyId: string,
  newStatus: 'running' | 'paused' | 'stopped'
): Promise<ActionState> {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: 'Unauthorized' };
  }

  await prisma.strategy.update({
    where: { id: strategyId, userId: session.user.id },
    data: { status: newStatus },
  });

  revalidatePath(`/strategies/${strategyId}`);
  revalidatePath('/strategies');
  return { success: true };
}
```

### Order Placement via Server Actions

```typescript
// app/actions/orders.ts
'use server';

import { revalidatePath } from 'next/cache';
import { getServerSession } from '@/lib/auth/session';
import { CreateOrderSchema } from '@/lib/types/orders';
import { placeOrder, cancelOrder as cancelOrderQuery } from '@/lib/db/queries/orders';
import { auditLog } from '@/lib/logging/audit';
import type { ActionState } from './strategies';

export async function placeOrderAction(
  prevState: ActionState,
  formData: FormData
): Promise<ActionState & { orderId?: string }> {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: 'Unauthorized' };
  }

  const raw = {
    marketId: formData.get('marketId'),
    tokenId: formData.get('tokenId'),
    side: formData.get('side'),
    type: formData.get('type'),
    price: Number(formData.get('price')),
    size: Number(formData.get('size')),
    postOnly: formData.get('postOnly') === 'true',
  };

  const result = CreateOrderSchema.safeParse(raw);
  if (!result.success) {
    return {
      success: false,
      error: 'Validation failed',
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  try {
    const order = await placeOrder(session.user.id, result.data);

    await auditLog({
      userId: session.user.id,
      action: 'create',
      resource: 'order',
      resourceId: order.orderId,
      metadata: {
        marketId: result.data.marketId,
        side: result.data.side,
        size: result.data.size,
        price: result.data.price,
      },
    });

    revalidatePath('/orders');
    revalidatePath('/positions');
    return { success: true, orderId: order.orderId };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to place order',
    };
  }
}

export async function cancelOrderAction(orderId: string): Promise<ActionState> {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: 'Unauthorized' };
  }

  try {
    await cancelOrderQuery(session.user.id, orderId);
    revalidatePath('/orders');
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to cancel order',
    };
  }
}
```

### Settings via Server Actions

```typescript
// app/actions/settings.ts
'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getServerSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db/prisma';
import { encrypt } from '@/lib/auth/crypto';
import type { ActionState } from './strategies';

const PolymarketCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  passphrase: z.string().min(1),
});

const BotSettingsSchema = z.object({
  maxBetAmount: z.coerce.number().positive(),
  autoTradeEnabled: z.coerce.boolean(),
  riskLevel: z.enum(['conservative', 'moderate', 'aggressive']),
  maxDailyLoss: z.coerce.number().positive(),
  maxOpenPositions: z.coerce.number().int().positive(),
});

export async function savePolymarketCredentials(
  prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await getServerSession();
  if (!session) return { success: false, error: 'Unauthorized' };

  const raw = {
    apiKey: formData.get('apiKey'),
    apiSecret: formData.get('apiSecret'),
    passphrase: formData.get('passphrase'),
  };

  const result = PolymarketCredentialsSchema.safeParse(raw);
  if (!result.success) {
    return {
      success: false,
      error: 'Validation failed',
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  // Encrypt before storing -- secrets never stored in plaintext
  await prisma.userCredential.upsert({
    where: { userId: session.user.id },
    update: {
      polymarketApiKey: encrypt(result.data.apiKey),
      polymarketApiSecret: encrypt(result.data.apiSecret),
      polymarketPassphrase: encrypt(result.data.passphrase),
    },
    create: {
      userId: session.user.id,
      polymarketApiKey: encrypt(result.data.apiKey),
      polymarketApiSecret: encrypt(result.data.apiSecret),
      polymarketPassphrase: encrypt(result.data.passphrase),
    },
  });

  revalidatePath('/settings');
  return { success: true };
}

export async function saveBotSettings(
  prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await getServerSession();
  if (!session) return { success: false, error: 'Unauthorized' };

  const raw = {
    maxBetAmount: formData.get('maxBetAmount'),
    autoTradeEnabled: formData.get('autoTradeEnabled'),
    riskLevel: formData.get('riskLevel'),
    maxDailyLoss: formData.get('maxDailyLoss'),
    maxOpenPositions: formData.get('maxOpenPositions'),
  };

  const result = BotSettingsSchema.safeParse(raw);
  if (!result.success) {
    return {
      success: false,
      error: 'Validation failed',
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  await prisma.botSettings.upsert({
    where: { userId: session.user.id },
    update: result.data,
    create: { userId: session.user.id, ...result.data },
  });

  revalidatePath('/settings');
  return { success: true };
}
```

---

## 5. Database Integration (Prisma + PostgreSQL)

### Prisma Setup

```typescript
// lib/db/prisma.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'info', 'warn', 'error']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
```

### Complete Prisma Schema

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─────────────────────────────────────────────
// USER & AUTH
// ─────────────────────────────────────────────

model User {
  id          String   @id @default(cuid())
  address     String   @unique           // Ethereum wallet address
  displayName String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  wallet          Wallet?
  credential      UserCredential?
  botSettings     BotSettings?
  strategies      Strategy[]
  orders          Order[]
  trades          Trade[]
  positions       Position[]
  alerts          Alert[]
  notifications   Notification[]
  portfolioSnaps  PortfolioSnapshot[]
  auditLogs       AuditLog[]
  sessions        Session[]

  @@map("users")
}

model Session {
  id        String   @id @default(cuid())
  userId    String
  token     String   @unique
  expiresAt DateTime
  createdAt DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([token])
  @@index([userId])
  @@map("sessions")
}

model Wallet {
  id        String   @id @default(cuid())
  userId    String   @unique
  address   String   @unique
  chainId   Int      @default(137)      // Polygon
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("wallets")
}

model UserCredential {
  id                     String   @id @default(cuid())
  userId                 String   @unique
  polymarketApiKey       String                        // encrypted
  polymarketApiSecret    String                        // encrypted
  polymarketPassphrase   String                        // encrypted
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("user_credentials")
}

model BotSettings {
  id                String   @id @default(cuid())
  userId            String   @unique
  maxBetAmount      Float    @default(100)
  autoTradeEnabled  Boolean  @default(false)
  riskLevel         String   @default("moderate")  // conservative | moderate | aggressive
  maxDailyLoss      Float    @default(500)
  maxOpenPositions  Int      @default(10)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("bot_settings")
}

// ─────────────────────────────────────────────
// MARKETS
// ─────────────────────────────────────────────

model Market {
  id              String   @id @default(cuid())
  polymarketId    String   @unique                 // Polymarket condition ID
  slug            String?
  question        String
  description     String?  @db.Text
  category        String?
  imageUrl        String?
  status          String   @default("active")      // active | closed | resolved
  endDate         DateTime?
  resolutionSource String?
  volume          Float    @default(0)
  liquidity       Float    @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  outcomes        Outcome[]
  snapshots       MarketSnapshot[]
  orders          Order[]
  trades          Trade[]
  positions       Position[]
  strategyMarkets StrategyMarket[]

  @@index([status])
  @@index([category])
  @@index([volume(sort: Desc)])
  @@map("markets")
}

model Outcome {
  id        String @id @default(cuid())
  marketId  String
  tokenId   String @unique                         // ERC1155 token ID
  label     String                                 // "Yes" / "No" / custom
  price     Float  @default(0.5)
  prevPrice Float  @default(0.5)

  market Market @relation(fields: [marketId], references: [id], onDelete: Cascade)

  @@index([marketId])
  @@map("outcomes")
}

model MarketSnapshot {
  id         String   @id @default(cuid())
  marketId   String
  price      Float
  volume     Float
  liquidity  Float
  spread     Float?
  bidDepth   Float?
  askDepth   Float?
  timestamp  DateTime @default(now())

  market Market @relation(fields: [marketId], references: [id], onDelete: Cascade)

  @@index([marketId, timestamp])
  @@map("market_snapshots")
}

// ─────────────────────────────────────────────
// ORDERS & TRADES
// ─────────────────────────────────────────────

model Order {
  id                  String   @id @default(cuid())
  userId              String
  marketId            String
  polymarketOrderId   String?  @unique
  tokenId             String
  side                String                         // BUY | SELL
  type                String                         // FOK | GTC | GTD
  price               Float
  size                Float
  filledSize          Float    @default(0)
  remainingSize       Float
  averageFillPrice    Float?
  status              String   @default("pending")   // pending | open | filled | partial | cancelled | expired | rejected
  postOnly            Boolean  @default(false)
  strategyId          String?
  strategyRunId       String?
  expiration          DateTime?
  errorMsg            String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  user        User          @relation(fields: [userId], references: [id])
  market      Market        @relation(fields: [marketId], references: [id])
  strategy    Strategy?     @relation(fields: [strategyId], references: [id])
  strategyRun StrategyRun?  @relation(fields: [strategyRunId], references: [id])
  trades      Trade[]

  @@index([userId, status])
  @@index([userId, marketId])
  @@index([strategyId])
  @@index([polymarketOrderId])
  @@map("orders")
}

model Trade {
  id        String   @id @default(cuid())
  userId    String
  orderId   String
  marketId  String
  tokenId   String
  side      String                                   // BUY | SELL
  price     Float
  size      Float
  fee       Float    @default(0)
  txHash    String?
  createdAt DateTime @default(now())

  user   User   @relation(fields: [userId], references: [id])
  order  Order  @relation(fields: [orderId], references: [id])
  market Market @relation(fields: [marketId], references: [id])

  @@index([userId, createdAt])
  @@index([orderId])
  @@index([marketId])
  @@map("trades")
}

model Position {
  id                String   @id @default(cuid())
  userId            String
  marketId          String
  tokenId           String
  outcome           String
  side              String                           // LONG | SHORT
  size              Float
  averageEntryPrice Float
  realizedPnl       Float    @default(0)
  status            String   @default("open")        // open | closed
  openedAt          DateTime @default(now())
  closedAt          DateTime?
  updatedAt         DateTime @updatedAt

  user   User   @relation(fields: [userId], references: [id])
  market Market @relation(fields: [marketId], references: [id])

  @@unique([userId, marketId, tokenId, status])
  @@index([userId, status])
  @@map("positions")
}

// ─────────────────────────────────────────────
// STRATEGIES
// ─────────────────────────────────────────────

model Strategy {
  id                      String   @id @default(cuid())
  userId                  String
  name                    String
  description             String?
  type                    String                     // market_making | momentum | mean_reversion | arbitrage | custom_rule
  status                  String   @default("draft") // draft | running | paused | stopped | error
  config                  Json                       // StrategyConfig JSON
  scheduleEnabled         Boolean  @default(false)
  scheduleIntervalSeconds Int      @default(30)
  scheduleStartTime       DateTime?
  scheduleEndTime         DateTime?
  lastRunAt               DateTime?
  totalRuns               Int      @default(0)
  totalPnl                Float    @default(0)
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt

  user    User              @relation(fields: [userId], references: [id])
  markets StrategyMarket[]
  runs    StrategyRun[]
  logs    StrategyLog[]
  orders  Order[]

  @@index([userId, status])
  @@map("strategies")
}

model StrategyMarket {
  id         String @id @default(cuid())
  strategyId String
  marketId   String

  strategy Strategy @relation(fields: [strategyId], references: [id], onDelete: Cascade)
  market   Market   @relation(fields: [marketId], references: [id])

  @@unique([strategyId, marketId])
  @@map("strategy_markets")
}

model StrategyRun {
  id           String    @id @default(cuid())
  strategyId   String
  status       String    @default("running")      // running | completed | error
  ordersPlaced Int       @default(0)
  ordersFilled Int       @default(0)
  pnl          Float     @default(0)
  error        String?   @db.Text
  startedAt    DateTime  @default(now())
  endedAt      DateTime?

  strategy Strategy @relation(fields: [strategyId], references: [id], onDelete: Cascade)
  orders   Order[]

  @@index([strategyId, startedAt])
  @@map("strategy_runs")
}

model StrategyLog {
  id         String   @id @default(cuid())
  strategyId String
  level      String                                // info | warn | error | debug
  message    String   @db.Text
  data       Json?
  createdAt  DateTime @default(now())

  strategy Strategy @relation(fields: [strategyId], references: [id], onDelete: Cascade)

  @@index([strategyId, createdAt])
  @@map("strategy_logs")
}

// ─────────────────────────────────────────────
// ALERTS & NOTIFICATIONS
// ─────────────────────────────────────────────

model Alert {
  id              String    @id @default(cuid())
  userId          String
  name            String
  type            String                             // price_above | price_below | pnl_threshold | strategy_error | order_filled
  marketId        String?
  strategyId      String?
  threshold       Float?
  enabled         Boolean   @default(true)
  channels        Json      @default("[\"in_app\"]") // ["in_app", "email", "webhook"]
  webhookUrl      String?
  lastTriggeredAt DateTime?
  triggerCount    Int       @default(0)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  user          User           @relation(fields: [userId], references: [id])
  notifications Notification[]

  @@index([userId, enabled])
  @@map("alerts")
}

model Notification {
  id        String   @id @default(cuid())
  userId    String
  alertId   String?
  type      String
  message   String
  data      Json?
  read      Boolean  @default(false)
  createdAt DateTime @default(now())

  user  User   @relation(fields: [userId], references: [id])
  alert Alert? @relation(fields: [alertId], references: [id])

  @@index([userId, read, createdAt])
  @@map("notifications")
}

// ─────────────────────────────────────────────
// PORTFOLIO
// ─────────────────────────────────────────────

model PortfolioSnapshot {
  id             String   @id @default(cuid())
  userId         String
  totalValue     Float
  availableBalance Float
  totalDeposited Float
  totalPnl       Float
  openPositions  Int
  timestamp      DateTime @default(now())

  user User @relation(fields: [userId], references: [id])

  @@index([userId, timestamp])
  @@map("portfolio_snapshots")
}

// ─────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────

model AuditLog {
  id         String   @id @default(cuid())
  userId     String
  action     String                                  // create | update | delete | start | stop | cancel
  resource   String                                  // order | strategy | bot | settings
  resourceId String?
  requestId  String?
  metadata   Json?
  ipAddress  String?
  createdAt  DateTime @default(now())

  user User @relation(fields: [userId], references: [id])

  @@index([userId, createdAt])
  @@index([resource, action])
  @@map("audit_logs")
}
```

### Migration Strategy

```bash
# Initial setup
npx prisma init
npx prisma migrate dev --name init

# Naming convention for migrations:
# YYYYMMDD_HHMMSS_description
# Examples:
#   20260210_120000_init
#   20260215_090000_add_strategy_schedule_fields
#   20260220_140000_add_portfolio_snapshot_index

# Production migration (never use migrate dev in prod)
npx prisma migrate deploy
```

Migration workflow:

1. Change `schema.prisma`
2. Run `npx prisma migrate dev --name descriptive_name`
3. Review generated SQL in `prisma/migrations/`
4. Commit migration files alongside schema changes
5. CI runs `npx prisma migrate deploy` against staging/production

### Database Seeding

```typescript
// prisma/seed.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Seed demo user
  const user = await prisma.user.upsert({
    where: { address: '0xDEMO000000000000000000000000000000000001' },
    update: {},
    create: {
      address: '0xDEMO000000000000000000000000000000000001',
      displayName: 'Demo Trader',
    },
  });

  // Seed sample markets
  const markets = [
    {
      polymarketId: 'demo-market-btc-100k',
      question: 'Will Bitcoin reach $100k by end of 2026?',
      category: 'Crypto',
      status: 'active',
      endDate: new Date('2026-12-31'),
      volume: 5_000_000,
      liquidity: 250_000,
    },
    {
      polymarketId: 'demo-market-us-election',
      question: 'Will the incumbent party win the 2028 presidential election?',
      category: 'Politics',
      status: 'active',
      endDate: new Date('2028-11-05'),
      volume: 12_000_000,
      liquidity: 800_000,
    },
    {
      polymarketId: 'demo-market-fed-rate',
      question: 'Will the Fed cut rates in March 2026?',
      category: 'Economics',
      status: 'active',
      endDate: new Date('2026-03-20'),
      volume: 3_000_000,
      liquidity: 150_000,
    },
  ];

  for (const m of markets) {
    const market = await prisma.market.upsert({
      where: { polymarketId: m.polymarketId },
      update: m,
      create: m,
    });

    // Create outcomes for each market
    await prisma.outcome.createMany({
      data: [
        {
          marketId: market.id,
          tokenId: `${m.polymarketId}-yes`,
          label: 'Yes',
          price: 0.55 + Math.random() * 0.2,
          prevPrice: 0.5,
        },
        {
          marketId: market.id,
          tokenId: `${m.polymarketId}-no`,
          label: 'No',
          price: 0.45 - Math.random() * 0.2,
          prevPrice: 0.5,
        },
      ],
      skipDuplicates: true,
    });
  }

  // Seed bot settings
  await prisma.botSettings.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      maxBetAmount: 100,
      autoTradeEnabled: false,
      riskLevel: 'moderate',
      maxDailyLoss: 500,
      maxOpenPositions: 10,
    },
  });

  // Seed a sample strategy
  await prisma.strategy.create({
    data: {
      userId: user.id,
      name: 'Demo Momentum Strategy',
      description: 'Sample momentum strategy for testing',
      type: 'momentum',
      status: 'draft',
      config: {
        marketIds: [markets[0].polymarketId],
        maxPositionSize: 500,
        maxOrderSize: 100,
        lookbackMinutes: 60,
        entryThreshold: 0.05,
        exitThreshold: 0.02,
      },
    },
  });

  console.log('Seed completed successfully');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

Add to `package.json`:

```json
{
  "prisma": {
    "seed": "npx tsx prisma/seed.ts"
  }
}
```

Run with: `npx prisma db seed`

---

## 6. Real-Time Features

### 6.1 Server-Sent Events (SSE) for Live Dashboard Updates

SSE is the primary real-time delivery mechanism for the browser. It works natively with Next.js route handlers and requires no additional infrastructure.

```typescript
// app/api/v1/stream/prices/route.ts
import { NextRequest } from 'next/server';
import { getServerSession } from '@/lib/auth/session';
import { redis } from '@/lib/cache/redis';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }

  const marketIds = req.nextUrl.searchParams.get('marketIds')?.split(',') ?? [];
  if (marketIds.length === 0) {
    return new Response('marketIds query param required', { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const subscriber = redis.duplicate();

      // Subscribe to Redis price channels
      const channels = marketIds.map((id) => `price:${id}`);
      await subscriber.subscribe(...channels);

      subscriber.on('message', (channel: string, message: string) => {
        const data = `data: ${message}\n\n`;
        controller.enqueue(encoder.encode(data));
      });

      // Send heartbeat every 30 seconds to keep connection alive
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 30_000);

      // Cleanup on disconnect
      req.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        subscriber.unsubscribe(...channels);
        subscriber.quit();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable Nginx buffering
    },
  });
}
```

```typescript
// app/api/v1/stream/orders/route.ts
import { NextRequest } from 'next/server';
import { getServerSession } from '@/lib/auth/session';
import { redis } from '@/lib/cache/redis';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const subscriber = redis.duplicate();
      const channel = `user:${session.user.id}:orders`;

      await subscriber.subscribe(channel);

      subscriber.on('message', (_channel: string, message: string) => {
        const parsed = JSON.parse(message);
        const event = [
          `event: ${parsed.type}`,  // order_filled, order_cancelled, etc.
          `data: ${message}`,
          '',
          '',
        ].join('\n');
        controller.enqueue(encoder.encode(event));
      });

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 30_000);

      req.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        subscriber.unsubscribe(channel);
        subscriber.quit();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
```

### Client-Side SSE Hook

```typescript
// lib/hooks/useSSE.ts
'use client';

import { useEffect, useRef, useCallback, useState } from 'react';

interface UseSSEOptions<T> {
  url: string;
  enabled?: boolean;
  onMessage?: (data: T) => void;
  onError?: (error: Event) => void;
  eventTypes?: string[];         // Named event types to listen for
  retryInterval?: number;        // ms, default 5000
}

export function useSSE<T = unknown>(options: UseSSEOptions<T>) {
  const {
    url,
    enabled = true,
    onMessage,
    onError,
    eventTypes,
    retryInterval = 5000,
  } = options;

  const sourceRef = useRef<EventSource | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastData, setLastData] = useState<T | null>(null);

  const connect = useCallback(() => {
    if (!enabled) return;

    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => setConnected(true);

    // Default message handler (unnamed events)
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as T;
        setLastData(data);
        onMessage?.(data);
      } catch {
        // Non-JSON data
      }
    };

    // Named event handlers
    eventTypes?.forEach((type) => {
      source.addEventListener(type, (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as T;
          setLastData(data);
          onMessage?.(data);
        } catch {
          // Non-JSON data
        }
      });
    });

    source.onerror = (event) => {
      setConnected(false);
      onError?.(event);
      source.close();
      // Auto-reconnect
      setTimeout(connect, retryInterval);
    };

    return source;
  }, [url, enabled, onMessage, onError, eventTypes, retryInterval]);

  useEffect(() => {
    const source = connect();
    return () => {
      source?.close();
      setConnected(false);
    };
  }, [connect]);

  return { connected, lastData };
}
```

### 6.2 WebSocket Proxy to Polymarket Feeds

The background worker process maintains persistent WebSocket connections to Polymarket and re-publishes events into Redis Pub/Sub. The Next.js SSE routes then relay those Redis events to browser clients. This decouples the long-lived WebSocket from the request-response lifecycle of Next.js.

```typescript
// lib/polymarket/websocket.ts
import WebSocket from 'ws';
import { redis } from '@/lib/cache/redis';
import { logger } from '@/lib/logging/logger';

interface PolymarketWSConfig {
  url: string;
  channels: {
    type: 'market' | 'user';
    ids: string[];    // asset_ids for market, condition_ids for user
  }[];
  auth?: {
    apiKey: string;
    secret: string;
    passphrase: string;
  };
}

export class PolymarketWebSocketManager {
  private ws: WebSocket | null = null;
  private config: PolymarketWSConfig;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private isAlive = false;

  constructor(config: PolymarketWSConfig) {
    this.config = config;
  }

  connect() {
    const log = logger.child({ component: 'polymarket-ws' });

    this.ws = new WebSocket(this.config.url);

    this.ws.on('open', () => {
      log.info('Connected to Polymarket WebSocket');
      this.isAlive = true;

      // Send subscription message
      for (const channel of this.config.channels) {
        const msg: Record<string, unknown> = {
          type: channel.type,
        };
        if (channel.type === 'market') {
          msg.assets_ids = channel.ids;
        } else {
          msg.markets = channel.ids;
          if (this.config.auth) {
            msg.auth = this.config.auth;
          }
        }
        this.ws!.send(JSON.stringify(msg));
      }

      // Start ping/pong keepalive
      this.pingTimer = setInterval(() => {
        if (!this.isAlive) {
          log.warn('WebSocket ping timeout, reconnecting');
          this.ws?.terminate();
          return;
        }
        this.isAlive = false;
        this.ws?.ping();
      }, 30_000);
    });

    this.ws.on('pong', () => {
      this.isAlive = true;
    });

    this.ws.on('message', async (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString());

        // Republish to Redis based on event type
        if (data.event_type === 'price_change') {
          await redis.publish(
            `price:${data.market_id}`,
            JSON.stringify({
              marketId: data.market_id,
              tokenId: data.asset_id,
              price: data.price,
              timestamp: data.timestamp,
            })
          );
        } else if (data.event_type === 'book') {
          await redis.publish(
            `orderbook:${data.market_id}`,
            JSON.stringify(data)
          );
        } else if (data.event_type === 'trade' || data.event_type === 'order') {
          // User-specific events
          if (data.owner) {
            await redis.publish(
              `user:${data.owner}:orders`,
              JSON.stringify({ type: data.event_type, ...data })
            );
          }
        }

        // Also cache latest price in Redis for quick access
        if (data.price && data.asset_id) {
          await redis.set(
            `latest_price:${data.asset_id}`,
            JSON.stringify({ price: data.price, timestamp: data.timestamp }),
            'EX',
            60 // 60 second TTL
          );
        }
      } catch (err) {
        log.error({ err }, 'Failed to process WebSocket message');
      }
    });

    this.ws.on('close', (code, reason) => {
      log.warn({ code, reason: reason.toString() }, 'WebSocket closed');
      this.cleanup();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      log.error({ err }, 'WebSocket error');
    });
  }

  subscribe(assetIds: string[]) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        assets_ids: assetIds,
        operation: 'subscribe',
      }));
    }
  }

  unsubscribe(assetIds: string[]) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        assets_ids: assetIds,
        operation: 'unsubscribe',
      }));
    }
  }

  private cleanup() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info('Reconnecting to Polymarket WebSocket...');
      this.connect();
    }, 5_000);
  }

  disconnect() {
    this.cleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
```

### 6.3 Polling Fallback

For environments where SSE is unreliable (corporate proxies, certain mobile browsers), the frontend includes a polling fallback using SWR:

```typescript
// lib/hooks/useRealtimeData.ts
'use client';

import useSWR from 'swr';
import { useSSE } from './useSSE';
import { useState, useCallback } from 'react';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface UseRealtimeOptions<T> {
  sseUrl: string;
  restUrl: string;
  pollingInterval?: number;    // ms for SWR fallback
  sseEnabled?: boolean;
}

export function useRealtimeData<T>(options: UseRealtimeOptions<T>) {
  const { sseUrl, restUrl, pollingInterval = 5000, sseEnabled = true } = options;
  const [sseData, setSseData] = useState<T | null>(null);

  const handleSSEMessage = useCallback((data: T) => {
    setSseData(data);
  }, []);

  const { connected } = useSSE<T>({
    url: sseUrl,
    enabled: sseEnabled,
    onMessage: handleSSEMessage,
  });

  // SWR as fallback when SSE is not connected
  const { data: pollData, error } = useSWR<{ data: T }>(
    connected ? null : restUrl,   // Disable polling when SSE is active
    fetcher,
    { refreshInterval: pollingInterval }
  );

  return {
    data: sseData ?? pollData?.data ?? null,
    isStreaming: connected,
    isPolling: !connected && !error,
    error,
  };
}
```

### Architecture Diagram: Real-Time Data Flow

```
Polymarket WebSocket
        |
        v
  [Background Worker Process]  <-- maintains persistent WS connection
        |
        v
  [Redis Pub/Sub]              <-- decouples WS lifecycle from HTTP
        |
    +---+---+
    |       |
    v       v
  [SSE Route Handler]     [SSE Route Handler]
    |                       |
    v                       v
  Browser A              Browser B
  (EventSource)          (EventSource)
```

---

## 7. Background Jobs & Scheduling

### Architecture Decision

Next.js route handlers are request-response: they cannot host long-running processes. The bot engine runs as a **separate Node.js process** managed by BullMQ, communicating with the Next.js app through Redis.

```
┌──────────────────┐     ┌──────────────────┐
│  Next.js App     │     │  Worker Process   │
│  (API Routes)    │<───>│  (BullMQ Workers) │
│                  │     │                    │
│  - Dashboard UI  │     │  - Market Sync     │
│  - REST API      │     │  - Strategy Exec   │
│  - SSE Streams   │     │  - P&L Calculator  │
│  - Server Actions│     │  - Alert Evaluator │
│                  │     │  - WS Manager      │
└────────┬─────────┘     └────────┬───────────┘
         │                        │
         └──────────┬─────────────┘
                    │
              ┌─────┴─────┐
              │   Redis    │
              │ (BullMQ +  │
              │  Pub/Sub + │
              │  Cache)    │
              └─────┬──────┘
                    │
              ┌─────┴──────┐
              │ PostgreSQL  │
              │ (Prisma)    │
              └─────────────┘
```

### Queue Definitions

```typescript
// lib/jobs/queue.ts
import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '@/lib/logging/logger';

const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

// ── Queue Definitions ──────────────────────────

export const marketSyncQueue = new Queue('market-sync', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export const strategyQueue = new Queue('strategy-execution', {
  connection,
  defaultJobOptions: {
    attempts: 1,     // Strategies should not auto-retry (could double-trade)
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 2000 },
  },
});

export const pnlQueue = new Queue('pnl-calculation', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 10000 },
    removeOnComplete: { count: 200 },
  },
});

export const alertQueue = new Queue('alert-evaluation', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: { count: 1000 },
  },
});

// ── Job Types ──────────────────────────────────

export interface MarketSyncJob {
  type: 'full_sync' | 'incremental' | 'single_market';
  marketId?: string;
}

export interface StrategyExecutionJob {
  strategyId: string;
  runId: string;
  userId: string;
  trigger: 'scheduled' | 'manual';
}

export interface PnlCalculationJob {
  userId: string;
  type: 'snapshot' | 'recalculate';
}

export interface AlertEvaluationJob {
  alertId: string;
  userId: string;
  trigger: 'price_change' | 'order_event' | 'scheduled';
  data: Record<string, unknown>;
}

// ── Bot Control ────────────────────────────────

export async function startBot(userId: string) {
  // Schedule recurring jobs
  await marketSyncQueue.add(
    'incremental-sync',
    { type: 'incremental' } satisfies MarketSyncJob,
    {
      repeat: { every: 60_000 },          // Every minute
      jobId: 'market-sync-recurring',
    }
  );

  await pnlQueue.add(
    'portfolio-snapshot',
    { userId, type: 'snapshot' } satisfies PnlCalculationJob,
    {
      repeat: { every: 300_000 },          // Every 5 minutes
      jobId: `pnl-snapshot-${userId}`,
    }
  );

  // Start all strategies marked as 'running'
  // (handled by the worker startup logic)

  await redis.set('bot:status', JSON.stringify({
    state: 'running',
    startedAt: new Date().toISOString(),
  }));

  return { state: 'starting' as const, message: 'Bot engine starting' };
}

export async function stopBot(userId: string) {
  // Remove recurring jobs
  await marketSyncQueue.removeRepeatableByKey('market-sync-recurring');
  await pnlQueue.removeRepeatableByKey(`pnl-snapshot-${userId}`);

  // Drain strategy queue
  await strategyQueue.drain();

  await redis.set('bot:status', JSON.stringify({
    state: 'stopped',
    stoppedAt: new Date().toISOString(),
  }));

  return { state: 'stopping' as const, message: 'Bot engine stopping', openOrdersCancelled: 0 };
}

export async function getBotStatus() {
  const raw = await redis.get('bot:status');
  if (!raw) {
    return { state: 'stopped', uptime: null, startedAt: null } as any;
  }
  const status = JSON.parse(raw);

  // Enrich with queue health
  const [marketSyncHealth, strategyHealth, pnlHealth, alertHealth] = await Promise.all([
    marketSyncQueue.getJobCounts(),
    strategyQueue.getJobCounts(),
    pnlQueue.getJobCounts(),
    alertQueue.getJobCounts(),
  ]);

  return {
    ...status,
    uptime: status.startedAt
      ? Math.floor((Date.now() - new Date(status.startedAt).getTime()) / 1000)
      : null,
    workerStatus: {
      marketSync: marketSyncHealth.failed > 0 ? 'error' : 'running',
      strategyExecutor: strategyHealth.failed > 0 ? 'error' : 'running',
      pnlCalculator: pnlHealth.failed > 0 ? 'error' : 'running',
      alertEvaluator: alertHealth.failed > 0 ? 'error' : 'running',
    },
    queues: { marketSyncHealth, strategyHealth, pnlHealth, alertHealth },
  };
}

const redis = new IORedis(process.env.REDIS_URL!);
```

### Worker Implementations

```typescript
// lib/jobs/workers/market-sync.ts
import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';
import type { MarketSyncJob } from '../queue';

const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

export const marketSyncWorker = new Worker<MarketSyncJob>(
  'market-sync',
  async (job: Job<MarketSyncJob>) => {
    const log = logger.child({ worker: 'market-sync', jobId: job.id });

    if (job.data.type === 'full_sync') {
      log.info('Starting full market sync');
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const resp = await fetch(
          `${GAMMA_API}/markets?limit=${limit}&offset=${offset}&active=true`
        );
        const markets = await resp.json();

        if (!Array.isArray(markets) || markets.length === 0) {
          hasMore = false;
          break;
        }

        for (const m of markets) {
          await prisma.market.upsert({
            where: { polymarketId: m.conditionId },
            update: {
              question: m.question,
              description: m.description,
              category: m.groupItemTitle ?? m.category,
              status: m.active ? 'active' : m.closed ? 'closed' : 'resolved',
              endDate: m.endDate ? new Date(m.endDate) : null,
              volume: m.volume ?? 0,
              liquidity: m.liquidity ?? 0,
              imageUrl: m.image,
              slug: m.slug,
            },
            create: {
              polymarketId: m.conditionId,
              question: m.question,
              description: m.description,
              category: m.groupItemTitle ?? m.category,
              status: 'active',
              endDate: m.endDate ? new Date(m.endDate) : null,
              volume: m.volume ?? 0,
              liquidity: m.liquidity ?? 0,
              imageUrl: m.image,
              slug: m.slug,
            },
          });
        }

        offset += limit;
        job.updateProgress(offset);
      }

      log.info({ totalSynced: offset }, 'Full sync complete');
    } else if (job.data.type === 'incremental') {
      // Fetch only recently updated markets
      const since = new Date(Date.now() - 120_000).toISOString(); // last 2 min
      const resp = await fetch(
        `${GAMMA_API}/markets?active=true&updatedSince=${since}&limit=50`
      );
      const markets = await resp.json();

      if (Array.isArray(markets)) {
        for (const m of markets) {
          // Fetch live price from CLOB
          const tokens = m.clobTokenIds ?? [];
          for (const tokenId of tokens) {
            try {
              const priceResp = await fetch(`${CLOB_API}/price/${tokenId}`);
              const priceData = await priceResp.json();

              await prisma.outcome.upsert({
                where: { tokenId },
                update: {
                  prevPrice: priceData.price,
                  price: priceData.price,
                },
                create: {
                  marketId: m.conditionId,
                  tokenId,
                  label: tokenId.endsWith('-yes') ? 'Yes' : 'No',
                  price: priceData.price ?? 0.5,
                  prevPrice: 0.5,
                },
              });
            } catch {
              // Price fetch failed, skip
            }
          }
        }
      }
    }
  },
  { connection, concurrency: 2 }
);
```

```typescript
// lib/jobs/workers/strategy-executor.ts
import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';
import { getPolymarketClient } from '@/lib/polymarket/client';
import type { StrategyExecutionJob } from '../queue';

const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

export const strategyExecutorWorker = new Worker<StrategyExecutionJob>(
  'strategy-execution',
  async (job: Job<StrategyExecutionJob>) => {
    const { strategyId, runId, userId } = job.data;
    const log = logger.child({ worker: 'strategy-exec', strategyId, runId });

    const strategy = await prisma.strategy.findUnique({
      where: { id: strategyId },
      include: { markets: { include: { market: true } } },
    });

    if (!strategy || strategy.status !== 'running') {
      log.warn('Strategy not found or not running, skipping');
      return;
    }

    const run = await prisma.strategyRun.update({
      where: { id: runId },
      data: { status: 'running' },
    });

    try {
      const client = await getPolymarketClient(userId);
      const config = strategy.config as Record<string, unknown>;

      // Dispatch to strategy-type-specific executor
      switch (strategy.type) {
        case 'momentum':
          await executeMomentum(client, strategy, config, run.id, log);
          break;
        case 'mean_reversion':
          await executeMeanReversion(client, strategy, config, run.id, log);
          break;
        case 'market_making':
          await executeMarketMaking(client, strategy, config, run.id, log);
          break;
        default:
          log.warn({ type: strategy.type }, 'Unknown strategy type');
      }

      await prisma.strategyRun.update({
        where: { id: runId },
        data: { status: 'completed', endedAt: new Date() },
      });

      await prisma.strategy.update({
        where: { id: strategyId },
        data: {
          lastRunAt: new Date(),
          totalRuns: { increment: 1 },
        },
      });
    } catch (err) {
      log.error({ err }, 'Strategy execution failed');

      await prisma.strategyRun.update({
        where: { id: runId },
        data: {
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
          endedAt: new Date(),
        },
      });

      await prisma.strategyLog.create({
        data: {
          strategyId,
          level: 'error',
          message: `Execution failed: ${err instanceof Error ? err.message : 'Unknown'}`,
          data: { runId, error: String(err) },
        },
      });
    }
  },
  { connection, concurrency: 5 }
);

// Strategy-type executors are stubs; real logic depends on trading strategy design.
async function executeMomentum(
  client: any,
  strategy: any,
  config: Record<string, unknown>,
  runId: string,
  log: any
) {
  const lookback = (config.lookbackMinutes as number) ?? 60;
  const entryThreshold = (config.entryThreshold as number) ?? 0.05;

  for (const sm of strategy.markets) {
    const market = sm.market;

    // Get recent snapshots for momentum signal
    const snapshots = await prisma.marketSnapshot.findMany({
      where: {
        marketId: market.id,
        timestamp: { gte: new Date(Date.now() - lookback * 60_000) },
      },
      orderBy: { timestamp: 'asc' },
    });

    if (snapshots.length < 2) continue;

    const oldest = snapshots[0].price;
    const latest = snapshots[snapshots.length - 1].price;
    const momentum = (latest - oldest) / oldest;

    log.info({ market: market.question, momentum }, 'Momentum signal');

    if (Math.abs(momentum) >= entryThreshold) {
      const side = momentum > 0 ? 'BUY' : 'SELL';
      const size = Math.min(
        config.maxOrderSize as number,
        config.maxPositionSize as number
      );

      log.info({ side, size, price: latest }, 'Placing momentum order');

      // Place order through Polymarket client (implementation depends on SDK)
      // const result = await client.createAndPostOrder({ ... });

      await prisma.strategyLog.create({
        data: {
          strategyId: strategy.id,
          level: 'info',
          message: `Momentum signal: ${side} ${size} at ${latest}`,
          data: { momentum, side, size, runId },
        },
      });
    }
  }
}

async function executeMeanReversion(client: any, strategy: any, config: Record<string, unknown>, runId: string, log: any) {
  // Implementation follows similar pattern to momentum
  log.info('Mean reversion execution - to be implemented');
}

async function executeMarketMaking(client: any, strategy: any, config: Record<string, unknown>, runId: string, log: any) {
  // Implementation follows similar pattern
  log.info('Market making execution - to be implemented');
}
```

### Worker Entry Point

```typescript
// workers/index.ts
// Run as: npx tsx workers/index.ts

import { marketSyncWorker } from '@/lib/jobs/workers/market-sync';
import { strategyExecutorWorker } from '@/lib/jobs/workers/strategy-executor';
import { PolymarketWebSocketManager } from '@/lib/polymarket/websocket';
import { logger } from '@/lib/logging/logger';

const log = logger.child({ process: 'worker' });

log.info('Starting worker processes...');

// Workers are started by importing them (BullMQ auto-starts processing)
log.info('Market sync worker started');
log.info('Strategy executor worker started');

// Start WebSocket manager
const wsManager = new PolymarketWebSocketManager({
  url: 'wss://ws-subscriptions-clob.polymarket.com/ws/',
  channels: [
    { type: 'market', ids: [] }, // Subscribe dynamically via Redis
  ],
});
wsManager.connect();
log.info('Polymarket WebSocket connected');

// Graceful shutdown
const shutdown = async () => {
  log.info('Shutting down workers...');
  await marketSyncWorker.close();
  await strategyExecutorWorker.close();
  wsManager.disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

### Deployment: Running Workers Alongside Next.js

**Development** (single process via `concurrently`):
```json
{
  "scripts": {
    "dev": "concurrently \"next dev\" \"npx tsx --watch workers/index.ts\"",
    "workers": "npx tsx workers/index.ts"
  }
}
```

**Production** (Docker Compose):
```yaml
# docker-compose.yml
services:
  web:
    build: .
    command: npm start
    ports:
      - "3000:3000"
    env_file: .env
    depends_on:
      - redis
      - postgres

  workers:
    build: .
    command: npx tsx workers/index.ts
    env_file: .env
    depends_on:
      - redis
      - postgres
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: polybot
      POSTGRES_USER: polybot
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    ports:
      - "5432:5432"
    volumes:
      - pg-data:/var/lib/postgresql/data

volumes:
  redis-data:
  pg-data:
```

---

## 8. Caching Strategy

### 8.1 Next.js Built-In Caching

```typescript
// lib/polymarket/gamma.ts
// Use Next.js fetch cache for market data that changes infrequently

const GAMMA_API = 'https://gamma-api.polymarket.com';

export async function getMarkets(params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${GAMMA_API}/markets?${query}`, {
    next: {
      revalidate: 60, // Revalidate every 60 seconds (ISR-style)
      tags: ['markets'],
    },
  });
  return res.json();
}

export async function getMarketById(id: string) {
  const res = await fetch(`${GAMMA_API}/markets/${id}`, {
    next: {
      revalidate: 30, // More frequent for detail pages
      tags: [`market-${id}`],
    },
  });
  return res.json();
}

// For volatile data (order book), skip cache entirely
export async function getOrderBook(tokenId: string) {
  const res = await fetch(`https://clob.polymarket.com/orderbook/${tokenId}`, {
    cache: 'no-store', // Always fresh
  });
  return res.json();
}
```

Invalidation via Server Actions or route handlers:

```typescript
import { revalidateTag } from 'next/cache';

// After a market sync job completes:
revalidateTag('markets');

// After a specific market updates:
revalidateTag(`market-${marketId}`);
```

### 8.2 Redis Integration

```typescript
// lib/cache/redis.ts
import IORedis from 'ioredis';

const globalForRedis = globalThis as unknown as {
  redis: IORedis | undefined;
};

export const redis =
  globalForRedis.redis ??
  new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      return Math.min(times * 200, 5000);
    },
  });

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}
```

```typescript
// lib/cache/keys.ts
// Centralized cache key definitions to prevent collisions

export const CacheKeys = {
  // Market data (30s - 5m TTL)
  marketList: (page: number) => `cache:markets:list:${page}`,
  marketDetail: (id: string) => `cache:markets:${id}`,
  orderBook: (tokenId: string) => `cache:orderbook:${tokenId}`,
  latestPrice: (tokenId: string) => `latest_price:${tokenId}`,

  // User data (1-5m TTL)
  userPositions: (userId: string) => `cache:user:${userId}:positions`,
  userPortfolio: (userId: string) => `cache:user:${userId}:portfolio`,
  userOrders: (userId: string, status: string) =>
    `cache:user:${userId}:orders:${status}`,

  // Session & auth (matches session TTL)
  session: (token: string) => `session:${token}`,

  // Rate limiting
  rateLimit: (key: string, window: string) => `rl:${window}:${key}`,

  // Bot state
  botStatus: () => 'bot:status',

  // Pub/Sub channels
  priceChannel: (marketId: string) => `price:${marketId}`,
  orderbookChannel: (marketId: string) => `orderbook:${marketId}`,
  userOrdersChannel: (userId: string) => `user:${userId}:orders`,
} as const;
```

```typescript
// lib/cache/strategies.ts
import { redis } from './redis';
import { CacheKeys } from './keys';

export async function getCached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number
): Promise<T> {
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached) as T;
  }

  const data = await fetcher();
  await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
  return data;
}

export async function invalidateCache(pattern: string) {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

// Specific invalidation helpers
export async function invalidateUserCache(userId: string) {
  await invalidateCache(`cache:user:${userId}:*`);
}

export async function invalidateMarketCache(marketId?: string) {
  if (marketId) {
    await redis.del(CacheKeys.marketDetail(marketId));
  }
  await invalidateCache('cache:markets:list:*');
}
```

### 8.3 Cache Invalidation Strategy Summary

| Data Type | Cache Layer | TTL | Invalidation Trigger |
|-----------|-------------|-----|---------------------|
| Market list | Next.js fetch + Redis | 60s | Market sync job, `revalidateTag('markets')` |
| Market detail | Next.js fetch + Redis | 30s | Market sync job, `revalidateTag('market-{id}')` |
| Order book | None (no-store) | 0 | Always fetched live |
| Live prices | Redis only | 10s | WebSocket updates overwrite continuously |
| User positions | Redis | 60s | After order fill, P&L recalculation |
| Portfolio stats | Redis | 300s | P&L snapshot job, manual recalc |
| User session | Redis | Matches session expiry | Logout, session refresh |
| Strategy list | None | 0 | Small data set, always fetched from DB |

---

## 9. Error Handling & Logging

### 9.1 Typed API Errors

```typescript
// lib/errors/api-error.ts
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    details?: unknown,
    isOperational = true
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(message, 400, 'BAD_REQUEST', details);
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError(message, 401, 'UNAUTHORIZED');
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(message, 403, 'FORBIDDEN');
  }

  static notFound(resource: string) {
    return new ApiError(`${resource} not found`, 404, 'NOT_FOUND');
  }

  static conflict(message: string) {
    return new ApiError(message, 409, 'CONFLICT');
  }

  static rateLimited() {
    return new ApiError('Too many requests', 429, 'RATE_LIMITED');
  }

  static internal(message = 'Internal server error') {
    return new ApiError(message, 500, 'INTERNAL_ERROR', undefined, false);
  }

  static polymarketError(message: string, details?: unknown) {
    return new ApiError(
      `Polymarket API error: ${message}`,
      502,
      'POLYMARKET_ERROR',
      details
    );
  }
}
```

### 9.2 Global Error Handler

```typescript
// lib/errors/handler.ts
import { NextResponse } from 'next/server';
import { ApiError } from './api-error';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nextjs';
import type { Logger } from 'pino';

export function handleApiError(
  error: unknown,
  requestId: string,
  log: Logger
): NextResponse {
  const timestamp = new Date().toISOString();

  // Known operational errors
  if (error instanceof ApiError) {
    log.warn(
      { statusCode: error.statusCode, code: error.code },
      error.message
    );

    if (!error.isOperational) {
      Sentry.captureException(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: error.message,
        code: error.code,
        details: error.details,
        requestId,
        timestamp,
      },
      { status: error.statusCode }
    );
  }

  // Prisma errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    log.warn({ prismaCode: error.code }, 'Database error');

    if (error.code === 'P2002') {
      return NextResponse.json(
        {
          success: false,
          error: 'Resource already exists',
          code: 'CONFLICT',
          requestId,
          timestamp,
        },
        { status: 409 }
      );
    }

    if (error.code === 'P2025') {
      return NextResponse.json(
        {
          success: false,
          error: 'Resource not found',
          code: 'NOT_FOUND',
          requestId,
          timestamp,
        },
        { status: 404 }
      );
    }
  }

  // Unknown errors -- always log + report
  log.error({ err: error }, 'Unhandled error');
  Sentry.captureException(error);

  return NextResponse.json(
    {
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      requestId,
      timestamp,
    },
    { status: 500 }
  );
}
```

### 9.3 Structured Logging with Pino

```typescript
// lib/logging/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'HH:MM:ss.l',
          },
        },
      }
    : {}),
  // Production: JSON output for log aggregation (Datadog, CloudWatch, etc.)
  base: {
    service: 'auto-poly-bet-bot',
    env: process.env.NODE_ENV,
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.apiSecret',
      '*.passphrase',
      '*.privateKey',
    ],
    censor: '[REDACTED]',
  },
});
```

### 9.4 Audit Logging

```typescript
// lib/logging/audit.ts
import { prisma } from '@/lib/db/prisma';
import { logger } from './logger';

interface AuditEntry {
  userId: string;
  action: string;
  resource: string;
  resourceId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export async function auditLog(entry: AuditEntry) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId ?? null,
        requestId: entry.requestId ?? null,
        metadata: entry.metadata ?? null,
        ipAddress: entry.ipAddress ?? null,
      },
    });

    logger.info(
      {
        audit: true,
        userId: entry.userId,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId,
      },
      `Audit: ${entry.action} ${entry.resource}`
    );
  } catch (err) {
    // Audit log failure should not break the request
    logger.error({ err, entry }, 'Failed to write audit log');
  }
}
```

### 9.5 Sentry Integration

```typescript
// sentry.server.config.ts  (Next.js auto-loads this)
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  integrations: [
    Sentry.prismaIntegration(),     // Track DB query performance
  ],
  beforeSend(event) {
    // Scrub sensitive data
    if (event.request?.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
    }
    return event;
  },
});
```

---

## 10. Authentication & Security

### 10.1 Wallet-Based Authentication

This application uses Ethereum wallet signing (EIP-4361 / Sign-In with Ethereum) instead of traditional username/password auth. The flow:

1. Frontend generates a nonce and message
2. User signs the message with their wallet (MetaMask, WalletConnect, etc.)
3. Backend verifies the signature, creates/finds the user, and issues a session token

```typescript
// lib/auth/wallet.ts
import { ethers } from 'ethers';
import { prisma } from '@/lib/db/prisma';
import { redis } from '@/lib/cache/redis';
import { CacheKeys } from '@/lib/cache/keys';
import crypto from 'crypto';

const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

export async function verifyWalletSignature(
  address: string,
  signature: string,
  message: string
): Promise<boolean> {
  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    return recoveredAddress.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

export async function createSession(params: {
  address: string;
  polymarketApiKey?: string;
  polymarketApiSecret?: string;
  polymarketPassphrase?: string;
}) {
  // Find or create user
  const user = await prisma.user.upsert({
    where: { address: params.address.toLowerCase() },
    update: {},
    create: {
      address: params.address.toLowerCase(),
    },
  });

  // Create wallet record if needed
  await prisma.wallet.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      address: params.address.toLowerCase(),
    },
  });

  // Store Polymarket credentials if provided (encrypted)
  if (params.polymarketApiKey) {
    const { encrypt } = await import('./crypto');
    await prisma.userCredential.upsert({
      where: { userId: user.id },
      update: {
        polymarketApiKey: encrypt(params.polymarketApiKey),
        polymarketApiSecret: encrypt(params.polymarketApiSecret!),
        polymarketPassphrase: encrypt(params.polymarketPassphrase!),
      },
      create: {
        userId: user.id,
        polymarketApiKey: encrypt(params.polymarketApiKey),
        polymarketApiSecret: encrypt(params.polymarketApiSecret!),
        polymarketPassphrase: encrypt(params.polymarketPassphrase!),
      },
    });
  }

  // Generate session token
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000);

  // Store in DB (for persistence across restarts)
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      token,
      expiresAt,
    },
  });

  // Cache in Redis (for fast lookup)
  const sessionData = {
    id: session.id,
    userId: user.id,
    user: {
      id: user.id,
      address: user.address,
      displayName: user.displayName,
    },
    expiresAt: expiresAt.toISOString(),
  };

  await redis.set(
    CacheKeys.session(token),
    JSON.stringify(sessionData),
    'EX',
    SESSION_TTL
  );

  return {
    session: sessionData,
    token,
  };
}
```

```typescript
// lib/auth/session.ts
import { cookies } from 'next/headers';
import { redis } from '@/lib/cache/redis';
import { prisma } from '@/lib/db/prisma';
import { CacheKeys } from '@/lib/cache/keys';

interface SessionData {
  id: string;
  userId: string;
  user: {
    id: string;
    address: string;
    displayName: string | null;
  };
  expiresAt: string;
}

export async function getServerSession(): Promise<SessionData | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('session-token')?.value;

  if (!token) return null;

  // Check Redis first
  const cached = await redis.get(CacheKeys.session(token));
  if (cached) {
    const session = JSON.parse(cached) as SessionData;
    if (new Date(session.expiresAt) > new Date()) {
      return session;
    }
    // Expired -- clean up
    await redis.del(CacheKeys.session(token));
    return null;
  }

  // Fallback to DB
  const dbSession = await prisma.session.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!dbSession || dbSession.expiresAt < new Date()) {
    return null;
  }

  // Re-populate Redis cache
  const sessionData: SessionData = {
    id: dbSession.id,
    userId: dbSession.userId,
    user: {
      id: dbSession.user.id,
      address: dbSession.user.address,
      displayName: dbSession.user.displayName,
    },
    expiresAt: dbSession.expiresAt.toISOString(),
  };

  await redis.set(
    CacheKeys.session(token),
    JSON.stringify(sessionData),
    'EX',
    Math.floor((dbSession.expiresAt.getTime() - Date.now()) / 1000)
  );

  return sessionData;
}
```

### 10.2 Credential Encryption

Polymarket API keys and secrets are encrypted at rest using AES-256-GCM. The encryption key is stored in an environment variable, never in the database.

```typescript
// lib/auth/crypto.ts
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex'); // 32 bytes

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  // Format: iv:authTag:ciphertext
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decrypt(encrypted: string): string {
  const [ivHex, authTagHex, ciphertext] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
```

Generate the encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Add to .env as ENCRYPTION_KEY=<output>
```

### 10.3 Rate Limiting

```typescript
// lib/middleware/rate-limit.ts
import { redis } from '@/lib/cache/redis';
import { CacheKeys } from '@/lib/cache/keys';

interface RateLimitConfig {
  max: number;
  window: string;   // e.g. "1m", "1h", "1d"
}

function parseWindow(window: string): number {
  const unit = window.slice(-1);
  const value = parseInt(window.slice(0, -1), 10);
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return 60;
  }
}

export async function rateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<boolean> {
  const windowSeconds = parseWindow(config.window);
  const key = CacheKeys.rateLimit(identifier, config.window);

  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, windowSeconds);
  }

  return current <= config.max;
}
```

### 10.4 CORS & Security Headers in Middleware

```typescript
// middleware.ts (updated from section 2)
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Version redirect
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/v1/')) {
    const newUrl = request.nextUrl.clone();
    newUrl.pathname = pathname.replace('/api/', '/api/v1/');
    return NextResponse.rewrite(newUrl);
  }

  const requestId = crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set('x-request-id', requestId);

  const response = NextResponse.next({ request: { headers } });

  // Security headers
  response.headers.set('x-request-id', requestId);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
  );

  // CORS for API routes
  if (pathname.startsWith('/api/')) {
    const origin = request.headers.get('origin');
    const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(',');

    if (origin && allowedOrigins.includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      response.headers.set('Access-Control-Allow-Credentials', 'true');
      response.headers.set('Access-Control-Max-Age', '86400');
    }
  }

  return response;
}

export const config = {
  matcher: ['/api/:path*', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

### 10.5 Environment Variables

```bash
# .env.local (never committed)

# Database
DATABASE_URL="postgresql://polybot:password@localhost:5432/polybot"

# Redis
REDIS_URL="redis://localhost:6379"

# Auth
ENCRYPTION_KEY="<64-hex-char-key>"    # For encrypting Polymarket credentials
SESSION_SECRET="<random-string>"

# Polymarket -- stored per-user in DB, but operator can set defaults
POLYMARKET_CLOB_URL="https://clob.polymarket.com"
POLYMARKET_GAMMA_URL="https://gamma-api.polymarket.com"
POLYMARKET_DATA_URL="https://data-api.polymarket.com"
POLYMARKET_WS_URL="wss://ws-subscriptions-clob.polymarket.com/ws/"
POLYMARKET_CHAIN_ID="137"

# Sentry
SENTRY_DSN="https://xxx@sentry.io/xxx"

# CORS
ALLOWED_ORIGINS="http://localhost:3000"

# Logging
LOG_LEVEL="info"
```

---

## 11. Testing Strategy

### 11.1 Test Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['app/api/**', 'lib/**', 'app/actions/**'],
      exclude: ['node_modules', 'tests', '*.config.*'],
    },
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
```

```typescript
// tests/setup.ts
import { beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@/lib/db/prisma';

beforeAll(async () => {
  // Ensure test database is available
  // Use a separate test database configured via TEST_DATABASE_URL
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
    ?? 'postgresql://polybot:password@localhost:5432/polybot_test';
});

beforeEach(async () => {
  // Clean all tables before each test
  const tablenames = await prisma.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public'`;

  for (const { tablename } of tablenames) {
    if (tablename !== '_prisma_migrations') {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "public"."${tablename}" CASCADE;`
      );
    }
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});
```

### 11.2 Unit Tests for API Routes

```typescript
// tests/api/markets.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/v1/markets/route';
import { NextRequest } from 'next/server';

// Mock the database queries
vi.mock('@/lib/db/queries/markets', () => ({
  searchMarkets: vi.fn().mockResolvedValue({
    data: [
      {
        id: 'market-1',
        polymarketId: 'cond-1',
        question: 'Will BTC reach $100k?',
        status: 'active',
        volume: 5000000,
        liquidity: 250000,
        outcomes: [
          { tokenId: 'tok-yes', outcome: 'Yes', price: 0.65 },
          { tokenId: 'tok-no', outcome: 'No', price: 0.35 },
        ],
      },
    ],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
  }),
}));

// Mock auth (markets endpoint is public)
vi.mock('@/lib/auth/session', () => ({
  getServerSession: vi.fn().mockResolvedValue(null),
}));

describe('GET /api/v1/markets', () => {
  it('returns paginated market list', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/markets?page=1&limit=20');
    const response = await GET(req, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.data).toHaveLength(1);
    expect(body.data.data[0].question).toBe('Will BTC reach $100k?');
    expect(body.data.pagination.total).toBe(1);
  });

  it('passes search filters to query', async () => {
    const { searchMarkets } = await import('@/lib/db/queries/markets');
    const req = new NextRequest(
      'http://localhost:3000/api/v1/markets?search=bitcoin&category=Crypto&status=active'
    );
    await GET(req, { params: Promise.resolve({}) });

    expect(searchMarkets).toHaveBeenCalledWith(
      expect.objectContaining({
        search: 'bitcoin',
        category: 'Crypto',
        status: 'active',
      })
    );
  });
});
```

```typescript
// tests/api/orders.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, GET } from '@/app/api/v1/orders/route';
import { NextRequest } from 'next/server';

const mockSession = {
  user: { id: 'user-1', address: '0xabc', displayName: 'Test' },
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
};

vi.mock('@/lib/auth/session', () => ({
  getServerSession: vi.fn().mockResolvedValue(mockSession),
}));

vi.mock('@/lib/db/queries/orders', () => ({
  placeOrder: vi.fn().mockResolvedValue({
    orderId: 'order-1',
    polymarketOrderId: 'pm-order-1',
    status: 'open',
    fills: [],
    errorMsg: null,
  }),
  listOrders: vi.fn().mockResolvedValue({
    data: [],
    pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
  }),
}));

vi.mock('@/lib/logging/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/middleware/rate-limit', () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
}));

describe('POST /api/v1/orders', () => {
  it('creates an order with valid input', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/orders', {
      method: 'POST',
      body: JSON.stringify({
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        type: 'GTC',
        price: 0.65,
        size: 100,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(req, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.orderId).toBe('order-1');
  });

  it('rejects invalid order with 400', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/orders', {
      method: 'POST',
      body: JSON.stringify({
        marketId: 'market-1',
        // Missing required fields
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const { getServerSession } = await import('@/lib/auth/session');
    vi.mocked(getServerSession).mockResolvedValueOnce(null);

    const req = new NextRequest('http://localhost:3000/api/v1/orders', {
      method: 'POST',
      body: JSON.stringify({
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        type: 'GTC',
        price: 0.65,
        size: 100,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(401);
  });
});
```

### 11.3 Integration Tests with Test Database

```typescript
// tests/integration/portfolio.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { getPortfolioStats } from '@/lib/db/queries/portfolio';

describe('Portfolio queries (integration)', () => {
  let userId: string;

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { address: '0xtest123' },
    });
    userId = user.id;

    const market = await prisma.market.create({
      data: {
        polymarketId: 'test-market-1',
        question: 'Test market?',
        status: 'active',
        volume: 1000,
        liquidity: 500,
      },
    });

    // Create a position
    await prisma.position.create({
      data: {
        userId,
        marketId: market.id,
        tokenId: 'tok-1',
        outcome: 'Yes',
        side: 'LONG',
        size: 100,
        averageEntryPrice: 0.5,
        status: 'open',
      },
    });

    // Create trades
    const order = await prisma.order.create({
      data: {
        userId,
        marketId: market.id,
        tokenId: 'tok-1',
        side: 'BUY',
        type: 'GTC',
        price: 0.5,
        size: 100,
        remainingSize: 0,
        filledSize: 100,
        status: 'filled',
      },
    });

    await prisma.trade.create({
      data: {
        userId,
        orderId: order.id,
        marketId: market.id,
        tokenId: 'tok-1',
        side: 'BUY',
        price: 0.5,
        size: 100,
        fee: 0.5,
      },
    });
  });

  it('calculates portfolio stats correctly', async () => {
    const stats = await getPortfolioStats(userId);

    expect(stats).toBeDefined();
    expect(stats.openPositions).toBe(1);
    expect(stats.totalTrades).toBe(1);
  });
});
```

### 11.4 Mocking Polymarket API with MSW

```typescript
// tests/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

export const handlers = [
  // Gamma API - List markets
  http.get(`${GAMMA_API}/markets`, () => {
    return HttpResponse.json([
      {
        conditionId: 'cond-btc-100k',
        question: 'Will BTC reach $100k?',
        description: 'Bitcoin price prediction market',
        category: 'Crypto',
        active: true,
        volume: 5000000,
        liquidity: 250000,
        clobTokenIds: ['tok-btc-yes', 'tok-btc-no'],
        image: 'https://example.com/btc.png',
        slug: 'btc-100k',
      },
    ]);
  }),

  // CLOB API - Price
  http.get(`${CLOB_API}/price/:tokenId`, ({ params }) => {
    return HttpResponse.json({
      price: 0.65,
      timestamp: new Date().toISOString(),
    });
  }),

  // CLOB API - Order book
  http.get(`${CLOB_API}/orderbook/:tokenId`, ({ params }) => {
    return HttpResponse.json({
      bids: [
        { price: 0.64, size: 500 },
        { price: 0.63, size: 1000 },
      ],
      asks: [
        { price: 0.66, size: 400 },
        { price: 0.67, size: 800 },
      ],
    });
  }),

  // CLOB API - Place order
  http.post(`${CLOB_API}/orders`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({
      success: true,
      orderId: `pm-order-${Date.now()}`,
      orderHashes: [],
      errorMsg: '',
    });
  }),

  // CLOB API - Cancel order
  http.post(`${CLOB_API}/orders/:id/cancel`, ({ params }) => {
    return HttpResponse.json({ success: true });
  }),
];
```

```typescript
// tests/mocks/server.ts
import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
```

```typescript
// tests/setup.ts (updated)
import { beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { server } from './mocks/server';
import { prisma } from '@/lib/db/prisma';

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'warn' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

// ... database cleanup as shown above
```

### 11.5 E2E Testing with Playwright

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    port: 3000,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

```typescript
// tests/e2e/dashboard.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test('renders dashboard with stats cards', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('Dashboard')).toBeVisible();
    await expect(page.getByText('Total Bets')).toBeVisible();
    await expect(page.getByText('Active Bets')).toBeVisible();
    await expect(page.getByText('Win Rate')).toBeVisible();
  });

  test('sidebar navigation works', async ({ page }) => {
    await page.goto('/');

    await page.click('text=Bets');
    await expect(page).toHaveURL('/bets');
    await expect(page.getByText('View and manage your bets')).toBeVisible();

    await page.click('text=Settings');
    await expect(page).toHaveURL('/settings');
    await expect(page.getByText('Configure your bot settings')).toBeVisible();
  });

  test('theme toggle works', async ({ page }) => {
    await page.goto('/');

    const html = page.locator('html');
    await expect(html).not.toHaveClass(/dark/);

    await page.click('[aria-label="Toggle theme"]');
    await expect(html).toHaveClass(/dark/);

    await page.click('[aria-label="Toggle theme"]');
    await expect(html).not.toHaveClass(/dark/);
  });
});
```

```typescript
// tests/e2e/orders.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Order Placement', () => {
  test.beforeEach(async ({ page }) => {
    // Mock authenticated session via cookie
    await page.context().addCookies([
      {
        name: 'session-token',
        value: 'test-session-token',
        domain: 'localhost',
        path: '/',
      },
    ]);
  });

  test('can navigate to market and see order form', async ({ page }) => {
    await page.goto('/markets');
    // Click first market card
    await page.click('[data-testid="market-card"]');
    await expect(page.getByText('Place Order')).toBeVisible();
  });
});
```

### 11.6 Test Scripts in package.json

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:all": "vitest run && playwright test"
  }
}
```

---

## Appendix: Complete .env.example

```bash
# ─── Database ───────────────────────────────
DATABASE_URL="postgresql://polybot:password@localhost:5432/polybot"
TEST_DATABASE_URL="postgresql://polybot:password@localhost:5432/polybot_test"

# ─── Redis ──────────────────────────────────
REDIS_URL="redis://localhost:6379"

# ─── Encryption ─────────────────────────────
ENCRYPTION_KEY=""  # Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ─── Session ────────────────────────────────
SESSION_SECRET=""  # Any random string

# ─── Polymarket API URLs ────────────────────
POLYMARKET_CLOB_URL="https://clob.polymarket.com"
POLYMARKET_GAMMA_URL="https://gamma-api.polymarket.com"
POLYMARKET_DATA_URL="https://data-api.polymarket.com"
POLYMARKET_WS_URL="wss://ws-subscriptions-clob.polymarket.com/ws/"
POLYMARKET_CHAIN_ID="137"

# ─── Monitoring ─────────────────────────────
SENTRY_DSN=""
LOG_LEVEL="info"  # debug | info | warn | error

# ─── CORS ───────────────────────────────────
ALLOWED_ORIGINS="http://localhost:3000"

# ─── Node ───────────────────────────────────
NODE_ENV="development"
```
