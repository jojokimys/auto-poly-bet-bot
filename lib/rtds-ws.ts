/**
 * Polymarket RTDS WebSocket — real-time crypto spot prices.
 *
 * Connects to wss://ws-live-data.polymarket.com (free, no auth).
 * Subscribes to `crypto_prices` (Binance) and `crypto_prices_chainlink` (settlement oracle).
 * Provides sync getSpotPrice() — no API calls, just reads in-memory map.
 */

import WebSocket from 'ws';
import type { CryptoAsset } from './trading-types';

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const HEARTBEAT_MS = 15_000;           // ping every 15s (5s was too aggressive)
const PONG_TIMEOUT_MS = 10_000;        // force reconnect if no pong within 10s
const LIVENESS_TIMEOUT_MS = 45_000;    // force reconnect if no data for 45s
const MAX_RECONNECT_DELAY = 30_000;

/** Map asset name → RTDS symbol (Binance source) */
const ASSET_TO_SYMBOL: Record<CryptoAsset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};

const SYMBOL_TO_ASSET: Record<string, CryptoAsset> = {
  btcusdt: 'BTC',
  ethusdt: 'ETH',
  solusdt: 'SOL',
  xrpusdt: 'XRP',
};

/** Chainlink RTDS symbols → asset (settlement oracle) */
const CHAINLINK_SYMBOL_TO_ASSET: Record<string, CryptoAsset> = {
  'btc/usd': 'BTC',
  'eth/usd': 'ETH',
  'sol/usd': 'SOL',
  'xrp/usd': 'XRP',
};

export interface SpotPriceEntry {
  price: number;
  timestamp: number;
}

type PriceHandler = (asset: CryptoAsset, price: number, timestamp: number) => void;

const PRICE_HISTORY_SIZE = 10; // ~10s of history at ~1s updates

export class RtdsWS {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;
  private prices: Map<CryptoAsset, SpotPriceEntry> = new Map();
  private chainlinkPrices: Map<CryptoAsset, SpotPriceEntry> = new Map();
  private priceHistory: Map<CryptoAsset, SpotPriceEntry[]> = new Map();
  private onPrice: PriceHandler | null = null;
  private lastDataAt = 0;

  connect(onPrice?: PriceHandler): void {
    this.onPrice = onPrice ?? null;
    this.intentionalClose = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }

    this.ws = new WebSocket(RTDS_URL);

    this.ws.on('open', () => {
      console.log('[rtds] Connected');
      this.reconnectDelay = 1000;
      this.lastDataAt = Date.now();

      // Subscribe to Binance crypto prices
      this.ws!.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{
          topic: 'crypto_prices',
          type: '*',
        }],
      }));

      // Subscribe to Chainlink crypto prices (settlement oracle)
      this.ws!.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{
          topic: 'crypto_prices_chainlink',
          type: '*',
        }],
      }));

      // Start heartbeat + liveness check
      this.stopTimers();
      this.heartbeatTimer = setInterval(() => this.sendPing(), HEARTBEAT_MS);
      this.resetLivenessTimer();
    });

    // Handle WebSocket-level pong (response to ws.ping())
    this.ws.on('pong', () => {
      this.clearPongTimer();
    });

    this.ws.on('message', (data) => {
      const msg = data.toString();
      this.lastDataAt = Date.now();
      this.resetLivenessTimer();

      if (msg === 'PONG') {
        this.clearPongTimer();
        return;
      }

      try {
        const parsed = JSON.parse(msg);
        if (parsed.statusCode) return; // error response

        const topic = parsed.topic as string | undefined;
        const payload = parsed.payload;
        if (!topic || !payload) return;

        // Live update: payload = { symbol, value, timestamp, full_accuracy_value }
        if (payload.symbol && payload.value != null) {
          this._handlePriceItem(payload, topic);
        }

        // Initial snapshot dump: payload = { symbol, data: [{timestamp, value}, ...] }
        if (payload.symbol && Array.isArray(payload.data) && payload.data.length > 0) {
          const last = payload.data[payload.data.length - 1];
          if (last?.value != null) {
            this._handlePriceItem({ symbol: payload.symbol, value: last.value, timestamp: last.timestamp }, topic);
          }
        }
      } catch {
        // Ignore unparseable messages
      }
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'unknown';
      console.log(`[rtds] Disconnected (code=${code}, reason=${reasonStr})`);
      this.stopTimers();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[rtds] Error:', err.message);
      // error is always followed by close, so reconnect happens there
    });
  }

  private sendPing(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Send both WebSocket-level ping AND text PING
    try {
      this.ws.ping();
      this.ws.send('PING');
    } catch {
      // Connection may be broken
    }

    // Start pong timeout — if no pong/data within PONG_TIMEOUT_MS, force reconnect
    this.clearPongTimer();
    this.pongTimer = setTimeout(() => {
      console.warn('[rtds] Pong timeout — forcing reconnect');
      this.forceReconnect();
    }, PONG_TIMEOUT_MS);
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private resetLivenessTimer(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = setTimeout(() => {
      const age = Date.now() - this.lastDataAt;
      console.warn(`[rtds] No data for ${(age / 1000).toFixed(0)}s — forcing reconnect`);
      this.forceReconnect();
    }, LIVENESS_TIMEOUT_MS);
  }

  private forceReconnect(): void {
    this.stopTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    if (!this.intentionalClose) {
      this.scheduleReconnect();
    }
  }

  private _handlePriceItem(item: { symbol: string; value: string | number; timestamp?: number }, topic?: string): void {
    const symbol = String(item.symbol).toLowerCase();
    const price = typeof item.value === 'string' ? parseFloat(item.value) : item.value;
    const timestamp = item.timestamp ?? Date.now();
    if (!Number.isFinite(price) || price <= 0) return;

    // Route by topic if available
    if (topic === 'crypto_prices_chainlink') {
      const chainlinkAsset = CHAINLINK_SYMBOL_TO_ASSET[symbol];
      if (chainlinkAsset) {
        this.chainlinkPrices.set(chainlinkAsset, { price, timestamp });
      }
      return;
    }

    // Binance source (topic === 'crypto_prices' or legacy)
    const binanceAsset = SYMBOL_TO_ASSET[symbol];
    if (binanceAsset) {
      this.prices.set(binanceAsset, { price, timestamp });
      // Record price history for momentum calculation
      let history = this.priceHistory.get(binanceAsset);
      if (!history) { history = []; this.priceHistory.set(binanceAsset, history); }
      history.push({ price, timestamp });
      if (history.length > PRICE_HISTORY_SIZE) history.shift();
      this.onPrice?.(binanceAsset, price, timestamp);
      return;
    }

    // Fallback: check Chainlink by symbol pattern (contains '/')
    const chainlinkAsset = CHAINLINK_SYMBOL_TO_ASSET[symbol];
    if (chainlinkAsset) {
      this.chainlinkPrices.set(chainlinkAsset, { price, timestamp });
    }
  }

  /** Debug: get raw price map state */
  debugPriceState(): Record<string, { price: number; age: number; stale: boolean }> {
    const result: Record<string, { price: number; age: number; stale: boolean }> = {};
    for (const [asset, entry] of this.prices) {
      const age = Date.now() - entry.timestamp;
      result[`binance:${asset}`] = { price: entry.price, age, stale: age > 30_000 };
    }
    for (const [asset, entry] of this.chainlinkPrices) {
      const age = Date.now() - entry.timestamp;
      result[`chainlink:${asset}`] = { price: entry.price, age, stale: age > 30_000 };
    }
    return result;
  }

  /** Get Binance spot price for an asset (sync). Returns null if stale/missing. */
  getSpotPrice(asset: CryptoAsset): number | null {
    const entry = this.prices.get(asset);
    if (!entry) return null;
    // Stale if older than 30s
    if (Date.now() - entry.timestamp > 30_000) return null;
    return entry.price;
  }

  /** Get Chainlink oracle price for an asset (sync). Returns null if stale/missing. */
  getChainlinkPrice(asset: CryptoAsset): number | null {
    const entry = this.chainlinkPrices.get(asset);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > 30_000) return null;
    return entry.price;
  }

  /**
   * Check if Chainlink oracle agrees with the given spot price direction relative to strike.
   * Returns true if Chainlink agrees with spotPrice direction, or if Chainlink data is unavailable.
   */
  oraclesAgree(asset: CryptoAsset, strike: number, spotPrice: number): boolean {
    const chainlink = this.getChainlinkPrice(asset);
    if (!chainlink) return false;     // no Chainlink data = block entry (settlement uses Chainlink)
    // If Chainlink is within 0.05% of strike, it's too close to disagree meaningfully
    const chainlinkDiffPct = Math.abs(chainlink - strike) / strike;
    if (chainlinkDiffPct < 0.0005) return true;  // trust Binance alone
    // Chainlink and spot must agree on direction
    return (spotPrice >= strike) === (chainlink >= strike);
  }

  /**
   * Get price momentum as % change over recent history.
   * Positive = price rising, negative = price falling.
   * Returns null if insufficient history.
   */
  getMomentum(asset: CryptoAsset): number | null {
    const history = this.priceHistory.get(asset);
    if (!history || history.length < 3) return null;
    const oldest = history[0];
    const newest = history[history.length - 1];
    if (newest.timestamp - oldest.timestamp > 15_000) return null;
    return (newest.price - oldest.price) / oldest.price;
  }

  /** Get all current spot prices */
  getAllPrices(): Map<CryptoAsset, SpotPriceEntry> {
    return new Map(this.prices);
  }

  /** Get RTDS symbol for a crypto asset */
  static getSymbol(asset: CryptoAsset): string {
    return ASSET_TO_SYMBOL[asset];
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.prices.clear();
    this.chainlinkPrices.clear();
    this.priceHistory.clear();
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongTimer();
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log(`[rtds] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
}
