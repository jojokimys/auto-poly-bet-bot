# Skill Engine + /trade Architecture (v3 - Cycle Summary)

> **Date:** 2026-02-16
> **Status:** Implemented
> **Stack:** Next.js 15, SQLite (Prisma), Zustand, in-memory bot engine

---

## Overview

Dual-loop 시스템: **Skill Engine** (자동 백그라운드)과 **`/trade` Claude** (AI 판단)가 Opportunity Queue를 매개로 협력한다.

`/trade`는 Engine 위의 "AI 판단 오버레이" — **cycle-summary** 단일 API로 모든 데이터를 수집하고, 판단/실행/학습만 수행한다.

```
+-------------------------------------------------------------+
|  /trade (Claude AI Overlay)                                   |
|  - 단일 API: GET /api/bot/cycle-summary                       |
|  - AI 판단 + 주문 실행 + 전략 학습                              |
+---------------+-------------------------+--------------------+
                | 1회 GET                  | POST 주문 실행
                v                         v
+----------------------------+   +-----------------------------+
| /api/bot/cycle-summary     |   | /api/skills/orders          |
|   -> loadProfile (1회)     |   |   -> executeOrder()         |
|   -> getPositions          |   |   -> executeArbOrder()      |
|   -> getRiskAssessment     |   +-----------------------------+
|   -> scanForEarlyExits     |
|   -> getCryptoPrices       |   +-----------------------------+
|   -> getPendingOpps (mem)  |   | /api/skills/opportunities   |
|   -> getQueueStats (mem)   |   |   -> approve/reject         |
|   -> getBotState (mem)     |   +-----------------------------+
|   -> getBotLogs (mem)      |
+----------------------------+
                ^
                | 큐에 기회 적재
+---------------+---------------------------------------------+
|  Skill Engine (Background, 30s cycle)                        |
|  - enabledStrategies별 독립 scan -> evaluate -> queue        |
|  - arb만 자동 실행, 나머지는 큐에 대기                         |
+--------------------------------------------------------------+
```

### 데이터 수집 플로우 (cycle-summary 내부)

```
loadProfile(profileId)           // 1회만
  ├─ getPositions(profile)       // sequential (risk가 이걸 의존)
  │   └─ getRiskAssessment(profile, positions)  // parallel 그룹 ┐
  ├─ scanForEarlyExits(profile)                 //               │
  ├─ getCryptoPrices(['BTC','ETH','SOL'])       //               ┘
  ├─ getPendingOpportunities()   // in-memory (즉시)
  ├─ getQueueStats()             // in-memory (즉시)
  ├─ getBotState(profileId)      // in-memory (즉시)
  └─ getBotLogs(profileId, 20)   // in-memory (즉시)
```

**핵심 개선:**
- 프로필 1회 로드 (기존: 4~6회 중복)
- CLOB auth 최소화 (positions에서 1회 + early-exit에서 재사용)
- In-memory 데이터는 API 오버헤드 없이 직접 접근
- 6개 API → 1개 API (네트워크 왕복 5회 절약)

---

## Skill Engine Cycle (lib/bot/skill-engine.ts)

매 30초마다 실행:

| Phase | 내용 | 비고 |
|-------|------|------|
| 1 | `getPositions()` + `getRiskAssessment()` | 순차 실행 (risk ← positions 의존) |
| 1.5 | `executeEarlyExits()` | 확정된 포지션 자동 매도 |
| 2 | **Multi-Strategy Scan + Evaluate** | 핵심 - 아래 상세 |
| 3 | opportunity-queue에 적재 | confidence >= 60 |
| 4 | autoExecutable=true인 arb만 자동 실행 | complement-arb, multi-outcome-arb |
| 5 | 세션 로그 기록 | AiDecision + AiSession |

### Phase 2: Multi-Strategy Scan + Evaluate

프로필의 `enabledStrategies` (JSON 배열)에 등록된 전략만 실행한다.

```
for each enabledStrategy:
  1) scanner(config)        -> ScoredOpportunity[]     <- strategy-registry
  2) strategy.evaluate()    -> StrategySignal | null    <- lib/bot/strategies/
  3) signalToOpportunity()  -> Opportunity              <- signal-converter
```

- **strategy-registry.ts**: 전략 이름 -> 스캐너 + 평가기 + 메타데이터 매핑 (Single Source of Truth)
- **signal-converter.ts**: `StrategySignal` -> `Opportunity` 변환 (confidence, risk, timeWindow 계산)
- 전략 2~3개만 켜면 2~3번의 Gamma API call만 발생 (8개 전략 = 최대 8 API calls)

---

## /trade Claude Loop (.claude/commands/trade.md)

Claude가 **Commander**로서 cycle-summary 기반 5-Phase 루프를 실행:

### 5-Phase 루프

| Phase | 내용 | 호출 |
|-------|------|------|
| 1 | **데이터 수집**: cycle-summary 1회 호출 | `GET /api/bot/cycle-summary` |
| 1.5 | **조건부 분석가**: marketCategories 기반 맞춤 리서치 | WebSearch (crypto/politics/sports/economics/geopolitics/tech) |
| 2 | **판단**: earlyExits → opportunities 평가 → Kelly 사이징 | (AI 추론) |
| 3 | **실행**: 주문 + 큐 approve/reject | `POST /api/skills/orders`, `POST /api/skills/opportunities` |
| 4 | **보고**: 적응형 로그 | (텍스트 출력) |
| 5 | **학습**: 10사이클마다 performance 분석 | `GET /api/skills/performance` |

### Phase 1.5: 확장된 Analyst

기존: 크립토 기회만 리서치
**변경**: `marketCategories` 배열에 따라 해당 카테고리별 맞춤 검색 쿼리 실행

| 카테고리 | 검색 쿼리 예시 |
|----------|--------------|
| crypto | "bitcoin price today", "crypto market sentiment" |
| politics | "US politics news today", "{인물} latest" |
| sports | "{종목} game result", "{이벤트} odds" |
| economics | "US economy news", "fed rate decision" |
| geopolitics | "{지역} conflict update" |
| tech | "{기업명} news", "AI industry update" |

---

## Opportunity Queue (lib/bot/opportunity-queue.ts)

두 루프의 협력 지점.

```
Engine (30s)                          Claude (/trade)
    |                                      |
    | scan -> evaluate -> signalToOpp()    |
    |         |                            |
    v         v                            |
+---------------------+                   |
|  Opportunity Queue   |<-- cycle-summary  | GET /api/bot/cycle-summary
|  (in-memory, max 50) |    에 포함        |   (opportunities.pending)
|                      |                   |
|  autoExecutable:     |                   | Claude 평가
|   true  -> Engine    |                   |
|           자동 실행  |<------------------| approve/reject
|   false -> 큐 대기   |                   | POST /api/skills/opportunities
+---------------------+                   |
                                           | 승인된 기회 직접 실행
                                           | POST /api/skills/orders
                                           v
```

### 큐 TTL

| timeWindow | TTL |
|------------|-----|
| urgent | 5분 |
| minutes | 15분 |
| hours | 1시간 |

---

## Strategy 역할 분담

| 전략 | 스캔 주체 | 실행 주체 | autoExecutable |
|------|----------|----------|---------------|
| value-betting | Engine | **Claude** | false |
| near-expiry-sniper | Engine | **Claude** | false |
| micro-scalper | Engine | **Claude** | false |
| complement-arb | Engine | **Engine** (자동) | true |
| panic-reversal | Engine | **Claude** | false |
| crypto-latency | Engine | **Claude** | false |
| multi-outcome-arb | Engine | **Engine** (자동) | true |
| crypto-scalper | Engine | **Claude** | false |

**원칙**: 시장 중립(market-neutral) arb는 Engine이 자동 실행, 방향성(directional) 트레이드는 Claude가 판단 후 실행.

---

## Performance Tracking (전략별 성과 추적)

```
logDecision({ ..., strategy: 'value-betting' })
          |
          v
  AiDecision 테이블 (strategy 컬럼)
          |
          v
  getStrategyPerformance(profileId, 'value-betting')
  getAllStrategyPerformance(profileId)
          |
          v
  /api/skills/performance -> Claude Phase 5 학습
```

모든 결정(자동 arb, Claude 수동)에 `strategy` 필드가 기록되어 전략별 승률/PnL/판단 횟수를 분리 집계한다.

---

## Key Files

| 파일 | 역할 |
|------|------|
| `lib/bot/skill-engine.ts` | 자동 백그라운드 엔진 (30s cycle) |
| `lib/bot/strategy-registry.ts` | 전략 이름 <-> 스캐너/평가기 매핑 |
| `lib/bot/signal-converter.ts` | StrategySignal -> Opportunity 변환 |
| `lib/bot/opportunity-queue.ts` | in-memory 기회 큐 관리 |
| `lib/bot/scanner.ts` | 8개 시장 스캐너 |
| `lib/bot/strategies/` | 8개 전략 평가기 |
| `lib/skills/order-manager.ts` | 주문 실행 + arb 주문 오케스트레이션 |
| `lib/skills/reporter.ts` | 세션/결정/학습 로깅 |
| `lib/skills/performance.ts` | 성과 집계 (전체 + 전략별) |
| `lib/skills/explorer.ts` | `/api/skills/explore` 전용 (Claude 수동 탐색) |
| `app/api/bot/cycle-summary/route.ts` | **통합 데이터 API** (/trade 전용) |
| `.claude/commands/trade.md` | /trade 스킬 정의 (Commander + Analyst) |
| `.claude/commands/trade-strategy.md` | 전략 메모리 (파라미터, 학습 로그) |

---

## API Endpoints

| Endpoint | Method | 용도 |
|----------|--------|------|
| `/api/bot` | POST | Engine start/stop (`{ action, profileId }`) |
| `/api/bot/logs` | GET | Engine 로그 조회 |
| `/api/bot/cycle-summary` | GET | **통합 데이터 (portfolio + risk + earlyExits + opportunities + crypto + logs)** |
| `/api/skills/opportunities` | GET | 큐 pending 기회 조회 |
| `/api/skills/opportunities` | POST | 큐 approve/reject (`{ id, action }`) |
| `/api/skills/opportunities` | DELETE | 큐 전체 초기화 |
| `/api/skills/orders` | POST | 수동 주문 실행 |
| `/api/skills/orders` | DELETE | 오픈 주문 전체 취소 |
| `/api/skills/explore` | GET | 실시간 시장 스캔 (explorer.ts) |
| `/api/skills/positions` | GET | 포지션 + 잔고 조회 |
| `/api/skills/risk` | GET | 리스크 평가 |
| `/api/skills/early-exit` | GET | 조기 청산 후보 |
| `/api/skills/crypto` | GET | 크립토 가격 데이터 |
| `/api/skills/performance` | GET | 성과 분석 |
| `/api/skills/report` | POST | 세션 리포트 저장 |
| `/api/profiles` | GET/POST | 프로필 목록/생성 |
| `/api/profiles/[id]` | GET/PUT/DELETE | 프로필 CRUD |

---

## DB Schema (핵심)

```
BotProfile
  - enabledStrategies: String  // JSON array, e.g. '["value-betting","complement-arb"]'

AiDecision
  - strategy: String?          // 전략명, 성과 추적용

AiSession
  - profileId, cycleCount, totalPnl, summary

BotLog
  - profileId, level, event, message, data (JSON)
```

---

## Signal Conversion: StrategySignal -> Opportunity

`signal-converter.ts`에서 수행하는 변환 매핑:

| StrategySignal | Opportunity | 변환 로직 |
|---|---|---|
| `action` | `signal` | 직접 매핑 |
| `price` | `suggestedPrice` | 직접 매핑 |
| `size` | `suggestedSize` | 직접 매핑 |
| `reason` | `reasoning` | 직접 매핑 |
| `score (0-100)` | `confidence` | `min(95, 40 + score * 0.55)` |
| strategy name | `type` | registry에서 |
| `secondLeg` + `bundleLegs` | `arbLegs` | ArbLeg[] 통합 |
| computed | `expectedProfit` | `(1 - price) * size * 0.98` |
| computed | `riskLevel` | score >= 70 -> LOW, >= 50 -> MEDIUM, else HIGH |
| registry | `autoExecutable` | registry에서 |
| `hoursToExpiry` | `timeWindow` | < 0.25h -> urgent, < 1h -> minutes, else default |
