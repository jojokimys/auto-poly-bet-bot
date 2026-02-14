import 'server-only';
import { getEnv } from '@/lib/config/env';
import type { GammaEvent, GammaMarket } from '@/lib/types/polymarket';

function gammaUrl(path: string): string {
  return `${getEnv().GAMMA_API_URL}${path}`;
}

export async function fetchEvents(params?: {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
  order?: string;
  ascending?: boolean;
}): Promise<GammaEvent[]> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset) searchParams.set('offset', String(params.offset));
  if (params?.active !== undefined) searchParams.set('active', String(params.active));
  if (params?.closed !== undefined) searchParams.set('closed', String(params.closed));
  if (params?.order) searchParams.set('order', params.order);
  if (params?.ascending !== undefined) searchParams.set('ascending', String(params.ascending));

  const qs = searchParams.toString();
  const url = gammaUrl(`/events${qs ? `?${qs}` : ''}`);

  // Events include nested markets arrays — responses can exceed 6MB,
  // which is above Next.js data cache 2MB limit. Skip cache entirely.
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Gamma events fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchMarkets(params?: {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
  order?: string;
  ascending?: boolean;
}): Promise<GammaMarket[]> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset) searchParams.set('offset', String(params.offset));
  if (params?.active !== undefined) searchParams.set('active', String(params.active));
  if (params?.closed !== undefined) searchParams.set('closed', String(params.closed));
  if (params?.order) searchParams.set('order', params.order);
  if (params?.ascending !== undefined) searchParams.set('ascending', String(params.ascending));

  const qs = searchParams.toString();
  const url = gammaUrl(`/markets${qs ? `?${qs}` : ''}`);

  const res = await fetch(url, { next: { revalidate: 60 } });
  if (!res.ok) throw new Error(`Gamma markets fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchEvent(id: string): Promise<GammaEvent> {
  const url = gammaUrl(`/events/${id}`);
  const res = await fetch(url, { next: { revalidate: 30 } });
  if (!res.ok) throw new Error(`Gamma event fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchMarket(conditionId: string): Promise<GammaMarket> {
  const url = gammaUrl(`/markets?condition_id=${conditionId}`);
  const res = await fetch(url, { next: { revalidate: 30 } });
  if (!res.ok) throw new Error(`Gamma market fetch failed: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Market not found: ${conditionId}`);
  }
  return data[0];
}
