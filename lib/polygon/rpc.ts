import 'server-only';

import { JsonRpcProvider } from '@ethersproject/providers';
import { createWalletClient, createPublicClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

// ─── RPC URLs ────────────────────────────────────────────

const POLYGON_RPC1 = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const POLYGON_RPC2 = process.env.POLYGON_RPC_URL2 || POLYGON_RPC1;
const POLYGON_RPC3 = process.env.POLYGON_RPC_URL3 || POLYGON_RPC1;

/** All unique RPC URLs (deduplicated) */
export const POLYGON_RPCS = [POLYGON_RPC1, POLYGON_RPC2, POLYGON_RPC3].filter(
  (url, i, arr) => arr.indexOf(url) === i,
);

/** TX-dedicated RPCs (RPC2 → RPC3 fallback) */
export const TX_RPCS = [POLYGON_RPC2, POLYGON_RPC3].filter(
  (url, i, arr) => arr.indexOf(url) === i,
);

export const CHAIN_ID = 137;

// ─── TX RPC Fallback State ───────────────────────────────

let currentTxRpcIndex = 0;
let rpcBackoffUntil = 0;

/** Get the current TX RPC URL (respects backoff) */
export function getTxRpcUrl(): string {
  if (Date.now() < rpcBackoffUntil) return TX_RPCS[TX_RPCS.length - 1];
  return TX_RPCS[currentTxRpcIndex];
}

/** Switch to next TX RPC on 429/rate-limit (default 5min backoff) */
export function switchToNextRpc(backoffMs = 300_000): void {
  currentTxRpcIndex = (currentTxRpcIndex + 1) % TX_RPCS.length;
  rpcBackoffUntil = Date.now() + backoffMs;
}

/** Check if an error is a rate-limit or network error worth retrying */
export function isRetryableRpcError(msg: string): boolean {
  return (
    msg.includes('429') ||
    msg.includes('Too Many') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('NETWORK_ERROR') ||
    msg.includes('could not detect network') ||
    msg.includes('bad result from backend')
  );
}

// ─── Ethers Read-Only Provider (with fallback) ───────────

let providerCache: JsonRpcProvider | null = null;
let providerRpcIndex = 0;

export class FetchJsonRpcProvider extends JsonRpcProvider {
  async send(method: string, params: Array<any>): Promise<any> {
    const request = { method, params, id: 42, jsonrpc: '2.0' };
    const res = await fetch(this.connection.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    if (json.result === undefined || json.result === null) {
      throw new Error(`RPC returned empty result for ${method}`);
    }
    return json.result;
  }
}

/** Get cached ethers provider (for simple one-off reads) */
export function getProvider(forceNew = false): JsonRpcProvider {
  if (!providerCache || forceNew) {
    providerCache = new FetchJsonRpcProvider(POLYGON_RPCS[providerRpcIndex], CHAIN_ID);
  }
  return providerCache;
}

/** Execute a read call with automatic fallback through all RPCs */
export async function withProviderFallback<T>(
  fn: (provider: JsonRpcProvider) => Promise<T>,
): Promise<T> {
  let lastErr: Error | null = null;
  for (let i = 0; i < POLYGON_RPCS.length; i++) {
    const idx = (providerRpcIndex + i) % POLYGON_RPCS.length;
    const provider = new FetchJsonRpcProvider(POLYGON_RPCS[idx], CHAIN_ID);
    try {
      const result = await fn(provider);
      if (idx !== providerRpcIndex) {
        providerRpcIndex = idx;
        providerCache = provider;
      }
      return result;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error('All RPCs failed');
}

// ─── Viem Client Factories ───────────────────────────────

/** Create viem public + wallet clients for the current TX RPC */
export function createTxClients(privateKey: Hex) {
  const rpcUrl = getTxRpcUrl();
  const account = privateKeyToAccount(privateKey);
  return {
    rpcUrl,
    account,
    walletClient: createWalletClient({ account, chain: polygon, transport: http(rpcUrl) }),
    publicClient: createPublicClient({ chain: polygon, transport: http(rpcUrl) }),
  };
}

/** Create viem clients for a specific RPC URL */
export function createClientsForRpc(privateKey: Hex, rpcUrl: string) {
  const account = privateKeyToAccount(privateKey);
  return {
    rpcUrl,
    account,
    walletClient: createWalletClient({ account, chain: polygon, transport: http(rpcUrl) }),
    publicClient: createPublicClient({ chain: polygon, transport: http(rpcUrl) }),
  };
}

/** Create a read-only viem public client for the current TX RPC */
export function createPublicTxClient() {
  return createPublicClient({ chain: polygon, transport: http(getTxRpcUrl()) });
}

// ─── Gas Price Cache ─────────────────────────────────────

let cachedGasPrice: { price: bigint; timestamp: number } | null = null;
const GAS_PRICE_CACHE_TTL_MS = 30_000; // 30s

export const MIN_GAS_PRICE = 150_000_000_000n; // 150 gwei
export const PROXY_REDEEM_GAS = 300_000n;       // hardcoded (actual: 107k-137k)
export const EOA_REDEEM_GAS = 200_000n;

export async function getCachedGasPrice(
  publicClient: ReturnType<typeof createPublicClient>,
): Promise<bigint> {
  const now = Date.now();
  if (cachedGasPrice && now - cachedGasPrice.timestamp < GAS_PRICE_CACHE_TTL_MS) {
    return cachedGasPrice.price;
  }
  try {
    const estimated = await publicClient.getGasPrice();
    const price = estimated > MIN_GAS_PRICE ? estimated : MIN_GAS_PRICE;
    cachedGasPrice = { price, timestamp: now };
    return price;
  } catch {
    return cachedGasPrice?.price ?? MIN_GAS_PRICE;
  }
}
