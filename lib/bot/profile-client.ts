import 'server-only';

import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { Wallet } from '@ethersproject/wallet';
import { getEnv } from '@/lib/config/env';
import { trackClobCall, trackClobAuthCall } from './api-tracker';

const CHAIN_ID = 137;

export interface ProfileCredentials {
  id: string;
  name: string;
  privateKey: string;
  funderAddress: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
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
  const sigType = funder ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;

  const client = new ClobClient(
    env.CLOB_API_URL,
    CHAIN_ID,
    wallet,
    creds,
    sigType,
    funder,
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

/** Place an order for a specific profile */
export async function placeProfileOrder(
  profile: ProfileCredentials,
  params: { tokenId: string; side: 'BUY' | 'SELL'; price: number; size: number }
) {
  trackClobAuthCall(); // getTickSize
  trackClobAuthCall(); // getNegRisk
  trackClobAuthCall(); // createAndPostOrder
  const client = getClientForProfile(profile);
  const tickSize = await client.getTickSize(params.tokenId);
  const negRisk = await client.getNegRisk(params.tokenId);

  return client.createAndPostOrder(
    {
      tokenID: params.tokenId,
      price: params.price,
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
