# Gabool Strategy — Implementation Plan

## 개요

Polymarket 바이너리 마켓에서 YES + NO 가격 합이 $1.00 미만일 때 양쪽 모두 매수하여 확정 수익을 얻는 전략.

```
YES 가격: $0.42
NO  가격: $0.55
합계: $0.97 → $0.03 underprice

양쪽 매수 → 어떤 결과든 $1.00 수령 → $0.03 확정 수익 (수수료 차감 전)
```

## 수익성 분석

### 수수료 구조

```
takerFee = 0.25 × (price × (1 - price))²

가격별 수수료:
  $0.10/$0.90: ~0.0002 (0.02c) → 왕복 0.04c
  $0.20/$0.80: ~0.0016 (0.16c) → 왕복 0.32c
  $0.30/$0.70: ~0.0044 (0.44c) → 왕복 0.88c
  $0.40/$0.60: ~0.0058 (0.58c) → 왕복 1.16c
  $0.50/$0.50: ~0.0039 (0.39c) → 왕복 0.78c ← 이건 양쪽 다 50c일 때
```

### 실제 시나리오

```
Case A: YES=$0.30, NO=$0.67 (합=$0.97, gap=3c)
  YES 수수료: 0.25 × (0.30 × 0.70)² = 0.0011
  NO  수수료: 0.25 × (0.67 × 0.33)² = 0.0012
  총 수수료: 0.23c
  순 수익: 3.0c - 0.23c = 2.77c per share
  100 shares = $2.77 ✅

Case B: YES=$0.45, NO=$0.53 (합=$0.98, gap=2c)
  YES 수수료: 0.25 × (0.45 × 0.55)² = 0.0015
  NO  수수료: 0.25 × (0.53 × 0.47)² = 0.0016
  총 수수료: 0.31c
  순 수익: 2.0c - 0.31c = 1.69c per share
  100 shares = $1.69 ✅

Case C: YES=$0.48, NO=$0.51 (합=$0.99, gap=1c)
  총 수수료: ~0.30c
  순 수익: 1.0c - 0.30c = 0.70c per share
  100 shares = $0.70 (가스비 고려하면 미미)
```

### 손익분기점

- 극단 가격 ($0.10-0.20): gap > **0.1c** 이면 수익
- 중간 가격 ($0.30-0.50): gap > **0.5c** 이면 수익
- **실질적 최소 gap: 1.5c** (가스비 + 슬리피지 포함)

## Merge vs Hold-to-Settlement

### Option A: Merge (즉시 확정)
- 양쪽 토큰 보유 → `mergePositions()` 호출 → USDC 즉시 수령
- 장점: 즉시 수익 확정, 자본 회전 빠름
- 단점: Polygon 가스비 (~$0.02-0.05)

### Option B: Hold to Settlement
- 마켓 결과 나올 때까지 보유 → `redeemPositions()` 호출
- 장점: merge 가스비 절약
- 단점: 자본이 묶임 (수일~수주), 기회비용

### 결론: **Merge 우선** (자본 회전이 핵심)

## 핵심 요구사항

### 1. 마켓 스캐너
- Gamma API로 활성 바이너리 마켓 전체 스캔
- 각 마켓의 YES/NO tokenId 쌍 추출
- 주기: 30초~1분

### 2. 스프레드 모니터 (RTDS WebSocket)
- RTDS WS에서 실시간 가격 수신 (모든 마켓)
- `YES_price + NO_price` 계산
- gap > threshold → 기회 감지

### 3. CLOB 오더북 확인
- 기회 감지 시 CLOB WS로 실제 오더북 확인
- best ask 기준으로 실행 가능한 물량 확인
- 양쪽 모두 충분한 유동성 필요

### 4. 동시 매수 실행
- YES + NO 동시 taker 매수
- 한쪽만 체결되면 리스크 → 가능한 빠르게 양쪽 실행
- 실패 시 체결된 쪽 즉시 매도 (손실 최소화)

### 5. 포지션 관리 + Auto-Merge
- 양쪽 모두 체결 확인
- `mergePositions()` 호출하여 즉시 USDC 회수
- 밸런스 업데이트

## 아키텍처

```
/app/gabool/page.tsx          ← 대시보드 (독립 페이지)
/app/api/gabool/route.ts      ← API (start/stop, status, trades)
/app/api/gabool/prices/route.ts ← SSE (스프레드 실시간)

/lib/gabool/
  ├── engine.ts               ← 메인 엔진 (싱글톤)
  ├── market-scanner.ts       ← 활성 바이너리 마켓 스캔
  ├── spread-monitor.ts       ← 스프레드 계산 + 기회 감지
  └── merge-executor.ts       ← merge 실행 로직
```

### 재사용 가능한 기존 코드

| 모듈 | 경로 | 용도 |
|------|------|------|
| RTDS WebSocket | `lib/rtds-ws.ts` | 실시간 가격 수신 |
| CLOB WebSocket | `lib/polymarket-ws.ts` | 오더북 깊이 확인 |
| Profile Client | `lib/bot/profile-client.ts` | 주문 실행 |
| Redeem/Merge | `lib/polymarket/redeem.ts` | merge 실행 |
| Gamma API | `lib/polymarket/gamma.ts` | 마켓 검색 |
| Fee Calc | `lib/fees.ts` | 수수료 계산 |

## 데이터 흐름

```
[Gamma API] ──30s──→ [Market Scanner] → 활성 바이너리 마켓 목록
                            │
                            ▼
[RTDS WS] ──실시간──→ [Spread Monitor] → YES+NO 가격 합 계산
                            │
                     gap > threshold?
                            │ YES
                            ▼
[CLOB WS] ──확인──→ [Liquidity Check] → 양쪽 ask 물량 확인
                            │
                     양쪽 충분?
                            │ YES
                            ▼
                    [동시 매수 실행]
                     YES taker BUY
                     NO  taker BUY
                            │
                    양쪽 체결 확인?
                            │ YES
                            ▼
                    [mergePositions]
                     → USDC 회수
```

## 대시보드 UI

```
┌─────────────────────────────────────────┐
│ Gabool Scanner           [RUNNING] ✅    │
│ Balance: $142.50  |  PnL: +$8.32/hr    │
├─────────────────────────────────────────┤
│ Active Markets: 47  |  Opportunities: 3  │
│                                          │
│ Market                YES   NO   Gap     │
│ ─────────────────────────────────────── │
│ 🟢 Will BTC hit 80k  0.32  0.65  3.0c  │
│ 🟡 ETH > 5000        0.15  0.82  3.0c  │
│ ⚪ Trump wins NH      0.45  0.53  2.0c  │
├─────────────────────────────────────────┤
│ Recent Trades                            │
│ Time   Market        Gap  Size  PnL     │
│ 14:32  BTC 80k       3.2c  50  +$1.60  │
│ 14:28  ETH merge     2.8c  30  +$0.84  │
├─────────────────────────────────────────┤
│ Live Logs                                │
│ [14:32:01] MERGE OK: BTC 80k +$1.60    │
│ [14:31:58] BUY YES+NO: BTC 80k 50×     │
│ [14:31:55] GAP DETECTED: BTC 80k 3.2c  │
└─────────────────────────────────────────┘
```

## CONFIG 초안

```typescript
const CONFIG = {
  // 스프레드 임계값
  MIN_GAP_CENTS: 2.0,        // 최소 2c gap (수수료 후 수익)

  // 사이징
  MIN_SHARES: 5,             // Polymarket 최소 주문
  MAX_SHARES_PER_TRADE: 100, // 최대 사이즈
  MAX_DOLLAR_PER_TRADE: 50,  // 최대 달러

  // 리스크
  MAX_OPEN_BUNDLES: 5,       // 동시 오픈 번들
  MAX_SINGLE_SIDE_EXPOSURE: 30, // 한쪽만 체결 시 최대 노출 ($)

  // 유동성
  MIN_LIQUIDITY_SHARES: 10,  // 양쪽 최소 유동성
  MAX_SPREAD_SLIPPAGE: 0.5,  // 주문~체결 사이 스프레드 변동 허용

  // 타이밍
  SCAN_INTERVAL_MS: 30_000,     // 마켓 스캔 주기
  MERGE_DELAY_MS: 5_000,        // 양쪽 체결 후 merge 대기
  SINGLE_SIDE_TIMEOUT_MS: 10_000, // 한쪽만 체결 시 타임아웃

  // Auto-merge
  AUTO_MERGE: true,           // 양쪽 체결 시 자동 merge
};
```

## 리스크 관리

### 한쪽만 체결되는 경우 (가장 큰 리스크)
1. YES 매수 성공, NO 매수 실패
2. → 10초 내 NO 재시도 (가격 변동 허용)
3. → 실패 시 YES 매도 (손실 감수)
4. → 손실 = YES 매수/매도 스프레드 + 수수료

### 완화 전략
- 유동성 낮은 마켓 스킵
- 양쪽 ask 물량 확인 후 진입
- 한쪽 체결 실패 시 즉시 반대쪽 매도
- 최대 노출 한도 설정

## 구현 순서

### Phase 1: 스캐너 + 모니터 (읽기 전용)
1. Gamma API로 바이너리 마켓 스캔
2. RTDS WS로 실시간 스프레드 모니터링
3. 대시보드에 기회 표시 (거래 X)

### Phase 2: 매수 실행
4. CLOB 유동성 확인
5. 동시 매수 로직
6. 한쪽 실패 시 롤백 로직

### Phase 3: 자동 Merge + 수익 확정
7. 양쪽 체결 확인 → mergePositions 호출
8. 밸런스 업데이트
9. PnL 추적

### Phase 4: 최적화
10. Maker 주문 (수수료 0) 지원
11. 멀티 아웃컴 마켓 지원
12. 가스비 최적화 (배치 merge)
