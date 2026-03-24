import WebSocket from 'ws';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const HEARTBEAT_MS = 10_000;
const MAX_RECONNECT_DELAY = 30_000;

export interface UserTrade {
  event_type: 'trade';
  id: string;
  market: string;       // condition_id
  asset_id: string;     // token_id
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  status: 'MATCHED' | 'MINED' | 'CONFIRMED' | 'FAILED' | 'RETRYING';
  outcome: string;
  trader_side: 'TAKER' | 'MAKER';
}

export interface UserOrder {
  event_type: 'order';
  type: 'PLACEMENT' | 'UPDATE' | 'CANCELLATION';
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  original_size: string;
  size_matched: string;
  price: string;
  status: 'LIVE' | 'MATCHED' | 'CANCELED';
  outcome: string;
}

type TradeHandler = (trade: UserTrade) => void;
type OrderHandler = (order: UserOrder) => void;

export class PolymarketUserWS {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;

  private apiKey: string;
  private secret: string;
  private passphrase: string;

  private onTrade: TradeHandler | null = null;
  private onOrder: OrderHandler | null = null;
  private subscribedMarkets: Set<string> = new Set();

  constructor(apiKey: string, secret: string, passphrase: string) {
    this.apiKey = apiKey;
    this.secret = secret;
    this.passphrase = passphrase;
  }

  connect(
    conditionIds: string[],
    onTrade: TradeHandler,
    onOrder?: OrderHandler,
  ): void {
    this.onTrade = onTrade;
    this.onOrder = onOrder ?? null;
    for (const id of conditionIds) this.subscribedMarkets.add(id);
    this.intentionalClose = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      console.log('[user:ws] Connected');
      this.reconnectDelay = 1000;

      // Auth + subscribe
      const msg: any = {
        auth: {
          apiKey: this.apiKey,
          secret: this.secret,
          passphrase: this.passphrase,
        },
        type: 'user',
      };
      if (this.subscribedMarkets.size > 0) {
        msg.markets = [...this.subscribedMarkets];
      }
      this.ws!.send(JSON.stringify(msg));

      // Heartbeat
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send('PING');
        }
      }, HEARTBEAT_MS);
    });

    this.ws.on('message', (data: Buffer) => {
      const raw = data.toString();
      if (raw === 'PONG') return;

      try {
        const parsed = JSON.parse(raw);

        // Handle arrays (batch events)
        const events = Array.isArray(parsed) ? parsed : [parsed];
        for (const evt of events) {
          if (evt.event_type === 'trade' && this.onTrade) {
            this.onTrade(evt as UserTrade);
          } else if (evt.event_type === 'order' && this.onOrder) {
            this.onOrder(evt as UserOrder);
          }
        }
      } catch {
        // Not JSON, ignore
      }
    });

    this.ws.on('close', () => {
      console.log('[user:ws] Disconnected');
      this.stopHeartbeat();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[user:ws] Error:', err.message);
    });
  }

  subscribe(conditionIds: string[]): void {
    for (const id of conditionIds) this.subscribedMarkets.add(id);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        operation: 'subscribe',
        markets: conditionIds,
      }));
    }
  }

  unsubscribe(conditionIds: string[]): void {
    for (const id of conditionIds) this.subscribedMarkets.delete(id);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        operation: 'unsubscribe',
        markets: conditionIds,
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
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
}
