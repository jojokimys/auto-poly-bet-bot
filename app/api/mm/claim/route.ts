import { NextRequest, NextResponse } from 'next/server';
import { fetchClaimablePositions, redeemPositions, redeemPositionsRPC } from '@/lib/polymarket/redeem';
import { loadProfile } from '@/lib/bot/profile-client';

export async function GET(req: NextRequest) {
  const profileId = req.nextUrl.searchParams.get('profileId');
  if (!profileId) return NextResponse.json({ error: 'profileId required' }, { status: 400 });

  const profile = await loadProfile(profileId);
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

  const walletAddress = profile.funderAddress || (await import('@ethersproject/wallet')).Wallet.createRandom().address;
  const claimable = await fetchClaimablePositions(walletAddress);
  return NextResponse.json({ walletAddress, claimable });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { profileId, conditionId, negRisk, yesTokenId, noTokenId, mode } = body;

  if (!profileId || !conditionId || !yesTokenId || !noTokenId) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  const profile = await loadProfile(profileId);
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

  const redeemFn = mode === 'rpc' ? redeemPositionsRPC : redeemPositions;
  const result = await redeemFn(profile, conditionId, negRisk ?? false, yesTokenId, noTokenId);
  return NextResponse.json(result);
}
