import 'server-only';

import type { CryptoPriceData } from './types';

const BINANCE_BASE = 'https://api.binance.com/api/v3';

const SYMBOL_MAP: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
  DOGE: 'DOGEUSDT',
  ADA: 'ADAUSDT',
  AVAX: 'AVAXUSDT',
  LINK: 'LINKUSDT',
  DOT: 'DOTUSDT',
  MATIC: 'MATICUSDT',
};

interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
}

export async function getCryptoPrices(symbols: string[]): Promise<CryptoPriceData> {
  const validSymbols = symbols
    .map(s => s.toUpperCase())
    .filter(s => SYMBOL_MAP[s]);

  if (validSymbols.length === 0) {
    return { prices: {}, timestamp: new Date().toISOString() };
  }

  const binanceSymbols = validSymbols.map(s => SYMBOL_MAP[s]);

  // Use 24hr ticker for price + change
  const symbolsParam = JSON.stringify(binanceSymbols);
  const res = await fetch(
    `${BINANCE_BASE}/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`,
    { cache: 'no-store' },
  );

  if (!res.ok) {
    throw new Error(`Binance ticker fetch failed: ${res.status}`);
  }

  const tickers: Ticker24h[] = await res.json();

  const prices: Record<string, { price: number; change24h: number }> = {};

  for (const ticker of tickers) {
    // Reverse map: BTCUSDT → BTC
    const asset = validSymbols.find(s => SYMBOL_MAP[s] === ticker.symbol);
    if (asset) {
      prices[asset] = {
        price: parseFloat(ticker.lastPrice),
        change24h: parseFloat(ticker.priceChangePercent),
      };
    }
  }

  return {
    prices,
    timestamp: new Date().toISOString(),
  };
}
