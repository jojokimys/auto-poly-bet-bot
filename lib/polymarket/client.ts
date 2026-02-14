import 'server-only';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { Wallet } from '@ethersproject/wallet';
import { getEnv, hasTradeCredentials } from '@/lib/config/env';
import type { ApiKeyCreds } from '@/lib/types/polymarket';

const CHAIN_ID = 137; // Polygon mainnet

let readClient: ClobClient | null = null;
let authClient: ClobClient | null = null;

/** Read-only client — no private key needed */
export function getReadClient(): ClobClient {
  if (readClient) return readClient;
  const env = getEnv();
  readClient = new ClobClient(env.CLOB_API_URL, CHAIN_ID);
  return readClient;
}

/** Authenticated client for trading — requires private key + API creds */
export function getAuthClient(): ClobClient {
  if (authClient) return authClient;

  if (!hasTradeCredentials()) {
    throw new Error(
      'Trading credentials not configured. Set PRIVATE_KEY, POLY_API_KEY, POLY_API_SECRET, POLY_API_PASSPHRASE.'
    );
  }

  const env = getEnv();
  const wallet = new Wallet(env.PRIVATE_KEY);
  const creds: ApiKeyCreds = {
    key: env.POLY_API_KEY,
    secret: env.POLY_API_SECRET,
    passphrase: env.POLY_API_PASSPHRASE,
  };

  // Use POLY_GNOSIS_SAFE when a funder address (proxy wallet) is configured,
  // otherwise default to EOA signing.
  const funder = env.FUNDER_ADDRESS || undefined;
  const sigType = funder ? SignatureType.POLY_PROXY : SignatureType.EOA;

  authClient = new ClobClient(
    env.CLOB_API_URL,
    CHAIN_ID,
    wallet,
    creds,
    sigType,
    funder,
  );
  return authClient;
}

/** Reset cached clients (useful after settings change) */
export function resetClients(): void {
  readClient = null;
  authClient = null;
}
