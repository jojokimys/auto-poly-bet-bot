import { z } from 'zod';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

const envSchema = z.object({
  // Builder API Credentials (from builders.polymarket.com)
  POLY_BUILDER_API_KEY: z.string().default(''),
  POLY_BUILDER_API_SECRET: z.string().default(''),
  POLY_BUILDER_API_PASSPHRASE: z.string().default(''),

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

let cachedBuilderConfig: BuilderConfig | undefined | null = null;

/** Returns a BuilderConfig if builder API credentials are configured, otherwise undefined. */
export function getBuilderConfig(): BuilderConfig | undefined {
  if (cachedBuilderConfig !== null) return cachedBuilderConfig;

  const env = getEnv();
  if (
    env.POLY_BUILDER_API_KEY &&
    env.POLY_BUILDER_API_SECRET &&
    env.POLY_BUILDER_API_PASSPHRASE
  ) {
    cachedBuilderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: env.POLY_BUILDER_API_KEY,
        secret: env.POLY_BUILDER_API_SECRET,
        passphrase: env.POLY_BUILDER_API_PASSPHRASE,
      },
    });
  } else {
    cachedBuilderConfig = undefined;
  }

  return cachedBuilderConfig;
}
