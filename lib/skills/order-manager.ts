import 'server-only';

import { prisma } from '@/lib/db/prisma';
import { placeProfileOrder, type ProfileCredentials } from '@/lib/bot/profile-client';
import type { OrderRequest, OrderResult } from './types';

async function loadProfile(profileId: string): Promise<ProfileCredentials | null> {
  const p = await prisma.botProfile.findUnique({ where: { id: profileId } });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    privateKey: p.privateKey,
    funderAddress: p.funderAddress,
    apiKey: p.apiKey,
    apiSecret: p.apiSecret,
    apiPassphrase: p.apiPassphrase,
  };
}

export async function executeOrder(req: OrderRequest): Promise<OrderResult> {
  const profile = await loadProfile(req.profileId);
  if (!profile) {
    return { success: false, message: `Profile not found: ${req.profileId}` };
  }

  try {
    const result = await placeProfileOrder(profile, {
      tokenId: req.tokenId,
      side: req.action,
      price: req.price,
      size: req.size,
    });

    const orderId = (result as any)?.orderID || (result as any)?.id || 'unknown';

    // Log to BotLog for visibility
    await prisma.botLog.create({
      data: {
        profileId: req.profileId,
        level: 'trade',
        event: 'ai-order',
        message: `AI ${req.action} ${req.size}x ${req.outcome} @ ${req.price} — ${req.reason}`,
        data: JSON.stringify({
          conditionId: req.conditionId,
          tokenId: req.tokenId,
          orderId,
        }),
      },
    });

    return {
      success: true,
      orderId,
      message: `Order placed: ${req.action} ${req.size}x ${req.outcome} @ $${req.price}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Order execution failed';

    await prisma.botLog.create({
      data: {
        profileId: req.profileId,
        level: 'error',
        event: 'ai-order-error',
        message: `Failed: ${req.action} ${req.outcome} — ${message}`,
        data: JSON.stringify({ conditionId: req.conditionId, error: message }),
      },
    });

    return { success: false, message };
  }
}
