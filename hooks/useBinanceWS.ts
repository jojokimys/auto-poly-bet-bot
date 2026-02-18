'use client';

import { useEffect, useRef, useCallback } from 'react';

export interface LiveKline {
  time: number;      // kline open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean; // true when candle is finalized
}

interface UseBinanceWSOptions {
  symbol?: string;  // 'BTCUSDT' | 'ETHUSDT' | ... (default: 'BTCUSDT')
  onKline: (kline: LiveKline) => void;
  enabled?: boolean;
}

export function useBinanceWS({ symbol = 'BTCUSDT', onKline, enabled = true }: UseBinanceWSOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const onKlineRef = useRef(onKline);
  onKlineRef.current = onKline;

  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(1000);
  const intentionalClose = useRef(false);

  const connect = useCallback(() => {
    if (!enabled) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    intentionalClose.current = false;
    const wsUrl = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_1m`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay.current = 1000;
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          if (data.e === 'kline' && data.k) {
            const k = data.k;
            onKlineRef.current({
              time: k.t,
              open: parseFloat(k.o),
              high: parseFloat(k.h),
              low: parseFloat(k.l),
              close: parseFloat(k.c),
              volume: parseFloat(k.v),
              isClosed: k.x,
            });
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (enabled && !intentionalClose.current) {
          reconnectTimer.current = setTimeout(() => {
            connect();
          }, reconnectDelay.current);
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      // ignore connection errors
    }
  }, [enabled, symbol]);

  useEffect(() => {
    if (enabled) {
      connect();
    }
    return () => {
      intentionalClose.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, connect]);
}
