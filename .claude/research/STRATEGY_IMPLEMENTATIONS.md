# Strategy Implementations Reference

> 코드베이스 `lib/bot/strategies/`의 전략 구현을 정리한 레퍼런스 문서.
> 각 전략의 진입 조건, 스코어링, 포지션 사이징, 리스크 관리를 요약.

---

## 전략 목록

| # | 전략명 | 타입 | 시간대 | 가격대 | 리스크 |
|---|--------|------|--------|--------|--------|
| 1 | [Value Betting](#1-value-betting) | 방향성 | 6h~30d | 15-85c | 중 |
| 2 | [Near-Expiry Sniper](#2-near-expiry-sniper) | 만기 수확 | 1-8h | 90-94c | 저 |
| 3 | [Micro-Scalper](#3-micro-scalper) | 만기 수확 | 5-60min | 93-97c | 저 |
| 4 | [Crypto Latency](#4-crypto-latency) | 래그 차익 | 2-13min | <70c | 중-고 |
| 5 | [Crypto Scalper](#5-crypto-scalper) | 래그 차익 | 3-45min | ≤15c or ≥85c | 중 |
| 6 | [Complement Arb](#6-complement-arb) | 무위험 차익 | 무관 | 합<97.5c | 극저 |
| 7 | [Multi-Outcome Arb](#7-multi-outcome-arb) | 무위험 차익 | 무관 | 합<97.5c | 극저 |
| 8 | [Panic Reversal](#8-panic-reversal) | 평균회귀 | >2h 만기 | 50-90c | 중-고 |

**공통 상수:** Winner Fee = 2%, Effective Payout = $0.98/share

---

## 1. Value Betting

**파일:** `value-betting.ts` | **기본 전략** (Default)

### 개요
스캐너의 멀티팩터 스코어링으로 저평가된 아웃컴을 매수. 시장가보다 약간 낮은 리밋 오더로 진입.

### 진입 조건
| 필터 | 값 |
|------|-----|
| 괴리 (dislocation) | > 5% (50/50에서 벗어남) |
| 가격 | 15c ~ 85c |
| 만기 | > 6h (스캐너에서 필터) |
| 유동성 | > $1,000 |
| 거래량 24h | > $5,000 |
| 스프레드 | < 5c |

### 포지션 사이징
```
confidence = min(1, score / 80)
targetCost = maxBetAmount × confidence
limitDiscount = 1c + (spread / 2)
limitPrice = price - limitDiscount
size = targetCost / limitPrice
```

### 특징
- 리밋 오더를 시장가보다 1-2% 낮게 설정 → 유리한 가격 체결 기대
- 스코어 80+ 이면 최대 사이즈 배분
- 극단적 가격 (15c 미만, 85c 초과) 제외

---

## 2. Near-Expiry Sniper

**파일:** `near-expiry-sniper.ts`

### 개요
만기 1-8시간 이내, 90-94c 토큰 매수. 4개 시그널 중 3개 이상 확인시 진입. 만기 후 $0.98 수령.

### 진입 조건 (Hard Filters)
| 필터 | 값 |
|------|-----|
| 가격 | 90c ~ 94c |
| 만기 | 1h ~ 8h |
| 유동성 | ≥ $2,000 |
| 거래량 24h | ≥ $5,000 |
| 스프레드 | ≤ 2c |
| Yes+No 합 | ~$1.00 (±2c) |
| 반대편 가격 | < 12c |
| 순이익/주 | > 0.5c |

### 멀티 시그널 스코어링 (100점)
| 시그널 | 배점 | 확인 조건 |
|--------|------|-----------|
| Price Level | 0-25 | (price - 0.90) / 0.04 × 25 |
| Time Decay | 0-25 | ≤2h=25, ≤4h=22, ≤6h=18, else=12. 확인: ≤6h |
| Momentum | 0-20 | 24h 가격 상승폭 기반. 확인: 상승 중. **3c+ 급락 시 HARD REJECT** |
| Volume | 0-15 | vol/liq 비율. 확인: ≥0.3 |
| Spread | 0-15 | ≤0.5c=15, ≤1c=12, ≤1.5c=8, else=4. 확인: ≤1.5c |

**게이트:** 확인된 시그널 ≥ 3개, 총점 ≥ 60

### 포지션 사이징
```
maxPerTrade = balance × 5%
confidence = min(1.0, totalScore / 80)
targetCost = maxPerTrade × confidence
4개 시그널 모두 확인시: targetCost × 1.2 (최대 7%)
```

---

## 3. Micro-Scalper

**파일:** `micro-scalper.ts`

### 개요
5-60분 만기 마켓에서 93-97c 토큰 매수. 3단계 티어 시스템.

### 티어 구조
| 티어 | 시간 | 가격 | 스프레드 | 유동성 | 거래량 | 포지션% |
|------|------|------|----------|--------|--------|---------|
| **Sprint** | 5-15min | 95-97c | ≤1c | ≥$3K | ≥$8K | 10% |
| **Dash** | 15-30min | 94-97c | ≤1.5c | ≥$2.5K | ≥$6K | 8% |
| **Quick** | 30-60min | 93-96c | ≤2c | ≥$2K | ≥$5K | 6% |

### 추가 필터
- Yes+No 합 = $1.00 ±2c
- 반대편 가격 < 10c
- 순이익 ≥ 1c/주 (fee 후)
- **모멘텀 가드:** 2h 내 2c+ 급락 → HARD REJECT
- 가격 하락 0.5c+ → 거부

### 컨피던스 스코어링 (100점)
| 요소 | 배점 |
|------|------|
| Time Proximity | 0-30 (≤10min=30, ≤20=25, ≤40=20, else=15) |
| Price Level | 0-21 ((price - 0.90) × 300) |
| Spread | 0-20 (≤0.5c=20, ≤1c=15, ≤1.5c=10) |
| Volume Conviction | 0-15 (vol/liq ≥0.5=15, ≥0.3=10) |
| Momentum | 0-10 (상승=10, 안정=5) |

**게이트:** conf ≥ 60

### 포지션 사이징
```
scaledPct = tier.maxPositionPct × (confidence / 85)
targetCost = balance × min(scaledPct, maxPct)
```

---

## 4. Crypto Latency

**파일:** `crypto-latency.ts`

### 개요
15분 크립토 마켓에서 바이낸스 현물가 vs 폴리마켓 괴리 차익. BTC가 이미 움직였는데 폴리마켓 가격이 반영 안됐을 때 진입.

### 진입 조건
| 필터 | 값 |
|------|-----|
| 필수 데이터 | spotPrice, openingPrice 존재 |
| 만기 | 2~13분 |
| 현물 움직임 | ≥ 0.1% |
| 타겟 토큰가 | 5c ~ 70c |

### 방향 결정
- BTC 상승 → YES 매수 (YES가 저평가)
- BTC 하락 → NO 매수 (NO가 저평가)

### 스코어링 (100점)
| 요소 | 배점 |
|------|------|
| Move Magnitude | 0-35 (abs% / 0.5% × 35) |
| Time Remaining | 0-25 (5-10min=25, 3-5=20, >10=15, 2-3=10) |
| Token Discount | 0-25 ((0.70 - price) / 0.40 × 25) |
| Volume | 0-15 (log10(vol) × 3) |

**게이트:** score ≥ 50

### 포지션 사이징
```
confidence = min(1.0, score / 80)
pctOfBalance = 5% + 3% × confidence  (5-8%)
targetCost = balance × pctOfBalance
```

---

## 5. Crypto Scalper

**파일:** `crypto-scalper.ts`

### 개요
**유일한 SELL 시그널 생성 전략.** 바이낸스 현물 vs 폴리마켓 가격 괴리를 이용. 극단적 가격대(≤15c or ≥85c)에서만 진입하여 수수료 최소화.

### 진입 조건
| 필터 | 값 |
|------|-----|
| 필수 데이터 | spotPrice, openingPrice, cryptoAsset |
| 만기 | 3~45분 |
| 가격대 | ≤15c 또는 ≥85c (수수료 최소화) |
| 괴리 (dislocation) | ≥ 5c |

### Fair Price 계산
```typescript
fairYes = 0.50 + ((spot - strike) / strike) × 120
// ±0.4% 현물 이동 → 0.02~0.98 범위 매핑
```

### 엔트리 스코어링 (100점)
| 요소 | 배점 |
|------|------|
| Dislocation | 0-35 (gap / 15c × 35) |
| Spot Move | 0-25 (abs% / 0.5% × 25) |
| Time Remaining | 0-20 (5-20min=20, 3-5=12, 20-35=15, else=8) |
| Volume | 0-20 (log10(vol) × 4) |

**게이트:** score ≥ 50

### 엑싯 로직 (4가지 트리거)
| 트리거 | 조건 | 설명 |
|--------|------|------|
| Take Profit | currentPrice ≥ targetPrice | TP = entryPrice + dislocation × 50% |
| Stop Loss | currentPrice ≤ stopPrice | SL = entryPrice - 3c |
| Time Exit | 보유 ≥ 12분 | 최대 보유 시간 초과 |
| Dislocation Closed | \|fair - market\| < 2c | 괴리 소멸 |

### 포지션 사이징
```
confidence = min(1.0, score / 80)
targetCost = balance × 2.5% × confidence  (보수적)
```

---

## 6. Complement Arb

**파일:** `complement-arb.ts`

### 개요
바이너리 마켓에서 YES + NO 동시 매수. 합산 비용 < $0.975이면 아웃컴 무관 이익 보장.

### 진입 조건
| 필터 | 값 |
|------|-----|
| 필수 데이터 | yesBestAsk, noBestAsk, yesTokenId, noTokenId |
| 합산 비용 | < $0.975 (2.5c+ gross → 0.5c+ net) |
| Ask Depth (각 쪽) | ≥ $50 |
| 개별 가격 | 각각 < 95c |

### 스코어링 (100점)
| 요소 | 배점 |
|------|------|
| Profit Margin | 0-40 (grossProfit / 3c × 40) |
| Min Depth | 0-30 (minDepth / $500 × 30) |
| Volume | 0-30 (log10(vol) × 6) |

**게이트:** score ≥ 40

### 포지션 사이징
```
confidence = min(1.0, score / 80)
targetCost = balance × 8% × confidence  (시장 중립이므로 공격적)
size = targetCost / combinedCost
```

### 실행
- **두 레그 동시 실행** (YES BUY + NO BUY)
- `secondLeg` 필드로 두 번째 주문 정보 전달
- 한쪽만 체결되면 방향 노출 위험

---

## 7. Multi-Outcome Arb

**파일:** `multi-outcome-arb.ts`

### 개요
3개 이상 아웃컴 마켓에서 전체 YES 매수 비용 < $0.975이면 번들 매수. 정확히 하나가 $1.00로 결제되므로 이익 보장.

### 진입 조건
| 필터 | 값 |
|------|-----|
| 아웃컴 수 | ≥ 3 |
| 번들 비용 | < $0.975 |
| 각 레그 Ask Depth | ≥ $25 |
| 번들 데이터 | bundleLegs, bundleCost 존재 |

### 스코어링 (100점)
| 요소 | 배점 |
|------|------|
| Profit Margin | 0-40 (grossProfit / 3c × 40) |
| Min Leg Depth | 0-30 (minDepth / $300 × 30) |
| Event Volume | 0-30 (log10(vol) × 5) |

**게이트:** score ≥ 30 (낮은 임계값 - 무위험이므로)

### 실행
- 가장 비싼 아웃컴을 primary leg로 설정
- 나머지는 `bundleLegs` 배열로 전달
- **모든 레그 체결 필수** — 부분 체결시 방향 노출

---

## 8. Panic Reversal

**파일:** `panic-reversal.ts`

### 개요
고확률 마켓(>50c)이 2시간 내 5c+ 급락 후 회복 신호 감지시 매수. 패닉/고래 매도 후 평균회귀 기대.

### 진입 조건
| 필터 | 값 |
|------|-----|
| 가격 | 50c ~ 90c |
| 거래량 24h | ≥ $10,000 |
| 유동성 | ≥ $5,000 |
| 가격 관측 수 | ≥ 3회 (2h 윈도우) |
| 2h 고점 대비 하락 | ≥ 5c |
| Yes+No 합 | $1.00 ±5c (정상 마켓 확인) |
| 회복 신호 | 현재가 ≥ 직전 관측가 |

### 스코어링 (100점)
| 요소 | 배점 |
|------|------|
| Drop Magnitude | 0-30 (drop / 15c × 30) |
| Volume | 0-25 (log10(vol) × 5) |
| Recovery Amount | 0-25 (recovery / 3c × 25) |
| Spread | 0-20 (≤1c=20, ≤2c=15, ≤3c=10, ≤5c=5) |

**게이트:** score ≥ 55

### 포지션 사이징
```
confidence = min(1.0, score / 80)
pctOfBalance = 3% + 2% × confidence  (3-5%, 고위험 전략이므로 보수적)
```

---

## 전략 간 비교

### 시간대 커버리지
```
|--5m--|--15m--|--30m--|--1h--|---8h---|---24h---|------30d------|
|Sprint|--Dash-|Quick-|       |        |         |               |
|--CryptoLatency(2-13m)--|    |        |         |               |
|---CryptoScalper(3-45m)-----|        |         |               |
|           NearExpiry(1-8h)-----------|         |               |
|                   PanicReversal(>2h 만기)------|               |
|                             ValueBetting(6h+)-----------------|
|           CompArb/MultiArb: 시간 무관 (즉시 차익)             |
```

### 위험-수익 스펙트럼
```
낮은 위험 ◄─────────────────────────────────────────► 높은 위험
CompArb   MultiArb   NearExpiry   MicroScalp   Value   CryptoScalp   CryptoLatency   Panic
(~1%)     (~3%)      (4-8%)       (1-3%)       (5-50%) (5-15%)       (10-30%)        (5-15%)
```

### 포지션 사이징 비교
| 전략 | Balance 대비 % | 근거 |
|------|----------------|------|
| Complement Arb | 8% | 시장 중립, 무위험 |
| Multi-Outcome Arb | 8% | 시장 중립, 무위험 |
| Micro-Scalper | 6-10% (티어별) | 높은 확률, 짧은 보유 |
| Crypto Latency | 5-8% | 중위험, 빠른 체결 필요 |
| Near-Expiry | 5-7% | 높은 확률, 멀티시그널 확인 |
| Value Betting | maxBetAmount 기준 | 설정에 의존 |
| Panic Reversal | 3-5% | 높은 위험, 보수적 |
| Crypto Scalper | 2.5% | DB 추적, 손절 내장 |

---

## 공통 패턴

### 1. 모멘텀 가드
Near-Expiry, Micro-Scalper 모두 가격 급락 이력 감지시 **HARD REJECT**:
- Near-Expiry: 24h 내 3c+ 급락
- Micro-Scalper: 2h 내 2c+ 급락

### 2. 스코어링 → 게이트 → 사이징
모든 전략이 동일 패턴 사용:
1. 멀티팩터 스코어 계산 (0-100)
2. 최소 점수 게이트 통과
3. `confidence = min(1.0, score / N)` → 사이즈 비례 조정

### 3. Fair Price vs Market Price
Crypto 전략들은 바이낸스 현물가로 "공정 가격"을 계산하고, 폴리마켓 가격과의 괴리를 측정:
```
fairYes = 0.50 + ((spot - strike) / strike) × 120
dislocation = fairPrice - marketPrice
```
