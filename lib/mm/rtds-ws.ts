/**
 * Polymarket RTDS WebSocket — real-time crypto spot prices.
 *
 * Connects to wss://ws-live-data.polymarket.com (free, no auth).
 * Subscribes to `crypto_prices` (Binance) and `crypto_prices_chainlink` (settlement oracle).
 * Provides sync getSpotPrice() — no API calls, just reads in-memory map.
 */

import WebSocket from 'ws';
import type { CryptoAsset } from './types';

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const HEARTBEAT_MS = 10_000;
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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;
  private prices: Map<CryptoAsset, SpotPriceEntry> = new Map();
  private chainlinkPrices: Map<CryptoAsset, SpotPriceEntry> = new Map();
  private priceHistory: Map<CryptoAsset, SpotPriceEntry[]> = new Map();
  private onPrice: PriceHandler | null = null;

  connect(onPrice?: PriceHandler): void {
    this.onPrice = onPrice ?? null;
    this.intentionalClose = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }

    this.ws = new WebSocket(RTDS_URL);

    this.ws.on('open', () => {
      console.log('[rtds] Connected');
      this.reconnectDelay = 1000;

      // Subscribe to Binance crypto prices
      this.ws!.send(JSON.stringify({
        type: 'subscribe',
        channel: 'crypto_prices',
      }));

      // Subscribe to Chainlink crypto prices (settlement oracle)
      this.ws!.send(JSON.stringify({
        type: 'subscribe',
        channel: 'crypto_prices_chainlink',
      }));

      // Start heartbeat
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send('PING');
        }
      }, HEARTBEAT_MS);
    });

    this.ws.on('message', (data) => {
      const msg = data.toString();
      if (msg === 'PONG') return;

      try {
        const parsed = JSON.parse(msg);

        // RTDS sends: { symbol, value, timestamp } for crypto_prices / crypto_prices_chainlink
        if (parsed.symbol && parsed.value != null) {
          this._handlePriceItem(parsed);
        }

        // Also handle array format: { data: [{ symbol, value, timestamp }, ...] }
        if (Array.isArray(parsed.data)) {
          for (const item of parsed.data) {
            if (item.symbol && item.value != null) {
              this._handlePriceItem(item);
            }
          }
        }
      } catch {
        // Ignore unparseable messages
      }
    });

    this.ws.on('close', () => {
      console.log('[rtds] Disconnected');
      this.stopHeartbeat();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[rtds] Error:', err.message);
    });
  }

  private _handlePriceItem(item: { symbol: string; value: string | number; timestamp?: number }): void {
    const symbol = String(item.symbol).toLowerCase();
    const price = typeof item.value === 'string' ? parseFloat(item.value) : item.value;
    const timestamp = item.timestamp ?? Date.now();
    if (!Number.isFinite(price) || price <= 0) return;

    // Check Binance source first
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

    // Check Chainlink source
    const chainlinkAsset = CHAINLINK_SYMBOL_TO_ASSET[symbol];
    if (chainlinkAsset) {
      this.chainlinkPrices.set(chainlinkAsset, { price, timestamp });
    }
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
   * @param asset - crypto asset
   * @param strike - market strike price
   * @param spotPrice - current spot price from Binance REST (the sniper's primary source)
   * Returns true if Chainlink agrees with spotPrice direction, or if Chainlink data is unavailable.
   */
  oraclesAgree(asset: CryptoAsset, strike: number, spotPrice: number): boolean {
    const chainlink = this.getChainlinkPrice(asset);
    if (!chainlink) return true;      // no Chainlink data = fallback to Binance only
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
    // Compare oldest vs newest in the ring buffer
    const oldest = history[0];
    const newest = history[history.length - 1];
    // Skip if history span is too old (>15s gap = stale)
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
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.prices.clear();
    this.chainlinkPrices.clear();
    this.priceHistory.clear();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
