import WebSocket from 'ws';
import type { BookSnapshot } from './types';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const HEARTBEAT_MS = 10_000;
const MAX_RECONNECT_DELAY = 30_000;

type BookHandler = (book: BookSnapshot) => void;
type ConnectionHandler = () => void;

export class PolymarketWS {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private subscribedAssets: Set<string> = new Set();
  private onBook: BookHandler | null = null;
  private onDisconnect: ConnectionHandler | null = null;
  private intentionalClose = false;

  connect(assetIds: string[], onBook: BookHandler, onDisconnect?: ConnectionHandler): void {
    this.onBook = onBook;
    this.onDisconnect = onDisconnect ?? null;
    for (const id of assetIds) this.subscribedAssets.add(id);
    this.intentionalClose = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }

    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      console.log('[mm:ws] Connected');
      this.reconnectDelay = 1000;

      // Send initial subscription
      if (this.subscribedAssets.size > 0) {
        this.ws!.send(JSON.stringify({
          assets_ids: [...this.subscribedAssets],
          type: 'market',
        }));
      }

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

        if (parsed.event_type === 'book' && parsed.asset_id) {
          this.onBook?.({
            assetId: parsed.asset_id,
            buys: parsed.buys || [],
            sells: parsed.sells || [],
            timestamp: parsed.timestamp || Date.now(),
          });
        } else if (parsed.event_type === 'price_change' && parsed.price_changes) {
          // On price_change, we trigger a book-level update per affected asset
          // The engine will use the latest best bid/ask from the change
          for (const change of parsed.price_changes) {
            if (change.asset_id && change.best_bid && change.best_ask) {
              this.onBook?.({
                assetId: change.asset_id,
                buys: [{ price: change.best_bid, size: '0' }],
                sells: [{ price: change.best_ask, size: '0' }],
                timestamp: parsed.timestamp || Date.now(),
              });
            }
          }
        }
      } catch {
        // Ignore unparseable messages
      }
    });

    this.ws.on('close', () => {
      console.log('[mm:ws] Disconnected');
      this.stopHeartbeat();
      if (!this.intentionalClose) {
        this.onDisconnect?.();
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[mm:ws] Error:', err.message);
    });
  }

  subscribe(assetIds: string[]): void {
    for (const id of assetIds) this.subscribedAssets.add(id);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        assets_ids: assetIds,
        operation: 'subscribe',
      }));
    }
  }

  unsubscribe(assetIds: string[]): void {
    for (const id of assetIds) this.subscribedAssets.delete(id);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        assets_ids: assetIds,
        operation: 'unsubscribe',
      }));
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.subscribedAssets.clear();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log(`[mm:ws] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
}
