/**
 * Coinbase Advanced Trade WebSocket — BTC-USD real-time trades.
 * URL: wss://advanced-trade-ws.coinbase.com
 * Channel: market_trades (no auth required for market data)
 */

import WebSocket from 'ws';

const COINBASE_WS_URL = 'wss://advanced-trade-ws.coinbase.com';
const MAX_RECONNECT_DELAY = 30_000;
const RING_BUFFER_SIZE = 20;

interface PriceEntry {
  price: number;
  timestamp: number;
}

type TradeHandler = (price: number, timestamp: number) => void;

export class CoinbaseDirectWS {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;
  private latestPrice: PriceEntry | null = null;
  private ringBuffer: PriceEntry[] = [];
  private onTrade: TradeHandler | null = null;
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

    this.ws = new WebSocket(COINBASE_WS_URL);

    this.ws.on('open', () => {
      console.log('[coinbase-ws] Connected');
      this.reconnectDelay = 1000;

      // Subscribe to BTC-USD market trades
      this.ws!.send(JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-USD'],
        channel: 'market_trades',
      }));

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
        if (msg.channel !== 'market_trades' || !msg.events) return;

        for (const event of msg.events) {
          if (event.type !== 'update' || !event.trades) continue;
          for (const trade of event.trades) {
            const price = parseFloat(trade.price);
            const timestamp = new Date(trade.time).getTime() || Date.now();
            if (Number.isFinite(price) && price > 0) {
              this.latestPrice = { price, timestamp };
              this.ringBuffer.push({ price, timestamp });
              if (this.ringBuffer.length > RING_BUFFER_SIZE) {
                this.ringBuffer.shift();
              }
              this.onTrade?.(price, timestamp);
            }
          }
        }
      } catch { /* ignore */ }
    });

    this.ws.on('close', () => {
      console.log('[coinbase-ws] Disconnected');
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[coinbase-ws] Error:', err.message);
    });
  }

  /** Latest BTC-USD trade price. Null if no data or stale (>10s). */
  getPrice(): number | null {
    if (!this.latestPrice) return null;
    if (Date.now() - this.latestPrice.timestamp > 10_000) return null;
    return this.latestPrice.price;
  }

  /** % change over last 5 trades. Positive = rising. */
  getMicroMomentum(): number | null {
    if (this.ringBuffer.length < 5) return null;
    const recent = this.ringBuffer.slice(-5);
    return (recent[recent.length - 1].price - recent[0].price) / recent[0].price;
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
    console.log(`[coinbase-ws] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
}
