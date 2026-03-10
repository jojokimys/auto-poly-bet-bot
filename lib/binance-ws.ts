/**
 * Direct Binance WebSocket — BTC trade stream.
 * Bypasses RTDS 500ms relay lag for HFT speed scalping.
 * URL: wss://stream.binance.com:9443/ws/btcusdt@trade
 */

import WebSocket from 'ws';

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws/btcusdt@trade';
const MAX_RECONNECT_DELAY = 30_000;
const RING_BUFFER_SIZE = 20; // ~50ms granularity at high freq

interface PriceEntry {
  price: number;
  timestamp: number;
}

type TradeHandler = (price: number, timestamp: number) => void;

export class BinanceDirectWS {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;
  private latestPrice: PriceEntry | null = null;
  private ringBuffer: PriceEntry[] = [];
  private onTrade: TradeHandler | null = null;

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
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Binance trade event: { e: "trade", p: "91234.56", T: 1709... }
        if (msg.e === 'trade' && msg.p) {
          const price = parseFloat(msg.p);
          const timestamp = msg.T ?? Date.now();
          if (Number.isFinite(price) && price > 0) {
            this.latestPrice = { price, timestamp };
            this.ringBuffer.push({ price, timestamp });
            if (this.ringBuffer.length > RING_BUFFER_SIZE) {
              this.ringBuffer.shift();
            }
            this.onTrade?.(price, timestamp);
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

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.latestPrice = null;
    this.ringBuffer = [];
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
