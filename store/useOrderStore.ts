import { create } from 'zustand';
import type { Order } from '@/lib/types/app';

interface OrderFormState {
  side: 'BUY' | 'SELL';
  price: string;
  size: string;
  outcome: string;
  tokenId: string;
}

interface OrderState {
  openOrders: Order[];
  loading: boolean;
  error: string | null;
  placing: boolean;
  orderForm: OrderFormState;

  fetchOpenOrders: () => Promise<void>;
  placeOrder: (params: {
    conditionId: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    outcome: string;
  }) => Promise<boolean>;
  cancelOrder: (orderId: string) => Promise<boolean>;
  setOrderForm: (form: Partial<OrderFormState>) => void;
  resetOrderForm: () => void;
}

const defaultOrderForm: OrderFormState = {
  side: 'BUY',
  price: '',
  size: '',
  outcome: '',
  tokenId: '',
};

export const useOrderStore = create<OrderState>((set, get) => ({
  openOrders: [],
  loading: false,
  error: null,
  placing: false,
  orderForm: { ...defaultOrderForm },

  fetchOpenOrders: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/orders');
      if (!res.ok) throw new Error('Failed to fetch orders');
      const data = await res.json();
      set({ openOrders: data.orders || [], loading: false });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  placeOrder: async (params) => {
    set({ placing: true, error: null });
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to place order');
      }
      set({ placing: false });
      // Refresh open orders
      get().fetchOpenOrders();
      return true;
    } catch (error) {
      set({ error: (error as Error).message, placing: false });
      return false;
    }
  },

  cancelOrder: async (orderId) => {
    set({ error: null });
    try {
      const res = await fetch(`/api/orders/${orderId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to cancel order');
      // Refresh open orders
      get().fetchOpenOrders();
      return true;
    } catch (error) {
      set({ error: (error as Error).message });
      return false;
    }
  },

  setOrderForm: (form) =>
    set((state) => ({ orderForm: { ...state.orderForm, ...form } })),

  resetOrderForm: () => set({ orderForm: { ...defaultOrderForm } }),
}));
