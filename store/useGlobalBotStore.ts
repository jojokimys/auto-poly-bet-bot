import { create } from 'zustand';
import type { BotState, BotLogEntry } from '@/lib/bot/types';

interface ApiUsageStats {
  gammaApiCalls: number;
  clobApiCalls: number;
  clobAuthCalls: number;
  totalCalls: number;
  startedAt: string;
}

interface GlobalBotState {
  /** Map of profileId → BotState */
  states: Record<string, BotState>;
  /** Recent logs for toast notifications */
  recentLogs: BotLogEntry[];
  /** Last seen log ID to detect new logs */
  lastSeenLogId: string | null;
  /** New logs since last check (for toast) */
  newLogs: BotLogEntry[];
  /** API usage stats */
  apiUsage: ApiUsageStats | null;
  /** Polling interval handle */
  _intervalId: ReturnType<typeof setInterval> | null;

  /** Start polling bot states (call once from layout) */
  startPolling: () => void;
  /** Stop polling */
  stopPolling: () => void;
  /** Fetch latest state + logs */
  poll: () => Promise<void>;
  /** Clear new logs after showing toasts */
  clearNewLogs: () => void;
}

export const useGlobalBotStore = create<GlobalBotState>((set, get) => ({
  states: {},
  recentLogs: [],
  lastSeenLogId: null,
  newLogs: [],
  apiUsage: null,
  _intervalId: null,

  startPolling: () => {
    const existing = get()._intervalId;
    if (existing) return; // Already polling

    // Poll immediately
    get().poll();

    // Then poll every 3 seconds
    const id = setInterval(() => {
      get().poll();
    }, 3000);

    set({ _intervalId: id });
  },

  stopPolling: () => {
    const id = get()._intervalId;
    if (id) {
      clearInterval(id);
      set({ _intervalId: null });
    }
  },

  poll: async () => {
    try {
      // Fetch bot states + api usage
      const stateRes = await fetch('/api/bot');
      if (stateRes.ok) {
        const data = await stateRes.json();
        set({
          states: data.states ?? {},
          apiUsage: data.apiUsage ?? null,
        });
      }

      // Fetch recent logs (only if any bot is running)
      const { states, lastSeenLogId } = get();
      const hasRunning = Object.values(states).some(
        (s) => s.status === 'running'
      );

      if (hasRunning) {
        const logRes = await fetch('/api/bot/logs?limit=10');
        if (logRes.ok) {
          const logData = await logRes.json();
          const logs: BotLogEntry[] = logData.logs || [];

          if (logs.length > 0) {
            // Detect new notable logs since last seen
            if (lastSeenLogId) {
              const lastIdx = logs.findIndex((l) => l.id === lastSeenLogId);
              // Logs after the last seen one that are notable
              const newEntries = (lastIdx === -1 ? logs : logs.slice(lastIdx + 1))
                .filter((l) => l.level === 'trade' || l.level === 'error' || l.level === 'warn');
              if (newEntries.length > 0) {
                set((prev) => ({
                  newLogs: [...prev.newLogs, ...newEntries],
                }));
              }
            }

            set({
              recentLogs: logs,
              lastSeenLogId: logs[logs.length - 1].id,
            });
          }
        }
      }
    } catch {
      // Silent fail — polling shouldn't crash the UI
    }
  },

  clearNewLogs: () => set({ newLogs: [] }),
}));
