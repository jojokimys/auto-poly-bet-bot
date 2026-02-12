import { create } from 'zustand';
import type { BotSettingsPublic } from '@/lib/types/app';

interface SettingsState {
  settings: BotSettingsPublic | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;

  fetchSettings: () => Promise<void>;
  saveSettings: (data: Record<string, unknown>) => Promise<boolean>;
  testConnection: () => Promise<boolean>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loading: false,
  saving: false,
  error: null,
  success: null,

  fetchSettings: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('Failed to fetch settings');
      const data = await res.json();
      set({ settings: data, loading: false });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  saveSettings: async (data) => {
    set({ saving: true, error: null, success: null });
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to save settings');
      const updated = await res.json();
      set({ settings: updated, saving: false, success: 'Settings saved successfully' });
      return true;
    } catch (error) {
      set({ error: (error as Error).message, saving: false });
      return false;
    }
  },

  testConnection: async () => {
    set({ error: null, success: null });
    try {
      const res = await fetch('/api/markets?limit=1');
      if (!res.ok) throw new Error('Connection test failed');
      set({ success: 'Connected to Polymarket API successfully' });
      return true;
    } catch (error) {
      set({ error: (error as Error).message });
      return false;
    }
  },
}));
