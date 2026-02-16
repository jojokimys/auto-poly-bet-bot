# New Strategy Research — February 2026

> Researched 2026-02-17. Strategies NOT yet implemented, candidates for future development.

## 1. Spread Capture / Passive Market Making ⭐ Priority 1

**원리**: 양쪽(YES/NO)에 리밋 주문을 동시 배치하여 스프레드 수익 + maker 리워드 획득

**메커닉**:
- YES 53c bid + NO 43c bid → 둘 다 체결시 96c 투입, $0.98 정산 = 2c 확정 수익
- Polymarket maker 수수료 100% 리워드 환급 → 추가 수익
- 변동성 낮은 장기 마켓(정치/이벤트)에서 안정적

**성과 예상**: 승률 ~95%, 한 봇 $10K 시작→$700-800/일 수익 사례
**위험**: 한쪽만 체결시 방향 노출 (adverse selection)
**구현 난이도**: 중 — 양방향 주문 관리, 인벤토리 스큐 모니터링 필요
**$250 적합도**: 우수 — 5-10 마켓에 $25-50 배치

## 2. Cross-Timeframe Crypto Hedging ⭐ Priority 2

**원리**: 같은 자산의 5분/15분/1시간 마켓 간 가격 불일치 이용

**메커닉**:
- 5분 BTC UP 70c인데 15분 BTC UP 50c → 15분 YES 매수
- 기존 크립토 인프라(Binance 연동, 스캐너) 재활용 가능
- Polymarket 내부 시간대 간 비교 (외부 거래소 비교 아님)

**성과 예상**: 승률 55-65%, 하루 20-40건, 트레이드당 2-8c
**위험**: 모멘텀 신호 노이즈, 시간대 간 상관관계 불완전
**구현 난이도**: 중 — 기존 스캐너에 시간대 그룹핑 추가
**$250 적합도**: 우수 — 고빈도, 소액 포지션

## 3. Liquidity Reward Farming ⭐ Priority 3

**원리**: Polymarket 유동성 리워드 프로그램에 최적화된 주문 배치

**메커닉**:
- midpoint 근처 양방향 tight 주문 → quadratic spread function으로 리워드 3배
- 안정적 장기 마켓 선택 (변동 낮은 정치/규제 이벤트)
- midpoint < 10c이면 반드시 양방향 주문 필요

**성과 예상**: 연 10-200% (신규 마켓 높음, 성숙 마켓 ~10%)
**위험**: adverse selection (가격 급변시 구식 주문 체결)
**구현 난이도**: 하-중 — 리밋 주문 유지 + 주기적 리밸런싱
**$250 적합도**: 양호 — 패시브, 다른 전략과 병행

## 4. Whale Shadow / Smart Money Following

**원리**: 수익률 높은 지갑 10-20개 온체인 모니터링 → 따라가기

**메커닉**:
- Polygon RPC/인덱서로 지갑 트랜잭션 모니터링
- 2-3개 고수익 지갑이 30분 내 같은 방향 → 진입
- Polywhaler 등 도구로 $10K+ 거래 실시간 추적

**성과 예상**: 승률 65-75%, 트레이드당 2-10c, 하루 3-10건
**위험**: 고래 2차 지갑 사용, 의도적 미끼, 진입가 이미 반영됨
**구현 난이도**: 중 — Polygon RPC + 지갑 리스트 큐레이션
**$250 적합도**: 양호

## 5. Stale Order Sniping

**원리**: 가격 급변 후 취소 안 된 구식 주문 즉시 체결

**메커닉**:
- 5분 내 5c+ 가격 이동 감지
- 오더북에서 이동 전 가격의 리밋 주문 탐색
- 시장가 60c→75c, 65c 매도 주문 남아있음 → 체결

**성과 예상**: 승률 ~85-90%, 트레이드당 3-10c
**위험**: sub-100ms 실행 속도 필요
**구현 난이도**: 상 — WebSocket + 실시간 오더북 필요
**$250 적합도**: 보통 — 속도 인프라 한계

## 6. Order Book Imbalance Momentum

**원리**: bid/ask 깊이 비율로 단기 방향 예측

**메커닉**:
- imbalance = (bid_vol - ask_vol) / (bid_vol + ask_vol)
- |imbalance| > 0.5 → 무거운 쪽으로 진입, 2-3c TP
- 유동성 높은 크립토 마켓에서 최적

**성과 예상**: 승률 60-65%, 하루 10-30건, 트레이드당 1-3c
**위험**: 마이크로스트럭쳐 신호는 확률적 (높은 빈도로 보완)
**구현 난이도**: 상 — WebSocket L2 데이터 필요
**$250 적합도**: 보통

## 7. News Reaction / Sentiment Speed Trading

**원리**: 뉴스 감지 → 마켓 반영 전 30-60초 윈도우에 진입

**메커닉**:
- RSS/Twitter API + NLP 감정 분석
- 키워드 매칭으로 뉴스 이벤트 → Polymarket 조건 매핑
- 니치/저주목 마켓이 HFT 경쟁 적음

**성과 예상**: 승률 70-80%, 트레이드당 3-15c, 하루 2-10건
**위험**: HFT 봇과 속도 경쟁, NLP 오판
**구현 난이도**: 상 — 외부 API + NLP + 매핑 로직
**$250 적합도**: 보통

---

## 핵심 인사이트

> 가장 성공한 Polymarket 봇($313→$438K)은 **maker 주문만** 사용, 98% 승률.
> 현재 우리 전략은 전부 taker 주문 (수수료 지불). Maker 전환시:
> - 수수료 절약 (winning trade의 2% → 0%)
> - 리워드 수령 (Polymarket 유동성 리워드)
> - 체결 속도 trade-off (리밋 아래로 넣으면 미체결 가능)

## 소스

- [Polymarket 2025 Six Major Profit Models (ChainCatcher)](https://www.chaincatcher.com/en/article/2233047)
- [Polymarket Strategies 2026 (CryptoNews)](https://cryptonews.com/cryptocurrency/polymarket-strategies/)
- [Polymarket 15-Minute Crypto Guide (PolyTrack)](https://www.polytrackhq.app/blog/polymarket-15-minute-crypto-guide)
- [Polymarket Fee Curve (QuantJourney)](https://quantjourney.substack.com/p/understanding-the-polymarket-fee)
- [Arbitrage Bots Dominate Polymarket (Yahoo Finance)](https://finance.yahoo.com/news/arbitrage-bots-dominate-polymarket-millions-100000888.html)
- [Market Making on Polymarket](https://news.polymarket.com/p/automated-market-making-on-polymarket)
- [Polymarket Liquidity Rewards Docs](https://docs.polymarket.com/polymarket-learn/trading/liquidity-rewards)
- [Trading Bot $313→$438K (Finbold)](https://finbold.com/trading-bot-turns-313-into-438000-on-polymarket-in-a-month/)
