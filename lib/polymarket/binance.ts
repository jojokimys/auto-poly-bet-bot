import 'server-only';

/**
 * Binance BTC price fetcher with 3-second cache.
 * Used by the crypto-latency-arb strategy to compare
 * Binance spot price against Polymarket crypto markets.
 */

let cachedPrice: { price: number; timestamp: number } | null = null;
const CACHE_TTL_MS = 3000;

export async function getBtcPrice(): Promise<number> {
  const now = Date.now();
  if (cachedPrice && now - cachedPrice.timestamp < CACHE_TTL_MS) {
    return cachedPrice.price;
  }

  const res = await fetch(
    'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    { cache: 'no-store' },
  );

  if (!res.ok) {
    throw new Error(`Binance price fetch failed: ${res.status}`);
  }

  const data: { symbol: string; price: string } = await res.json();
  const price = parseFloat(data.price);

  cachedPrice = { price, timestamp: now };
  return price;
}

// ─── Multi-Asset Price Fetcher (1s cache for scalper) ────

const cryptoCache = new Map<string, { price: number; timestamp: number }>();
const CRYPTO_CACHE_TTL_MS = 1000;

const SUPPORTED_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const;
export type CryptoSymbol = (typeof SUPPORTED_SYMBOLS)[number];

// ─── Historical Price (opening price of crypto markets) ──

const historicalPriceCache = new Map<string, number>();

export async function getHistoricalPrice(
  symbol: CryptoSymbol,
  timestampMs: number,
): Promise<number | null> {
  const cacheKey = `${symbol}:${timestampMs}`;
  const cached = historicalPriceCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (timestampMs > Date.now()) return null;

  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${timestampMs}&limit=1`,
    { cache: 'no-store' },
  );

  if (!res.ok) return null;

  const raw: any[][] = await res.json();
  if (raw.length === 0) return null;

  const openPrice = parseFloat(raw[0][1]);
  historicalPriceCache.set(cacheKey, openPrice);
  return openPrice;
}

// ─── 5-min High-Low Range (volatility check) ────────────

const rangeCache = new Map<string, { rangePct: number; timestamp: number }>();
const RANGE_CACHE_TTL_MS = 10_000; // 10s cache — don't hammer Binance

/**
 * Returns (high - low) / low over the last 5 minutes as a fraction.
 * Uses 5 x 1m klines. Returns null on error.
 */
export async function get5mRangePct(symbol: CryptoSymbol): Promise<number | null> {
  const now = Date.now();
  const cached = rangeCache.get(symbol);
  if (cached && now - cached.timestamp < RANGE_CACHE_TTL_MS) {
    return cached.rangePct;
  }

  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=5`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;

    const raw: any[][] = await res.json();
    if (raw.length === 0) return null;

    let high = -Infinity;
    let low = Infinity;
    for (const candle of raw) {
      const h = parseFloat(candle[2]); // high
      const l = parseFloat(candle[3]); // low
      if (h > high) high = h;
      if (l < low) low = l;
    }

    const rangePct = low > 0 ? (high - low) / low : 0;
    rangeCache.set(symbol, { rangePct, timestamp: now });
    return rangePct;
  } catch {
    return null;
  }
}

export async function getCryptoPrice(symbol: CryptoSymbol): Promise<number> {
  const now = Date.now();
  const cached = cryptoCache.get(symbol);
  if (cached && now - cached.timestamp < CRYPTO_CACHE_TTL_MS) {
    return cached.price;
  }

  const res = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
    { cache: 'no-store' },
  );

  if (!res.ok) {
    throw new Error(`Binance ${symbol} price fetch failed: ${res.status}`);
  }

  const data: { symbol: string; price: string } = await res.json();
  const price = parseFloat(data.price);

  cryptoCache.set(symbol, { price, timestamp: now });
  return price;
}
