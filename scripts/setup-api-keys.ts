/**
 * Polymarket API Key Setup Script
 *
 * Derives or creates API credentials from your wallet private key.
 * Automatically writes them to .env.local (no manual copy-paste needed).
 *
 * Usage:
 *   # Set PRIVATE_KEY (and optionally FUNDER_ADDRESS) in .env.local, then:
 *   yarn bot:setup-keys
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { Wallet } from '@ethersproject/wallet';

const CHAIN_ID = 137; // Polygon mainnet
const CLOB_URL = process.env.CLOB_API_URL || 'https://clob.polymarket.com';

/**
 * Read .env.local, update or append key=value pairs, write back.
 * Preserves existing entries and comments.
 */
function writeEnvValues(updates: Record<string, string>) {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  const lines = content.split('\n');

  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) {
      lines[idx] = line;
    } else {
      lines.push(line);
    }
  }

  // Remove trailing empty lines, add single newline at end
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  lines.push('');

  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: PRIVATE_KEY not found in .env.local');
    console.error('Add PRIVATE_KEY=0x... to .env.local first.');
    process.exit(1);
  }

  const funderAddress = process.env.FUNDER_ADDRESS || '';
  const wallet = new Wallet(privateKey);

  const sigType = funderAddress
    ? SignatureType.POLY_PROXY
    : SignatureType.EOA;
  const sigLabel = funderAddress ? 'POLY_PROXY' : 'EOA (direct)';

  console.log('='.repeat(60));
  console.log('  Polymarket API Key Setup');
  console.log('='.repeat(60));
  console.log(`  Wallet Address:  ${wallet.address}`);
  console.log(`  Funder Address:  ${funderAddress || '(none — using EOA)'}`);
  console.log(`  Signature Type:  ${sigLabel}`);
  console.log(`  CLOB Endpoint:   ${CLOB_URL}`);
  console.log();

  const client = new ClobClient(
    CLOB_URL,
    CHAIN_ID,
    wallet,
    undefined,
    sigType,
    funderAddress || undefined,
  );

  console.log('  Deriving API credentials...');
  console.log();

  try {
    const creds = await client.createOrDeriveApiKey();

    // Write credentials directly to .env.local
    writeEnvValues({
      POLY_API_KEY: creds.key,
      POLY_API_SECRET: creds.secret,
      POLY_API_PASSPHRASE: creds.passphrase,
    });

    console.log('  Written to .env.local:');
    console.log('-'.repeat(60));
    console.log(`  POLY_API_KEY=${creds.key}`);
    console.log(`  POLY_API_SECRET=${creds.secret}`);
    console.log(`  POLY_API_PASSPHRASE=${creds.passphrase}`);
    console.log('-'.repeat(60));
    console.log();

    // Verify the credentials work
    const authedClient = new ClobClient(
      CLOB_URL,
      CHAIN_ID,
      wallet,
      creds,
      sigType,
      funderAddress || undefined,
    );

    console.log('  Verifying credentials...');
    const balance = await authedClient.getBalanceAllowance({
      asset_type: 'COLLATERAL' as any,
    });
    console.log(`  USDC Balance:    $${parseFloat(balance.balance).toFixed(2)}`);
    console.log(`  USDC Allowance:  $${parseFloat(balance.allowance).toFixed(2)}`);
    console.log();
    console.log('  Done! Credentials verified and saved to .env.local');
  } catch (err) {
    console.error('  FAILED:', err instanceof Error ? err.message : err);
    console.error();
    console.error('  Common issues:');
    console.error('  - Wallet has never interacted with Polymarket (deposit USDC first)');
    console.error('  - Private key format wrong (needs 0x prefix, 64 hex chars)');
    console.error('  - FUNDER_ADDRESS wrong (should be the address shown on your Polymarket profile)');
    process.exit(1);
  }

  console.log('='.repeat(60));
}

main();
