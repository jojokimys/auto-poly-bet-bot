import { create } from 'zustand';
import type { MMState, MMConfig, VolatilityState, CryptoAsset, MarketMode, SniperState, SniperDetail, SniperConfig } from '@/lib/mm/types';
import type { BotLogEntry } from '@/lib/bot/types';

interface MMMarketDetail {
  conditionId: string;
  question: string;
  cryptoAsset: string;
  endTime: string;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  yesHeld: number;
  noHeld: number;
  minutesLeft: number;
  strikePrice: number | null;
}

interface MMDetail {
  state: MMState;
  markets: MMMarketDetail[];
  volatility: VolatilityState;
  config: MMConfig;
}

export interface KlinePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderEvent {
  time: number;
  type: 'quote' | 'pull' | 'circuit-breaker' | 'market' | 'expiry';
  message: string;
}

export interface ScannedMarket {
  conditionId: string;
  question: string;
  cryptoAsset: string;
  endTime: string;
  strikePrice: number | null;
  minutesLeft: number;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
}

interface MMStoreState {
  states: Record<string, MMState>;
  detail: MMDetail | null;
  logs: BotLogEntry[];
  klines: KlinePoint[];
  livePrice: number | null;
  orderEvents: OrderEvent[];
  scannedMarkets: ScannedMarket[];
  selectedProfileId: string | null;
  selectedAsset: CryptoAsset;
  selectedMode: MarketMode;
  loading: boolean;
  error: string | null;

  // Sniper state
  sniperStates: Record<string, SniperState>;
  sniperDetail: SniperDetail | null;
  sniperLogs: BotLogEntry[];

  _pollId: ReturnType<typeof setInterval> | null;
  _klineId: ReturnType<typeof setInterval> | null;
  _scanId: ReturnType<typeof setInterval> | null;

  setSelectedProfile: (id: string | null) => void;
  setMarketOption: (asset: CryptoAsset, mode: MarketMode) => void;
  updateLiveKline: (kline: KlinePoint & { isClosed: boolean }) => void;
  poll: () => Promise<void>;
  fetchKlines: () => Promise<void>;
  fetchScannedMarkets: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  startMM: (profileId: string, config?: { mode?: MarketMode; assets?: CryptoAsset[]; maxPositionSize?: number }) => Promise<void>;
  stopMM: (profileId: string) => Promise<void>;
  startSniper: (profileId: string, config?: Partial<SniperConfig>) => Promise<void>;
  stopSniper: (profileId: string) => Promise<void>;
}

// Extract order events from MM logs
function extractOrderEvents(logs: BotLogEntry[]): OrderEvent[] {
  const eventMap: Record<string, OrderEvent['type']> = {
    'mm:quote': 'quote',
    'mm:pull': 'pull',
    'mm:circuit-breaker': 'circuit-breaker',
    'mm:market': 'market',
    'mm:expiry': 'expiry',
  };

  return logs
    .filter((l) => eventMap[l.event])
    .map((l) => ({
      time: new Date(l.createdAt).getTime(),
      type: eventMap[l.event],
      message: l.message,
    }));
}

export const useMMStore = create<MMStoreState>((set, get) => ({
  states: {},
  detail: null,
  logs: [],
  klines: [],
  livePrice: null,
  orderEvents: [],
  scannedMarkets: [],
  selectedProfileId: null,
  selectedAsset: 'BTC',
  selectedMode: '15m',
  loading: false,
  error: null,
  sniperStates: {},
  sniperDetail: null,
  sniperLogs: [],
  _pollId: null,
  _klineId: null,
  _scanId: null,

  setSelectedProfile: (id) => {
    set({ selectedProfileId: id, detail: null, sniperDetail: null });
  },

  setMarketOption: (asset, mode) => {
    set({ selectedAsset: asset, selectedMode: mode, klines: [], livePrice: null, scannedMarkets: [] });
    get().fetchKlines();
    get().fetchScannedMarkets();
  },

  updateLiveKline: (kline) => {
    const { klines } = get();
    if (klines.length === 0) return;

    const updated = [...klines];
    const last = updated[updated.length - 1];

    if (kline.time === last.time) {
      updated[updated.length - 1] = {
        time: kline.time,
        open: kline.open,
        high: kline.high,
        low: kline.low,
        close: kline.close,
        volume: kline.volume,
      };
    } else if (kline.time > last.time) {
      updated.push({
        time: kline.time,
        open: kline.open,
        high: kline.high,
        low: kline.low,
        close: kline.close,
        volume: kline.volume,
      });
      if (updated.length > 60) updated.shift();
    }

    set({ klines: updated, livePrice: kline.close });
  },

  poll: async () => {
    try {
      const stateRes = await fetch('/api/mm');
      if (stateRes.ok) {
        const data = await stateRes.json();
        set({ states: data.states ?? {}, sniperStates: data.sniperStates ?? {} });
      }

      const { selectedProfileId } = get();
      if (selectedProfileId) {
        const detailRes = await fetch(`/api/mm?detail=true&profileId=${selectedProfileId}`);
        if (detailRes.ok) {
          const data = await detailRes.json();
          set({ detail: data.detail ?? null });
        }

        // Sniper detail
        const sniperDetailRes = await fetch(`/api/mm?sniperDetail=true&profileId=${selectedProfileId}`);
        if (sniperDetailRes.ok) {
          const data = await sniperDetailRes.json();
          set({ sniperDetail: data.sniperDetail ?? null });
        }

        // Sniper logs
        const sniperLogRes = await fetch(`/api/mm?logs=true&sniper=true&profileId=${selectedProfileId}&limit=50`);
        if (sniperLogRes.ok) {
          const data = await sniperLogRes.json();
          set({ sniperLogs: data.logs ?? [] });
        }

        const logRes = await fetch(`/api/mm?logs=true&profileId=${selectedProfileId}&limit=50`);
        if (logRes.ok) {
          const data = await logRes.json();
          const logs: BotLogEntry[] = data.logs ?? [];
          set({ logs, orderEvents: extractOrderEvents(logs) });
        }
      }
    } catch {
      // Silent fail
    }
  },

  fetchKlines: async () => {
    try {
      const symbol = `${get().selectedAsset}USDT`;
      const res = await fetch(`/api/mm/klines?symbol=${symbol}&interval=1m&limit=60`);
      if (res.ok) {
        const data = await res.json();
        set({ klines: data.klines ?? [] });
      }
    } catch {
      // Silent fail
    }
  },

  fetchScannedMarkets: async () => {
    try {
      const { selectedAsset, selectedMode } = get();
      const targetWindow = selectedMode === '5m' ? 5 : 15;
      const res = await fetch(`/api/mm?scan=true&asset=${selectedAsset}&targetWindow=${targetWindow}`);
      if (res.ok) {
        const data = await res.json();
        set({ scannedMarkets: data.markets ?? [] });
      }
    } catch {
      // Silent fail
    }
  },

  startPolling: () => {
    const { _pollId } = get();
    if (_pollId) return;

    get().poll();
    get().fetchKlines();
    get().fetchScannedMarkets();

    const pollId = setInterval(() => get().poll(), 3000);
    const klineId = setInterval(() => get().fetchKlines(), 15_000);
    const scanId = setInterval(() => get().fetchScannedMarkets(), 30_000);
    set({ _pollId: pollId, _klineId: klineId, _scanId: scanId });
  },

  stopPolling: () => {
    const { _pollId, _klineId, _scanId } = get();
    if (_pollId) clearInterval(_pollId);
    if (_klineId) clearInterval(_klineId);
    if (_scanId) clearInterval(_scanId);
    set({ _pollId: null, _klineId: null, _scanId: null });
  },

  startMM: async (profileId, config) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/mm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', profileId, config }),
      });
      if (!res.ok) {
        const data = await res.json();
        set({ error: data.error || 'Failed to start MM' });
      }
      await get().poll();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
    set({ loading: false });
  },

  stopMM: async (profileId) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/mm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', profileId }),
      });
      if (!res.ok) {
        const data = await res.json();
        set({ error: data.error || 'Failed to stop MM' });
      }
      await get().poll();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
    set({ loading: false });
  },

  startSniper: async (profileId, config) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/mm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start-sniper', profileId, config }),
      });
      if (!res.ok) {
        const data = await res.json();
        set({ error: data.error || 'Failed to start Sniper' });
      }
      await get().poll();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
    set({ loading: false });
  },

  stopSniper: async (profileId) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/mm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop-sniper', profileId }),
      });
      if (!res.ok) {
        const data = await res.json();
        set({ error: data.error || 'Failed to stop Sniper' });
      }
      await get().poll();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
    set({ loading: false });
  },
}));
