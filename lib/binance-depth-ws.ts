/**
 * Binance WebSocket — BTC/USDT orderbook depth stream.
 * Provides real-time order book imbalance (OBI) and wall detection.
 * URL: wss://stream.binance.com:9443/ws/btcusdt@depth20@100ms
 *
 * Streams top-20 bid/ask levels every 100ms.
 */

import WebSocket from 'ws';

const BINANCE_DEPTH_URL = 'wss://stream.binance.com:9443/ws/btcusdt@depth20@100ms';
const MAX_RECONNECT_DELAY = 30_000;
const OBI_HISTORY_SIZE = 60; // ~6 seconds at 100ms updates

interface DepthLevel {
  price: number;
  qty: number;
}

interface DepthSnapshot {
  bids: DepthLevel[];
  asks: DepthLevel[];
  timestamp: number;
}

interface OBIEntry {
  obi: number;
  timestamp: number;
}

export type DepthHandler = (snapshot: DepthSnapshot) => void;

export class BinanceDepthWS {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;
  private onDepth: DepthHandler | null = null;
  private pingMs: number | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt = 0;

  private latestDepth: DepthSnapshot | null = null;
  private obiHistory: OBIEntry[] = [];

  connect(onDepth?: DepthHandler): void {
    this.onDepth = onDepth ?? null;
    this.intentionalClose = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }

    this.ws = new WebSocket(BINANCE_DEPTH_URL);

    this.ws.on('open', () => {
      console.log('[binance-depth] Connected (BTC depth20 @100ms)');
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
        // Binance depth20 format: { bids: [["price","qty"],...], asks: [...] }
        if (msg.bids && msg.asks) {
          const snapshot: DepthSnapshot = {
            bids: msg.bids.map((b: string[]) => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) })),
            asks: msg.asks.map((a: string[]) => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) })),
            timestamp: Date.now(),
          };
          this.latestDepth = snapshot;
          this.updateOBI(snapshot);
          this.onDepth?.(snapshot);
        }
      } catch { /* ignore */ }
    });

    this.ws.on('close', () => {
      console.log('[binance-depth] Disconnected');
      if (!this.intentionalClose) this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[binance-depth] Error:', err.message);
    });
  }

  private updateOBI(snapshot: DepthSnapshot): void {
    const obi = this.computeOBI(snapshot);
    this.obiHistory.push({ obi, timestamp: snapshot.timestamp });
    if (this.obiHistory.length > OBI_HISTORY_SIZE) {
      this.obiHistory.shift();
    }
  }

  /**
   * Weighted Order Book Imbalance (top levels weighted more heavily).
   * Returns value between -1 (all asks) and +1 (all bids).
   * Positive = buying pressure, Negative = selling pressure.
   */
  computeOBI(snapshot?: DepthSnapshot): number {
    const depth = snapshot ?? this.latestDepth;
    if (!depth) return 0;

    let bidVol = 0;
    let askVol = 0;

    // Weight by inverse distance from mid: level 0 gets weight 1.0, decay 0.7 per level
    const DECAY = 0.7;
    const levels = Math.min(depth.bids.length, depth.asks.length, 10);

    for (let i = 0; i < levels; i++) {
      const weight = Math.pow(DECAY, i);
      bidVol += depth.bids[i].qty * weight;
      askVol += depth.asks[i].qty * weight;
    }

    const total = bidVol + askVol;
    if (total === 0) return 0;
    return (bidVol - askVol) / total;
  }

  /**
   * Detect OBI regime change (sign flip with magnitude).
   * Compares average OBI over recent window vs older window.
   * Returns { flipped, delta, recentOBI, olderOBI }.
   */
  getOBIFlip(recentWindowMs = 2000, olderWindowMs = 4000): {
    flipped: boolean;
    delta: number;
    recentOBI: number;
    olderOBI: number;
  } {
    const now = Date.now();
    const recentEntries = this.obiHistory.filter(e => now - e.timestamp <= recentWindowMs);
    const olderEntries = this.obiHistory.filter(
      e => now - e.timestamp > recentWindowMs && now - e.timestamp <= olderWindowMs
    );

    if (recentEntries.length < 3 || olderEntries.length < 3) {
      return { flipped: false, delta: 0, recentOBI: 0, olderOBI: 0 };
    }

    const recentOBI = recentEntries.reduce((s, e) => s + e.obi, 0) / recentEntries.length;
    const olderOBI = olderEntries.reduce((s, e) => s + e.obi, 0) / olderEntries.length;
    const delta = recentOBI - olderOBI;
    const flipped = Math.sign(recentOBI) !== Math.sign(olderOBI) && Math.abs(delta) > 0.15;

    return { flipped, delta, recentOBI, olderOBI };
  }

  /**
   * Get current OBI value (latest snapshot).
   */
  getCurrentOBI(): number {
    return this.computeOBI();
  }

  /**
   * Detect large walls in the orderbook.
   * A wall is a level with volume > wallMultiple × average level volume.
   */
  detectWalls(wallMultiple = 3): { bidWall: DepthLevel | null; askWall: DepthLevel | null } {
    if (!this.latestDepth) return { bidWall: null, askWall: null };

    const { bids, asks } = this.latestDepth;
    const levels = Math.min(bids.length, asks.length, 10);

    const avgBidQty = bids.slice(0, levels).reduce((s, b) => s + b.qty, 0) / levels;
    const avgAskQty = asks.slice(0, levels).reduce((s, a) => s + a.qty, 0) / levels;

    let bidWall: DepthLevel | null = null;
    let askWall: DepthLevel | null = null;

    for (let i = 0; i < levels; i++) {
      if (bids[i].qty > avgBidQty * wallMultiple && (!bidWall || bids[i].qty > bidWall.qty)) {
        bidWall = bids[i];
      }
      if (asks[i].qty > avgAskQty * wallMultiple && (!askWall || asks[i].qty > askWall.qty)) {
        askWall = asks[i];
      }
    }

    return { bidWall, askWall };
  }

  /**
   * Get bid/ask depth ratio (total bid volume / total ask volume within top N levels).
   */
  getDepthRatio(levels = 10): number {
    if (!this.latestDepth) return 1;
    const n = Math.min(this.latestDepth.bids.length, this.latestDepth.asks.length, levels);
    const bidVol = this.latestDepth.bids.slice(0, n).reduce((s, b) => s + b.qty, 0);
    const askVol = this.latestDepth.asks.slice(0, n).reduce((s, a) => s + a.qty, 0);
    if (askVol === 0) return 10;
    return bidVol / askVol;
  }

  /**
   * Get the spread in dollars.
   */
  getSpread(): number {
    if (!this.latestDepth || this.latestDepth.asks.length === 0 || this.latestDepth.bids.length === 0) return 0;
    return this.latestDepth.asks[0].price - this.latestDepth.bids[0].price;
  }

  getLatestDepth(): DepthSnapshot | null {
    return this.latestDepth;
  }

  getOBIHistory(): OBIEntry[] {
    return [...this.obiHistory];
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getPingMs(): number | null {
    return this.pingMs;
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.latestDepth = null;
    this.obiHistory = [];
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
    console.log(`[binance-depth] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
}
