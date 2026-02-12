import { create } from 'zustand';
import type { ConnectionStatus } from '@/lib/types/app';

interface AppState {
  theme: 'light' | 'dark';
  sidebarOpen: boolean;
  connectionStatus: ConnectionStatus;
  toggleTheme: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
}

export const useAppStore = create<AppState>((set) => ({
  theme: 'light',
  sidebarOpen: true,
  connectionStatus: 'disconnected',
  toggleTheme: () =>
    set((state) => ({
      theme: state.theme === 'light' ? 'dark' : 'light',
    })),
  setTheme: (theme) => set({ theme }),
  toggleSidebar: () =>
    set((state) => ({
      sidebarOpen: !state.sidebarOpen,
    })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
}));
