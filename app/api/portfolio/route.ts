import { NextRequest, NextResponse } from 'next/server';
import { Wallet } from '@ethersproject/wallet';
import { loadProfile, getProfileBalance } from '@/lib/bot/profile-client';
import { getPortfolioStats, getDailyPnl } from '@/lib/polymarket/portfolio-api';
import { getNetPositions } from '@/lib/skills/early-exit';
import { fetchClaimablePositions } from '@/lib/polymarket/redeem';
import type { PortfolioDateRange } from '@/lib/types/dashboard';

export async function GET(req: NextRequest) {
  try {
    const profileId = req.nextUrl.searchParams.get('profileId');
    if (!profileId) {
      return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    }

    const profile = await loadProfile(profileId);
    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    const daily = req.nextUrl.searchParams.get('daily');
    if (daily === 'true') {
      const walletAddress = profile.funderAddress || new Wallet(profile.privateKey).address;
      const [dailyPnl, cashBalance, positions, claimable] = await Promise.all([
        getDailyPnl(profile),
        getProfileBalance(profile).catch(() => 0),
        getNetPositions(profile).catch(() => new Map()),
        fetchClaimablePositions(walletAddress).catch(() => []),
      ]);
      let positionValue = 0;
      for (const pos of positions.values()) {
        if (pos.netSize > 0.001) positionValue += pos.totalCost;
      }
      const claimableValue = claimable.reduce((sum, p) => sum + p.size, 0);
      const balance = cashBalance + positionValue + claimableValue;
      return NextResponse.json({ dailyPnl, balance });
    }

    const range: PortfolioDateRange = {};
    const after = req.nextUrl.searchParams.get('after');
    const before = req.nextUrl.searchParams.get('before');
    if (after) range.after = after;
    if (before) range.before = before;

    const stats = await getPortfolioStats(profile, range);
    return NextResponse.json({ stats });
  } catch (error) {
    console.error('Portfolio API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch portfolio data' },
      { status: 500 },
    );
  }
}
