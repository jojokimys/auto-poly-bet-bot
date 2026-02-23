import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { startSniper, stopSniper, getSniperState, getSniperDetail, getSniperLogs } from '@/lib/mm/sniper-engine';
import { prisma } from '@/lib/db/prisma';

const cryptoAssetEnum = z.enum(['BTC', 'ETH', 'SOL', 'XRP']);

const marketSelectionSchema = z.object({
  asset: cryptoAssetEnum,
  mode: z.enum(['5m', '15m']),
});

const sniperConfigSchema = z.object({
  selections: z.array(marketSelectionSchema).min(1).optional(),
  minMinutesLeft: z.number().min(0.1).max(10).optional(),
  maxMinutesLeft: z.number().min(0.5).max(15).optional(),
  minPriceDiffPct: z.number().min(0.0001).max(0.1).optional(),
  maxTokenPrice: z.number().min(0.5).max(0.99).optional(),
  maxPositionPct: z.number().min(0.01).max(0.50).optional(),
  maxExposurePct: z.number().min(0.10).max(1.0).optional(),
  maxConcurrentPositions: z.number().int().min(1).max(10).optional(),
}).optional();

const sniperActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    profileId: z.string().min(1),
    config: sniperConfigSchema,
  }),
  z.object({
    action: z.literal('stop'),
    profileId: z.string().min(1),
  }),
]);

export async function GET(req: NextRequest) {
  const profileId = req.nextUrl.searchParams.get('profileId') ?? undefined;

  // Logs
  if (req.nextUrl.searchParams.get('logs') === 'true') {
    const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10);
    return NextResponse.json({ logs: getSniperLogs(profileId, limit) });
  }

  // Detail
  if (req.nextUrl.searchParams.get('detail') === 'true' && profileId) {
    const d = getSniperDetail(profileId);
    return NextResponse.json({ detail: d });
  }

  // Default: all sniper states
  return NextResponse.json({ states: getSniperState() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = sniperActionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = parsed.data;

    if (data.action === 'start') {
      const profile = await prisma.botProfile.findUnique({
        where: { id: data.profileId },
      });

      if (!profile) {
        return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
      }
      if (!profile.isActive) {
        return NextResponse.json({ error: 'Profile is inactive' }, { status: 400 });
      }
      if (!profile.privateKey || !profile.apiKey) {
        return NextResponse.json({ error: 'Profile missing credentials' }, { status: 400 });
      }

      const state = await startSniper(data.profileId, data.config);
      return NextResponse.json({ profileId: data.profileId, state });
    }

    if (data.action === 'stop') {
      const state = await stopSniper(data.profileId);
      return NextResponse.json({ profileId: data.profileId, state });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Sniper API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to control sniper' },
      { status: 500 },
    );
  }
}
