/**
 * Polymarket RTDS WebSocket — real-time crypto spot prices.
 *
 * Connects to wss://ws-live-data.polymarket.com (free, no auth).
 * Subscribes to `crypto_prices` topic (Binance source, ~1s updates).
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

export interface SpotPriceEntry {
  price: number;
  timestamp: number;
}

type PriceHandler = (asset: CryptoAsset, price: number, timestamp: number) => void;

export class RtdsWS {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;
  private prices: Map<CryptoAsset, SpotPriceEntry> = new Map();
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

        // RTDS sends: { symbol, value, timestamp } for crypto_prices
        if (parsed.symbol && parsed.value != null) {
          const symbol = String(parsed.symbol).toLowerCase();
          const asset = SYMBOL_TO_ASSET[symbol];
          if (asset) {
            const price = typeof parsed.value === 'string' ? parseFloat(parsed.value) : parsed.value;
            const timestamp = parsed.timestamp ?? Date.now();
            if (Number.isFinite(price) && price > 0) {
              this.prices.set(asset, { price, timestamp });
              this.onPrice?.(asset, price, timestamp);
            }
          }
        }

        // Also handle array format: { data: [{ symbol, value, timestamp }, ...] }
        if (Array.isArray(parsed.data)) {
          for (const item of parsed.data) {
            if (item.symbol && item.value != null) {
              const symbol = String(item.symbol).toLowerCase();
              const asset = SYMBOL_TO_ASSET[symbol];
              if (asset) {
                const price = typeof item.value === 'string' ? parseFloat(item.value) : item.value;
                const timestamp = item.timestamp ?? Date.now();
                if (Number.isFinite(price) && price > 0) {
                  this.prices.set(asset, { price, timestamp });
                  this.onPrice?.(asset, price, timestamp);
                }
              }
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

  /** Get spot price for an asset (sync, no API call). Returns null if no data yet. */
  getSpotPrice(asset: CryptoAsset): number | null {
    const entry = this.prices.get(asset);
    if (!entry) return null;
    // Stale if older than 30s
    if (Date.now() - entry.timestamp > 30_000) return null;
    return entry.price;
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
