import { z } from 'zod';

const envSchema = z.object({
  // Polymarket Wallet
  PRIVATE_KEY: z.string().default(''),
  FUNDER_ADDRESS: z.string().default(''),

  // Polymarket API Credentials
  POLY_API_KEY: z.string().default(''),
  POLY_API_SECRET: z.string().default(''),
  POLY_API_PASSPHRASE: z.string().default(''),

  // Endpoints
  CLOB_API_URL: z.string().url().default('https://clob.polymarket.com'),
  GAMMA_API_URL: z.string().url().default('https://gamma-api.polymarket.com'),

  // Database
  DATABASE_URL: z.string().default('file:./dev.db'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;
  cachedEnv = envSchema.parse(process.env);
  return cachedEnv;
}

export function hasTradeCredentials(): boolean {
  const env = getEnv();
  return !!(
    env.PRIVATE_KEY &&
    env.POLY_API_KEY &&
    env.POLY_API_SECRET &&
    env.POLY_API_PASSPHRASE
  );
}
