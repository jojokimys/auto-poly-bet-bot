import 'server-only';

import { ClobClient, type TickSize } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { SignatureType } from '@polymarket/order-utils';
import { Wallet } from '@ethersproject/wallet';
import { prisma } from '@/lib/db/prisma';
import { getEnv, getBuilderConfig } from '@/lib/config/env';
import { trackClobCall, trackClobAuthCall } from './api-tracker';
import { fetchBestBidAsk } from './orderbook';

const CHAIN_ID = 137;

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
  const result = await client.getBalanceAllowance({
    asset_type: 'COLLATERAL' as any,
  });
  return parseFloat(result.balance) / 1e6;
}

/** Get trades for a specific profile */
export async function getProfileTrades(profile: ProfileCredentials) {
  trackClobAuthCall();
  const client = getClientForProfile(profile);
  return client.getTrades();
}

/** Get open orders for a specific profile */
export async function getProfileOpenOrders(profile: ProfileCredentials) {
  trackClobAuthCall();
  const client = getClientForProfile(profile);
  const orders = await client.getOpenOrders();
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
  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
  ]);

  tokenMetaCache.set(tokenId, { tickSize, negRisk, expiresAt: Date.now() + TOKEN_META_TTL_MS });
  return { tickSize, negRisk };
}

/** Place an order for a specific profile (maker-enforced) */
export async function placeProfileOrder(
  profile: ProfileCredentials,
  params: { tokenId: string; side: 'BUY' | 'SELL'; price: number; size: number }
) {
  trackClobAuthCall(); // createAndPostOrder
  const client = getClientForProfile(profile);
  const { tickSize, negRisk } = await getTokenMeta(client, params.tokenId);

  // Maker enforcement: ensure price doesn't cross the spread
  const tick = parseFloat(tickSize);
  let adjustedPrice = params.price;

  const book = await fetchBestBidAsk(params.tokenId);
  if (book) {
    if (params.side === 'BUY' && book.bestAsk !== null && params.price >= book.bestAsk) {
      adjustedPrice = book.bestAsk - tick;
      console.log(`[maker] BUY price adjusted: ${params.price} → ${adjustedPrice} (bestAsk: ${book.bestAsk})`);
    }
    if (params.side === 'SELL' && book.bestBid !== null && params.price <= book.bestBid) {
      adjustedPrice = book.bestBid + tick;
      console.log(`[maker] SELL price adjusted: ${params.price} → ${adjustedPrice} (bestBid: ${book.bestBid})`);
    }
  }

  // Round to tick size
  adjustedPrice = Math.round(adjustedPrice / tick) * tick;
  // Fix floating point: keep same decimal places as tick
  const decimals = tickSize.split('.')[1]?.length ?? 2;
  adjustedPrice = parseFloat(adjustedPrice.toFixed(decimals));

  return client.createAndPostOrder(
    {
      tokenID: params.tokenId,
      price: adjustedPrice,
      size: params.size,
      side: params.side as any,
    },
    { tickSize, negRisk },
  );
}

/** Cancel all open orders for a profile */
export async function cancelAllProfileOrders(profile: ProfileCredentials) {
  trackClobAuthCall();
  const client = getClientForProfile(profile);
  return client.cancelAll();
}

/** Cancel specific orders by hash */
export async function cancelProfileOrders(profile: ProfileCredentials, orderIds: string[]) {
  trackClobAuthCall();
  const client = getClientForProfile(profile);
  return client.cancelOrders(orderIds);
}
