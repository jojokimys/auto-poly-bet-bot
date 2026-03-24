import 'server-only';
import { getEnv } from '@/lib/config/env';

/** Fetch with retry on 429/5xx, exponential backoff */
async function fetchWithRetry(url: string, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      if (attempt < maxRetries) {
        const delay = (attempt + 1) * 2000; // 2s, 4s, 6s
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
    throw new Error(`Fetch failed: ${res.status} ${url}`);
  }
  throw new Error(`Fetch exhausted retries: ${url}`);
}

/** Market with active liquidity rewards from Gamma API */
export interface RewardMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  liquidity: number;
  volume: number;
  volume24hr: number;
  spread: number;
  bestBid: number;
  bestAsk: number;
  midpoint: number;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
  rewardsMinSize: number;
  rewardsMaxSpread: number;
  /** Daily reward in USDC for this market's entire pool */
  rewardsDailyRate: number;
  /** Competition score from CLOB — higher = more competition = lower yield */
  competitiveness: number;
  negRisk: boolean;
  image?: string;
  icon?: string;
  eventTitle?: string;
  eventSlug?: string;
}

interface GammaMarketRaw {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  liquidity: string;
  volume: string;
  volume24hr?: string;
  spread?: string;
  bestBid?: string;
  bestAsk?: string;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  rewardsMinSize: number;
  rewardsMaxSpread: number;
  negRisk?: boolean;
  image?: string;
  icon?: string;
  events?: Array<{ title: string; slug: string }>;
}

/** CLOB rewards endpoint entry */
interface ClobRewardEntry {
  condition_id: string;
  total_daily_rate: number;
  native_daily_rate: number;
  rewards_max_spread: number;
  rewards_min_size: number;
}

/** Per-market CLOB reward detail (includes competitiveness) */
interface ClobRewardDetail {
  condition_id: string;
  market_competitiveness: number;
}

/**
 * Fetch daily reward rates from CLOB API (bulk, paginated).
 * Returns a map of conditionId → total_daily_rate (USDC/day).
 */
async function fetchRewardRates(): Promise<Map<string, number>> {
  const env = getEnv();
  const baseUrl = env.CLOB_API_URL.replace(/\/$/, '');
  const rateMap = new Map<string, number>();

  try {
    let cursor = '';
    while (true) {
      const url = cursor
        ? `${baseUrl}/rewards/markets/current?next_cursor=${cursor}`
        : `${baseUrl}/rewards/markets/current`;
      const res = await fetchWithRetry(url);
      const json = await res.json();

      const entries: ClobRewardEntry[] = Array.isArray(json) ? json : json.data ?? [];
      for (const e of entries) {
        rateMap.set(e.condition_id, e.total_daily_rate ?? e.native_daily_rate ?? 0);
      }

      // Check for next page
      const nextCursor = json.next_cursor;
      if (!nextCursor || nextCursor === 'LTE=' || entries.length === 0) break;
      cursor = nextCursor;
    }
  } catch {
    // Non-critical — return what we have
  }

  return rateMap;
}

/**
 * Fetch market_competitiveness for a batch of condition IDs.
 * Uses per-market endpoint: GET /rewards/markets/{condition_id}
 * Fetches in parallel with concurrency limit to avoid rate-limiting.
 */
async function fetchCompetitiveness(
  conditionIds: string[],
  concurrency = 5,
): Promise<Map<string, number>> {
  const env = getEnv();
  const baseUrl = env.CLOB_API_URL.replace(/\/$/, '');
  const compMap = new Map<string, number>();

  // Process in batches to avoid rate-limiting
  for (let i = 0; i < conditionIds.length; i += concurrency) {
    const batch = conditionIds.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (cid) => {
        const res = await fetch(`${baseUrl}/rewards/markets/${cid}`, { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        const items: ClobRewardDetail[] = json.data ?? (Array.isArray(json) ? json : []);
        for (const item of items) {
          if (item.market_competitiveness != null) {
            compMap.set(item.condition_id, item.market_competitiveness);
          }
        }
      }),
    );
    // Small delay between batches to be polite
    if (i + concurrency < conditionIds.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return compMap;
}

/**
 * Fetch all active markets that have liquidity rewards enabled.
 * Enriches with daily reward rates and competitiveness from CLOB API.
 */
export async function scanRewardMarkets(): Promise<RewardMarket[]> {
  const env = getEnv();

  // Fetch reward rates in parallel with market scan
  const rateMapPromise = fetchRewardRates();

  const allMarkets: RewardMarket[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${env.GAMMA_API_URL}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`;
    const res = await fetchWithRetry(url);

    const raw: GammaMarketRaw[] = await res.json();
    if (raw.length === 0) break;

    for (const m of raw) {
      if (!m.rewardsMaxSpread || m.rewardsMaxSpread <= 0) continue;

      const outcomePrices = safeParseJson<number[]>(m.outcomePrices, [0.5, 0.5]);
      const clobTokenIds = safeParseJson<string[]>(m.clobTokenIds, []);
      const outcomes = safeParseJson<string[]>(m.outcomes, ['Yes', 'No']);

      if (clobTokenIds.length < 2) continue;

      const bestBid = parseFloat(m.bestBid ?? '0');
      const bestAsk = parseFloat(m.bestAsk ?? '1');
      const midpoint = (bestBid + bestAsk) / 2 || outcomePrices[0] || 0.5;

      allMarkets.push({
        id: m.id,
        question: m.question,
        conditionId: m.conditionId,
        slug: m.slug,
        endDate: m.endDate,
        liquidity: parseFloat(m.liquidity) || 0,
        volume: parseFloat(m.volume) || 0,
        volume24hr: parseFloat(m.volume24hr ?? '0'),
        spread: parseFloat(m.spread ?? '0'),
        bestBid,
        bestAsk,
        midpoint,
        outcomes,
        outcomePrices,
        clobTokenIds,
        rewardsMinSize: m.rewardsMinSize,
        rewardsMaxSpread: m.rewardsMaxSpread,
        rewardsDailyRate: 0, // Populated below
        competitiveness: 0,  // Populated below
        negRisk: m.negRisk ?? false,
        image: m.image,
        icon: m.icon,
        eventTitle: m.events?.[0]?.title,
        eventSlug: m.events?.[0]?.slug,
      });
    }

    if (raw.length < limit) break;
    offset += limit;
  }

  // Enrich with daily rates
  const rateMap = await rateMapPromise;
  for (const m of allMarkets) {
    m.rewardsDailyRate = rateMap.get(m.conditionId) ?? 0;
  }

  // Enrich top candidates with competitiveness (with 10s timeout to avoid blocking)
  try {
    const withRates = allMarkets
      .filter((m) => m.rewardsDailyRate > 0)
      .sort((a, b) => {
        const roiA = a.liquidity > 0 ? a.rewardsDailyRate / a.liquidity : 0;
        const roiB = b.liquidity > 0 ? b.rewardsDailyRate / b.liquidity : 0;
        return roiB - roiA;
      })
      .slice(0, 20);

    const compMap = await Promise.race([
      fetchCompetitiveness(withRates.map((m) => m.conditionId)),
      new Promise<Map<string, number>>((resolve) => setTimeout(() => resolve(new Map()), 10_000)),
    ]);
    for (const m of allMarkets) {
      m.competitiveness = compMap.get(m.conditionId) ?? 0;
    }
  } catch { /* non-critical */ }

  return allMarkets;
}

function safeParseJson<T>(val: string | undefined, fallback: T): T {
  if (!val) return fallback;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}
