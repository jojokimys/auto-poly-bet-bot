import { NextRequest, NextResponse } from 'next/server';
import { createWalletClient, createPublicClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { loadProfile } from '@/lib/bot/profile-client';
import { TX_RPCS } from '@/lib/polygon/rpc';

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

  for (const rpcUrl of TX_RPCS) {
    try {
      const publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
      const [confirmed, pending, gasPrice] = await Promise.all([
        publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }),
        publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        publicClient.getGasPrice(),
      ]);
      return NextResponse.json({
        rpcUrl: rpcUrl.replace(/\/[a-f0-9]{20,}$/i, '/***'),
        address: account.address,
        confirmedNonce: confirmed,
        pendingNonce: pending,
        stuckCount: pending - confirmed,
        currentGasGwei: Number(gasPrice) / 1e9,
      });
    } catch {
      continue;
    }
  }
  return NextResponse.json({ error: 'All RPCs failed' }, { status: 502 });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { profileId, gasPriceGwei = 200 } = body;

  if (!profileId) return NextResponse.json({ error: 'profileId required' }, { status: 400 });

  const profile = await loadProfile(profileId);
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

  const account = privateKeyToAccount(profile.privateKey as Hex);
  const gasPrice = BigInt(Math.round(gasPriceGwei * 1e9));
  const results: { nonce: number; txHash: string | null; error: string | null }[] = [];
  let rpcIdx = 0;

  const publicClient = createPublicClient({ chain: polygon, transport: http(TX_RPCS[0]) });
  const confirmed = await publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' });
  const pending = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const stuckCount = pending - confirmed;

  if (stuckCount === 0) {
    return NextResponse.json({ message: 'No stuck transactions', confirmed, pending });
  }

  for (let nonce = confirmed; nonce < pending; nonce++) {
    const rpcUrl = TX_RPCS[rpcIdx];
    const walletClient = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });
    try {
      const txHash = await walletClient.sendTransaction({
        chain: polygon,
        to: account.address,
        value: 0n,
        nonce,
        gasPrice,
        gas: 21000n,
      });
      results.push({ nonce, txHash, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes('429') || msg.includes('Too Many') || msg.includes('rate limit');
      if (isRateLimit && rpcIdx < TX_RPCS.length - 1) {
        rpcIdx++;
        nonce--;
        continue;
      }
      results.push({ nonce, txHash: null, error: msg });
      if (msg.includes('nonce too low')) continue;
      if (msg.includes('replacement transaction underpriced')) break;
    }
  }

  return NextResponse.json({
    stuckCount,
    gasPriceGwei,
    startNonce: confirmed,
    endNonce: pending - 1,
    rpcUsed: TX_RPCS[rpcIdx]?.replace(/\/[a-f0-9]{20,}$/i, '/***'),
    results,
    sent: results.filter(r => r.txHash).length,
    failed: results.filter(r => r.error).length,
  });
}
