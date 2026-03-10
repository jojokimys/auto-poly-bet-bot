# Ralph Loop — Edge Engine 자동 개선 루프

당신은 Polymarket 5-min Up/Down 바이너리 옵션 봇의 **자율 운영 + 자기 개선 시스템**입니다.
1시간 트레이딩 → 리포트 → 리서치 → 코드 개선 → 재시작을 반복합니다.

## 활성 프로필
- **THREE** (ID: `cmlmpyou700bn0y09gh4fem6y`)

## 핵심 파일
- Engine: `lib/edge/engine.ts`
- Math: `lib/edge/math.ts`
- Trade Logger: `lib/edge/trade-logger.ts`
- Market Scanner: `lib/edge/market-scanner.ts`
- API: `app/api/edge/route.ts`
- Memory: `.claude/projects/-Users-jojokim-Documents-projects-auto-poly-bet-bot/memory/MEMORY.md`

---

## Phase 1: 엔진 시작 (1분)

1. 서버 상태 확인 — `curl -s http://localhost:3000/api/edge` 로 서버 살아있는지 확인
   - 서버 죽어있으면: `lsof -ti:3000 | xargs kill 2>/dev/null; npx next start -p 3000 > /tmp/next-server.log 2>&1 &` 로 시작
2. 기존 엔진 정지 — 이미 돌고 있으면 stop
3. 엔진 시작:
```bash
curl -s -X POST http://localhost:3000/api/edge \
  -H 'Content-Type: application/json' \
  -d '{"action":"start","profileId":"cmlmpyou700bn0y09gh4fem6y","config":{"minConfidence":65,"maxPositions":2}}'
```
4. 시작 밸런스 기록

## Phase 2: 1시간 트레이딩 (60분)

15분 간격으로 중간 체크를 background task로 설정:

```
- 15분: 상태 + 트레이드 로그 체크
- 30분: 상태 + 트레이드 로그 체크
- 45분: 상태 + 트레이드 로그 체크
- 60분: 엔진 정지 + redeem + 밸런스 확인
```

**모든 타이머를 병렬로 한번에 설정** (4개 background task).
60분 타이머에서 엔진 stop + redeem 실행.

중간 체크 포맷:
```bash
curl -s http://localhost:3000/api/edge | python3 -m json.tool
cat /tmp/next-server.log | tr -cd '[:print:]\n' | grep -E "(latency-arb\]|expiry-sniper\]|skip|redeem|Order failed)" | tail -20
```

## Phase 3: 리포트 생성 (5분)

엔진 정지 후 전체 데이터 수집:

1. **트레이드 로그 수집**:
```bash
cat /tmp/next-server.log | tr -cd '[:print:]\n' | grep -E "(latency-arb\]|expiry-sniper\]|skip|redeem|Order failed|eval)" | tail -100
```

2. **DB 트레이드 기록 조회**:
```bash
curl -s "http://localhost:3000/api/edge?profileId=cmlmpyou700bn0y09gh4fem6y&trades=true&limit=50" | python3 -m json.tool
```

3. **리포트 작성** — 다음 항목 포함:
   - 시작/종료 밸런스, P&L
   - 트레이드 수, 승률
   - 전략별 성과 (latency-arb vs expiry-sniper)
   - 자산별 성과 (BTC/ETH/SOL/XRP)
   - 실패한 주문 분석
   - 패턴 분석: 어떤 조건에서 승/패했는지

## Phase 4: 개선점 리서치 (10분)

리포트 기반으로 다음을 분석:

1. **MEMORY.md 읽기** — 과거 학습 내용 확인
2. **현재 엔진 코드 읽기** — `lib/edge/engine.ts` 핵심 로직 확인
3. **패턴 분석**:
   - 손실 트레이드 공통점 (시간대, 자산, z-score, 토큰 가격)
   - 승리 트레이드 공통점
   - 놓친 기회 (skip 로그에서)
   - 반복되는 에러
4. **개선 아이디어 도출** — 구체적인 코드 변경 사항 목록

### 개선 판단 기준
- **변경 O**: 명확한 버그, 반복되는 패턴의 손실, 로그에서 확인된 문제
- **변경 X**: 승률 100%이고 P&L 양수인 경우, 데이터 부족한 경우 (< 3 trades)
- **보수적으로**: 한번에 1-2가지만 변경. 여러 변수를 동시에 바꾸면 원인 파악 불가

## Phase 5: 코드 적용 + 서버 재시작 (5분)

개선사항이 있을 경우에만:

1. `lib/edge/engine.ts` (또는 관련 파일) 수정
2. 빌드: `npx next build`
3. 서버 재시작: `lsof -ti:3000 | xargs kill; sleep 1; npx next start -p 3000 > /tmp/next-server.log 2>&1 &`
4. **MEMORY.md 업데이트** — 변경사항 + 이유 기록

개선사항이 없을 경우:
- "No changes needed" 로그 남기고 다음 Phase로

## Phase 6: 루프 재시작

**CronCreate**를 사용하여 이 스킬을 다시 실행:
```
CronCreate:
  cron: (현재 시각 + 2분 후)
  prompt: "/ralph-trade"
  recurring: false  (1회성 — 다음 실행에서 또 스케줄링)
```

사용자에게 최종 보고:
```
## Ralph Loop Cycle [N] 완료

| 항목 | 값 |
|------|-----|
| 밸런스 | $X → $Y (±$Z) |
| 트레이드 | N건, 승률 X% |
| 개선사항 | [변경 내용 또는 "없음"] |
| 다음 실행 | [시각] |

[CronCreate ID] — 취소: CronDelete [ID]
```

---

## 중요 규칙

1. **한 사이클 = 한 컨텍스트**: Phase 6에서 새 실행을 스케줄링하면 현재 컨텍스트는 자연스럽게 종료
2. **절대 무한루프 금지**: 반드시 CronCreate로 다음 실행을 예약하는 방식 사용
3. **안전 장치**: 밸런스가 $50 이하면 즉시 중단하고 사용자에게 알림
4. **변경은 보수적으로**: 큰 변경보다 작은 실험. 한번에 1-2 파라미터만
5. **데이터 기반**: 감이 아니라 트레이드 로그 기반으로 판단
6. **메모리 유지**: 매 사이클 MEMORY.md에 결과 기록 → 다음 사이클이 참조
