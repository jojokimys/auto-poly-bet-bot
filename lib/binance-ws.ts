/**
 * Direct Binance WebSocket — BTC trade stream.
 * Bypasses RTDS 500ms relay lag for HFT speed scalping.
 * URL: wss://stream.binance.com:9443/ws/btcusdt@trade
 *
 * Also tracks trade flow intensity:
 *   - Taker buy vs sell volume over rolling windows
 *   - Flow imbalance (buy volume - sell volume) / total
 *   - Acceleration: is buy/sell intensity increasing?
 *
 * Binance trade `m` field: true = buyer is maker → taker SELL
 *                          false = buyer is taker → taker BUY
 */

import WebSocket from 'ws';

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws/btcusdt@trade';
const MAX_RECONNECT_DELAY = 30_000;
const RING_BUFFER_SIZE = 20;
const FLOW_BUFFER_SIZE = 500; // ~10-30 seconds of trades depending on activity

interface PriceEntry {
  price: number;
  timestamp: number;
}

interface FlowEntry {
  price: number;
  qty: number;
  isBuyerTaker: boolean; // true = aggressive buy, false = aggressive sell
  timestamp: number;
}

export interface TradeFlowStats {
  /** Buy volume - Sell volume / Total volume, [-1, 1]. Positive = buying pressure */
  imbalance: number;
  /** Total taker buy volume in window (BTC) */
  buyVolume: number;
  /** Total taker sell volume in window (BTC) */
  sellVolume: number;
  /** Trades per second in window */
  tradesPerSec: number;
  /** Flow imbalance acceleration: recent vs older (positive = buy pressure increasing) */
  acceleration: number;
  /** Number of trades in window */
  tradeCount: number;
  /** Volume spike ratio: current window volume / baseline average. >2 = spike */
  volumeSpike: number;
}

type TradeHandler = (price: number, timestamp: number) => void;
export type RawTradeHandler = (trade: { price: number; qty: number; isBuyerTaker: boolean; timestamp: number }) => void;

export class BinanceDirectWS {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;
  private latestPrice: PriceEntry | null = null;
  private ringBuffer: PriceEntry[] = [];
  private flowBuffer: FlowEntry[] = [];
  private onTrade: TradeHandler | null = null;
  private onRawTrade: RawTradeHandler | null = null;
  private pingMs: number | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt = 0;

  connect(onTrade?: TradeHandler): void {
    this.onTrade = onTrade ?? null;
    this.intentionalClose = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }

    this.ws = new WebSocket(BINANCE_WS_URL);

    this.ws.on('open', () => {
      console.log('[binance-ws] Connected (direct BTC trade stream)');
      this.reconnectDelay = 1000;
      this.startPing();
    });

    this.ws.on('pong', () => {
      if (this.pingSentAt > 0) {
        this.pingMs = Date.now() - this.pingSentAt;
        this.pingSentAt = 0;
      }
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Binance trade: { e:"trade", p:"91234.56", q:"0.001", m:true/false, T:1709... }
        // m=true → buyer is maker → taker is SELLER
        // m=false → buyer is taker → taker is BUYER
        if (msg.e === 'trade' && msg.p) {
          const price = parseFloat(msg.p);
          const qty = parseFloat(msg.q ?? '0');
          const timestamp = msg.T ?? Date.now();
          const isBuyerTaker = msg.m === false;

          if (Number.isFinite(price) && price > 0) {
            this.latestPrice = { price, timestamp };
            this.ringBuffer.push({ price, timestamp });
            if (this.ringBuffer.length > RING_BUFFER_SIZE) {
              this.ringBuffer.shift();
            }

            // Track trade flow
            if (qty > 0) {
              this.flowBuffer.push({ price, qty, isBuyerTaker, timestamp });
              if (this.flowBuffer.length > FLOW_BUFFER_SIZE) {
                this.flowBuffer.shift();
              }
            }

            this.onTrade?.(price, timestamp);
            this.onRawTrade?.({ price, qty, isBuyerTaker, timestamp });
          }
        }
      } catch { /* ignore */ }
    });

    this.ws.on('close', () => {
      console.log('[binance-ws] Disconnected');
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[binance-ws] Error:', err.message);
    });
  }

  /** Sync — returns latest BTC trade price. Null if no data or stale (>10s). */
  getPrice(): number | null {
    if (!this.latestPrice) return null;
    if (Date.now() - this.latestPrice.timestamp > 10_000) return null;
    return this.latestPrice.price;
  }

  /** % change over last 5 trades (~250ms window). Positive = rising. */
  getMicroMomentum(): number | null {
    if (this.ringBuffer.length < 5) return null;
    const recent = this.ringBuffer.slice(-5);
    const oldest = recent[0];
    const newest = recent[recent.length - 1];
    return (newest.price - oldest.price) / oldest.price;
  }

  /**
   * Get trade flow stats for a rolling window.
   * @param windowMs - lookback window in ms (default 5000 = 5 seconds)
   */
  getTradeFlow(windowMs = 5000): TradeFlowStats {
    const now = Date.now();
    const cutoff = now - windowMs;
    const trades = this.flowBuffer.filter(t => t.timestamp >= cutoff);

    if (trades.length < 2) {
      return { imbalance: 0, buyVolume: 0, sellVolume: 0, tradesPerSec: 0, acceleration: 0, tradeCount: 0, volumeSpike: 0 };
    }

    let buyVol = 0;
    let sellVol = 0;
    for (const t of trades) {
      if (t.isBuyerTaker) buyVol += t.qty;
      else sellVol += t.qty;
    }

    const total = buyVol + sellVol;
    const imbalance = total > 0 ? (buyVol - sellVol) / total : 0;

    const spanMs = trades[trades.length - 1].timestamp - trades[0].timestamp;
    const tradesPerSec = spanMs > 0 ? (trades.length / spanMs) * 1000 : 0;

    // Acceleration: compare flow imbalance of recent half vs older half
    const mid = Math.floor(trades.length / 2);
    const olderTrades = trades.slice(0, mid);
    const recentTrades = trades.slice(mid);

    let olderBuy = 0, olderSell = 0, recentBuy = 0, recentSell = 0;
    for (const t of olderTrades) { if (t.isBuyerTaker) olderBuy += t.qty; else olderSell += t.qty; }
    for (const t of recentTrades) { if (t.isBuyerTaker) recentBuy += t.qty; else recentSell += t.qty; }

    const olderTotal = olderBuy + olderSell;
    const recentTotal = recentBuy + recentSell;
    const olderImb = olderTotal > 0 ? (olderBuy - olderSell) / olderTotal : 0;
    const recentImb = recentTotal > 0 ? (recentBuy - recentSell) / recentTotal : 0;
    const acceleration = recentImb - olderImb;

    // Volume spike: compare current window volume vs baseline (4x window lookback)
    const baselineCutoff = now - windowMs * 4;
    const baselineTrades = this.flowBuffer.filter(t => t.timestamp >= baselineCutoff && t.timestamp < cutoff);
    let baselineVol = 0;
    for (const t of baselineTrades) baselineVol += t.qty;
    // Normalize to same window size (baseline covers 3x windowMs)
    const baselineAvgPerWindow = baselineTrades.length > 0 ? baselineVol / 3 : total;
    const volumeSpike = baselineAvgPerWindow > 0 ? total / baselineAvgPerWindow : 1;

    return {
      imbalance,
      buyVolume: buyVol,
      sellVolume: sellVol,
      tradesPerSec,
      acceleration,
      tradeCount: trades.length,
      volumeSpike,
    };
  }

  setRawTradeHandler(handler: RawTradeHandler | null): void {
    this.onRawTrade = handler;
  }

  /** Return recent price samples for volatility estimation. */
  getPriceHistory(): { price: number; timestamp: number }[] {
    return [...this.ringBuffer];
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getPingMs(): number | null {
    return this.pingMs;
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.latestPrice = null;
    this.ringBuffer = [];
    this.flowBuffer = [];
    this.pingMs = null;
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.pingSentAt = Date.now();
        this.ws.ping();
      }
    }, 10_000);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log(`[binance-ws] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
}
