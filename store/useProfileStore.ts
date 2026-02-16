import { create } from 'zustand';

export interface ProfilePublic {
  id: string;
  name: string;
  funderAddress: string;
  hasPrivateKey: boolean;
  hasApiCredentials: boolean;
  hasBuilderCredentials: boolean;
  isActive: boolean;
  enabledStrategies: string[];
  maxPortfolioExposure: number;
  createdAt: string;
}

interface ProfileState {
  profiles: ProfilePublic[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;

  fetchProfiles: () => Promise<void>;
  createProfile: (data: Record<string, unknown>) => Promise<boolean>;
  updateProfile: (id: string, data: Record<string, unknown>) => Promise<boolean>;
  deleteProfile: (id: string) => Promise<boolean>;
  clearMessages: () => void;
}

export const useProfileStore = create<ProfileState>((set) => ({
  profiles: [],
  loading: false,
  saving: false,
  error: null,
  success: null,

  fetchProfiles: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/profiles');
      if (!res.ok) throw new Error('Failed to fetch profiles');
      const data = await res.json();
      set({ profiles: data.profiles, loading: false });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  createProfile: async (data: Record<string, unknown>) => {
    set({ saving: true, error: null, success: null });
    try {
      const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create profile');
      }
      const profile = await res.json();
      set((state) => ({
        profiles: [profile, ...state.profiles],
        saving: false,
        success: 'Profile created successfully',
      }));
      return true;
    } catch (error) {
      set({ error: (error as Error).message, saving: false });
      return false;
    }
  },

  updateProfile: async (id, data) => {
    set({ saving: true, error: null, success: null });
    try {
      const res = await fetch(`/api/profiles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update profile');
      }
      const updated = await res.json();
      set((state) => ({
        profiles: state.profiles.map((p) => (p.id === id ? updated : p)),
        saving: false,
        success: 'Profile updated successfully',
      }));
      return true;
    } catch (error) {
      set({ error: (error as Error).message, saving: false });
      return false;
    }
  },

  deleteProfile: async (id) => {
    set({ saving: true, error: null, success: null });
    try {
      const res = await fetch(`/api/profiles/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete profile');
      }
      set((state) => ({
        profiles: state.profiles.filter((p) => p.id !== id),
        saving: false,
        success: 'Profile deleted successfully',
      }));
      return true;
    } catch (error) {
      set({ error: (error as Error).message, saving: false });
      return false;
    }
  },

  clearMessages: () => set({ error: null, success: null }),
}));
