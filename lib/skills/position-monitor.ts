import 'server-only';

import { prisma } from '@/lib/db/prisma';
import {
  getProfileBalance,
  getProfileOpenOrders,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';
import type { PositionData } from './types';

async function loadProfile(profileId: string): Promise<ProfileCredentials | null> {
  const p = await prisma.botProfile.findUnique({ where: { id: profileId } });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    privateKey: p.privateKey,
    funderAddress: p.funderAddress,
    signatureType: p.signatureType,
    apiKey: p.apiKey,
    apiSecret: p.apiSecret,
    apiPassphrase: p.apiPassphrase,
  };
}

export async function getPositions(profileId: string): Promise<PositionData | null> {
  const profile = await loadProfile(profileId);
  if (!profile) return null;

  const [balance, openOrders, scalperPositions] = await Promise.all([
    getProfileBalance(profile),
    getProfileOpenOrders(profile),
    prisma.scalperPosition.findMany({
      where: { profileId, status: 'OPEN' },
    }),
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

  const parsedScalper = scalperPositions.map(sp => ({
    conditionId: sp.conditionId,
    outcome: sp.outcome,
    entryPrice: sp.entryPrice,
    size: sp.size,
    targetPrice: sp.targetPrice,
    stopPrice: sp.stopPrice,
    holdTimeMinutes: Math.round((Date.now() - sp.entryTime.getTime()) / 60000),
  }));

  const orderExposure = parsedOrders.reduce((sum: number, o: any) => sum + o.price * o.size, 0);
  const scalperExposure = parsedScalper.reduce((sum, sp) => sum + sp.entryPrice * sp.size, 0);
  const totalExposure = orderExposure + scalperExposure;

  return {
    profileId,
    profileName: profile.name,
    balance,
    openOrders: parsedOrders,
    scalperPositions: parsedScalper,
    exposure: {
      total: Math.round(totalExposure * 100) / 100,
      percentage: balance > 0 ? Math.round((totalExposure / balance) * 10000) / 100 : 0,
    },
    summary: {
      totalPositions: parsedOrders.length + parsedScalper.length,
      totalExposure: Math.round(totalExposure * 100) / 100,
    },
  };
}
