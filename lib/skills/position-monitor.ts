import 'server-only';

import {
  getProfileBalance,
  getProfileOpenOrders,
  loadProfile,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';
import { getNetPositions } from './early-exit';
import type { PositionData } from './types';

export async function getPositions(profileId: string, cachedProfile?: ProfileCredentials): Promise<PositionData | null> {
  const profile = cachedProfile ?? await loadProfile(profileId);
  if (!profile) return null;

  const [balance, openOrders, netPositions] = await Promise.all([
    getProfileBalance(profile),
    getProfileOpenOrders(profile),
    getNetPositions(profile),
  ]);

  const parsedOrders = (openOrders || []).map((o: any) => ({
    id: o.id || '',
    conditionId: o.market || '',
    side: o.side || '',
    price: parseFloat(o.price || '0'),
    size: parseFloat(o.original_size || o.size || '0'),
    status: o.status || 'OPEN',
    tokenId: o.asset_id || '',
  }));

  const heldPositions = Array.from(netPositions.values()).map(p => ({
    tokenId: p.tokenId,
    conditionId: p.conditionId,
    outcome: p.outcome,
    netSize: p.netSize,
    avgEntryPrice: p.avgEntryPrice,
    totalCost: Math.round(p.totalCost * 100) / 100,
  }));

  const orderExposure = parsedOrders.reduce((sum: number, o: any) => sum + o.price * o.size, 0);
  const heldExposure = heldPositions.reduce((sum, hp) => sum + hp.avgEntryPrice * hp.netSize, 0);
  const totalExposure = orderExposure + heldExposure;

  // balance = free USDC (after LIVE order locks). Total portfolio includes locked USDC.
  const totalPortfolio = balance + orderExposure;

  return {
    profileId,
    profileName: profile.name,
    balance,
    openOrders: parsedOrders,
    heldPositions,
    exposure: {
      total: Math.round(totalExposure * 100) / 100,
      percentage: totalPortfolio > 0 ? Math.round((totalExposure / totalPortfolio) * 10000) / 100 : 0,
    },
    summary: {
      totalPositions: heldPositions.length,
      totalExposure: Math.round(totalExposure * 100) / 100,
    },
  };
}
