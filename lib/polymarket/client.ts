import 'server-only';
import { ClobClient } from '@polymarket/clob-client';
import { getEnv } from '@/lib/config/env';

const CHAIN_ID = 137; // Polygon mainnet

let readClient: ClobClient | null = null;

/** Read-only client — no private key needed */
export function getReadClient(): ClobClient {
  if (readClient) return readClient;
  const env = getEnv();
  readClient = new ClobClient(env.CLOB_API_URL, CHAIN_ID);
  return readClient;
}
