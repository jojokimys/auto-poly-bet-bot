import 'server-only';

import { prisma } from '@/lib/db/prisma';
import { loadProfile, placeProfileOrder, type ProfileCredentials } from '@/lib/bot/profile-client';
import type { OrderRequest, OrderResult, ArbOrderResult } from './types';

export async function executeOrder(req: OrderRequest, cachedProfile?: ProfileCredentials): Promise<OrderResult> {
  const profile = cachedProfile ?? await loadProfile(req.profileId);
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

    // Check if CLOB API returned an error
    const clobError = (result as any)?.error;
    if (clobError) {
      await prisma.botLog.create({
        data: {
          profileId: req.profileId,
          level: 'error',
          event: 'ai-order-clob-error',
          message: `CLOB rejected: ${clobError} (status ${(result as any)?.status})`,
          data: JSON.stringify({ conditionId: req.conditionId, clobResponse: result }),
        },
      });
      return {
        success: false,
        orderId,
        message: `CLOB error: ${clobError}`,
      };
    }

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

/**
 * Execute all legs of an arb order in parallel.
 * All legs must succeed for a true arb; partial fills create directional risk.
 */
export async function executeArbOrder(legs: OrderRequest[], cachedProfile?: ProfileCredentials): Promise<ArbOrderResult> {
  if (legs.length === 0) {
    return { success: false, results: [], message: 'No legs provided' };
  }

  const results = await Promise.all(legs.map(leg => executeOrder(leg, cachedProfile)));
  const succeeded = results.filter(r => r.success).length;
  const allSuccess = succeeded === legs.length;

  if (!allSuccess && succeeded > 0) {
    // Partial fill — log warning (directional exposure risk)
    await prisma.botLog.create({
      data: {
        profileId: legs[0].profileId,
        level: 'warn',
        event: 'arb-partial-fill',
        message: `Arb partial fill: ${succeeded}/${legs.length} legs succeeded. Directional exposure risk!`,
        data: JSON.stringify(results),
      },
    });
  }

  return {
    success: allSuccess,
    results,
    message: allSuccess
      ? `Arb complete: ${legs.length} legs filled`
      : `Arb partial: ${succeeded}/${legs.length} legs filled`,
  };
}
