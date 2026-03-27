# LP Engine Logic

## Overview

Wall Rider 전략으로 Polymarket LP 리워드 파밍. wall 뒤에 limit order를 배치하고, 체결되지 않으면서 rewards를 수집. fill 시 즉시 sell.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    ENGINE START                       │
│                                                     │
│  1. Profile + Balance + Blacklist 로드               │
│  2. COLLATERAL allowance 승인                       │
│  3. User WS 연결 (fill 감지)                        │
│  4. scanAndAllocate (마켓 스캔 + wall check)         │
│  5. syncWithClob (orphan 주문 정리)                  │
│  6. syncExistingPositions (잔여 포지션 sell)          │
│  7. wallPollLoop 시작                               │
│  8. clobSync timer 시작 (30s)                       │
│  9. scanTimer 시작 (5min)                           │
└─────────────────────────────────────────────────────┘
```

## Main Loop: wallPollLoop (3초 주기)

```
매 3초:
  1. Balance refresh (30초마다)

  2. Orderbook fetch (병렬 10개씩 REST)
     - active 마켓 (주문 있음): 3초 주기
     - idle 마켓 (주문 없음): 30초 주기

  3. Active 마켓 처리 (fire-and-forget, 50ms stagger, 마켓별 lock)
     각 마켓:
       checkWallAndAct(YES side) + checkWallAndAct(NO side)
       ├─ wall 붕괴 → 즉시 cancel (CLOB 기반)
       ├─ wall OK + 가격 1¢+ 이동 → requote (cancel + ladder 재배치)
       └─ wall OK + 가격 동일 → skip

  4. Idle 마켓 (30초 경과분): requote (새 진입 기회)
```

## Ladder 주문 방식

wall 가격부터 maxSpread edge까지 1¢ 간격으로 주문 배치:

```
예: midpoint 0.50, maxSpread 4¢, wall @0.48

YES side:
  0.48 ← wall 바로 뒤 (0.5x size — fill 위험 높음)
  0.47 ← 1x size
  0.46 ← 1x size (maxSpread edge)

NO side (동일 로직, 1-X 기준):
  0.48 ← wall 바로 뒤 (0.5x)
  0.47 ← 1x
  0.46 ← 1x
```

- 가까울수록 Q-score 높음 → rewards 많음
- 첫 번째 rung (wall 바로 뒤): 0.5x size로 리스크 감소
- 모든 주문은 `postOnly: true` (maker only)

## Wall 계산

```
findWallPrice(bids, mid, maxSpread, minWall=$3000):
  mid에서 1¢ 아래부터 스캔
  각 가격에서: 그 위의 모든 bid $ 합산 = wallAbove
  wallAbove >= $3000이면 → 이 가격에 배치

예: mid=0.50
  candidate 0.49: wall above = $1,200 → 부족
  candidate 0.48: wall above = $1,200 + $2,100 = $3,300 → OK → wall @0.48
```

## Fill 감지 & 대응

```
User WS (실시간):
  MATCHED status:
    → 해당 마켓 모든 주문 emergency cancel (fire-and-forget)
    → 나머지 ladder가 fill되는 것 방지

  MINED status (on-chain 확인 후):
    → 즉시 SELL (retry 0→1→3초, allowance 갱신 포함)
    → 성공 시 balance refresh
    → 실패 시 pendingSells 큐
    → 해당 마켓 blacklist
```

## CLOB Sync (30초마다)

```
1. getOpenOrders()로 CLOB 실제 상태 조회
2. Orphan 주문 cancel (CLOB에 있지만 엔진에 없음)
3. Stale 주문 제거 (엔진에 있지만 CLOB에 없음)
4. Hedge position cleanup
5. Pending sells retry
```

## scanAndAllocate (5분마다)

```
1. Gamma API에서 reward 마켓 전체 스캔
2. 필터:
   - expiry > 2시간
   - midpoint 10-90%
   - liquidity > $10K
   - blacklist 제외
   - tight spread (≤2¢) 제외 (allowTightSpread=false)
3. Wall check (병렬 10개씩): 양쪽 wall ≥ $3K
4. 마켓 추가/제거
5. requoteAll (fire-and-forget, 300ms stagger)
6. Orphan 포지션 sweep sell
```

## Blacklist

- fill 1회 발생 시 즉시 blacklist (60초 윈도우 내 중복 방지)
- DB에 영속 (LpBlacklist 테이블)
- 엔진 시작 시 로드
- blacklisted 마켓은 scanAndAllocate에서 제외

## 주문 Cancel (P0: CLOB 기반)

```
cancelLpOrdersFromClob(mm, tokenIndex?):
  1. getOpenOrders()로 CLOB 실제 주문 조회
  2. 해당 마켓 token의 BUY 주문 필터
  3. 실제 orderId로 cancel
  4. 엔진 메모리 sync
```

엔진 메모리의 orderId에 의존하지 않고, 매번 CLOB에서 직접 조회하여 cancel.
이전에 주문 누적 문제($29K 손실)의 근본 원인이었음.

## Constants

| 파라미터 | 값 | 설명 |
|---|---|---|
| WALL_POLL_ACTIVE_MS | 3s | 주문 있는 마켓 poll 주기 |
| WALL_POLL_IDLE_MS | 30s | 주문 없는 마켓 poll 주기 |
| REQUOTE_INTERVAL_MS | 30s | idle 마켓 requote 주기 |
| CLOB_SYNC_INTERVAL_MS | 30s | CLOB 상태 sync 주기 |
| SCAN_INTERVAL_MS | 5min | 마켓 재스캔 주기 |
| BATCH_SIZE | 10 | REST fetch 병렬 수 |
| CAPITAL_PER_SIDE | 47% | 잔고의 47%를 각 사이드에 배치 |
| DEFAULT_MIN_WALL_SIZE | $3,000 | 최소 wall 크기 |
| WALL_MULTIPLIER | 3 | wall ≥ 3x 주문 비용 |
| MAX_SPREAD_RATIO | 1.00 | reward zone 100% 사용 |
| MIN_MIDPOINT | 0.10 | 극단 확률 제외 |
| MAX_MIDPOINT | 0.90 | 극단 확률 제외 |
| MIN_LIQUIDITY | $10K | 최소 유동성 |
| HEDGE_TIMEOUT_MS | 60s | post-only hedge 타임아웃 |

## API Endpoints

| Endpoint | 설명 |
|---|---|
| GET /api/lp | 엔진 상태 + 로그 |
| GET /api/lp?positions=true | 보유 포지션 조회 (Gamma API) |
| GET /api/lp?scan=true | reward 마켓 스캔 |
| POST /api/lp { action: "start" } | 엔진 시작 |
| POST /api/lp { action: "stop" } | 엔진 중지 |
| POST /api/lp { action: "sell" } | 단일 포지션 매도 |
| POST /api/lp { action: "sell-all" } | 전체 포지션 매도 |

## Frontend

- `/lp` — 엔진 대시보드 + 스캔 탭
- DepthGrid — 10칸 정사각형 orderbook 시각화 (YES 오른쪽/NO 왼쪽)
- WallBar — 스캔 페이지용 간소화 wall 시각화
