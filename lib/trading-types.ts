/** Shared types for MM infrastructure (WS, market data) */

export type CryptoAsset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export const ALL_CRYPTO_ASSETS: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

export interface BookLevel {
  price: string;
  size: string;
}

export interface BookSnapshot {
  assetId: string;
  buys: BookLevel[];
  sells: BookLevel[];
  timestamp: number;
  /** true for full orderbook snapshots, false for price_change (best bid/ask only) */
  isFullBook?: boolean;
}
