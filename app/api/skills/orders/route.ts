import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { executeOrder } from '@/lib/skills/order-manager';
import { prisma } from '@/lib/db/prisma';
import { cancelAllProfileOrders, type ProfileCredentials } from '@/lib/bot/profile-client';

const orderSchema = z.object({
  profileId: z.string().min(1),
  action: z.enum(['BUY', 'SELL']),
  conditionId: z.string().min(1),
  tokenId: z.string().min(1),
  outcome: z.string().min(1),
  price: z.number().min(0.001).max(0.999),
  size: z.number().min(0.1).max(1000),
  reason: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = orderSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await executeOrder(parsed.data);
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    console.error('Skills/orders error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Order execution failed' },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const profileId = req.nextUrl.searchParams.get('profileId');
    if (!profileId) {
      return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    }

    const p = await prisma.botProfile.findUnique({ where: { id: profileId } });
    if (!p) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    const profile: ProfileCredentials = {
      id: p.id, name: p.name, privateKey: p.privateKey,
      funderAddress: p.funderAddress, apiKey: p.apiKey,
      apiSecret: p.apiSecret, apiPassphrase: p.apiPassphrase,
    };

    const result = await cancelAllProfileOrders(profile);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('Cancel orders error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cancel failed' },
      { status: 500 },
    );
  }
}
