# Auto Poly Bet Bot -- Dashboard Design System

> Comprehensive UI/UX specification for a Polymarket automated betting platform.
> Tech stack: Next.js 15 (App Router), Tailwind CSS 3.4, HeroUI 2.x, Zustand 4.x

---

## Table of Contents

1. [Design System Specifications](#1-design-system-specifications)
2. [Dashboard Pages & Layout System](#2-dashboard-pages--layout-system)
3. [Main Dashboard (Home)](#3-main-dashboard-home)
4. [Markets Explorer Page](#4-markets-explorer-page)
5. [Portfolio & Positions Page](#5-portfolio--positions-page)
6. [Strategy Management Page](#6-strategy-management-page)
7. [Trade History & Analytics Page](#7-trade-history--analytics-page)
8. [Bot Control Panel Page](#8-bot-control-panel-page)
9. [Alerts & Notifications](#9-alerts--notifications)
10. [Key UI Components to Build](#10-key-ui-components-to-build)
11. [Wireframe Descriptions](#11-wireframe-descriptions)

---

## 1. Design System Specifications

### 1.1 Color Palette

Extend the existing `tailwind.config.ts` with a custom trading-oriented palette. These colors are added under `theme.extend.colors` and also registered with the HeroUI plugin via its theme config.

```ts
// tailwind.config.ts  --  theme.extend.colors
colors: {
  // ---- surface / background hierarchy (dark-first) ----
  surface: {
    DEFAULT: '#0B0F19',   // app background (dark)
    raised:  '#111827',   // cards, panels
    overlay: '#1F2937',   // modals, dropdowns, popovers
    subtle:  '#374151',   // hover states, dividers
  },

  // ---- profit / loss (the two most important colors) ----
  profit: {
    DEFAULT: '#22C55E',   // green-500 equivalent
    light:   '#4ADE80',   // green-400  -- hover / sparkline fill
    muted:   'rgba(34,197,94,0.15)', // background tint for badges
  },
  loss: {
    DEFAULT: '#EF4444',   // red-500 equivalent
    light:   '#F87171',   // red-400
    muted:   'rgba(239,68,68,0.15)',
  },

  // ---- accent (brand / primary action) ----
  accent: {
    DEFAULT: '#6366F1',   // indigo-500
    hover:   '#818CF8',   // indigo-400
    muted:   'rgba(99,102,241,0.15)',
  },

  // ---- warning / info ----
  warning: {
    DEFAULT: '#F59E0B',   // amber-500
    muted:   'rgba(245,158,11,0.15)',
  },
  info: {
    DEFAULT: '#3B82F6',   // blue-500
    muted:   'rgba(59,130,246,0.15)',
  },

  // ---- neutral text hierarchy (dark mode primary) ----
  text: {
    primary:   '#F9FAFB',  // gray-50
    secondary: '#9CA3AF',  // gray-400
    tertiary:  '#6B7280',  // gray-500
    disabled:  '#4B5563',  // gray-600
  },

  // ---- light-mode overrides (applied via `.light` class) ----
  'light-surface': {
    DEFAULT: '#FFFFFF',
    raised:  '#F9FAFB',
    overlay: '#FFFFFF',
    subtle:  '#E5E7EB',
  },
  'light-text': {
    primary:   '#111827',
    secondary: '#6B7280',
    tertiary:  '#9CA3AF',
  },
}
```

#### Semantic usage rules

| Purpose | Dark mode class | Light mode class |
|---|---|---|
| App background | `bg-surface` | `light:bg-white` |
| Card / panel | `bg-surface-raised` | `light:bg-gray-50` |
| Positive value | `text-profit` | same |
| Negative value | `text-loss` | same |
| Positive badge bg | `bg-profit-muted text-profit` | same |
| Negative badge bg | `bg-loss-muted text-loss` | same |
| Primary button | `bg-accent hover:bg-accent-hover` | same |
| Muted / disabled text | `text-text-tertiary` | `light:text-gray-400` |

### 1.2 Typography Scale

Use the system font stack already provided by Next.js (`font-sans`). Define a strict typographic scale via Tailwind utility classes:

| Token | Tailwind class | Size / Weight | Usage |
|---|---|---|---|
| `display` | `text-3xl font-bold tracking-tight` | 30px / 700 | Page titles |
| `heading-lg` | `text-2xl font-semibold` | 24px / 600 | Section headers |
| `heading-md` | `text-xl font-semibold` | 20px / 600 | Card titles |
| `heading-sm` | `text-lg font-medium` | 18px / 500 | Sub-section titles |
| `body` | `text-sm font-normal` | 14px / 400 | Default body text |
| `body-lg` | `text-base font-normal` | 16px / 400 | Emphasized body |
| `caption` | `text-xs font-medium` | 12px / 500 | Labels, table headers |
| `mono` | `font-mono text-sm` | 14px / 400 | Prices, numbers, code |
| `stat` | `text-2xl font-bold font-mono tabular-nums` | 24px / 700 | Large numeric stats |

All numeric/financial values must use `tabular-nums` (Tailwind: `tabular-nums`) for alignment in tables and columns.

### 1.3 Spacing System

Follow Tailwind's 4px base grid. Standardized spacing tokens for the app:

| Token | Value | Usage |
|---|---|---|
| `gap-page` | `p-6` (24px) | Main content padding |
| `gap-section` | `space-y-6` (24px) | Between major sections |
| `gap-card-inner` | `p-5` (20px) | Inside cards |
| `gap-items` | `space-y-4` (16px) | Between items in a list |
| `gap-inline` | `space-x-3` (12px) | Between inline elements |
| `gap-tight` | `space-x-2` / `space-y-2` (8px) | Tight groupings |

### 1.4 Card & Container Styles

All cards use HeroUI `<Card>` with customized classes:

```
Standard card:
  className="bg-surface-raised border border-white/5 shadow-lg shadow-black/10"

Elevated card (stats, important):
  className="bg-surface-raised border border-white/5 shadow-xl shadow-black/20"

Interactive card (clickable markets):
  className="bg-surface-raised border border-white/5 shadow-lg
             hover:border-accent/30 hover:shadow-accent/5
             transition-all duration-200 cursor-pointer"

Danger card (emergency controls):
  className="bg-surface-raised border border-loss/20 shadow-lg"
```

Border radius: HeroUI default (`rounded-large` = 14px). Override to `rounded-xl` where needed.

### 1.5 Data Visualization Color Scheme

For charts (recommended library: `recharts` or `lightweight-charts`):

| Series / Meaning | Hex | CSS variable suggestion |
|---|---|---|
| Primary line | `#6366F1` | `--chart-primary` |
| Profit area fill | `rgba(34,197,94,0.2)` | `--chart-profit-fill` |
| Loss area fill | `rgba(239,68,68,0.2)` | `--chart-loss-fill` |
| Volume bars | `#3B82F6` | `--chart-volume` |
| Grid lines | `#1F2937` | `--chart-grid` |
| Tooltip bg | `#111827` | `--chart-tooltip-bg` |
| Category 1 | `#8B5CF6` | purple |
| Category 2 | `#EC4899` | pink |
| Category 3 | `#F59E0B` | amber |
| Category 4 | `#14B8A6` | teal |
| Category 5 | `#6366F1` | indigo |

Pie / donut chart allocations use the Category 1-5 colors above.

### 1.6 Loading States & Skeleton Screens

Every data-driven section must have a skeleton fallback. Use HeroUI `<Skeleton>`:

```tsx
// StatCard skeleton
<Card className="bg-surface-raised border border-white/5">
  <CardBody className="p-5 space-y-3">
    <Skeleton className="w-24 h-3 rounded-md" />   {/* label */}
    <Skeleton className="w-32 h-8 rounded-md" />   {/* value */}
    <Skeleton className="w-16 h-3 rounded-md" />   {/* trend */}
  </CardBody>
</Card>

// Table skeleton -- repeat 5 rows
<div className="space-y-2">
  {Array.from({ length: 5 }).map((_, i) => (
    <Skeleton key={i} className="w-full h-12 rounded-md" />
  ))}
</div>

// Chart skeleton
<Skeleton className="w-full h-64 rounded-xl" />
```

### 1.7 Empty States

Each page has a tailored empty state placed where data would normally render:

| Page | Illustration idea | Headline | Subtext | CTA |
|---|---|---|---|---|
| Dashboard | Chart icon | "No data yet" | "Connect your wallet and start trading to see your dashboard" | "Explore Markets" button |
| Markets | Search icon | "No markets found" | "Try adjusting your filters or search query" | "Clear Filters" |
| Portfolio | Briefcase icon | "No open positions" | "Browse markets and place your first bet" | "Explore Markets" |
| Strategies | Robot icon | "No strategies configured" | "Create your first automated strategy" | "Create Strategy" |
| Trade History | Clock icon | "No trade history" | "Your completed trades will appear here" | "Explore Markets" |
| Bot Panel | Terminal icon | "Bot not configured" | "Set up your API keys and configure the bot" | "Go to Settings" |

Layout: center-aligned, max-width `max-w-sm mx-auto text-center py-16`.

### 1.8 Error States

```tsx
// Inline error (inside a card that failed to load)
<Card className="bg-surface-raised border border-loss/20">
  <CardBody className="p-5 text-center space-y-3">
    <div className="text-loss text-2xl">!</div>
    <p className="text-text-primary font-medium">Failed to load data</p>
    <p className="text-text-secondary text-sm">Check your connection and try again.</p>
    <Button size="sm" variant="flat" color="danger" onPress={retry}>
      Retry
    </Button>
  </CardBody>
</Card>

// Full-page error (500 / unexpected)
// Rendered in app/error.tsx -- uses same pattern but with larger text and
// a "Go Home" secondary button.
```

---

## 2. Dashboard Pages & Layout System

### 2.1 Page Hierarchy & Routes

```
/                       -- Main Dashboard (Home)
/markets                -- Markets Explorer
/markets/[id]           -- Market Detail (dynamic route)
/portfolio              -- Portfolio & Positions
/strategies             -- Strategy Management
/strategies/[id]        -- Strategy Detail
/strategies/new         -- Create Strategy Wizard
/history                -- Trade History & Analytics
/bot                    -- Bot Control Panel
/alerts                 -- Alerts & Notifications
/settings               -- Settings (existing)
```

### 2.2 Overall App Layout

The existing layout in `app/layout.tsx` uses Header + Sidebar + Main. We enhance it to support a collapsible sidebar, fixed header, and scrollable main content.

```
+----------------------------------------------------------+
|  HEADER (h-14, fixed top, full width, z-50)              |
|  [hamburger] [logo] [breadcrumb]     [alerts] [theme] [avatar] |
+----------+-----------------------------------------------+
|          |                                               |
| SIDEBAR  |  MAIN CONTENT AREA                            |
| (w-64    |  (flex-1, overflow-y-auto, p-6)               |
| fixed    |                                               |
| left,    |  Scrollable. All page content renders here.   |
| top-14,  |                                               |
| h-[calc( |                                               |
| 100vh-   |                                               |
| 56px)])  |                                               |
|          |                                               |
+----------+-----------------------------------------------+
```

#### Updated `app/layout.tsx` structure:

```tsx
<html lang="en" className="dark" suppressHydrationWarning>
  <body className="font-sans antialiased bg-surface dark:bg-surface light:bg-white">
    <HeroUIProvider>
      <ThemeProvider>
        <div className="min-h-screen flex flex-col">
          <Header />  {/* fixed, h-14, z-50 */}
          <div className="flex flex-1 pt-14"> {/* offset for fixed header */}
            <Sidebar /> {/* fixed, w-64 or w-16 collapsed */}
            <main className="flex-1 ml-64 lg:ml-64 md:ml-16
                            transition-all duration-300 p-6
                            overflow-y-auto">
              {children}
            </main>
          </div>
        </div>
        <ToastContainer /> {/* global toast notifications */}
      </ThemeProvider>
    </HeroUIProvider>
  </body>
</html>
```

### 2.3 Sidebar Navigation

The sidebar has two states: expanded (w-64) and collapsed (w-16, icons only). On mobile (< md), it becomes an overlay drawer.

**Navigation items** (updated from existing 3 to full set):

| Icon | Label | Route | Section divider |
|---|---|---|---|
| LayoutDashboard | Dashboard | `/` | -- |
| Globe | Markets | `/markets` | -- |
| Briefcase | Portfolio | `/portfolio` | -- |
| Brain | Strategies | `/strategies` | AUTOMATION |
| History | History | `/history` | -- |
| Bot | Bot Control | `/bot` | -- |
| Bell | Alerts | `/alerts` | NOTIFICATIONS |
| Settings | Settings | `/settings` | SYSTEM |

Sidebar footer: bot status mini indicator (green dot = running, red = stopped).

```tsx
// Active nav item
className="flex items-center space-x-3 px-3 py-2.5 rounded-lg
           bg-accent/10 text-accent border-l-2 border-accent font-medium"

// Inactive nav item
className="flex items-center space-x-3 px-3 py-2.5 rounded-lg
           text-text-secondary hover:bg-surface-overlay hover:text-text-primary
           transition-colors duration-150"

// Section divider
className="px-3 pt-6 pb-2 text-[10px] font-semibold uppercase tracking-widest
           text-text-disabled"
```

### 2.4 Header

Enhance the existing `Header.tsx`:

```
[hamburger] [PolyBot logo+text] [breadcrumb: Dashboard > ...]
                                        [search] [notifications bell + badge] [theme toggle] [avatar dropdown]
```

- Breadcrumb: auto-generated from route segments using `usePathname()`
- Notification bell: HeroUI `<Badge>` with count, opens dropdown
- Search: `<Input>` with `Cmd+K` shortcut hint, opens command palette modal

### 2.5 Responsive Breakpoints

| Breakpoint | Tailwind | Sidebar | Grid cols | Behavior |
|---|---|---|---|---|
| >= 1280px (xl) | `xl:` | Expanded (w-64) | 12-col grid available | Full desktop |
| >= 1024px (lg) | `lg:` | Expanded (w-64) | 12-col, some 8-col sections | Desktop |
| >= 768px (md) | `md:` | Collapsed (w-16, icons only) | 8-col or 6-col | Tablet |
| >= 640px (sm) | `sm:` | Hidden (hamburger opens overlay) | 4-col | Large mobile |
| < 640px | default | Hidden (hamburger opens overlay) | 1-col (stacked) | Mobile |

### 2.6 Dark Mode as Primary

The `ThemeProvider` should default to dark. Update the existing `useAppStore.ts`:

```ts
theme: 'dark',  // changed from 'light'
```

In `ThemeProvider.tsx`, if no saved preference exists and no system preference is detected, default to `'dark'`.

---

## 3. Main Dashboard (Home)

Route: `/` -- File: `app/page.tsx`

### 3.1 Layout (12-column grid)

```
Row 1: Stats bar (4 StatCards)
  [Portfolio Value + sparkline]  [Today's P&L]  [Open Positions]  [Total Exposure]
  cols: 3 + 3 + 3 + 3

Row 2: Charts + Activity
  [Portfolio value line chart (7 cols)]  [Active Strategies summary (5 cols)]

Row 3: Activity + Opportunities
  [Recent Activity Feed (7 cols)]  [Market Movers / Top Opportunities (5 cols)]

Row 4: Quick Actions
  [Quick action button bar, full width]
```

Tailwind grid: `grid grid-cols-12 gap-6`

### 3.2 Portfolio Value StatCard

```tsx
<Card className="col-span-12 sm:col-span-6 xl:col-span-3 bg-surface-raised border border-white/5">
  <CardBody className="p-5">
    <p className="text-xs font-medium text-text-secondary uppercase tracking-wider">
      Portfolio Value
    </p>
    <div className="flex items-end justify-between mt-2">
      <p className="text-2xl font-bold font-mono tabular-nums text-text-primary">
        $12,450.32
      </p>
      <SparklineChart data={last7days} color="profit" className="w-20 h-8" />
    </div>
    <p className="text-xs text-profit mt-1 font-medium">
      +$342.18 (2.83%) today
    </p>
  </CardBody>
</Card>
```

### 3.3 Today's P&L Card

Shows absolute dollar P&L and percentage. Color-coded: `text-profit` if positive, `text-loss` if negative.

```tsx
<div className="flex items-baseline space-x-2 mt-2">
  <p className="text-2xl font-bold font-mono tabular-nums text-profit">
    +$342.18
  </p>
  <PnLBadge value={2.83} /> {/* renders green badge with +2.83% */}
</div>
```

### 3.4 Active Strategies Summary

A card containing a compact list of strategies with status indicators:

```tsx
// Each strategy row
<div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
  <div className="flex items-center space-x-3">
    <StrategyStatusBadge status="running" /> {/* green pulse dot */}
    <span className="text-sm text-text-primary">Momentum Alpha</span>
  </div>
  <span className="text-xs font-mono text-profit">+5.2%</span>
</div>
```

Status indicators:
- Running: `bg-profit` pulsing dot (Tailwind `animate-pulse`)
- Paused: `bg-warning` static dot
- Error: `bg-loss` static dot with exclamation

### 3.5 Recent Activity Feed

A scrollable list (max-h-80 overflow-y-auto) of recent events:

```tsx
<div className="space-y-3">
  {activities.map(a => (
    <div key={a.id} className="flex items-start space-x-3">
      <div className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
        a.type === 'buy' ? 'bg-profit' :
        a.type === 'sell' ? 'bg-loss' : 'bg-info'
      }`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-primary truncate">{a.description}</p>
        <p className="text-xs text-text-tertiary">{a.timeAgo}</p>
      </div>
      {a.amount && (
        <span className="text-sm font-mono tabular-nums text-text-secondary">
          {a.amount}
        </span>
      )}
    </div>
  ))}
</div>
```

### 3.6 Quick Action Buttons

Full-width bar at bottom of dashboard:

```tsx
<div className="flex flex-wrap gap-3">
  <Button color="primary" startContent={<PlusIcon />}>Place Bet</Button>
  <Button variant="flat" color="secondary" startContent={<PlayIcon />}>Start Strategy</Button>
  <Button variant="flat" color="default" startContent={<WalletIcon />}>Deposit</Button>
</div>
```

### 3.7 Market Movers Widget

Top 5 markets by 24h volume change, shown as compact rows:

```tsx
<div className="space-y-2">
  {movers.map(m => (
    <div key={m.id} className="flex items-center justify-between p-2 rounded-lg
                                hover:bg-surface-overlay transition-colors cursor-pointer">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-primary truncate">{m.title}</p>
        <p className="text-xs text-text-tertiary">{m.category}</p>
      </div>
      <div className="text-right ml-3">
        <PriceDisplay price={m.price} />
        <PnLBadge value={m.change24h} size="sm" />
      </div>
    </div>
  ))}
</div>
```

---

## 4. Markets Explorer Page

Route: `/markets` -- File: `app/markets/page.tsx`

### 4.1 Layout

```
Row 1: Page header + controls
  [Title: "Markets"]  [Search input]  [Grid/List toggle]  [Sort dropdown]

Row 2: Category tabs
  [All] [Politics] [Crypto] [Sports] [Finance] [Science] [Culture] [Custom...]

Row 3: Market cards grid
  Grid view: grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4
  List view: single column, table-like rows
```

### 4.2 Search with Autocomplete

Use HeroUI `<Autocomplete>`:

```tsx
<Autocomplete
  className="max-w-md"
  inputProps={{
    classNames: {
      input: "bg-surface-overlay border-white/10",
    },
  }}
  label="Search markets"
  placeholder="Search by title, category, or keyword..."
  startContent={<SearchIcon className="text-text-tertiary" />}
>
  {filteredMarkets.map(m => (
    <AutocompleteItem key={m.id} textValue={m.title}>
      <div className="flex justify-between">
        <span>{m.title}</span>
        <PriceDisplay price={m.price} size="sm" />
      </div>
    </AutocompleteItem>
  ))}
</Autocomplete>
```

### 4.3 Category Tabs

Use HeroUI `<Tabs>`:

```tsx
<Tabs
  variant="underlined"
  color="primary"
  classNames={{
    tabList: "gap-4 border-b border-white/5",
    tab: "text-text-secondary data-[selected=true]:text-accent",
  }}
>
  <Tab key="all" title="All" />
  <Tab key="politics" title="Politics" />
  <Tab key="crypto" title="Crypto" />
  <Tab key="sports" title="Sports" />
  <Tab key="finance" title="Finance" />
  <Tab key="science" title="Science" />
  <Tab key="culture" title="Culture" />
</Tabs>
```

### 4.4 MarketCard (Grid View)

```tsx
<Card className="bg-surface-raised border border-white/5 hover:border-accent/30
                 transition-all duration-200 cursor-pointer">
  <CardBody className="p-4 space-y-3">
    {/* Category badge */}
    <Chip size="sm" variant="flat" color="secondary" className="text-xs">
      Politics
    </Chip>

    {/* Title */}
    <h3 className="text-sm font-medium text-text-primary line-clamp-2 leading-snug">
      Will the US federal government shut down before March 2026?
    </h3>

    {/* Price bar -- YES/NO */}
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs">
        <span className="text-profit font-medium">Yes 62c</span>
        <span className="text-loss font-medium">No 38c</span>
      </div>
      <div className="h-2 rounded-full bg-surface-overlay overflow-hidden flex">
        <div className="bg-profit h-full" style={{ width: '62%' }} />
        <div className="bg-loss h-full" style={{ width: '38%' }} />
      </div>
    </div>

    {/* Metadata row */}
    <div className="flex items-center justify-between text-xs text-text-tertiary">
      <span>Vol: $1.2M</span>
      <span>Liq: $450K</span>
      <span>Ends: Mar 15</span>
    </div>
  </CardBody>
</Card>
```

### 4.5 Sorting Options

HeroUI `<Dropdown>`:

```tsx
<Dropdown>
  <DropdownTrigger>
    <Button variant="flat" size="sm" endContent={<ChevronDownIcon />}>
      Sort: Volume
    </Button>
  </DropdownTrigger>
  <DropdownMenu aria-label="Sort markets" selectionMode="single">
    <DropdownItem key="volume">Volume (High to Low)</DropdownItem>
    <DropdownItem key="liquidity">Liquidity</DropdownItem>
    <DropdownItem key="expiry">Time to Expiry</DropdownItem>
    <DropdownItem key="priceChange">Price Change (24h)</DropdownItem>
    <DropdownItem key="newest">Newest</DropdownItem>
  </DropdownMenu>
</Dropdown>
```

### 4.6 Market Detail (Modal or Page)

Route: `/markets/[id]` -- or rendered as a HeroUI `<Modal size="4xl">`.

Layout:

```
Left column (8 cols):
  - Market title + category badge + resolution date
  - Price chart (lightweight-charts or recharts, h-80)
  - TimeframeSelector: [1H] [1D] [1W] [1M] [ALL]
  - Order book visualization (bid/ask depth)

Right column (4 cols):
  - Trade panel card:
    - [Buy YES] [Buy NO] toggle
    - Amount input with position size slider
    - Estimated cost, shares, avg price
    - [Place Order] button
  - Market info card:
    - Volume, Liquidity, Open Interest
    - Resolution source
    - Related markets
```

---

## 5. Portfolio & Positions Page

Route: `/portfolio` -- File: `app/portfolio/page.tsx`

### 5.1 Layout

```
Row 1: Summary stats (4 cards)
  [Total Value]  [Unrealized P&L]  [Realized P&L]  [# Positions]
  cols: 3 + 3 + 3 + 3

Row 2: Chart + Allocation
  [Portfolio value over time -- line chart (8 cols)]  [Allocation donut (4 cols)]

Row 3: Positions table (full 12 cols)
  Expandable rows with order history
```

### 5.2 Positions Table

Use HeroUI `<Table>`:

```tsx
<Table
  aria-label="Open positions"
  classNames={{
    wrapper: "bg-surface-raised border border-white/5",
    th: "bg-surface-overlay text-text-secondary text-xs uppercase",
    td: "text-sm py-3",
  }}
  sortDescriptor={sortDescriptor}
  onSortChange={setSortDescriptor}
>
  <TableHeader>
    <TableColumn key="market" allowsSorting>Market</TableColumn>
    <TableColumn key="side" allowsSorting>Side</TableColumn>
    <TableColumn key="shares" allowsSorting>Shares</TableColumn>
    <TableColumn key="avgCost" allowsSorting>Avg Cost</TableColumn>
    <TableColumn key="currentPrice" allowsSorting>Current</TableColumn>
    <TableColumn key="pnl" allowsSorting>P&L ($)</TableColumn>
    <TableColumn key="pnlPct" allowsSorting>P&L %</TableColumn>
    <TableColumn key="actions">Actions</TableColumn>
  </TableHeader>
  <TableBody>
    {positions.map(pos => (
      <TableRow key={pos.id} className="hover:bg-surface-overlay/50 cursor-pointer"
                onClick={() => toggleExpand(pos.id)}>
        <TableCell>
          <span className="text-text-primary font-medium">{pos.marketTitle}</span>
        </TableCell>
        <TableCell>
          <Chip size="sm" variant="flat"
                color={pos.side === 'YES' ? 'success' : 'danger'}>
            {pos.side}
          </Chip>
        </TableCell>
        <TableCell className="font-mono tabular-nums">{pos.shares}</TableCell>
        <TableCell className="font-mono tabular-nums">${pos.avgCost.toFixed(2)}</TableCell>
        <TableCell>
          <PriceDisplay price={pos.currentPrice} />
        </TableCell>
        <TableCell>
          <span className={pos.pnl >= 0 ? 'text-profit' : 'text-loss'}>
            {pos.pnl >= 0 ? '+' : ''}{pos.pnl.toFixed(2)}
          </span>
        </TableCell>
        <TableCell>
          <PnLBadge value={pos.pnlPct} />
        </TableCell>
        <TableCell>
          <Button size="sm" variant="flat" color="danger">Close</Button>
        </TableCell>
      </TableRow>
    ))}
  </TableBody>
</Table>
```

### 5.3 Expanded Row (Order History)

When a row is clicked, an expansion panel appears below it:

```tsx
<div className="p-4 bg-surface-overlay/50 border-t border-white/5">
  <p className="text-xs text-text-secondary uppercase font-semibold mb-3">Order History</p>
  <div className="space-y-2">
    {pos.orders.map(order => (
      <div key={order.id} className="flex items-center justify-between text-xs">
        <span className="text-text-tertiary">{order.timestamp}</span>
        <Chip size="sm" variant="dot"
              color={order.side === 'BUY' ? 'success' : 'danger'}>
          {order.side}
        </Chip>
        <span className="font-mono">{order.shares} @ ${order.price}</span>
        <span className="text-text-secondary">${order.total}</span>
      </div>
    ))}
  </div>
</div>
```

### 5.4 Allocation Donut Chart

Uses `recharts` `<PieChart>` with the Category 1-5 color scheme:

```tsx
const COLORS = ['#8B5CF6', '#EC4899', '#F59E0B', '#14B8A6', '#6366F1'];

<PieChart width={280} height={280}>
  <Pie
    data={allocationData}
    innerRadius={70}
    outerRadius={110}
    paddingAngle={3}
    dataKey="value"
  >
    {allocationData.map((_, idx) => (
      <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
    ))}
  </Pie>
  <Tooltip contentStyle={{ background: '#111827', border: '1px solid rgba(255,255,255,0.1)' }} />
</PieChart>
```

Center label overlay: total value in `text-xl font-bold font-mono`.

### 5.5 Realized vs Unrealized P&L Breakdown

Two-column stat display within a card:

```tsx
<div className="grid grid-cols-2 gap-6">
  <div>
    <p className="text-xs text-text-secondary uppercase">Unrealized P&L</p>
    <p className="text-xl font-bold font-mono tabular-nums text-profit mt-1">+$1,245.67</p>
  </div>
  <div>
    <p className="text-xs text-text-secondary uppercase">Realized P&L</p>
    <p className="text-xl font-bold font-mono tabular-nums text-profit mt-1">+$3,102.44</p>
  </div>
</div>
```

---

## 6. Strategy Management Page

Route: `/strategies` -- File: `app/strategies/page.tsx`

### 6.1 Layout

```
Row 1: Header + CTA
  [Title: "Strategies"]  [+ Create Strategy button]

Row 2: Strategy cards (grid)
  grid-cols-1 md:grid-cols-2 xl:grid-cols-3

Row 3: Strategy comparison table (toggleable, full width)
```

### 6.2 Strategy Card

```tsx
<Card className="bg-surface-raised border border-white/5">
  <CardHeader className="flex justify-between items-start pb-0">
    <div>
      <h3 className="text-base font-semibold text-text-primary">Momentum Alpha</h3>
      <p className="text-xs text-text-tertiary mt-0.5">Created Jan 15, 2026</p>
    </div>
    <StrategyStatusBadge status="active" />
  </CardHeader>
  <CardBody className="pt-4 space-y-4">
    {/* Equity curve mini chart */}
    <div className="h-24 w-full">
      <SparklineChart data={equityCurve} color="accent" fill />
    </div>

    {/* Performance metrics grid */}
    <div className="grid grid-cols-2 gap-3">
      <div>
        <p className="text-[10px] text-text-tertiary uppercase">ROI</p>
        <p className="text-sm font-bold font-mono text-profit">+24.5%</p>
      </div>
      <div>
        <p className="text-[10px] text-text-tertiary uppercase">Sharpe</p>
        <p className="text-sm font-bold font-mono text-text-primary">1.82</p>
      </div>
      <div>
        <p className="text-[10px] text-text-tertiary uppercase">Win Rate</p>
        <p className="text-sm font-bold font-mono text-text-primary">67%</p>
      </div>
      <div>
        <p className="text-[10px] text-text-tertiary uppercase">Max DD</p>
        <p className="text-sm font-bold font-mono text-loss">-8.3%</p>
      </div>
    </div>

    {/* Action buttons */}
    <div className="flex gap-2">
      <Button size="sm" variant="flat" color="warning" className="flex-1">Pause</Button>
      <Button size="sm" variant="flat" color="default" className="flex-1">Edit</Button>
      <Button size="sm" isIconOnly variant="flat" color="danger" aria-label="Delete">
        <TrashIcon className="w-4 h-4" />
      </Button>
    </div>
  </CardBody>
</Card>
```

### 6.3 StrategyStatusBadge

```tsx
const statusConfig = {
  active:      { color: 'success', label: 'Active',      dot: 'bg-profit animate-pulse' },
  paused:      { color: 'warning', label: 'Paused',      dot: 'bg-warning' },
  backtesting: { color: 'primary', label: 'Backtesting', dot: 'bg-info animate-pulse' },
  error:       { color: 'danger',  label: 'Error',       dot: 'bg-loss' },
  stopped:     { color: 'default', label: 'Stopped',     dot: 'bg-text-disabled' },
};

<Chip
  size="sm"
  variant="dot"
  color={statusConfig[status].color}
  classNames={{
    dot: statusConfig[status].dot,
  }}
>
  {statusConfig[status].label}
</Chip>
```

### 6.4 Strategy Configuration Wizard

Route: `/strategies/new` -- multi-step form.

Steps (use HeroUI `<Tabs>` or custom stepper):

1. **Basic Info**: Name, description, category focus
2. **Entry Rules**: Conditions for entering a position (price thresholds, volume filters, etc.)
3. **Exit Rules**: Take-profit %, stop-loss %, time-based exit
4. **Position Sizing**: Fixed amount, percentage of portfolio, Kelly criterion
5. **Risk Management**: Max positions, max exposure per market, daily loss limit
6. **Review & Deploy**: Summary of all settings, [Deploy] or [Backtest First] buttons

Each step uses HeroUI form components: `<Input>`, `<Select>`, `<Slider>`, `<Switch>`, `<RadioGroup>`.

### 6.5 Strategy Comparison View

Side-by-side table comparing 2-4 strategies:

```tsx
<Table aria-label="Strategy comparison" classNames={{
  wrapper: "bg-surface-raised border border-white/5",
}}>
  <TableHeader>
    <TableColumn>Metric</TableColumn>
    <TableColumn>Momentum Alpha</TableColumn>
    <TableColumn>Mean Reversion</TableColumn>
    <TableColumn>News Sentiment</TableColumn>
  </TableHeader>
  <TableBody>
    <TableRow><TableCell>ROI</TableCell><TableCell className="text-profit">+24.5%</TableCell>...</TableRow>
    <TableRow><TableCell>Sharpe Ratio</TableCell><TableCell>1.82</TableCell>...</TableRow>
    <TableRow><TableCell>Win Rate</TableCell><TableCell>67%</TableCell>...</TableRow>
    <TableRow><TableCell>Max Drawdown</TableCell><TableCell className="text-loss">-8.3%</TableCell>...</TableRow>
    <TableRow><TableCell>Total Trades</TableCell><TableCell>142</TableCell>...</TableRow>
    <TableRow><TableCell>Avg Trade</TableCell><TableCell className="text-profit">+$18.42</TableCell>...</TableRow>
  </TableBody>
</Table>
```

### 6.6 Strategy Detail Page

Route: `/strategies/[id]`

```
Row 1: Header
  [Strategy name]  [Status badge]  [Edit] [Pause] [Delete]

Row 2: Performance stats (4 StatCards)

Row 3: Equity curve chart (full width, h-96)
  TimeframeSelector below chart

Row 4: Trade log table
  Columns: Date, Market, Side, Shares, Entry, Exit, P&L, Duration
```

---

## 7. Trade History & Analytics Page

Route: `/history` -- File: `app/history/page.tsx`

### 7.1 Layout

```
Row 1: Header + Filters
  [Title]  [Date range picker]  [Category filter]  [Side filter]  [Export CSV]

Row 2: Analytics summary (4 StatCards)
  [Total Trades]  [Win Rate]  [Avg Win / Avg Loss]  [Profit Factor]

Row 3: Charts (two side-by-side)
  [Cumulative P&L chart (8 cols)]  [Win/Loss ratio donut (4 cols)]

Row 4: P&L Calendar Heatmap (full 12 cols)

Row 5: Additional analytics
  [Category Performance Breakdown (6 cols)]  [Time-of-Day Analysis (6 cols)]

Row 6: Full trade log table (12 cols)
```

### 7.2 P&L Calendar Heatmap

Inspired by GitHub's contribution graph. Shows daily P&L as colored squares over the past year.

```tsx
// Color scale:
// Large loss:  bg-loss             (#EF4444)
// Small loss:  bg-loss/40          (40% opacity)
// Flat:        bg-surface-overlay  (neutral)
// Small profit: bg-profit/40
// Large profit: bg-profit

<div className="flex gap-[3px]">
  {weeks.map((week, wi) => (
    <div key={wi} className="flex flex-col gap-[3px]">
      {week.days.map((day, di) => (
        <Tooltip key={di} content={`${day.date}: ${day.pnl > 0 ? '+' : ''}$${day.pnl}`}>
          <div
            className={`w-3 h-3 rounded-sm ${getPnLColor(day.pnl)}`}
          />
        </Tooltip>
      ))}
    </div>
  ))}
</div>

// Legend
<div className="flex items-center gap-2 mt-2 text-xs text-text-tertiary">
  <span>Loss</span>
  <div className="flex gap-[2px]">
    <div className="w-3 h-3 rounded-sm bg-loss" />
    <div className="w-3 h-3 rounded-sm bg-loss/40" />
    <div className="w-3 h-3 rounded-sm bg-surface-overlay" />
    <div className="w-3 h-3 rounded-sm bg-profit/40" />
    <div className="w-3 h-3 rounded-sm bg-profit" />
  </div>
  <span>Profit</span>
</div>
```

### 7.3 Cumulative P&L Chart

Line chart using recharts `<AreaChart>`:

- X-axis: dates
- Y-axis: cumulative P&L in dollars
- Fill: gradient from `profit` (above 0) and `loss` (below 0)
- Reference line at y=0

```tsx
<AreaChart data={cumulativePnL}>
  <defs>
    <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="#22C55E" stopOpacity={0.3} />
      <stop offset="100%" stopColor="#22C55E" stopOpacity={0} />
    </linearGradient>
  </defs>
  <XAxis dataKey="date" stroke="#6B7280" fontSize={11} />
  <YAxis stroke="#6B7280" fontSize={11} tickFormatter={v => `$${v}`} />
  <CartesianGrid stroke="#1F2937" strokeDasharray="3 3" />
  <ReferenceLine y={0} stroke="#374151" />
  <Area
    type="monotone"
    dataKey="pnl"
    stroke="#22C55E"
    fill="url(#profitGrad)"
    strokeWidth={2}
  />
  <Tooltip contentStyle={{ background: '#111827', border: '1px solid rgba(255,255,255,0.1)' }} />
</AreaChart>
```

### 7.4 Win/Loss Ratio Visualization

Donut chart center-labeled with win rate percentage:

```
  Win: 67% (green segment)
  Loss: 33% (red segment)
  Center text: "67%" in large bold
```

### 7.5 Category Performance Breakdown

Horizontal bar chart showing P&L by market category:

```
  Politics   ████████████  +$2,450
  Crypto     ██████        +$1,200
  Sports     ████          +$800
  Finance    ██            -$320  (red bar extending left)
```

### 7.6 Time-of-Day Analysis

Bar chart showing trading activity and average P&L by hour of day (0-23). Identifies the user's most profitable trading hours.

### 7.7 Full Trade Log

HeroUI `<Table>` with:
- Pagination: `<Pagination>` below table
- Columns: Date, Market, Side, Shares, Entry Price, Exit Price, P&L, P&L%, Duration, Strategy
- All columns sortable
- Filter chips above table for active filters

---

## 8. Bot Control Panel Page

Route: `/bot` -- File: `app/bot/page.tsx`

### 8.1 Layout

```
Row 1: Bot status hero card (full width)
  [Large status indicator]  [Uptime]  [Started at]  [EMERGENCY STOP button]

Row 2: Resource usage + Active instances
  [Resource Usage card (4 cols)]  [Active Strategy Instances table (8 cols)]

Row 3: Configuration + Live logs
  [Configuration settings (4 cols)]  [Live log stream (8 cols)]
```

### 8.2 Bot Status Hero Card

```tsx
<Card className="bg-surface-raised border border-white/5">
  <CardBody className="p-6">
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-4">
        {/* Large pulsing status indicator */}
        <div className={`w-4 h-4 rounded-full ${
          botStatus === 'running' ? 'bg-profit animate-pulse' :
          botStatus === 'stopped' ? 'bg-text-disabled' :
          'bg-loss animate-pulse'
        }`} />
        <div>
          <h2 className="text-xl font-bold text-text-primary">
            Bot {botStatus === 'running' ? 'Running' :
                 botStatus === 'stopped' ? 'Stopped' : 'Error'}
          </h2>
          <p className="text-sm text-text-secondary">
            Uptime: 3d 14h 22m | Started: Feb 7, 2026 10:15 AM
          </p>
        </div>
      </div>

      {/* Emergency Stop -- always visible, prominent */}
      <Button
        color="danger"
        size="lg"
        variant="solid"
        className="bg-loss hover:bg-loss-light font-bold uppercase tracking-wide
                   shadow-lg shadow-loss/25 min-w-[160px]"
        startContent={<StopIcon className="w-5 h-5" />}
      >
        Emergency Stop
      </Button>
    </div>
  </CardBody>
</Card>
```

### 8.3 Resource Usage Card

```tsx
<Card className="col-span-4 bg-surface-raised border border-white/5">
  <CardHeader><h3 className="text-base font-semibold">Resource Usage</h3></CardHeader>
  <CardBody className="space-y-4">
    {/* API Calls */}
    <div>
      <div className="flex justify-between text-xs text-text-secondary mb-1">
        <span>API Calls (24h)</span>
        <span>8,432 / 10,000</span>
      </div>
      <Progress value={84.32} color="warning" size="sm"
                classNames={{ track: "bg-surface-overlay" }} />
    </div>

    {/* Rate Limit */}
    <div>
      <div className="flex justify-between text-xs text-text-secondary mb-1">
        <span>Rate Limit Remaining</span>
        <span>156 / 200 per min</span>
      </div>
      <Progress value={78} color="success" size="sm"
                classNames={{ track: "bg-surface-overlay" }} />
    </div>

    {/* Memory */}
    <div>
      <div className="flex justify-between text-xs text-text-secondary mb-1">
        <span>Memory Usage</span>
        <span>245 MB</span>
      </div>
      <Progress value={24.5} color="primary" size="sm"
                classNames={{ track: "bg-surface-overlay" }} />
    </div>
  </CardBody>
</Card>
```

### 8.4 Active Strategy Instances

Table with start/stop/pause controls per instance:

```tsx
<Table classNames={{ wrapper: "bg-surface-raised border border-white/5" }}>
  <TableHeader>
    <TableColumn>Strategy</TableColumn>
    <TableColumn>Status</TableColumn>
    <TableColumn>Uptime</TableColumn>
    <TableColumn>Trades Today</TableColumn>
    <TableColumn>P&L Today</TableColumn>
    <TableColumn>Controls</TableColumn>
  </TableHeader>
  <TableBody>
    {instances.map(inst => (
      <TableRow key={inst.id}>
        <TableCell className="font-medium">{inst.name}</TableCell>
        <TableCell><StrategyStatusBadge status={inst.status} /></TableCell>
        <TableCell className="text-text-secondary text-sm">{inst.uptime}</TableCell>
        <TableCell className="font-mono">{inst.tradesToday}</TableCell>
        <TableCell>
          <PnLBadge value={inst.pnlToday} />
        </TableCell>
        <TableCell>
          <div className="flex gap-1">
            {inst.status === 'active' ? (
              <Button size="sm" isIconOnly variant="flat" color="warning" aria-label="Pause">
                <PauseIcon className="w-4 h-4" />
              </Button>
            ) : (
              <Button size="sm" isIconOnly variant="flat" color="success" aria-label="Start">
                <PlayIcon className="w-4 h-4" />
              </Button>
            )}
            <Button size="sm" isIconOnly variant="flat" color="danger" aria-label="Stop">
              <StopIcon className="w-4 h-4" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
    ))}
  </TableBody>
</Table>
```

### 8.5 Live Log Stream Viewer

```tsx
<Card className="col-span-8 bg-surface-raised border border-white/5">
  <CardHeader className="flex justify-between items-center">
    <h3 className="text-base font-semibold">Live Logs</h3>
    <div className="flex gap-2">
      <Chip size="sm" variant="flat"
            className={logFilter === 'all' ? 'bg-accent/20 text-accent' : ''}
            onClick={() => setLogFilter('all')}>All</Chip>
      <Chip size="sm" variant="flat"
            className={logFilter === 'error' ? 'bg-loss/20 text-loss' : ''}
            onClick={() => setLogFilter('error')}>Errors</Chip>
      <Chip size="sm" variant="flat"
            className={logFilter === 'trade' ? 'bg-profit/20 text-profit' : ''}
            onClick={() => setLogFilter('trade')}>Trades</Chip>
    </div>
  </CardHeader>
  <CardBody className="p-0">
    <div className="bg-[#0a0a0a] font-mono text-xs p-4 h-80 overflow-y-auto
                    scrollbar-thin scrollbar-thumb-surface-subtle scrollbar-track-transparent">
      {logs.map((log, i) => (
        <div key={i} className="flex gap-3 py-0.5 hover:bg-white/5">
          <span className="text-text-disabled flex-shrink-0">{log.timestamp}</span>
          <span className={`flex-shrink-0 w-12 ${
            log.level === 'ERROR' ? 'text-loss' :
            log.level === 'WARN'  ? 'text-warning' :
            log.level === 'INFO'  ? 'text-info' : 'text-text-tertiary'
          }`}>{log.level}</span>
          <span className="text-text-secondary">{log.message}</span>
        </div>
      ))}
      <div ref={logEndRef} /> {/* auto-scroll anchor */}
    </div>
  </CardBody>
</Card>
```

### 8.6 Configuration Settings

Card with key bot settings (quick access, full settings at `/settings`):

- Max concurrent strategies: `<Input type="number">`
- Global daily loss limit: `<Input>` with $ prefix
- Auto-restart on error: `<Switch>`
- API endpoint: `<Input>` (read-only display)
- Polling interval: `<Select>` (1s, 5s, 10s, 30s, 60s)

---

## 9. Alerts & Notifications

### 9.1 Toast Notifications

Use a custom toast system or integrate `react-hot-toast` / `sonner` styled to match the design system.

Position: top-right, stacked. Auto-dismiss after 5 seconds (configurable).

```tsx
// Toast variants
const toastStyles = {
  success: 'bg-surface-raised border-l-4 border-profit text-text-primary',
  error:   'bg-surface-raised border-l-4 border-loss text-text-primary',
  warning: 'bg-surface-raised border-l-4 border-warning text-text-primary',
  info:    'bg-surface-raised border-l-4 border-info text-text-primary',
  trade:   'bg-surface-raised border-l-4 border-accent text-text-primary',
};

// Toast structure
<div className={`${toastStyles[type]} rounded-lg shadow-xl p-4 max-w-sm`}>
  <div className="flex items-start space-x-3">
    <Icon className="w-5 h-5 mt-0.5 flex-shrink-0" />
    <div className="flex-1 min-w-0">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-text-secondary mt-0.5">{message}</p>
    </div>
    <button className="text-text-tertiary hover:text-text-primary">
      <XIcon className="w-4 h-4" />
    </button>
  </div>
</div>
```

Real-time event types that trigger toasts:
- Trade executed (buy/sell)
- Strategy signal triggered
- P&L threshold hit
- Bot error / restart
- Market resolution

### 9.2 Alert Configuration Page

Route: `/alerts` -- File: `app/alerts/page.tsx`

```
Row 1: Header
  [Title: "Alerts"]  [+ Create Alert button]

Row 2: Active alerts table
  Columns: Name, Type, Condition, Status (On/Off switch), Last Triggered, Actions

Row 3: Notification history
  Scrollable list of past alerts with timestamps
```

Alert types:
- **Price Alert**: Market price crosses threshold (above/below X cents)
- **P&L Alert**: Portfolio P&L crosses threshold ($ or %)
- **Strategy Signal**: Specific strategy generates entry/exit signal
- **Volume Alert**: Market volume spike
- **Resolution Alert**: Market resolves

Create Alert Modal:

```tsx
<Modal size="lg" classNames={{ base: "bg-surface-raised" }}>
  <ModalContent>
    <ModalHeader>Create Alert</ModalHeader>
    <ModalBody className="space-y-4">
      <Select label="Alert Type" variant="bordered">
        <SelectItem key="price">Price Alert</SelectItem>
        <SelectItem key="pnl">P&L Threshold</SelectItem>
        <SelectItem key="strategy">Strategy Signal</SelectItem>
        <SelectItem key="volume">Volume Spike</SelectItem>
        <SelectItem key="resolution">Market Resolution</SelectItem>
      </Select>

      {/* Conditional fields based on type */}
      <Autocomplete label="Market" placeholder="Search market..." variant="bordered" />
      <div className="flex gap-3">
        <Select label="Condition" variant="bordered" className="flex-1">
          <SelectItem key="above">Price Above</SelectItem>
          <SelectItem key="below">Price Below</SelectItem>
        </Select>
        <Input label="Value" type="number" variant="bordered" className="flex-1"
               endContent={<span className="text-text-tertiary text-sm">c</span>} />
      </div>

      {/* Delivery channels */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-text-primary">Deliver via</p>
        <div className="flex gap-4">
          <Checkbox defaultSelected>In-App</Checkbox>
          <Checkbox>Email</Checkbox>
          <Checkbox>Webhook</Checkbox>
        </div>
      </div>
    </ModalBody>
    <ModalFooter>
      <Button variant="flat" color="default">Cancel</Button>
      <Button color="primary">Create Alert</Button>
    </ModalFooter>
  </ModalContent>
</Modal>
```

### 9.3 Notification History

```tsx
<div className="space-y-2">
  {notifications.map(n => (
    <div key={n.id} className={`flex items-start space-x-3 p-3 rounded-lg
                                ${n.read ? 'bg-transparent' : 'bg-accent/5'}`}>
      <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
        n.type === 'trade' ? 'bg-accent' :
        n.type === 'alert' ? 'bg-warning' :
        n.type === 'error' ? 'bg-loss' : 'bg-info'
      }`} />
      <div className="flex-1">
        <p className="text-sm text-text-primary">{n.title}</p>
        <p className="text-xs text-text-tertiary mt-0.5">{n.message}</p>
      </div>
      <span className="text-xs text-text-disabled flex-shrink-0">{n.timeAgo}</span>
    </div>
  ))}
</div>
```

---

## 10. Key UI Components to Build

### 10.1 PriceDisplay

File: `components/ui/PriceDisplay.tsx`

```tsx
interface PriceDisplayProps {
  price: number;
  previousPrice?: number;
  size?: 'sm' | 'md' | 'lg';
  showCents?: boolean; // show "c" suffix for prediction market cents
}

// Sizes
const sizes = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-lg',
};

export function PriceDisplay({ price, previousPrice, size = 'md', showCents = true }: PriceDisplayProps) {
  const change = previousPrice ? price - previousPrice : 0;
  const colorClass = change > 0 ? 'text-profit' : change < 0 ? 'text-loss' : 'text-text-primary';

  return (
    <span className={`font-mono tabular-nums ${sizes[size]} ${colorClass}`}>
      {showCents ? `${(price * 100).toFixed(0)}c` : `$${price.toFixed(2)}`}
      {change !== 0 && (
        <span className="ml-1 text-[0.75em]">
          {change > 0 ? '\u25B2' : '\u25BC'} {/* up/down triangle */}
        </span>
      )}
    </span>
  );
}
```

### 10.2 PnLBadge

File: `components/ui/PnLBadge.tsx`

```tsx
interface PnLBadgeProps {
  value: number; // percentage
  size?: 'sm' | 'md';
  showSign?: boolean;
}

export function PnLBadge({ value, size = 'md', showSign = true }: PnLBadgeProps) {
  const isPositive = value >= 0;
  const sizeClasses = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-1';

  return (
    <span className={`inline-flex items-center rounded-md font-mono font-medium tabular-nums
                      ${sizeClasses}
                      ${isPositive ? 'bg-profit-muted text-profit' : 'bg-loss-muted text-loss'}`}>
      {showSign && isPositive ? '+' : ''}{value.toFixed(2)}%
    </span>
  );
}
```

### 10.3 MarketCard

File: `components/ui/MarketCard.tsx`

(Fully described in section 4.4 above. The component accepts a `Market` object and renders the card with price bar, metadata, and category chip.)

### 10.4 OrderBookVisualization

File: `components/ui/OrderBookVisualization.tsx`

Renders a horizontal depth chart with bids (green, left) and asks (red, right):

```tsx
interface OrderBookProps {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}

// Visual layout:
// Left side (bids/YES):  green bars growing right-to-left
// Center:                price column
// Right side (asks/NO):  red bars growing left-to-right
//
// Each row:
// [████████        ] 0.62 [        ████████]
// [██████          ] 0.60 [      ██████████]
// [████            ] 0.58 [    ████████████]

// Bar classes:
// Bid bar: bg-profit/20 with border-r-2 border-profit
// Ask bar: bg-loss/20 with border-l-2 border-loss
// Price text: font-mono text-xs text-text-secondary
// Size text: font-mono text-xs text-text-tertiary
```

Implementation uses a `<div>` grid with percentage-width bars calculated from cumulative depth.

### 10.5 SparklineChart

File: `components/ui/SparklineChart.tsx`

A minimal inline SVG chart with no axes, labels, or grid:

```tsx
interface SparklineChartProps {
  data: number[];
  color?: 'profit' | 'loss' | 'accent' | 'default';
  fill?: boolean;
  className?: string;
}

// Color map:
const colorMap = {
  profit:  { stroke: '#22C55E', fill: 'rgba(34,197,94,0.15)' },
  loss:    { stroke: '#EF4444', fill: 'rgba(239,68,68,0.15)' },
  accent:  { stroke: '#6366F1', fill: 'rgba(99,102,241,0.15)' },
  default: { stroke: '#9CA3AF', fill: 'rgba(156,163,175,0.1)' },
};

// Renders an SVG <polyline> (and optionally a filled <polygon>)
// calculated from normalized data points mapped to the viewBox.
```

### 10.6 DataTable

File: `components/ui/DataTable.tsx`

A wrapper around HeroUI `<Table>` with built-in sorting, filtering, and pagination:

```tsx
interface DataTableProps<T> {
  data: T[];
  columns: Array<{
    key: string;
    label: string;
    sortable?: boolean;
    render?: (item: T) => React.ReactNode;
    align?: 'start' | 'center' | 'end';
  }>;
  filterableColumns?: string[];
  pageSize?: number;
  onRowClick?: (item: T) => void;
  emptyContent?: React.ReactNode;
  isLoading?: boolean;
}

// Integrates:
// - HeroUI <Table> with sortDescriptor + onSortChange
// - HeroUI <Pagination> below table
// - Filter <Input> above table (searches across filterable columns)
// - Loading state: <Spinner> in table body
// - Empty state: custom emptyContent or default message
//
// Standard classNames:
//   wrapper: "bg-surface-raised border border-white/5"
//   th: "bg-surface-overlay text-text-secondary text-xs uppercase tracking-wider"
//   td: "text-sm text-text-primary"
//   tr: "hover:bg-surface-overlay/50 transition-colors"
```

### 10.7 StatCard

File: `components/ui/StatCard.tsx`

```tsx
interface StatCardProps {
  label: string;
  value: string;
  trend?: {
    value: number;
    label: string;
  };
  icon?: React.ReactNode;
  sparkline?: number[];
  className?: string;
}

export function StatCard({ label, value, trend, icon, sparkline, className }: StatCardProps) {
  return (
    <Card className={`bg-surface-raised border border-white/5 ${className}`}>
      <CardBody className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wider">
              {label}
            </p>
            <p className="text-2xl font-bold font-mono tabular-nums text-text-primary mt-2">
              {value}
            </p>
            {trend && (
              <div className="flex items-center space-x-1 mt-1">
                <span className={`text-xs font-medium ${
                  trend.value >= 0 ? 'text-profit' : 'text-loss'
                }`}>
                  {trend.value >= 0 ? '+' : ''}{trend.value}%
                </span>
                <span className="text-xs text-text-tertiary">{trend.label}</span>
              </div>
            )}
          </div>
          {icon && (
            <div className="p-2 rounded-lg bg-accent/10 text-accent">
              {icon}
            </div>
          )}
        </div>
        {sparkline && (
          <div className="mt-3">
            <SparklineChart data={sparkline} color={
              trend && trend.value >= 0 ? 'profit' : trend && trend.value < 0 ? 'loss' : 'default'
            } className="w-full h-8" />
          </div>
        )}
      </CardBody>
    </Card>
  );
}
```

### 10.8 TimeframeSelector

File: `components/ui/TimeframeSelector.tsx`

```tsx
const timeframes = [
  { key: '1H', label: '1H' },
  { key: '1D', label: '1D' },
  { key: '1W', label: '1W' },
  { key: '1M', label: '1M' },
  { key: '3M', label: '3M' },
  { key: 'ALL', label: 'ALL' },
];

export function TimeframeSelector({ selected, onChange }: {
  selected: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-surface-overlay p-1 gap-0.5">
      {timeframes.map(tf => (
        <button
          key={tf.key}
          onClick={() => onChange(tf.key)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            selected === tf.key
              ? 'bg-accent text-white shadow-sm'
              : 'text-text-secondary hover:text-text-primary hover:bg-surface-subtle'
          }`}
        >
          {tf.label}
        </button>
      ))}
    </div>
  );
}
```

### 10.9 PositionSizeSlider

File: `components/ui/PositionSizeSlider.tsx`

```tsx
interface PositionSizeSliderProps {
  value: number;
  maxValue: number;
  onChange: (value: number) => void;
}

export function PositionSizeSlider({ value, maxValue, onChange }: PositionSizeSliderProps) {
  const percentage = (value / maxValue) * 100;

  return (
    <div className="space-y-3">
      <div className="flex justify-between text-xs text-text-secondary">
        <span>Position Size</span>
        <span className="font-mono">${value.toFixed(2)} ({percentage.toFixed(0)}%)</span>
      </div>
      <Slider
        size="sm"
        step={1}
        minValue={0}
        maxValue={maxValue}
        value={value}
        onChange={onChange}
        color="primary"
        classNames={{
          track: "bg-surface-overlay",
          filler: "bg-accent",
        }}
      />
      {/* Quick percentage buttons */}
      <div className="flex gap-2">
        {[10, 25, 50, 75, 100].map(pct => (
          <Button
            key={pct}
            size="sm"
            variant="flat"
            className="flex-1 text-xs"
            onClick={() => onChange((pct / 100) * maxValue)}
          >
            {pct}%
          </Button>
        ))}
      </div>
    </div>
  );
}
```

### 10.10 StrategyStatusBadge

(Fully described in section 6.3 above.)

---

## 11. Wireframe Descriptions

All wireframes use a 12-column grid. Column references below use the notation `[col X-Y]` meaning the element spans columns X through Y (inclusive). Vertical layout is described top to bottom.

### 11.1 Main Dashboard (`/`)

```
VIEWPORT: Desktop 1440px
GRID: 12 columns, 24px gap, 24px page padding

ROW 1 (h: ~110px) -- Stats bar
  [col 1-3]   StatCard: Portfolio Value
               - Label top, value large, sparkline right-aligned, trend bottom
  [col 4-6]   StatCard: Today's P&L
               - Label top, dollar value large (colored), PnLBadge inline
  [col 7-9]   StatCard: Open Positions
               - Label top, count large, "5 markets" subtext
  [col 10-12] StatCard: Total Exposure
               - Label top, dollar value, progress bar showing % of portfolio

ROW 2 (h: ~360px) -- Charts + Strategies
  [col 1-7]   Card: Portfolio Value Chart
               - Card title: "Portfolio Value" + TimeframeSelector right-aligned
               - Area chart filling card body (h-72)
               - X-axis: dates, Y-axis: dollar values
  [col 8-12]  Card: Active Strategies
               - Card title: "Strategies" + "View All" link
               - List of 4-5 strategy rows (name + status dot + daily ROI)
               - If no strategies: empty state

ROW 3 (h: ~320px) -- Activity + Movers
  [col 1-7]   Card: Recent Activity
               - Card title: "Recent Activity" + filter tabs (All / Trades / Signals / Alerts)
               - Scrollable list (max-h-64 overflow-y-auto)
               - Each item: colored dot + description + timestamp + amount
  [col 8-12]  Card: Market Movers
               - Card title: "Top Opportunities"
               - 5 market rows (title + category + price + 24h change badge)
               - "View All Markets" link at bottom

ROW 4 (h: ~56px) -- Quick Actions
  [col 1-12]  Inline flex bar with 3 buttons:
               - "Place Bet" (primary, accent)
               - "Start Strategy" (flat, secondary)
               - "Deposit" (flat, default)
```

**Tablet (768px)**: Stats become 2x2 grid. Chart and strategies stack vertically (12 cols each). Activity and movers stack vertically.

**Mobile (< 640px)**: All sections stack in single column. Stats become 1-col. Quick actions become full-width stacked buttons.

### 11.2 Markets Explorer (`/markets`)

```
VIEWPORT: Desktop 1440px
GRID: 12 columns, 24px gap

ROW 1 (h: ~56px) -- Page header
  [col 1-4]   Page title: "Markets" (text-3xl font-bold)
  [col 5-9]   Search input with autocomplete (max-w-md)
  [col 10-11] Grid/List toggle button group
  [col 12]    Sort dropdown

ROW 2 (h: ~48px) -- Category tabs
  [col 1-12]  HeroUI Tabs (underlined variant), horizontally scrollable on mobile
               [All] [Politics] [Crypto] [Sports] [Finance] [Science] [Culture]

ROW 3+ -- Market cards
  GRID VIEW:
    [col 1-3] [col 4-6] [col 7-9] [col 10-12]  -- 4 cards per row on xl
    Each card: ~220px tall
    - Category chip (top-left)
    - Title (2 lines max, line-clamp-2)
    - YES/NO price bar (horizontal stacked bar)
    - Volume | Liquidity | Expiry (metadata row)

  LIST VIEW:
    [col 1-12] per row
    Each row: ~64px tall, flex layout
    - [Title (flex-1)] [Category chip] [Yes price] [No price] [Volume] [Liquidity] [Expiry] [Arrow >]

BOTTOM:
  [col 1-12] Pagination (center-aligned)
              <Pagination total={totalPages} page={page} onChange={setPage} />
```

**Tablet**: Grid becomes 2 columns. Search moves above tabs.

**Mobile**: Grid becomes 1 column. Search is full-width. Tabs become horizontally scrollable.

### 11.3 Portfolio & Positions (`/portfolio`)

```
VIEWPORT: Desktop 1440px
GRID: 12 columns, 24px gap

ROW 1 (h: ~110px) -- Summary stats
  [col 1-3]   StatCard: Total Value ($12,450.32)
  [col 4-6]   StatCard: Unrealized P&L (+$1,245.67, green)
  [col 7-9]   StatCard: Realized P&L (+$3,102.44, green)
  [col 10-12] StatCard: Open Positions (12)

ROW 2 (h: ~380px) -- Chart + Donut
  [col 1-8]   Card: Portfolio Value Over Time
               - Title + TimeframeSelector
               - Line chart (h-72) showing portfolio equity curve
               - Tooltip shows date + value
  [col 9-12]  Card: Allocation
               - Donut chart (h-64) with 5 category segments
               - Center: total value
               - Legend below: category name + percentage + color swatch

ROW 3 (h: ~48px) -- P&L Breakdown
  [col 1-12]  Card: P&L Summary (horizontal layout)
               - Left half: Unrealized P&L with breakdown by position
               - Right half: Realized P&L with breakdown by closed trades

ROW 4 (h: variable) -- Positions Table
  [col 1-12]  DataTable: Open Positions
               - Header row: Market | Side | Shares | Avg Cost | Current | P&L $ | P&L % | Actions
               - Sortable columns (click header to sort)
               - Filter input above table
               - Expandable rows (click to show order history)
               - Pagination below
```

### 11.4 Strategy Management (`/strategies`)

```
VIEWPORT: Desktop 1440px
GRID: 12 columns, 24px gap

ROW 1 (h: ~56px) -- Header
  [col 1-9]   Title: "Strategies"
  [col 10-12] Button: "+ Create Strategy" (primary)

ROW 2+ -- Strategy Cards
  [col 1-4] [col 5-8] [col 9-12]  -- 3 per row
  Each card (~320px tall):
    - Header: Name (left) + StatusBadge (right)
    - Creation date (small text)
    - Equity curve sparkline (h-24, full width)
    - 2x2 metric grid: ROI | Sharpe | Win Rate | Max DD
    - Action buttons: [Pause] [Edit] [Delete icon]

TOGGLE: "Compare Strategies" button shows comparison table
  [col 1-12]  Comparison table (described in 6.5)
```

### 11.5 Trade History & Analytics (`/history`)

```
VIEWPORT: Desktop 1440px
GRID: 12 columns, 24px gap

ROW 1 (h: ~56px) -- Header + Filters
  [col 1-3]   Title: "Trade History"
  [col 4-7]   Date range picker (HeroUI DateRangePicker)
  [col 8-9]   Category filter dropdown
  [col 10-11] Side filter (All / Buy / Sell)
  [col 12]    Export CSV button

ROW 2 (h: ~110px) -- Summary stats
  [col 1-3]   StatCard: Total Trades (342)
  [col 4-6]   StatCard: Win Rate (67%)
  [col 7-9]   StatCard: Avg Win / Avg Loss (+$45.20 / -$28.10)
  [col 10-12] StatCard: Profit Factor (1.72)

ROW 3 (h: ~320px) -- Charts
  [col 1-8]   Card: Cumulative P&L
               - Area chart with gradient fill
               - Reference line at y=0
               - TimeframeSelector
  [col 9-12]  Card: Win/Loss Ratio
               - Donut chart (win green, loss red)
               - Center: "67%" large text
               - Below: "230 Wins / 112 Losses"

ROW 4 (h: ~200px) -- Calendar Heatmap
  [col 1-12]  Card: P&L Calendar
               - Full-width heatmap (52 weeks x 7 days)
               - Color scale: deep red -> light red -> gray -> light green -> deep green
               - Month labels above
               - Day labels left (Mon, Wed, Fri)
               - Tooltip on hover: date + P&L amount
               - Legend bottom-right

ROW 5 (h: ~280px) -- Analytics breakdown
  [col 1-6]   Card: Category Performance
               - Horizontal bar chart
               - Each category: name + bar + dollar amount
               - Green bars for profit, red for loss
  [col 7-12]  Card: Time-of-Day Analysis
               - Vertical bar chart (24 bars for each hour)
               - Y-axis: avg P&L per trade
               - Color: green bars above 0, red below

ROW 6 (h: variable) -- Full Trade Log
  [col 1-12]  DataTable: All Trades
               - Columns: Date | Market | Side | Shares | Entry | Exit | P&L | P&L% | Duration | Strategy
               - All sortable
               - Filter chips above
               - Pagination: 25 rows per page
```

### 11.6 Bot Control Panel (`/bot`)

```
VIEWPORT: Desktop 1440px
GRID: 12 columns, 24px gap

ROW 1 (h: ~100px) -- Bot Status Hero
  [col 1-12]  Full-width card:
               - Left: Large status dot (pulsing if running) + "Bot Running" title + uptime stats
               - Right: EMERGENCY STOP button (large, red, prominent)
                 Shadow: shadow-lg shadow-loss/25
                 Min-width: 160px
                 Text: uppercase, bold, white on red

ROW 2 (h: ~300px) -- Resources + Instances
  [col 1-4]   Card: Resource Usage
               - API Calls progress bar (warning color when >80%)
               - Rate Limit progress bar
               - Memory usage progress bar
               - Each with label + current/max values
  [col 5-12]  Card: Active Strategy Instances
               - Table: Strategy | Status | Uptime | Trades Today | P&L Today | Controls
               - Controls: Play/Pause + Stop icon buttons
               - Color-coded P&L values

ROW 3 (h: ~400px) -- Config + Logs
  [col 1-4]   Card: Quick Configuration
               - Max concurrent strategies (number input)
               - Daily loss limit ($ input)
               - Auto-restart (switch toggle)
               - Polling interval (select dropdown)
               - [Save] button
  [col 5-12]  Card: Live Logs
               - Filter chips: [All] [Errors] [Trades] [System]
               - Terminal-style log viewer (monospace, dark bg)
               - Auto-scroll to bottom
               - Each line: timestamp + level (colored) + message
               - Height: h-80, scrollable
```

### 11.7 Alerts (`/alerts`)

```
VIEWPORT: Desktop 1440px
GRID: 12 columns, 24px gap

ROW 1 (h: ~56px) -- Header
  [col 1-9]   Title: "Alerts & Notifications"
  [col 10-12] Button: "+ Create Alert"

ROW 2 (h: variable) -- Active Alerts
  [col 1-12]  DataTable: Active Alerts
               - Columns: Name | Type (chip) | Condition | Market | Status (Switch) | Last Triggered | Actions
               - Actions: Edit + Delete buttons

ROW 3 (h: variable) -- Notification History
  [col 1-12]  Card: Recent Notifications
               - Scrollable list (max-h-96)
               - Each notification: type dot + title + message + timestamp
               - Unread items have subtle accent background
               - "Mark all as read" link in card header
```

---

## Appendix A: Zustand Store Architecture

Extend the existing `useAppStore.ts` and create domain-specific stores:

```
store/
  useAppStore.ts         -- theme, sidebar, global UI state (exists)
  usePortfolioStore.ts   -- positions, portfolio value, P&L
  useMarketsStore.ts     -- market data, filters, search
  useStrategyStore.ts    -- strategy configs, instances, performance
  useBotStore.ts         -- bot status, logs, resource usage
  useAlertStore.ts       -- alerts, notifications
  useTradeStore.ts       -- trade history, analytics data
```

Each store follows the pattern:

```ts
interface PortfolioState {
  positions: Position[];
  portfolioValue: number;
  isLoading: boolean;
  error: string | null;
  fetchPositions: () => Promise<void>;
  // ...
}

export const usePortfolioStore = create<PortfolioState>((set, get) => ({
  positions: [],
  portfolioValue: 0,
  isLoading: false,
  error: null,
  fetchPositions: async () => {
    set({ isLoading: true, error: null });
    try {
      const data = await api.getPositions();
      set({ positions: data, isLoading: false });
    } catch (err) {
      set({ error: err.message, isLoading: false });
    }
  },
}));
```

## Appendix B: File Structure

```
app/
  layout.tsx                    -- Root layout (Header + Sidebar + Main)
  page.tsx                      -- Main Dashboard (Home)
  error.tsx                     -- Global error boundary
  loading.tsx                   -- Global loading fallback
  markets/
    page.tsx                    -- Markets Explorer
    [id]/
      page.tsx                  -- Market Detail
  portfolio/
    page.tsx                    -- Portfolio & Positions
  strategies/
    page.tsx                    -- Strategy Management
    new/
      page.tsx                  -- Create Strategy Wizard
    [id]/
      page.tsx                  -- Strategy Detail
  history/
    page.tsx                    -- Trade History & Analytics
  bot/
    page.tsx                    -- Bot Control Panel
  alerts/
    page.tsx                    -- Alerts & Notifications
  settings/
    page.tsx                    -- Settings (existing)

components/
  Header.tsx                    -- App header (existing, to be enhanced)
  Sidebar.tsx                   -- Sidebar navigation (existing, to be enhanced)
  ThemeProvider.tsx              -- Theme management (existing)
  ui/
    PriceDisplay.tsx
    PnLBadge.tsx
    MarketCard.tsx
    OrderBookVisualization.tsx
    StrategyStatusBadge.tsx
    SparklineChart.tsx
    DataTable.tsx
    StatCard.tsx
    TimeframeSelector.tsx
    PositionSizeSlider.tsx
    EmptyState.tsx
    ErrorCard.tsx
    ToastProvider.tsx

store/
  useAppStore.ts                -- Global UI state (existing)
  usePortfolioStore.ts
  useMarketsStore.ts
  useStrategyStore.ts
  useBotStore.ts
  useAlertStore.ts
  useTradeStore.ts

lib/
  api.ts                        -- API client (Polymarket API wrappers)
  utils.ts                      -- Formatting helpers (currency, dates, etc.)
  constants.ts                  -- App constants, enums
  types.ts                      -- Shared TypeScript interfaces

hooks/
  useWebSocket.ts               -- WebSocket connection for live data
  useKeyboardShortcut.ts        -- Cmd+K, Escape, etc.
  useAutoRefresh.ts             -- Polling hook for data refresh
```

## Appendix C: Recommended Additional Dependencies

```json
{
  "recharts": "^2.12.0",
  "lightweight-charts": "^4.1.0",
  "sonner": "^1.4.0",
  "lucide-react": "^0.344.0",
  "date-fns": "^3.3.0",
  "@heroui/react": "^2.8.8"
}
```

- **recharts**: Portfolio charts, cumulative P&L, pie/donut, bar charts
- **lightweight-charts**: TradingView-style candlestick/line charts for market detail page
- **sonner**: Toast notifications (styled to match design system)
- **lucide-react**: Consistent icon set (replaces inline SVGs)
- **date-fns**: Date formatting and manipulation

---

*End of Design System Document*
