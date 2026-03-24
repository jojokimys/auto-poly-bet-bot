# Auto Poly Bet Bot

## Dev Server

- **cmux surface:4에서 `yarn dev` 실행** — `cmux send --surface surface:4 "yarn dev"` + `cmux send-key --surface surface:4 Enter`
- 포트: 3000 (기본)
- LP 엔진 시작: `POST /api/lp { action: "start", profileId: "cmlmpyou700bn0y09gh4fem6y" }`
- LP 엔진 중지: `POST /api/lp { action: "stop" }`

## LP Farming Engine

Wall Rider 전략으로 Polymarket LP 리워드 파밍:

- 미드포인트에 가장 가까운 벽(wall) 뒤에 양쪽(YES+NO) limit order 배치
- WS 실시간 벽 감시 — 벽 무너지면 즉시 주문 철회
- 체결 시 즉시 market sell → LP 재배치
- 5분마다 마켓 재스캔, 30초마다 requote

### 주요 파라미터 (engine.ts)

| 파라미터 | 값 | 설명 |
|---|---|---|
| CAPITAL_PER_SIDE | 47% | 잔고의 47%를 각 사이드에 배치 |
| MIN_WALL_SIZE | $300 | 최소 벽 크기 |
| MAX_SPREAD_RATIO | 80% | maxSpread의 80% 이내만 진입 |
| maxMarkets | 30 | 최대 동시 진입 마켓 수 |
| HEDGE_TIMEOUT | 60s | 폴백 헤지 타임아웃 |

### Active Profile

- `THREE` (id: `cmlmpyou700bn0y09gh4fem6y`) — signatureType: POLY_PROXY
