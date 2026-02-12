# Auto Poly Bet Bot -- Technical Architecture Document

> **Version:** 1.0.0
> **Date:** 2026-02-10
> **Status:** Design Phase
> **Existing Stack:** Next.js 15, React 19, Tailwind CSS, HeroUI, Zustand, TypeScript

---

## Table of Contents

1. [System Overview & High-Level Architecture](#1-system-overview--high-level-architecture)
2. [Core System Components](#2-core-system-components)
3. [Data Architecture](#3-data-architecture)
4. [Integration Architecture](#4-integration-architecture)
5. [Bot Engine Architecture](#5-bot-engine-architecture)
6. [Infrastructure & DevOps](#6-infrastructure--devops)
7. [Security Architecture](#7-security-architecture)
8. [Scalability Considerations](#8-scalability-considerations)

---

## 1. System Overview & High-Level Architecture

### 1.1 Monorepo Structure (Turborepo)

**Decision: Monorepo using Turborepo.**

A monorepo is the correct choice for this project because the web dashboard, API layer, and bot engine share significant TypeScript types (market models, order types, strategy interfaces) and utility code. Keeping them in a single repository eliminates version drift between shared contracts, simplifies atomic refactors, and allows a single CI pipeline.

We avoid a microservices split at this stage. The operational overhead of separate deployments, service discovery, and distributed tracing is not justified until the system proves product-market fit and reaches a scale where independent scaling of components becomes necessary.

```
auto-poly-bet-bot/
├── apps/
│   ├── web/                    # Next.js dashboard (existing code migrated here)
│   │   ├── app/                # Next.js App Router pages
│   │   ├── components/         # React components (Header, Sidebar, etc.)
│   │   ├── store/              # Zustand stores
│   │   └── next.config.js
│   └── bot/                    # Bot engine (standalone Node.js process)
│       ├── src/
│       │   ├── engine/         # Core bot engine loop
│       │   ├── strategies/     # Pluggable strategy implementations
│       │   ├── risk/           # Risk management module
│       │   ├── execution/      # Order execution & lifecycle
│       │   ├── data/           # Market data ingestion pipelines
│       │   └── backtest/       # Backtesting framework
│       └── tsconfig.json
├── packages/
│   ├── shared/                 # Shared types, constants, utilities
│   │   ├── src/
│   │   │   ├── types/          # Market, Order, Position, Strategy types
│   │   │   ├── constants/      # API endpoints, enums, limits
│   │   │   └── utils/          # Formatting, math, validation helpers
│   │   └── package.json
│   ├── polymarket-client/      # Polymarket API client wrapper
│   │   ├── src/
│   │   │   ├── rest/           # REST API methods (CLOB, Gamma, Data)
│   │   │   ├── ws/             # WebSocket connection manager
│   │   │   ├── auth/           # L1/L2 authentication
│   │   │   └── types/          # API-specific request/response types
│   │   └── package.json
│   ├── db/                     # Database client, migrations, seed
│   │   ├── src/
│   │   │   ├── schema/         # Drizzle ORM schema definitions
│   │   │   ├── migrations/     # SQL migration files
│   │   │   └── client.ts       # Database connection singleton
│   │   └── package.json
│   └── config/                 # Shared ESLint, TSConfig, Tailwind presets
│       ├── eslint-preset.js
│       └── tsconfig.base.json
├── turbo.json
├── package.json                # Root workspace config
└── docker-compose.yml          # Local dev: Postgres, Redis, TimescaleDB
```

**Justification for Turborepo over Nx:** Turborepo is lighter-weight, has first-class Next.js support (both from Vercel), and its remote caching integrates natively with Vercel deployments. Nx is more powerful for very large monorepos, but that power brings configuration complexity we do not need.

### 1.2 Monolith-First with Modular Boundaries

**Decision: Modular monolith with a clear extraction path.**

The bot engine runs as a single long-lived Node.js process (`apps/bot`) rather than a collection of microservices. Internally, it is composed of well-defined modules (strategy engine, risk manager, order executor, data pipeline) that communicate through an in-process event emitter. Each module has a clean interface boundary so that any one of them can be extracted into a standalone service later if scaling demands it.

Why not microservices now:
- A betting bot is latency-sensitive; inter-process network hops add milliseconds that matter.
- The team size does not justify the operational cost of distributed systems.
- Shared state (current positions, open orders, account balance) is needed by multiple modules simultaneously; distributing this state introduces consistency problems.

### 1.3 Architecture Diagram (Component & Data Flow)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         EXTERNAL SERVICES                           │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │ Polymarket   │  │ Polymarket   │  │ External Data Sources     │ │
│  │ CLOB REST    │  │ CLOB WSS     │  │ (News, Polling, Social)   │ │
│  │ + Gamma API  │  │              │  │                           │ │
│  │ + Data API   │  │              │  │                           │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────────┘ │
│         │                 │                       │                 │
│  ┌──────┴───────┐         │              ┌────────┴──────────┐     │
│  │ Polygon      │         │              │ Blockchain RPCs   │     │
│  │ Network      │         │              │ (Alchemy/Infura)  │     │
│  └──────────────┘         │              └───────────────────┘     │
└─────────────────────┬─────┴──────────────────────┬──────────────────┘
                      │                            │
┌─────────────────────┴────────────────────────────┴──────────────────┐
│                      POLYMARKET CLIENT PACKAGE                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────────┐  │
│  │  REST Client    │  │  WS Manager     │  │  Auth Module       │  │
│  │  (CLOB/Gamma/   │  │  (reconnection, │  │  (L1 key signing,  │  │
│  │   Data APIs)    │  │   heartbeat)    │  │   L2 HMAC-SHA256)  │  │
│  └────────┬────────┘  └────────┬────────┘  └────────────────────┘  │
└───────────┼─────────────────────┼───────────────────────────────────┘
            │                     │
            │  ┌──────────────────┤
            │  │                  │
┌───────────┴──┴──────────────────┴───────────────────────────────────┐
│                        BOT ENGINE (apps/bot)                         │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Data Pipeline │  │ Strategy     │  │ Risk Manager             │  │
│  │              │  │ Engine       │  │                          │  │
│  │ - Market     │  │              │  │ - Position limits        │  │
│  │   snapshots  │  │ - Strategy   │  │ - Drawdown controls      │  │
│  │ - News feed  │  │   registry   │  │ - Exposure limits        │  │
│  │ - Sentiment  │  │ - Signal     │  │ - Correlation checks     │  │
│  │ - On-chain   │  │   generation │  │ - Kill switch            │  │
│  │   data       │  │ - Backtest   │  │                          │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │
│         │                 │                        │                │
│         │    ┌────────────┴────────────┐           │                │
│         │    │ Event Bus (EventEmitter) │◄──────────┘                │
│         │    └────────────┬────────────┘                            │
│         │                 │                                          │
│  ┌──────┴─────────────────┴──────────────────────────────────────┐  │
│  │                   Order Executor                               │  │
│  │  - Order creation (GTC, FOK, GTD)                              │  │
│  │  - Order monitoring (fill tracking, partial fills)             │  │
│  │  - Cancellation logic                                          │  │
│  │  - Batch order submission                                      │  │
│  └───────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
┌───────────┴──────┐ ┌────────┴────────┐ ┌───────┴──────────┐
│   PostgreSQL     │ │   Redis         │ │  TimescaleDB     │
│                  │ │                 │ │  (extension)     │
│ - Trades         │ │ - Session cache │ │                  │
│ - Orders         │ │ - Rate limiting │ │ - Price ticks    │
│ - Strategies     │ │ - Bot state     │ │ - PnL series     │
│ - Users          │ │ - Pub/Sub for   │ │ - Market         │
│ - Audit log      │ │   dashboard     │ │   snapshots      │
│ - Alerts         │ │ - Order book    │ │                  │
│                  │ │   cache         │ │                  │
└──────────────────┘ └────────┬────────┘ └──────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │ Redis Pub/Sub     │
                    │ (bot -> dashboard │
                    │  real-time events)│
                    └─────────┬─────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────────┐
│                    WEB DASHBOARD (apps/web)                          │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │               Next.js API Routes (/api/*)                      │ │
│  │                                                                │ │
│  │  /api/markets     - Market list + search                       │ │
│  │  /api/positions   - Current positions                          │ │
│  │  /api/orders      - Order history + management                 │ │
│  │  /api/strategies  - CRUD strategies + activate/deactivate      │ │
│  │  /api/bot         - Start/stop/status of bot engine            │ │
│  │  /api/risk        - Risk parameters + current exposure         │ │
│  │  /api/backtest    - Trigger + retrieve backtest results        │ │
│  │  /api/alerts      - Alert configuration + history              │ │
│  │  /api/ws          - Server-Sent Events for real-time updates   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │               React Frontend (App Router)                      │ │
│  │                                                                │ │
│  │  /              - Dashboard (PnL, active positions, alerts)    │ │
│  │  /markets       - Market browser + search                      │ │
│  │  /bets          - Active & historical bets                     │ │
│  │  /strategies    - Strategy management                          │ │
│  │  /backtest      - Backtesting interface                        │ │
│  │  /risk          - Risk dashboard                               │ │
│  │  /settings      - Bot config, API keys, preferences            │ │
│  │  /logs          - Activity log / audit trail viewer             │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core System Components

### 2.1 Web Dashboard (apps/web)

The existing Next.js application serves as the monitoring and control interface. It is a read-heavy, event-driven dashboard that visualizes bot state and allows operator intervention.

**Technology choices already in place:**
- **Next.js 15 (App Router)** -- Server Components for initial page loads, Client Components for interactive widgets.
- **Tailwind CSS** -- Utility-first styling.
- **HeroUI** -- Component library for consistent UI elements (Cards, Buttons, Inputs, Tables, Modals).
- **Zustand** -- Lightweight client-side state management.

**Additional frontend libraries to add:**
| Library | Purpose | Justification |
|---------|---------|---------------|
| `recharts` | Charts (PnL curves, price history, portfolio allocation) | Lightweight, composable, React-native. Lighter than Victory or Nivo for our use case. |
| `@tanstack/react-query` | Server state management, data fetching, cache invalidation | Zustand handles UI state (theme, sidebar); React Query handles server state (positions, orders). Clear separation of concerns. |
| `react-hot-toast` | Notifications for trade events, alerts | Minimal bundle, great DX. |
| `date-fns` | Date formatting and manipulation | Tree-shakeable, no mutable global state (unlike Moment). |
| `zod` | Runtime type validation for forms and API responses | Already in the TypeScript ecosystem; works seamlessly with React Hook Form. |

**Page structure (expanding existing routes):**

```
app/
├── page.tsx                    # Dashboard home (exists, needs expansion)
├── markets/
│   ├── page.tsx                # Market browser with search/filter
│   └── [conditionId]/
│       └── page.tsx            # Single market detail + order placement
├── bets/
│   └── page.tsx                # Active & historical bets (exists, needs data)
├── strategies/
│   ├── page.tsx                # List all strategies with status toggles
│   ├── new/
│   │   └── page.tsx            # Strategy creation wizard
│   └── [strategyId]/
│       └── page.tsx            # Strategy detail + performance metrics
├── backtest/
│   ├── page.tsx                # Backtest runner interface
│   └── [runId]/
│       └── page.tsx            # Backtest results visualization
├── risk/
│   └── page.tsx                # Risk dashboard (exposure, drawdown, limits)
├── logs/
│   └── page.tsx                # Audit trail + activity log
├── settings/
│   └── page.tsx                # Settings (exists, needs expansion)
└── api/
    ├── markets/
    │   └── route.ts            # GET: proxies Gamma/CLOB market data
    ├── positions/
    │   └── route.ts            # GET: current positions from DB + Polymarket
    ├── orders/
    │   ├── route.ts            # GET: order history; POST: manual order
    │   └── [orderId]/
    │       └── route.ts        # GET: order detail; DELETE: cancel order
    ├── strategies/
    │   ├── route.ts            # GET: list; POST: create
    │   └── [strategyId]/
    │       └── route.ts        # GET/PUT/DELETE + POST activate/deactivate
    ├── bot/
    │   └── route.ts            # GET status; POST start/stop/restart
    ├── backtest/
    │   ├── route.ts            # POST: trigger backtest run
    │   └── [runId]/
    │       └── route.ts        # GET: backtest results
    ├── risk/
    │   └── route.ts            # GET: current risk metrics; PUT: update limits
    ├── alerts/
    │   └── route.ts            # GET/POST/DELETE alert configurations
    └── events/
        └── route.ts            # SSE endpoint for real-time dashboard updates
```

**Real-time updates strategy:**

Server-Sent Events (SSE) via a Next.js API route (`/api/events`) rather than a raw WebSocket from the frontend. Rationale:
- SSE works over standard HTTP, which Vercel supports natively.
- The dashboard is read-only for real-time data (it receives updates, it does not send a stream of messages back). SSE is purpose-built for this unidirectional pattern.
- The bot engine publishes events to Redis Pub/Sub; the SSE endpoint subscribes and forwards them to the browser.

### 2.2 API Layer

The API layer uses Next.js Route Handlers (the `app/api/` directory) rather than a separate Express/Fastify server. This decision keeps the deployment simple (one Next.js app on Vercel or a single Docker container) and avoids CORS configuration between frontend and backend.

**API design principles:**
- **RESTful conventions** with JSON request/response bodies.
- **No GraphQL.** The data access patterns for a trading dashboard are well-defined and do not benefit from GraphQL's flexibility. REST is simpler to cache, easier to debug, and has lower latency per request.
- **Zod validation** on every incoming request body via a shared middleware pattern.
- **Consistent error response format:**

```typescript
// packages/shared/src/types/api.ts
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;       // Machine-readable: "INSUFFICIENT_BALANCE", "STRATEGY_NOT_FOUND"
    message: string;    // Human-readable description
    details?: unknown;  // Optional validation errors, stack trace in dev
  };
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    timestamp: number;
  };
}
```

**Communication between dashboard and bot engine:**

The bot engine is a separate process (possibly on a separate server). The dashboard API routes do not call the bot engine directly via HTTP. Instead:

1. **Commands (dashboard -> bot):** The API route writes a command to a Redis list (`bot:commands`). The bot engine polls this list. Commands include `start_strategy`, `stop_strategy`, `cancel_order`, `update_risk_params`.
2. **State queries (dashboard <- bot):** The bot engine writes its current state to Redis keys (`bot:status`, `bot:positions`, `bot:orders:open`). The API route reads these keys.
3. **Events (bot -> dashboard):** The bot publishes events to Redis Pub/Sub channel `bot:events`. The SSE endpoint subscribes and streams to the browser.

This Redis-mediated communication pattern decouples the two processes completely. Either can restart independently without breaking the other.

### 2.3 Bot Engine (apps/bot)

The bot engine is the core of the system -- a long-running Node.js process that executes trading strategies against Polymarket's CLOB.

**Runtime choice: Node.js (not Python).**

Although Polymarket provides an official `py-clob-client`, we build the bot in TypeScript/Node.js for these reasons:
- The entire stack is TypeScript, enabling shared types across dashboard, API, and bot.
- Node.js's event loop is well-suited for I/O-bound work (API calls, WebSocket subscriptions).
- The `viem` library provides best-in-class TypeScript support for Ethereum/Polygon interactions.
- We build our own TypeScript CLOB client in `packages/polymarket-client` using the REST/WSS specifications directly, which gives us full control over retry logic, error handling, and typing.

**Engine lifecycle:**

```
┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  INIT   │───>│ LOADING  │───>│ RUNNING  │───>│ STOPPING │───> EXIT
│         │    │          │    │          │    │          │
│ Parse   │    │ Load     │    │ Main     │    │ Cancel   │
│ config, │    │ strats,  │    │ loop,    │    │ orders,  │
│ connect │    │ restore  │    │ process  │    │ persist  │
│ to DB,  │    │ state    │    │ signals, │    │ state,   │
│ Redis,  │    │ from DB  │    │ execute  │    │ close    │
│ WSS     │    │ + Redis  │    │ orders   │    │ conns    │
└─────────┘    └──────────┘    └──────────┘    └──────────┘
                                    │
                                    │ on error
                                    ▼
                              ┌──────────┐
                              │ RECOVERY │
                              │          │
                              │ Log err, │
                              │ check    │
                              │ positions│
                              │ resume   │
                              └──────────┘
```

**Main loop (simplified):**

```typescript
// apps/bot/src/engine/engine.ts
class BotEngine {
  private strategies: Map<string, StrategyRunner> = new Map();
  private riskManager: RiskManager;
  private orderExecutor: OrderExecutor;
  private dataManager: DataManager;
  private eventBus: EventEmitter;

  async run(): Promise<void> {
    await this.initialize();

    // Main loop runs on a configurable tick interval (default: 1 second)
    while (this.state === EngineState.RUNNING) {
      await this.tick();
      await sleep(this.config.tickIntervalMs);
    }
  }

  private async tick(): Promise<void> {
    // 1. Process incoming commands from Redis
    await this.processCommands();

    // 2. Update market data snapshot
    const snapshot = await this.dataManager.getLatestSnapshot();

    // 3. Run each active strategy
    for (const [id, runner] of this.strategies) {
      if (runner.status !== 'active') continue;

      const signals = await runner.evaluate(snapshot);

      for (const signal of signals) {
        // 4. Risk check each signal
        const approved = this.riskManager.check(signal);
        if (!approved.pass) {
          this.eventBus.emit('signal:rejected', { signal, reason: approved.reason });
          continue;
        }

        // 5. Execute approved signals
        await this.orderExecutor.execute(signal);
      }
    }

    // 6. Monitor open orders (fills, cancellations, expirations)
    await this.orderExecutor.monitorOpenOrders();

    // 7. Publish state to Redis for dashboard
    await this.publishState();
  }
}
```

### 2.4 Data Pipeline

The data pipeline is responsible for ingesting, normalizing, and storing all data the bot needs for decision-making.

**Data sources and ingestion methods:**

| Source | Data Type | Ingestion Method | Frequency |
|--------|-----------|-----------------|-----------|
| Polymarket CLOB REST | Market list, order books, prices | Polling (REST) | Every 5s for active markets |
| Polymarket CLOB WSS | Real-time price updates, trade feed | WebSocket subscription | Continuous |
| Polymarket Gamma API | Market metadata, categories, descriptions | Polling (REST) | Every 5 min |
| Polymarket Data API | User positions, trade history | Polling (REST) | Every 30s |
| News APIs (NewsAPI, GDELT) | News articles, headlines | Polling (REST) | Every 2 min |
| Social media (Twitter/X API) | Sentiment signals | Polling (REST) | Every 5 min |
| Polygon RPC (Alchemy) | On-chain events, USDC balance, CTF contract events | WebSocket + polling | Continuous + every 30s |
| Polling aggregators | Political polling data | Polling (REST) | Every 30 min |

**Data pipeline architecture inside the bot:**

```typescript
// apps/bot/src/data/DataManager.ts
class DataManager {
  private providers: DataProvider[] = [];
  private cache: MarketDataCache;  // In-memory + Redis backed

  // Register data providers
  register(provider: DataProvider): void {
    this.providers.push(provider);
  }

  // Each provider implements:
  interface DataProvider {
    name: string;
    type: 'polling' | 'streaming';
    start(): Promise<void>;
    stop(): Promise<void>;
    getLatest(): MarketSnapshot;
  }
}
```

### 2.5 Database Layer

Detailed in Section 3 below.

### 2.6 Message Queue / Event Bus

**In-process:** Node.js `EventEmitter` with typed events for module-to-module communication within the bot engine. We use a typed wrapper:

```typescript
// packages/shared/src/types/events.ts
interface BotEvents {
  'signal:generated': { strategyId: string; signal: TradingSignal };
  'signal:rejected': { signal: TradingSignal; reason: string };
  'order:created': { order: Order };
  'order:filled': { order: Order; fill: Fill };
  'order:cancelled': { order: Order; reason: string };
  'position:updated': { position: Position };
  'risk:alert': { alert: RiskAlert };
  'risk:kill-switch': { reason: string };
  'engine:state-change': { from: EngineState; to: EngineState };
  'error:critical': { error: Error; context: string };
}

class TypedEventBus extends EventEmitter {
  emit<K extends keyof BotEvents>(event: K, data: BotEvents[K]): boolean;
  on<K extends keyof BotEvents>(event: K, listener: (data: BotEvents[K]) => void): this;
}
```

**Cross-process (bot <-> dashboard):** Redis Pub/Sub on channel `bot:events`. The bot serializes events to JSON and publishes; the dashboard API's SSE endpoint subscribes.

**Why not RabbitMQ/Kafka:** Overkill for a single-bot system. Redis is already required for caching and state; its Pub/Sub is sufficient for our throughput (hundreds of events per minute, not millions). If we later need guaranteed delivery or event replay, we add a persistent event log table in PostgreSQL rather than introducing a full message broker.

### 2.7 Scheduler / Cron

**Library: `node-cron`** (within the bot engine process) combined with a lightweight task registry.

| Task | Schedule | Description |
|------|----------|-------------|
| `market-refresh` | Every 5 min | Re-fetch full market list from Gamma API, update DB |
| `position-reconciliation` | Every 1 min | Compare in-memory positions with on-chain + API state |
| `daily-pnl-snapshot` | Daily 00:00 UTC | Snapshot portfolio value, compute daily PnL |
| `strategy-rebalance-check` | Every 15 min | Check if any strategy needs position rebalancing |
| `stale-order-cleanup` | Every 2 min | Cancel orders older than configured TTL |
| `data-compaction` | Daily 03:00 UTC | Compress old time-series data, archive old logs |
| `health-check` | Every 30s | Verify all connections (DB, Redis, WSS, RPC) are alive |
| `report-generation` | Daily 08:00 UTC | Generate daily performance report, store in DB |

```typescript
// apps/bot/src/scheduler/Scheduler.ts
import cron from 'node-cron';

class Scheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();

  register(name: string, schedule: string, handler: () => Promise<void>): void {
    const task = cron.schedule(schedule, async () => {
      const start = Date.now();
      try {
        await handler();
        logger.info(`Task ${name} completed in ${Date.now() - start}ms`);
      } catch (err) {
        logger.error(`Task ${name} failed`, err);
        this.eventBus.emit('error:task', { task: name, error: err });
      }
    });
    this.tasks.set(name, task);
  }

  stopAll(): void {
    for (const [name, task] of this.tasks) {
      task.stop();
    }
  }
}
```

---

## 3. Data Architecture

### 3.1 Database Choice: PostgreSQL + TimescaleDB Extension + Redis

**PostgreSQL (primary relational store):**
- Stores all transactional data: orders, trades, positions, strategies, users, audit logs, alerts.
- ACID compliance is non-negotiable for financial data -- we need to trust that trade records are never lost or duplicated.
- JSONB columns for flexible data (strategy parameters, market metadata) without sacrificing query performance.
- Drizzle ORM for type-safe schema definitions, migrations, and queries -- chosen over Prisma because Drizzle generates leaner SQL, supports raw queries easily, and has better support for advanced PostgreSQL features (JSONB operators, CTEs, window functions).

**TimescaleDB (time-series extension on the same PostgreSQL instance):**
- Installed as a PostgreSQL extension rather than a separate database -- zero operational overhead.
- Hypertables for time-series data: price ticks, PnL snapshots, market volume history.
- Automatic data compression for older data (compress chunks older than 7 days).
- Continuous aggregates for pre-computed rollups (1-min, 5-min, 1-hour, 1-day candles).
- Retention policies to drop raw tick data older than 90 days (aggregates are kept indefinitely).

**Redis (cache, state, pub/sub):**
- **Caching:** Market data, order book snapshots (TTL: 5-30 seconds). Prevents hammering Polymarket APIs.
- **Rate limiting:** Token bucket per API endpoint using Redis atomic operations.
- **Bot state:** Current engine state, active strategies, open orders. Allows dashboard to read without querying bot process directly.
- **Pub/Sub:** Real-time event forwarding from bot to dashboard.
- **Session data:** Dashboard authentication sessions.

### 3.2 Schema Design (Drizzle ORM)

```typescript
// packages/db/src/schema/markets.ts
import { pgTable, text, numeric, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core';

export const markets = pgTable('markets', {
  id: text('id').primaryKey(),                              // Polymarket condition_id
  question: text('question').notNull(),
  description: text('description'),
  category: text('category'),
  endDate: timestamp('end_date'),
  active: boolean('active').default(true),
  closed: boolean('closed').default(false),
  tokens: jsonb('tokens').$type<MarketToken[]>(),           // [{token_id, outcome, price}]
  volume: numeric('volume', { precision: 20, scale: 6 }),
  liquidity: numeric('liquidity', { precision: 20, scale: 6 }),
  metadata: jsonb('metadata'),                               // Raw Gamma API response
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  categoryIdx: index('idx_markets_category').on(table.category),
  activeIdx: index('idx_markets_active').on(table.active),
  endDateIdx: index('idx_markets_end_date').on(table.endDate),
}));

// packages/db/src/schema/strategies.ts
export const strategies = pgTable('strategies', {
  id: text('id').primaryKey(),                               // UUID
  name: text('name').notNull(),
  type: text('type').notNull(),                              // 'value', 'momentum', 'arbitrage', 'news_sentiment', etc.
  status: text('status').notNull().default('inactive'),      // 'active', 'inactive', 'paused', 'error'
  config: jsonb('config').$type<StrategyConfig>().notNull(), // Strategy-specific parameters
  riskParams: jsonb('risk_params').$type<RiskParams>(),      // Per-strategy risk overrides
  marketFilters: jsonb('market_filters').$type<MarketFilter[]>(), // Which markets this strategy watches
  paperMode: boolean('paper_mode').default(true),            // Paper trading by default
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// packages/db/src/schema/orders.ts
export const orders = pgTable('orders', {
  id: text('id').primaryKey(),                               // Internal UUID
  externalId: text('external_id'),                           // Polymarket order ID
  strategyId: text('strategy_id').references(() => strategies.id),
  marketId: text('market_id').references(() => markets.id),
  tokenId: text('token_id').notNull(),                       // Polymarket token_id
  side: text('side').notNull(),                              // 'BUY' | 'SELL'
  type: text('type').notNull(),                              // 'GTC' | 'FOK' | 'GTD'
  price: numeric('price', { precision: 10, scale: 4 }).notNull(),
  size: numeric('size', { precision: 20, scale: 6 }).notNull(),
  filledSize: numeric('filled_size', { precision: 20, scale: 6 }).default('0'),
  status: text('status').notNull().default('pending'),       // 'pending','open','partial','filled','cancelled','expired','rejected'
  paperMode: boolean('paper_mode').default(false),
  signedOrder: jsonb('signed_order'),                        // EIP712 signed order payload
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  filledAt: timestamp('filled_at'),
  cancelledAt: timestamp('cancelled_at'),
}, (table) => ({
  strategyIdx: index('idx_orders_strategy').on(table.strategyId),
  marketIdx: index('idx_orders_market').on(table.marketId),
  statusIdx: index('idx_orders_status').on(table.status),
  createdAtIdx: index('idx_orders_created_at').on(table.createdAt),
}));

// packages/db/src/schema/trades.ts
export const trades = pgTable('trades', {
  id: text('id').primaryKey(),                               // Internal UUID
  orderId: text('order_id').references(() => orders.id),
  externalTradeId: text('external_trade_id'),                // Polymarket trade ID
  marketId: text('market_id').references(() => markets.id),
  tokenId: text('token_id').notNull(),
  side: text('side').notNull(),
  price: numeric('price', { precision: 10, scale: 4 }).notNull(),
  size: numeric('size', { precision: 20, scale: 6 }).notNull(),
  fee: numeric('fee', { precision: 20, scale: 6 }).default('0'),
  realizedPnl: numeric('realized_pnl', { precision: 20, scale: 6 }),
  paperMode: boolean('paper_mode').default(false),
  transactionHash: text('transaction_hash'),                 // On-chain settlement tx
  timestamp: timestamp('timestamp').notNull(),
}, (table) => ({
  orderIdx: index('idx_trades_order').on(table.orderId),
  marketIdx: index('idx_trades_market').on(table.marketId),
  timestampIdx: index('idx_trades_timestamp').on(table.timestamp),
}));

// packages/db/src/schema/positions.ts
export const positions = pgTable('positions', {
  id: text('id').primaryKey(),                               // market_id + token_id composite key
  marketId: text('market_id').references(() => markets.id),
  tokenId: text('token_id').notNull(),
  strategyId: text('strategy_id').references(() => strategies.id),
  side: text('side').notNull(),                              // 'LONG' | 'SHORT'
  size: numeric('size', { precision: 20, scale: 6 }).notNull(),
  avgEntryPrice: numeric('avg_entry_price', { precision: 10, scale: 4 }).notNull(),
  currentPrice: numeric('current_price', { precision: 10, scale: 4 }),
  unrealizedPnl: numeric('unrealized_pnl', { precision: 20, scale: 6 }),
  realizedPnl: numeric('realized_pnl', { precision: 20, scale: 6 }).default('0'),
  paperMode: boolean('paper_mode').default(false),
  openedAt: timestamp('opened_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  closedAt: timestamp('closed_at'),
}, (table) => ({
  strategyIdx: index('idx_positions_strategy').on(table.strategyId),
  marketIdx: index('idx_positions_market').on(table.marketId),
}));

// packages/db/src/schema/strategy_runs.ts
export const strategyRuns = pgTable('strategy_runs', {
  id: text('id').primaryKey(),
  strategyId: text('strategy_id').references(() => strategies.id),
  type: text('type').notNull(),                              // 'live' | 'paper' | 'backtest'
  status: text('status').notNull(),                          // 'running' | 'completed' | 'failed' | 'stopped'
  startedAt: timestamp('started_at').defaultNow(),
  endedAt: timestamp('ended_at'),
  config: jsonb('config'),                                   // Snapshot of strategy config at run start
  results: jsonb('results').$type<StrategyRunResults>(),     // PnL, trades count, win rate, etc.
  backtestParams: jsonb('backtest_params'),                  // Only for backtest runs: date range, initial capital
});

// packages/db/src/schema/alerts.ts
export const alerts = pgTable('alerts', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),       // 'price_threshold', 'drawdown', 'strategy_error', 'connection_lost', etc.
  severity: text('severity').notNull(), // 'info', 'warning', 'critical'
  title: text('title').notNull(),
  message: text('message').notNull(),
  context: jsonb('context'),           // Related IDs, values, etc.
  acknowledged: boolean('acknowledged').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  acknowledgedAt: timestamp('acknowledged_at'),
});

// packages/db/src/schema/audit_log.ts
export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  action: text('action').notNull(),    // 'order:create', 'order:cancel', 'strategy:start', 'risk:update', etc.
  actor: text('actor').notNull(),      // 'bot:strategy:value_v1', 'user:dashboard', 'system:scheduler'
  entityType: text('entity_type'),     // 'order', 'strategy', 'position', 'risk_params'
  entityId: text('entity_id'),
  before: jsonb('before'),             // State before change
  after: jsonb('after'),               // State after change
  metadata: jsonb('metadata'),         // IP address, request ID, etc.
  timestamp: timestamp('timestamp').defaultNow(),
}, (table) => ({
  actionIdx: index('idx_audit_action').on(table.action),
  entityIdx: index('idx_audit_entity').on(table.entityType, table.entityId),
  timestampIdx: index('idx_audit_timestamp').on(table.timestamp),
}));
```

### 3.3 TimescaleDB Hypertables

```sql
-- Price ticks from Polymarket WebSocket feed
CREATE TABLE price_ticks (
  time        TIMESTAMPTZ NOT NULL,
  market_id   TEXT NOT NULL,
  token_id    TEXT NOT NULL,
  price       NUMERIC(10, 4) NOT NULL,
  volume_24h  NUMERIC(20, 6),
  bid         NUMERIC(10, 4),
  ask         NUMERIC(10, 4),
  spread      NUMERIC(10, 4)
);
SELECT create_hypertable('price_ticks', 'time');
CREATE INDEX idx_price_ticks_market ON price_ticks (market_id, time DESC);

-- Portfolio value snapshots
CREATE TABLE portfolio_snapshots (
  time            TIMESTAMPTZ NOT NULL,
  total_value     NUMERIC(20, 6) NOT NULL,
  cash_balance    NUMERIC(20, 6) NOT NULL,
  positions_value NUMERIC(20, 6) NOT NULL,
  unrealized_pnl  NUMERIC(20, 6) NOT NULL,
  realized_pnl    NUMERIC(20, 6) NOT NULL,
  strategy_id     TEXT  -- NULL for portfolio-level
);
SELECT create_hypertable('portfolio_snapshots', 'time');

-- Continuous aggregate for 1-minute candles
CREATE MATERIALIZED VIEW price_candles_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  market_id,
  token_id,
  first(price, time) AS open,
  max(price) AS high,
  min(price) AS low,
  last(price, time) AS close,
  count(*) AS tick_count
FROM price_ticks
GROUP BY bucket, market_id, token_id;

-- Compression policy: compress chunks older than 7 days
SELECT add_compression_policy('price_ticks', INTERVAL '7 days');

-- Retention policy: drop raw ticks older than 90 days
SELECT add_retention_policy('price_ticks', INTERVAL '90 days');
```

### 3.4 Redis Key Structure

```
# Bot engine state
bot:status                          -> JSON { state, uptime, lastTick, activeStrategies }
bot:positions                       -> JSON { positions[] }
bot:orders:open                     -> JSON { orders[] }
bot:commands                        -> Redis List (LPUSH/BRPOP queue)

# Market data cache
cache:market:{conditionId}          -> JSON market data (TTL: 5 min)
cache:orderbook:{tokenId}           -> JSON order book (TTL: 10s)
cache:price:{tokenId}               -> string price (TTL: 5s)
cache:markets:list                  -> JSON full market list (TTL: 5 min)

# Rate limiting
ratelimit:clob:{endpoint}           -> Counter (TTL: sliding window)
ratelimit:gamma:{endpoint}          -> Counter (TTL: sliding window)

# Real-time events (Pub/Sub channels)
bot:events                          -> Pub/Sub channel for all bot events

# Strategy state
strategy:{strategyId}:state         -> JSON strategy-specific state (TTL: none, explicit delete)

# Session
session:{sessionId}                 -> JSON user session (TTL: 24h)
```

---

## 4. Integration Architecture

### 4.1 Polymarket CLOB API Integration

**Base URLs:**
- CLOB REST: `https://clob.polymarket.com`
- Gamma REST: `https://gamma-api.polymarket.com`
- Data REST: `https://data-api.polymarket.com`
- CLOB WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/`
- Live Data WebSocket: `wss://ws-live-data.polymarket.com`

**REST Client implementation:**

```typescript
// packages/polymarket-client/src/rest/ClobClient.ts
import { createHmac } from 'crypto';

class ClobRestClient {
  private baseUrl = 'https://clob.polymarket.com';
  private credentials: L2Credentials;

  // --- Public methods (no auth) ---
  async getMarkets(params?: { next_cursor?: string }): Promise<PaginatedResponse<Market>>;
  async getMarket(conditionId: string): Promise<Market>;
  async getOrderBook(tokenId: string): Promise<OrderBook>;
  async getPrice(tokenId: string): Promise<Price>;
  async getMidpoint(tokenId: string): Promise<number>;
  async getSpread(tokenId: string): Promise<Spread>;

  // --- L2 authenticated methods ---
  async createOrder(params: CreateOrderParams): Promise<SignedOrder>;
  async postOrder(signedOrder: SignedOrder): Promise<OrderResponse>;
  async cancelOrder(orderId: string): Promise<void>;
  async cancelAll(): Promise<void>;
  async getOpenOrders(params?: OpenOrdersParams): Promise<Order[]>;
  async getTrades(params?: TradesParams): Promise<Trade[]>;
  async getPositions(): Promise<Position[]>;

  // --- Batch operations ---
  async postBatchOrders(orders: SignedOrder[]): Promise<BatchOrderResponse>;  // Max 15

  // --- Internal auth ---
  private sign(method: string, path: string, body?: string, timestamp?: number): string {
    const ts = timestamp || Math.floor(Date.now() / 1000);
    const message = `${ts}${method}${path}${body || ''}`;
    return createHmac('sha256', this.credentials.secret)
      .update(message)
      .digest('base64');
  }

  private getAuthHeaders(method: string, path: string, body?: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      'POLY_API_KEY': this.credentials.apiKey,
      'POLY_SIGNATURE': this.sign(method, path, body, timestamp),
      'POLY_TIMESTAMP': timestamp.toString(),
      'POLY_PASSPHRASE': this.credentials.passphrase,
    };
  }
}
```

**WebSocket Manager:**

```typescript
// packages/polymarket-client/src/ws/WebSocketManager.ts
class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectBaseDelay = 1000; // Exponential backoff
  private heartbeatInterval: NodeJS.Timer | null = null;
  private subscriptions: Map<string, SubscriptionConfig> = new Map();

  async connect(url: string): Promise<void>;

  // Market channel - public, no auth needed
  async subscribeMarket(tokenIds: string[]): Promise<void>;

  // User channel - requires L2 auth
  async subscribeUser(conditionIds: string[], auth: L2Credentials): Promise<void>;

  // Event handlers
  onPriceUpdate(handler: (update: PriceUpdate) => void): void;
  onOrderUpdate(handler: (update: OrderUpdate) => void): void;
  onTradeUpdate(handler: (update: TradeUpdate) => void): void;

  // Reconnection with exponential backoff
  private async reconnect(): Promise<void> {
    const delay = Math.min(
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts),
      30000 // Max 30 seconds
    );
    await sleep(delay);
    this.reconnectAttempts++;

    // Re-subscribe to all previous subscriptions on reconnect
    await this.connect(this.url);
    for (const [id, config] of this.subscriptions) {
      await this.subscribe(config);
    }
  }

  // Heartbeat to keep connection alive
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000); // Every 30 seconds
  }
}
```

### 4.2 Polygon Blockchain Interaction

**Library: `viem`** (not ethers.js).

Justification: `viem` is smaller, faster, more type-safe, and designed for modern TypeScript. It has first-class support for the Polygon chain and provides better error messages.

```typescript
// packages/polymarket-client/src/chain/PolygonClient.ts
import { createPublicClient, createWalletClient, http, webSocket } from 'viem';
import { polygon } from 'viem/chains';

class PolygonClient {
  private publicClient: PublicClient;
  private walletClient: WalletClient;

  constructor(config: PolygonConfig) {
    this.publicClient = createPublicClient({
      chain: polygon,
      transport: http(config.rpcUrl), // Alchemy or Infura Polygon RPC
    });

    this.walletClient = createWalletClient({
      chain: polygon,
      transport: http(config.rpcUrl),
      account: privateKeyToAccount(config.privateKey), // Only in bot engine, never in dashboard
    });
  }

  // Check USDC balance
  async getUsdcBalance(): Promise<bigint>;

  // Approve USDC spending for CTF exchange
  async approveUsdcSpending(spender: Address, amount: bigint): Promise<Hash>;

  // Listen for CTF (Conditional Token Framework) events
  async watchCtfEvents(conditionId: string, handler: (event: CtfEvent) => void): void;

  // Get current allowance
  async getUsdcAllowance(spender: Address): Promise<bigint>;

  // Sign EIP712 order for CLOB
  async signOrder(order: UnsignedOrder): Promise<SignedOrder> {
    const signature = await this.walletClient.signTypedData({
      domain: CLOB_DOMAIN,
      types: ORDER_TYPES,
      primaryType: 'Order',
      message: order,
    });
    return { ...order, signature };
  }
}
```

**Key blockchain interactions:**
- **USDC approvals:** The CTF exchange contract needs USDC spending approval. This is a one-time setup per address.
- **Balance checking:** Verify USDC balance before placing orders.
- **Order signing:** All CLOB orders are EIP-712 typed data signatures, signed locally with the private key and submitted to the CLOB API.
- **Event monitoring:** Watch for on-chain settlement events to confirm trades.

### 4.3 External Data Sources

```typescript
// apps/bot/src/data/providers/

// News provider
class NewsDataProvider implements DataProvider {
  // NewsAPI.org for general news
  // GDELT for global event data
  // RSS feeds for specific outlets
  async fetchHeadlines(query: string): Promise<NewsArticle[]>;
  async getSentimentScore(marketQuestion: string): Promise<number>; // -1.0 to 1.0
}

// Social media sentiment
class SocialSentimentProvider implements DataProvider {
  // Twitter/X API v2 for tweet search
  // Reddit API for subreddit monitoring
  async getTwitterSentiment(keywords: string[]): Promise<SentimentData>;
  async getRedditSentiment(subreddits: string[], keywords: string[]): Promise<SentimentData>;
}

// Polling data (for political markets)
class PollingDataProvider implements DataProvider {
  // FiveThirtyEight, RealClearPolitics, polling APIs
  async getLatestPolls(race: string): Promise<PollData[]>;
  async getAggregatedPolling(race: string): Promise<AggregatedPoll>;
}
```

### 4.4 Authentication with Polymarket

**Two-level authentication flow:**

```
┌──────────────────────────────────────────────────────────────┐
│                  L1: Private Key Authentication               │
│                                                              │
│  1. Bot starts with Polygon private key (from env/vault)     │
│  2. Derive Ethereum address from private key                 │
│  3. Call CLOB API: POST /auth/api-key                       │
│     - Sign a challenge message with private key              │
│     - Receive: { apiKey, secret, passphrase }               │
│  4. Store L2 credentials in encrypted Redis                  │
│                                                              │
│  Note: L1 auth is only needed once (or when L2 keys expire) │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                  L2: API Key Authentication                    │
│                                                              │
│  For every authenticated request:                            │
│  1. Compute timestamp (Unix seconds)                         │
│  2. Construct message: "{timestamp}{method}{path}{body}"     │
│  3. HMAC-SHA256 sign with secret, base64 encode             │
│  4. Attach headers:                                          │
│     - POLY_API_KEY: apiKey                                   │
│     - POLY_SIGNATURE: computed signature                     │
│     - POLY_TIMESTAMP: timestamp                              │
│     - POLY_PASSPHRASE: passphrase                           │
│                                                              │
│  L2 credentials are used for ALL trading operations          │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. Bot Engine Architecture

### 5.1 Strategy Pattern for Pluggable Strategies

Every strategy implements a common interface. The strategy engine maintains a registry and runs each active strategy on every tick.

```typescript
// packages/shared/src/types/strategy.ts

interface TradingSignal {
  strategyId: string;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  orderType: 'GTC' | 'FOK' | 'GTD';
  price: number;           // Desired price (for limit orders)
  size: number;            // Position size in shares
  confidence: number;      // 0.0 to 1.0 -- how confident the strategy is
  urgency: 'low' | 'medium' | 'high';  // Affects order type selection
  metadata: Record<string, unknown>;    // Strategy-specific context
}

interface MarketSnapshot {
  timestamp: number;
  markets: Map<string, MarketData>;
  prices: Map<string, number>;
  orderBooks: Map<string, OrderBookSnapshot>;
  positions: Map<string, PositionData>;
  news?: NewsArticle[];
  sentiment?: Map<string, number>;
}

// The interface every strategy must implement
interface Strategy {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;

  // Called once when strategy is loaded
  initialize(config: StrategyConfig): Promise<void>;

  // Called every tick -- return zero or more signals
  evaluate(snapshot: MarketSnapshot): Promise<TradingSignal[]>;

  // Called when an order from this strategy fills
  onFill(fill: FillEvent): Promise<void>;

  // Called when strategy is stopped
  shutdown(): Promise<void>;

  // Return markets this strategy is interested in
  getWatchedMarkets(): string[];

  // Serialize state for persistence/recovery
  getState(): Record<string, unknown>;
  restoreState(state: Record<string, unknown>): void;
}
```

**Example strategy implementations:**

```typescript
// apps/bot/src/strategies/ValueStrategy.ts
// Buys when market price is significantly below estimated fair value
class ValueStrategy implements Strategy {
  id = 'value_v1';
  name = 'Value Betting';
  version = '1.0.0';
  description = 'Identifies markets where price diverges from estimated probability';

  private config: ValueStrategyConfig;
  private fairValues: Map<string, number> = new Map();

  async evaluate(snapshot: MarketSnapshot): Promise<TradingSignal[]> {
    const signals: TradingSignal[] = [];

    for (const marketId of this.getWatchedMarkets()) {
      const market = snapshot.markets.get(marketId);
      if (!market) continue;

      const currentPrice = snapshot.prices.get(market.tokenId);
      const fairValue = this.estimateFairValue(market, snapshot);

      if (!currentPrice || !fairValue) continue;

      const edge = fairValue - currentPrice;

      // Only trade when edge exceeds minimum threshold
      if (Math.abs(edge) > this.config.minEdge) {
        signals.push({
          strategyId: this.id,
          marketId,
          tokenId: market.tokenId,
          side: edge > 0 ? 'BUY' : 'SELL',
          orderType: 'GTC',
          price: currentPrice + (edge > 0 ? this.config.limitOffset : -this.config.limitOffset),
          size: this.calculatePositionSize(edge, currentPrice),
          confidence: Math.min(Math.abs(edge) / this.config.maxEdge, 1.0),
          urgency: Math.abs(edge) > this.config.highUrgencyEdge ? 'high' : 'medium',
          metadata: { fairValue, edge, method: 'polling_aggregate' },
        });
      }
    }
    return signals;
  }

  private estimateFairValue(market: MarketData, snapshot: MarketSnapshot): number | null {
    // Combine multiple signals: polling data, news sentiment, historical patterns
    // This is where the strategy's "alpha" lives
  }

  private calculatePositionSize(edge: number, price: number): number {
    // Kelly criterion or fractional Kelly for position sizing
    const kellyFraction = edge / (price * (1 - price)); // Simplified
    return Math.min(
      kellyFraction * this.config.bankroll * this.config.kellyMultiplier,
      this.config.maxPositionSize
    );
  }
}
```

```typescript
// apps/bot/src/strategies/MomentumStrategy.ts
// Follows price trends, buys when price is rising, sells when falling
class MomentumStrategy implements Strategy { /* ... */ }

// apps/bot/src/strategies/ArbitrageStrategy.ts
// Exploits mispricings between correlated markets
class ArbitrageStrategy implements Strategy { /* ... */ }

// apps/bot/src/strategies/NewsSentimentStrategy.ts
// Reacts to breaking news and sentiment shifts
class NewsSentimentStrategy implements Strategy { /* ... */ }

// apps/bot/src/strategies/MarketMakingStrategy.ts
// Provides liquidity by placing orders on both sides of the book
class MarketMakingStrategy implements Strategy { /* ... */ }
```

**Strategy Registry:**

```typescript
// apps/bot/src/engine/StrategyRegistry.ts
class StrategyRegistry {
  private strategies: Map<string, StrategyConstructor> = new Map();

  register(id: string, constructor: StrategyConstructor): void {
    this.strategies.set(id, constructor);
  }

  create(id: string, config: StrategyConfig): Strategy {
    const Constructor = this.strategies.get(id);
    if (!Constructor) throw new Error(`Unknown strategy: ${id}`);
    const instance = new Constructor();
    instance.initialize(config);
    return instance;
  }

  listAvailable(): string[] {
    return Array.from(this.strategies.keys());
  }
}
```

### 5.2 Order Lifecycle Management

```
┌─────────┐     ┌──────────┐     ┌──────────┐     ┌────────┐
│ SIGNAL   │────>│ PENDING  │────>│  OPEN    │────>│ FILLED │
│ (from    │     │ (risk    │     │ (on CLOB │     │        │
│ strategy)│     │  check,  │     │  book)   │     │        │
│          │     │  signing) │     │          │     │        │
└─────────┘     └──────┬───┘     └────┬─────┘     └────────┘
                       │              │
                       │              ├────> PARTIALLY_FILLED ──> FILLED
                       │              │
                       ▼              ├────> CANCELLED (by user/strategy)
                  REJECTED            │
                  (risk limit,        └────> EXPIRED (GTD timeout)
                   insufficient
                   balance)
```

```typescript
// apps/bot/src/execution/OrderExecutor.ts
class OrderExecutor {
  private openOrders: Map<string, ManagedOrder> = new Map();
  private polyClient: ClobRestClient;
  private polygonClient: PolygonClient;

  async execute(signal: TradingSignal): Promise<ManagedOrder> {
    // 1. Create unsigned order from signal
    const unsignedOrder = this.buildOrder(signal);

    // 2. Sign with private key (EIP-712)
    const signedOrder = await this.polygonClient.signOrder(unsignedOrder);

    // 3. Submit to CLOB
    const response = await this.polyClient.postOrder(signedOrder);

    // 4. Create managed order record
    const managed: ManagedOrder = {
      internalId: generateId(),
      externalId: response.orderId,
      signal,
      signedOrder,
      status: 'open',
      createdAt: Date.now(),
      fills: [],
    };

    // 5. Persist to database
    await this.db.insert(orders).values(this.toDbRecord(managed));

    // 6. Track in memory
    this.openOrders.set(managed.internalId, managed);

    // 7. Emit event
    this.eventBus.emit('order:created', { order: managed });

    return managed;
  }

  async monitorOpenOrders(): Promise<void> {
    // For each open order, check current status via API
    const apiOrders = await this.polyClient.getOpenOrders();
    const apiOrderMap = new Map(apiOrders.map(o => [o.id, o]));

    for (const [id, managed] of this.openOrders) {
      const apiOrder = apiOrderMap.get(managed.externalId);

      if (!apiOrder) {
        // Order no longer on book -- it was filled or cancelled
        const trades = await this.polyClient.getTrades({ orderId: managed.externalId });
        if (trades.length > 0) {
          await this.handleFill(managed, trades);
        } else {
          await this.handleCancellation(managed);
        }
        continue;
      }

      // Check for partial fills
      if (apiOrder.filledSize > managed.filledSize) {
        await this.handlePartialFill(managed, apiOrder);
      }

      // Check for staleness (configurable per order type)
      if (this.isStale(managed)) {
        await this.cancelOrder(managed, 'stale');
      }
    }
  }

  async cancelOrder(managed: ManagedOrder, reason: string): Promise<void> {
    await this.polyClient.cancelOrder(managed.externalId);
    managed.status = 'cancelled';
    this.openOrders.delete(managed.internalId);
    await this.db.update(orders).set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(orders.id, managed.internalId));
    this.eventBus.emit('order:cancelled', { order: managed, reason });
  }
}
```

### 5.3 Risk Management Module

The risk manager is a mandatory gate between signal generation and order execution. No order reaches the CLOB without passing all risk checks.

```typescript
// apps/bot/src/risk/RiskManager.ts

interface RiskCheckResult {
  pass: boolean;
  reason?: string;
  adjustedSignal?: TradingSignal; // Risk manager can reduce size
}

interface RiskParams {
  // Portfolio-level limits
  maxTotalExposure: number;           // Max total position value (e.g., $10,000)
  maxSingleMarketExposure: number;    // Max per-market (e.g., $2,000)
  maxOpenOrders: number;              // Max simultaneous open orders (e.g., 50)
  maxDailyLoss: number;              // Daily stop-loss (e.g., $500)
  maxDrawdownPercent: number;         // Max drawdown from peak (e.g., 10%)

  // Per-strategy limits
  maxStrategyExposure: number;        // Max per-strategy (e.g., $3,000)
  maxStrategyDailyLoss: number;

  // Order-level limits
  maxOrderSize: number;               // Max single order value (e.g., $500)
  minOrderSize: number;               // Min to avoid dust (e.g., $1)
  maxSlippageBps: number;             // Max acceptable slippage in basis points

  // Correlation limits
  maxCorrelatedExposure: number;      // Max exposure across correlated markets

  // Kill switch
  killSwitchEnabled: boolean;
  killSwitchDrawdownPercent: number;  // Emergency stop (e.g., 20%)
}

class RiskManager {
  private params: RiskParams;
  private peakPortfolioValue: number;
  private dailyPnl: number = 0;
  private dailyPnlResetAt: number;

  check(signal: TradingSignal): RiskCheckResult {
    const checks = [
      this.checkPortfolioExposure(signal),
      this.checkMarketExposure(signal),
      this.checkStrategyExposure(signal),
      this.checkOpenOrderCount(signal),
      this.checkOrderSize(signal),
      this.checkDailyLoss(signal),
      this.checkDrawdown(signal),
      this.checkCorrelation(signal),
      this.checkKillSwitch(),
    ];

    for (const result of checks) {
      if (!result.pass) return result;
    }

    return { pass: true };
  }

  private checkDrawdown(signal: TradingSignal): RiskCheckResult {
    const currentValue = this.getCurrentPortfolioValue();
    const drawdown = (this.peakPortfolioValue - currentValue) / this.peakPortfolioValue;

    if (drawdown >= this.params.maxDrawdownPercent / 100) {
      return {
        pass: false,
        reason: `Drawdown limit reached: ${(drawdown * 100).toFixed(1)}% >= ${this.params.maxDrawdownPercent}%`,
      };
    }
    return { pass: true };
  }

  private checkKillSwitch(): RiskCheckResult {
    if (!this.params.killSwitchEnabled) return { pass: true };

    const currentValue = this.getCurrentPortfolioValue();
    const drawdown = (this.peakPortfolioValue - currentValue) / this.peakPortfolioValue;

    if (drawdown >= this.params.killSwitchDrawdownPercent / 100) {
      // EMERGENCY: Cancel all orders, stop all strategies
      this.eventBus.emit('risk:kill-switch', {
        reason: `Kill switch triggered: ${(drawdown * 100).toFixed(1)}% drawdown`,
      });
      return { pass: false, reason: 'Kill switch activated' };
    }
    return { pass: true };
  }

  // Update peak value (called after every portfolio snapshot)
  updatePeakValue(currentValue: number): void {
    if (currentValue > this.peakPortfolioValue) {
      this.peakPortfolioValue = currentValue;
    }
  }

  // Reset daily PnL at midnight UTC
  resetDailyPnl(): void {
    this.dailyPnl = 0;
    this.dailyPnlResetAt = getNextMidnightUtc();
  }
}
```

### 5.4 Backtesting Framework

The backtesting framework replays historical data through a strategy and simulates order execution to estimate performance.

```typescript
// apps/bot/src/backtest/BacktestEngine.ts

interface BacktestConfig {
  strategyId: string;
  strategyConfig: StrategyConfig;
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  dataSource: 'database' | 'api';   // Use stored ticks or fetch from API
  slippageModel: 'none' | 'fixed' | 'proportional';
  slippageBps: number;              // Simulated slippage
  feeModel: 'none' | 'current';    // Apply Polymarket fee schedule
}

interface BacktestResult {
  runId: string;
  config: BacktestConfig;
  summary: {
    totalReturn: number;
    annualizedReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    totalTrades: number;
    averageHoldingPeriod: number;   // in hours
    profitFactor: number;
    calmarRatio: number;
  };
  equityCurve: { timestamp: number; value: number }[];
  trades: BacktestTrade[];
  dailyReturns: { date: string; return: number }[];
  drawdownCurve: { timestamp: number; drawdown: number }[];
}

class BacktestEngine {
  async run(config: BacktestConfig): Promise<BacktestResult> {
    // 1. Load historical data
    const historicalData = await this.loadData(config);

    // 2. Create strategy instance
    const strategy = this.registry.create(config.strategyId, config.strategyConfig);

    // 3. Create simulated executor
    const simulator = new SimulatedExecutor({
      initialCapital: config.initialCapital,
      slippageModel: config.slippageModel,
      slippageBps: config.slippageBps,
      feeModel: config.feeModel,
    });

    // 4. Replay data through strategy
    for (const snapshot of historicalData) {
      const signals = await strategy.evaluate(snapshot);

      for (const signal of signals) {
        const riskResult = this.riskManager.check(signal);
        if (riskResult.pass) {
          simulator.execute(signal, snapshot);
        }
      }

      // Process fills based on historical prices
      simulator.processMarketState(snapshot);
    }

    // 5. Compute performance metrics
    return this.computeResults(simulator, config);
  }
}
```

### 5.5 Paper Trading / Simulation Mode

Paper trading uses the real market data pipeline but routes orders through a `SimulatedExecutor` instead of the real CLOB client. This is the default mode for new strategies.

```typescript
// apps/bot/src/execution/SimulatedExecutor.ts
class SimulatedExecutor implements OrderExecutorInterface {
  private virtualBalance: number;
  private virtualPositions: Map<string, Position> = new Map();
  private simulatedOrders: Map<string, SimulatedOrder> = new Map();

  async execute(signal: TradingSignal): Promise<ManagedOrder> {
    // Simulate order fill based on current market price
    // Apply simulated slippage
    // Update virtual positions and balance
    // Still persist to database with paper_mode = true
  }

  async monitorOpenOrders(): Promise<void> {
    // Check if limit orders would have been filled based on real price movement
    for (const [id, order] of this.simulatedOrders) {
      const currentPrice = await this.dataManager.getPrice(order.tokenId);
      if (this.wouldFill(order, currentPrice)) {
        await this.simulateFill(order, currentPrice);
      }
    }
  }
}
```

The `paperMode` flag on orders, trades, and positions ensures paper trading data is always distinguishable from real trading data in the database and dashboard.

---

## 6. Infrastructure & DevOps

### 6.1 Deployment Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                    DEPLOYMENT TOPOLOGY                       │
│                                                             │
│  ┌─────────────────────────┐  ┌──────────────────────────┐ │
│  │      Vercel             │  │   VPS / Railway / Fly.io │ │
│  │                         │  │                          │ │
│  │  apps/web (Next.js)     │  │  apps/bot (Node.js)      │ │
│  │  - Dashboard UI         │  │  - Strategy engine       │ │
│  │  - API routes           │  │  - Order execution       │ │
│  │  - SSE endpoint         │  │  - Data pipeline         │ │
│  │                         │  │  - Scheduled tasks       │ │
│  │  Auto-scales, edge CDN  │  │                          │ │
│  │  Serverless functions   │  │  Always-on process       │ │
│  │                         │  │  PM2 process manager     │ │
│  └────────────┬────────────┘  └────────────┬─────────────┘ │
│               │                            │               │
│               └──────────┬─────────────────┘               │
│                          │                                  │
│                ┌─────────┴──────────┐                       │
│                │   Managed Services │                       │
│                │                    │                       │
│                │  - Neon (Postgres  │                       │
│                │    + TimescaleDB)  │                       │
│                │  - Upstash Redis   │                       │
│                │    (serverless)    │                       │
│                └────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

**Why this split:**
- **Vercel for the dashboard:** Next.js is Vercel's first-party framework. Edge caching, automatic HTTPS, preview deploys for PRs, zero-config.
- **Separate server for the bot:** The bot engine is a long-running process with persistent WebSocket connections. Vercel's serverless model (function timeout limits, cold starts) is fundamentally incompatible. Railway or Fly.io provides always-on containers with reasonable pricing ($5-20/month).
- **Neon for PostgreSQL:** Serverless Postgres with autoscaling, branching for dev/staging, and TimescaleDB extension support. Eliminates manual database administration.
- **Upstash for Redis:** Serverless Redis with per-request pricing and built-in rate limiting. REST API fallback when WebSocket is unavailable (works from Vercel Edge).

### 6.2 Environment Management

Three environments, each with isolated databases and Redis instances:

| Environment | Dashboard | Bot Engine | Database | Redis | Purpose |
|-------------|-----------|------------|----------|-------|---------|
| **dev** | `localhost:3000` | `localhost:4000` | Local Docker PostgreSQL | Local Docker Redis | Local development |
| **staging** | `staging.auto-poly-bet.vercel.app` | Railway staging | Neon staging branch | Upstash staging | Integration testing, paper trading |
| **prod** | `auto-poly-bet.vercel.app` | Railway prod | Neon main branch | Upstash prod | Live trading |

**Environment variables (using `.env` files per Turborepo conventions):**

```bash
# .env.local (never committed)

# Polymarket
POLYGON_PRIVATE_KEY=0x...          # Only in bot env
POLYMARKET_API_KEY=...
POLYMARKET_SECRET=...
POLYMARKET_PASSPHRASE=...
CLOB_BASE_URL=https://clob.polymarket.com
GAMMA_BASE_URL=https://gamma-api.polymarket.com

# Database
DATABASE_URL=postgresql://...

# Redis
REDIS_URL=redis://...

# Blockchain
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/...
ALCHEMY_API_KEY=...

# External APIs
NEWS_API_KEY=...
TWITTER_BEARER_TOKEN=...

# App
BOT_ENGINE_TICK_INTERVAL_MS=1000
DEFAULT_PAPER_MODE=true
DASHBOARD_AUTH_SECRET=...
```

### 6.3 Monitoring, Logging, and Alerting

**Structured Logging: `pino`**

```typescript
// packages/shared/src/utils/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty' }
    : undefined,
  base: {
    service: process.env.SERVICE_NAME, // 'web' | 'bot'
    env: process.env.NODE_ENV,
  },
  serializers: {
    err: pino.stdSerializers.err,
    order: (order) => ({ id: order.id, market: order.marketId, side: order.side, size: order.size }),
  },
});

// Usage:
logger.info({ orderId: 'abc', marketId: '0x123', side: 'BUY', size: 100 }, 'Order placed');
logger.error({ err, strategyId: 'value_v1' }, 'Strategy evaluation failed');
```

**Log destination:** `pino` outputs structured JSON to stdout. In production, Railway captures stdout and provides log search. For longer retention, pipe to **Better Stack (Logtail)** -- $0 for up to 1GB/month.

**Application monitoring: Sentry**
- Error tracking with full stack traces and context.
- Performance monitoring (transaction tracing for API routes and bot ticks).
- Free tier covers the needs of a single-developer project.

**Uptime monitoring: Better Stack (formerly Better Uptime)**
- HTTP checks on the dashboard every 60 seconds.
- Heartbeat monitoring for the bot engine (bot sends a heartbeat ping every tick; if missed for 3 minutes, alert triggers).

**Trading-specific alerts (via the alerts table + push notifications):**

| Alert | Trigger | Severity | Notification |
|-------|---------|----------|--------------|
| Kill switch activated | Portfolio drawdown exceeds threshold | Critical | SMS + Email + Dashboard |
| Strategy error | Strategy throws unhandled exception | Critical | Email + Dashboard |
| Connection lost | CLOB WebSocket disconnected > 60s | Warning | Dashboard |
| Daily loss limit | Daily PnL exceeds loss limit | Critical | SMS + Dashboard |
| Order rejected | CLOB rejects order submission | Warning | Dashboard |
| Large fill | Single fill > $500 | Info | Dashboard |
| Balance low | USDC balance < $100 | Warning | Email + Dashboard |

### 6.4 Secret Management

**Development:** `.env.local` files (git-ignored).

**Staging/Production:**
- **Vercel:** Environment variables in Vercel project settings (encrypted at rest).
- **Railway:** Environment variables in Railway service settings.
- **Critical secrets (private key):** For production, the Polygon private key should be stored in a dedicated secrets manager -- **Doppler** (free tier for small teams) or **Infisical** (open-source). The bot fetches the key at startup via the secrets manager API rather than having it in an environment variable that could be leaked in a process dump.

**Never log or expose:**
- Private keys
- API secrets
- Passphrases
- Full order signatures

The logger serializers must redact these fields.

### 6.5 CI/CD Pipeline

**GitHub Actions:**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'yarn'
      - run: yarn install --frozen-lockfile
      - run: yarn turbo lint
      - run: yarn turbo type-check

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: timescale/timescaledb:latest-pg16
        env:
          POSTGRES_PASSWORD: test
        ports: ['5432:5432']
      redis:
        image: redis:7
        ports: ['6379:6379']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'yarn'
      - run: yarn install --frozen-lockfile
      - run: yarn turbo test
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/test
          REDIS_URL: redis://localhost:6379

  deploy-web:
    needs: [lint-and-typecheck, test]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'

  deploy-bot:
    needs: [lint-and-typecheck, test]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: railwayapp/github-action@v1
        with:
          railway-token: ${{ secrets.RAILWAY_TOKEN }}
          service: bot-engine
```

---

## 7. Security Architecture

### 7.1 Wallet / Key Management

**Threat model:** The Polygon private key controls all funds. Its compromise means total loss.

**Protections:**
1. **Isolation:** The private key exists only in the bot engine's runtime memory. It is never sent to the dashboard, never stored in the database, never included in logs.
2. **Dedicated wallet:** Use a dedicated trading wallet, not a personal wallet. Fund it only with the amount allocated for trading.
3. **Proxy wallet pattern:** Polymarket supports proxy wallets. The bot operates through a proxy wallet that can only interact with the Polymarket CTF exchange contract. Even if the proxy is compromised, funds cannot be sent to arbitrary addresses.
4. **Startup derivation:** On startup, the bot derives L2 API credentials from the private key and then uses only L2 credentials for API interactions. The private key is only used for EIP-712 order signing.
5. **Memory protection:** In production, use `process.env` access once at startup, store in a closure, and delete the env var from the process:

```typescript
// apps/bot/src/config/secrets.ts
let _privateKey: string | null = null;

export function initializeSecrets(): void {
  _privateKey = process.env.POLYGON_PRIVATE_KEY!;
  delete process.env.POLYGON_PRIVATE_KEY; // Remove from env after reading
}

export function getPrivateKey(): string {
  if (!_privateKey) throw new Error('Secrets not initialized');
  return _privateKey;
}
```

### 7.2 API Authentication and Authorization

The dashboard API routes must be protected from unauthorized access.

**Authentication: NextAuth.js with credentials provider.**

For a single-operator setup, a simple password-based authentication is sufficient:

```typescript
// apps/web/app/api/auth/[...nextauth]/route.ts
import NextAuth from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';

export const authOptions = {
  providers: [
    CredentialsProvider({
      credentials: {
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const isValid = await bcrypt.compare(
          credentials.password,
          process.env.DASHBOARD_PASSWORD_HASH!
        );
        if (isValid) return { id: 'operator', name: 'Operator' };
        return null;
      },
    }),
  ],
  session: { strategy: 'jwt' },
};
```

**For multi-user:** Upgrade to wallet-based authentication (Sign-In with Ethereum) or OAuth.

### 7.3 Rate Limiting and Abuse Prevention

**External API rate limiting (bot -> Polymarket):**

```typescript
// packages/polymarket-client/src/utils/RateLimiter.ts
class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private maxTokens: number;
  private refillRate: number; // tokens per second

  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitTime = (1 - this.tokens) / this.refillRate * 1000;
      await sleep(waitTime);
      this.refill();
    }
    this.tokens -= 1;
  }
}

// Applied per-endpoint:
const rateLimiters = {
  'GET /markets': new TokenBucketRateLimiter(10, 2),    // 10 burst, 2/sec sustained
  'POST /order': new TokenBucketRateLimiter(5, 1),      // 5 burst, 1/sec sustained
  'GET /orderbook': new TokenBucketRateLimiter(20, 5),   // 20 burst, 5/sec sustained
};
```

**Dashboard API rate limiting (browser -> dashboard):**

Implemented at the API route level using Upstash Redis rate limiting:

```typescript
// apps/web/lib/rateLimit.ts
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(60, '1 m'), // 60 requests per minute
});
```

### 7.4 Audit Trail

Every state-changing action in the system is recorded in the `audit_log` table:

- Order creation, cancellation, fill
- Strategy activation, deactivation, configuration change
- Risk parameter changes
- Bot start/stop
- Dashboard login/logout
- Manual overrides

Each audit log entry records the actor (which strategy, which user action, which scheduler task), the before/after state, and a timestamp. This is both a compliance requirement and a debugging tool.

```typescript
// packages/shared/src/utils/audit.ts
class AuditLogger {
  async log(params: {
    action: string;
    actor: string;
    entityType?: string;
    entityId?: string;
    before?: unknown;
    after?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(auditLog).values({
      id: generateId(),
      ...params,
      timestamp: new Date(),
    });
  }
}
```

---

## 8. Scalability Considerations

### 8.1 Handling Multiple Strategies Simultaneously

The bot engine is designed from the start to run N strategies concurrently:

- **Strategy isolation:** Each strategy maintains its own state object. One strategy crashing does not affect others (wrapped in try/catch in the main loop).
- **Resource sharing:** All strategies share the same data pipeline (one WebSocket connection, one market data cache). Data is fetched once and distributed to all.
- **Independent risk envelopes:** Each strategy has its own risk parameters (max exposure, max loss) in addition to portfolio-level limits.
- **Priority system:** If two strategies generate conflicting signals for the same market, the strategy with higher confidence wins. Configurable conflict resolution.

**Scaling limit:** A single Node.js process can comfortably run 50+ strategies with a 1-second tick interval. The bottleneck is API rate limits, not compute. If we ever need more, we shard by market category (political strategies on one bot instance, sports on another).

### 8.2 Supporting Multiple Users/Accounts

The current architecture is designed for a single operator. To support multiple users:

1. **Database:** Add a `user_id` column to strategies, orders, trades, positions. Add a `users` table.
2. **Wallet per user:** Each user brings their own Polygon wallet. The bot signs orders with the user's key (stored encrypted in a vault, never in the database).
3. **Isolated risk:** Risk parameters become per-user. One user's loss does not affect another.
4. **API authentication:** Upgrade from single-password to multi-user auth (SIWE or OAuth).
5. **Bot engine:** Either run one bot process per user (simple isolation, more resource usage) or run a multi-tenant bot with user-scoped strategy runners (complex, but resource efficient).

**Recommendation:** Do not build multi-user until there is a clear need. The complexity of managing multiple users' private keys securely is significant and introduces custodial risk.

### 8.3 Data Growth Management

| Data Type | Growth Rate (est.) | Retention | Strategy |
|-----------|-------------------|-----------|----------|
| Price ticks | ~500K rows/day (500 markets x 1 tick/min) | 90 days raw, aggregates forever | TimescaleDB compression + retention policy |
| Orders | ~100-1000/day | Forever | Partition by month after 1M rows |
| Trades | ~50-500/day | Forever | Small table, no special handling |
| Audit log | ~1000-5000/day | 1 year | Partition by month, archive to cold storage |
| Market snapshots | ~144/day (every 10 min) | 1 year | Moderate growth, compress after 30 days |

**TimescaleDB automatic management:**
- Chunks are auto-created (default 7-day chunks).
- Compression compresses chunks older than 7 days (typically 10-20x compression ratio).
- Retention drops raw ticks older than 90 days.
- Continuous aggregates pre-compute 1-min/5-min/1-hour/1-day candles that are kept indefinitely.

**Database maintenance:**
- Weekly `VACUUM ANALYZE` on frequently updated tables (positions, orders).
- Monitor table bloat and index fragmentation.
- Neon handles this automatically for managed instances.

---

## Appendix A: Technology Stack Summary

| Layer | Technology | Version | Justification |
|-------|-----------|---------|---------------|
| **Frontend framework** | Next.js | 15.x | Already in place. App Router, RSC, API routes. |
| **UI components** | HeroUI | 2.x | Already in place. Clean, accessible components. |
| **Styling** | Tailwind CSS | 3.x | Already in place. Utility-first, no CSS bloat. |
| **Client state** | Zustand | 4.x | Already in place. Minimal, performant. |
| **Server state** | TanStack React Query | 5.x | Cache invalidation, optimistic updates, background refetch. |
| **Charts** | Recharts | 2.x | Lightweight, composable, React-native. |
| **Validation** | Zod | 3.x | Runtime type safety, form validation, API validation. |
| **ORM** | Drizzle ORM | 0.3x | Type-safe, thin, great PostgreSQL support. |
| **Database** | PostgreSQL + TimescaleDB | 16 + 2.x | ACID, JSONB, time-series via extension. |
| **Cache/Pub-Sub** | Redis (Upstash) | 7.x | Caching, rate limiting, cross-process messaging. |
| **Blockchain** | viem | 2.x | Type-safe, modern, smaller than ethers.js. |
| **HTTP client** | ky | 1.x | Tiny, typed, retry-capable fetch wrapper. |
| **WebSocket** | ws | 8.x | Standard Node.js WebSocket client. |
| **Logging** | pino | 9.x | Fast structured logging, JSON output. |
| **Scheduling** | node-cron | 3.x | Lightweight cron for Node.js. |
| **Process manager** | PM2 | 5.x | Restart on crash, cluster mode, log rotation. |
| **Monorepo** | Turborepo | 2.x | Fast builds, shared cache, Vercel-native. |
| **Auth** | NextAuth.js | 5.x | Session management, JWT, extensible providers. |
| **Error tracking** | Sentry | latest | Stack traces, performance monitoring, free tier. |
| **CI/CD** | GitHub Actions | n/a | Native to GitHub, free for public repos. |
| **Dashboard hosting** | Vercel | n/a | First-party Next.js platform, edge CDN. |
| **Bot hosting** | Railway | n/a | Always-on containers, simple deploys, $5/month. |
| **Database hosting** | Neon | n/a | Serverless Postgres, branching, autoscale. |
| **Redis hosting** | Upstash | n/a | Serverless Redis, per-request pricing, REST fallback. |

## Appendix B: API Endpoint Reference (Polymarket)

| Service | Base URL | Purpose |
|---------|----------|---------|
| CLOB REST | `https://clob.polymarket.com` | Trading operations (orders, trades, order book) |
| Gamma REST | `https://gamma-api.polymarket.com` | Market discovery (metadata, categories, search) |
| Data REST | `https://data-api.polymarket.com` | User data (positions, history) |
| CLOB WSS | `wss://ws-subscriptions-clob.polymarket.com/ws/` | Real-time order/trade updates |
| Live Data WSS | `wss://ws-live-data.polymarket.com` | Real-time market price feeds |

## Appendix C: Key Design Decisions Log

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Repository structure | Monorepo (Turborepo) | Multi-repo, Nx | Shared types, atomic refactors, simpler CI |
| Architecture | Modular monolith | Microservices | Latency-sensitive, small team, shared state |
| API style | REST (Next.js routes) | GraphQL, tRPC, separate Express | Well-defined access patterns, simpler caching |
| Database | PostgreSQL + TimescaleDB | MongoDB, ClickHouse, InfluxDB | ACID for trades, time-series in same DB |
| ORM | Drizzle | Prisma, Knex, raw SQL | Type-safe, thin, PostgreSQL-native |
| Blockchain library | viem | ethers.js, web3.js | Type-safe, smaller, modern |
| Cross-process comms | Redis Pub/Sub | RabbitMQ, Kafka, gRPC | Already using Redis, sufficient throughput |
| Bot runtime | Node.js | Python, Rust, Go | Shared TypeScript stack, async I/O |
| Dashboard real-time | SSE via API route | WebSocket, polling | Unidirectional, Vercel-compatible, simpler |
| Strategy architecture | Interface pattern | Plugin DLLs, config-driven | Type-safe, debuggable, testable |
