import { NextRequest, NextResponse } from 'next/server';
import { createWalletClient, createPublicClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { loadProfile } from '@/lib/bot/profile-client';

const POLYGON_RPC2 = process.env.POLYGON_RPC_URL2 || process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

/**
 * GET: Check nonce status (confirmed vs pending)
 * POST: Send replacement self-transfer TXs to clear stuck nonces
 */

export async function GET(req: NextRequest) {
  const profileId = req.nextUrl.searchParams.get('profileId');
  if (!profileId) return NextResponse.json({ error: 'profileId required' }, { status: 400 });

  const profile = await loadProfile(profileId);
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

  const account = privateKeyToAccount(profile.privateKey as Hex);
  const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC2) });

  const [confirmed, pending, gasPrice] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    publicClient.getGasPrice(),
  ]);

  const stuckCount = pending - confirmed;

  return NextResponse.json({
    rpcUrl: POLYGON_RPC2.replace(/\/[a-f0-9]{20,}$/i, '/***'), // mask API key
    address: account.address,
    confirmedNonce: confirmed,
    pendingNonce: pending,
    stuckCount,
    currentGasGwei: Number(gasPrice) / 1e9,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { profileId, gasPriceGwei = 200 } = body;

  if (!profileId) return NextResponse.json({ error: 'profileId required' }, { status: 400 });

  const profile = await loadProfile(profileId);
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

  const account = privateKeyToAccount(profile.privateKey as Hex);
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC2) });
  const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC2) });

  const confirmed = await publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' });
  const pending = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const stuckCount = pending - confirmed;

  if (stuckCount === 0) {
    return NextResponse.json({ message: 'No stuck transactions', confirmed, pending });
  }

  const gasPrice = BigInt(Math.round(gasPriceGwei * 1e9));
  const results: { nonce: number; txHash: string | null; error: string | null }[] = [];

  // Send replacement self-transfers for each stuck nonce
  for (let nonce = confirmed; nonce < pending; nonce++) {
    try {
      const txHash = await walletClient.sendTransaction({
        chain: polygon,
        to: account.address, // self-transfer
        value: 0n,
        nonce,
        gasPrice,
        gas: 21000n, // simple transfer
      });
      results.push({ nonce, txHash, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ nonce, txHash: null, error: msg });
      // If one nonce fails, subsequent ones will also fail
      if (msg.includes('nonce too low')) continue; // already confirmed, skip
      if (msg.includes('replacement transaction underpriced')) {
        // Need higher gas — stop and report
        break;
      }
    }
  }

  return NextResponse.json({
    stuckCount,
    gasPriceGwei,
    startNonce: confirmed,
    endNonce: pending - 1,
    results,
    sent: results.filter(r => r.txHash).length,
    failed: results.filter(r => r.error).length,
  });
}
