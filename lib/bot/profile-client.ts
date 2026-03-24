import 'server-only';

import { ClobClient, type TickSize } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { SignatureType } from '@polymarket/order-utils';
import { Wallet } from '@ethersproject/wallet';
import { prisma } from '@/lib/db/prisma';
import { getEnv, getBuilderConfig } from '@/lib/config/env';
// No-op API call tracker (was in api-tracker.ts)
function trackClobAuthCall() { /* no-op */ }

const CHAIN_ID = 137;

// ─── Retry wrapper for transient CLOB errors ────────────

const TRANSIENT_RE = /EADDRNOTAVAIL|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up|network|fetch failed|AggregateError/i;

function isTransientError(err: unknown): boolean {
  if (err instanceof AggregateError) return true;
  if (err instanceof Error) return TRANSIENT_RE.test(err.message);
  if (typeof err === 'string') return TRANSIENT_RE.test(err);
  return false;
}

function isErrorResponse(result: unknown): result is { error: unknown } {
  return result !== null && typeof result === 'object' && 'error' in (result as any);
}

function isTransientErrorResponse(result: { error: unknown }): boolean {
  const e = result.error;
  if (e instanceof AggregateError) return true;
  if (e instanceof Error) return TRANSIENT_RE.test(e.message);
  if (typeof e === 'string') return TRANSIENT_RE.test(e);
  return false;
}

function cleanErrorMessage(err: unknown): string {
  if (err instanceof AggregateError) {
    const inner = err.errors?.map((e: Error) => e.message).join('; ') ?? '';
    return `AggregateError: ${err.message} [${inner}]`;
  }
  if (err instanceof Error) {
    return err.message.replace(/\{[\s\S]*"POLY_API_KEY"[\s\S]*\}/, '[config redacted]');
  }
  return String(err);
}

/**
 * Retry wrapper for CLOB client calls.
 * Handles BOTH thrown errors AND error-return pattern ({ error: ... })
 * used by @polymarket/clob-client's internal errorHandling.
 */
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 500): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn();

      // CLOB client swallows errors and returns { error: ... } instead of throwing
      if (isErrorResponse(result)) {
        if (attempt < retries && isTransientErrorResponse(result)) {
          console.warn(`[clob-retry] Transient error (attempt ${attempt + 1}/${retries + 1}): ${cleanErrorMessage(result.error)}`);
          await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
          continue;
        }
        throw new Error(cleanErrorMessage(result.error));
      }

      return result;
    } catch (err) {
      if (attempt < retries && isTransientError(err)) {
        console.warn(`[clob-retry] Transient error (attempt ${attempt + 1}/${retries + 1}): ${cleanErrorMessage(err)}`);
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      const clean = cleanErrorMessage(err);
      const wrapped = new Error(clean);
      wrapped.cause = err;
      throw wrapped;
    }
  }
  throw new Error('withRetry: unreachable');
}

export interface ProfileCredentials {
  id: string;
  name: string;
  privateKey: string;
  funderAddress: string;
  signatureType?: number; // 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  builderApiKey?: string;
  builderApiSecret?: string;
  builderApiPassphrase?: string;
}

/** Load profile credentials from DB. Shared helper to avoid duplicate loading. */
export async function loadProfile(profileId: string): Promise<ProfileCredentials | null> {
  const p = await prisma.botProfile.findUnique({ where: { id: profileId } });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    privateKey: p.privateKey,
    funderAddress: p.funderAddress,
    signatureType: p.signatureType,
    apiKey: p.apiKey,
    apiSecret: p.apiSecret,
    apiPassphrase: p.apiPassphrase,
    builderApiKey: p.builderApiKey,
    builderApiSecret: p.builderApiSecret,
    builderApiPassphrase: p.builderApiPassphrase,
  };
}

const clientCache = new Map<string, ClobClient>();

/** Create an authenticated ClobClient for a specific bot profile */
export function getClientForProfile(profile: ProfileCredentials): ClobClient {
  const cached = clientCache.get(profile.id);
  if (cached) return cached;

  const env = getEnv();
  const wallet = new Wallet(profile.privateKey);
  const creds = {
    key: profile.apiKey,
    secret: profile.apiSecret,
    passphrase: profile.apiPassphrase,
  };

  const funder = profile.funderAddress || undefined;
  const sigType = profile.signatureType ?? (funder ? SignatureType.POLY_PROXY : SignatureType.EOA);

  // Profile-level builder creds take priority, then env fallback
  let builderConfig: BuilderConfig | undefined;
  if (profile.builderApiKey && profile.builderApiSecret && profile.builderApiPassphrase) {
    builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: profile.builderApiKey,
        secret: profile.builderApiSecret,
        passphrase: profile.builderApiPassphrase,
      },
    });
  } else {
    builderConfig = getBuilderConfig();
  }

  const client = new ClobClient(
    env.CLOB_API_URL,
    CHAIN_ID,
    wallet,
    creds,
    sigType,
    funder,
    undefined,      // geoBlockToken
    undefined,      // useServerTime
    builderConfig,  // builderConfig
  );

  clientCache.set(profile.id, client);
  return client;
}

/** Clear cached client for a profile (e.g. after credential update) */
export function clearProfileClient(profileId: string) {
  clientCache.delete(profileId);
}

/** Clear all cached clients */
export function clearAllProfileClients() {
  clientCache.clear();
}

/** Get balance for a specific profile */
export async function getProfileBalance(profile: ProfileCredentials): Promise<number> {
  trackClobAuthCall();
  const client = getClientForProfile(profile);
  const result = await withRetry(() => client.getBalanceAllowance({
    asset_type: 'COLLATERAL' as any,
  }));
  return parseFloat(result.balance) / 1e6;
}

/** Get token balance (position size) for a specific asset */
export async function getProfileTokenBalance(
  profile: ProfileCredentials,
  tokenId: string,
): Promise<number> {
  trackClobAuthCall();
  const client = getClientForProfile(profile);
  const result = await withRetry(() =>
    client.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId } as any),
  );
  // Balance is in raw units (6 decimals for USDC-backed tokens)
  return parseFloat(result.balance) / 1e6;
}

/** Get all open positions from Polymarket Data API */
export interface UserPosition {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  curPrice: number;
  cashPnl: number;
  percentPnl: number;
  realizedPnl: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
  redeemable: boolean;
  mergeable: boolean;
}

export async function getProfilePositions(profile: ProfileCredentials): Promise<UserPosition[]> {
  const wallet = profile.funderAddress;
  if (!wallet) return [];
  const res = await fetch(
    `https://data-api.polymarket.com/positions?user=${wallet}&sizeThreshold=0&limit=500`,
    { cache: 'no-store' },
  );
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter((p: any) => parseFloat(p.size) > 0)
    .map((p: any) => ({
      asset: p.asset,
      conditionId: p.conditionId,
      size: parseFloat(p.size) || 0,
      avgPrice: parseFloat(p.avgPrice) || 0,
      initialValue: parseFloat(p.initialValue) || 0,
      currentValue: parseFloat(p.currentValue) || 0,
      curPrice: parseFloat(p.curPrice) || 0,
      cashPnl: parseFloat(p.cashPnl) || 0,
      percentPnl: parseFloat(p.percentPnl) || 0,
      realizedPnl: parseFloat(p.realizedPnl) || 0,
      title: p.title ?? '',
      slug: p.slug ?? '',
      outcome: p.outcome ?? '',
      outcomeIndex: typeof p.outcomeIndex === 'number' ? p.outcomeIndex : 0,
      oppositeAsset: p.oppositeAsset ?? '',
      endDate: p.endDate ?? '',
      negativeRisk: p.negativeRisk ?? false,
      redeemable: p.redeemable ?? false,
      mergeable: p.mergeable ?? false,
    }));
}

/** Get trades for a specific profile */
export async function getProfileTrades(profile: ProfileCredentials) {
  trackClobAuthCall();
  const client = getClientForProfile(profile);
  return withRetry(() => client.getTrades());
}

/** Get open orders for a specific profile */
export async function getProfileOpenOrders(profile: ProfileCredentials) {
  trackClobAuthCall();
  const client = getClientForProfile(profile);
  const orders = await withRetry(() => client.getOpenOrders());
  return orders as any[];
}

// ─── Token metadata cache (tickSize + negRisk) ──────────
// TTL-based cache to avoid redundant CLOB API calls per token
const TOKEN_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
const tokenMetaCache = new Map<string, { tickSize: TickSize; negRisk: boolean; expiresAt: number }>();

async function getTokenMeta(client: ClobClient, tokenId: string): Promise<{ tickSize: TickSize; negRisk: boolean }> {
  const cached = tokenMetaCache.get(tokenId);
  if (cached && cached.expiresAt > Date.now()) {
    return { tickSize: cached.tickSize, negRisk: cached.negRisk };
  }

  trackClobAuthCall(); // getTickSize
  trackClobAuthCall(); // getNegRisk
  const [tickSize, negRisk] = await withRetry(() => Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
  ]));

  tokenMetaCache.set(tokenId, { tickSize, negRisk, expiresAt: Date.now() + TOKEN_META_TTL_MS });
  return { tickSize, negRisk };
}

/** Place an order for a specific profile.
 *  - Default (taker=false): maker-enforced — price adjusted to stay on passive side of spread.
 *  - taker=true: aggressive — buys AT bestAsk / sells AT bestBid for guaranteed fill.
 */
export async function placeProfileOrder(
  profile: ProfileCredentials,
  params: { tokenId: string; side: 'BUY' | 'SELL'; price: number; size: number; taker?: boolean; postOnly?: boolean }
) {
  trackClobAuthCall(); // createAndPostOrder
  const client = getClientForProfile(profile);
  const { tickSize, negRisk } = await getTokenMeta(client, params.tokenId);

  const tick = parseFloat(tickSize);
  let adjustedPrice = params.price;

  if (params.postOnly) {
    // postOnly: CLOB server rejects if order would cross the spread → zero taker fee guaranteed.
    // No need for manual maker enforcement — server handles it.
    adjustedPrice = params.price;
  } else if (params.taker) {
    // Taker mode: use caller's price directly (already set to bestAsk by sniper).
    // Do NOT re-fetch orderbook — price can spike between check and order.
    // params.price acts as a hard cap.
    adjustedPrice = params.price;
  } else {
    // Maker enforcement: use caller's price directly (use postOnly for server-side enforcement)
    adjustedPrice = params.price;
  }

  // Round to tick size
  adjustedPrice = Math.round(adjustedPrice / tick) * tick;
  // Fix floating point: keep same decimal places as tick
  const decimals = tickSize.split('.')[1]?.length ?? 2;
  adjustedPrice = parseFloat(adjustedPrice.toFixed(decimals));

  return withRetry(() => client.createAndPostOrder(
    {
      tokenID: params.tokenId,
      price: adjustedPrice,
      size: params.size,
      side: params.side as any,
    },
    { tickSize, negRisk },
    undefined, // orderType (GTC default)
    undefined, // deferExec
    params.postOnly ?? false, // postOnly — zero taker fee, rejected if crosses spread
  ));
}

/** Cancel all open orders for a profile */
export async function cancelAllProfileOrders(profile: ProfileCredentials) {
  trackClobAuthCall();
  const client = getClientForProfile(profile);
  return withRetry(() => client.cancelAll());
}

/** Cancel specific orders by hash */
export async function cancelProfileOrders(profile: ProfileCredentials, orderIds: string[]) {
  trackClobAuthCall();
  const client = getClientForProfile(profile);
  return withRetry(() => client.cancelOrders(orderIds));
}
