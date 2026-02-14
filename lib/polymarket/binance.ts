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
