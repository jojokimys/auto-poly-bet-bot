import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { startMM, stopMM, getMMState, getMMDetail, getMMLogs } from '@/lib/mm/engine';
import { startSniper, stopSniper, getSniperState, getSniperDetail, getSniperLogs } from '@/lib/mm/sniper-engine';
import { findActiveCryptoMarkets } from '@/lib/mm/market-finder';
import { fetchBestBidAsk } from '@/lib/bot/orderbook';
import { prisma } from '@/lib/db/prisma';

const cryptoAssetEnum = z.enum(['BTC', 'ETH', 'SOL', 'XRP']);

const mmConfigSchema = z.object({
  mode: z.enum(['5m', '15m']).optional(),
  assets: z.array(cryptoAssetEnum).min(1).optional(),
  maxPositionSize: z.number().int().min(1).max(500).optional(),
  baseSpreadCents: z.number().min(1).max(20).optional(),
}).optional();

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
  maxPositionSize: z.number().int().min(1).max(100).optional(),
  maxTotalExposure: z.number().min(1).max(500).optional(),
  maxConcurrentPositions: z.number().int().min(1).max(10).optional(),
}).optional();

const mmActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    profileId: z.string().min(1),
    config: mmConfigSchema,
  }),
  z.object({
    action: z.literal('stop'),
    profileId: z.string().min(1),
  }),
  z.object({
    action: z.literal('start-sniper'),
    profileId: z.string().min(1),
    config: sniperConfigSchema,
  }),
  z.object({
    action: z.literal('stop-sniper'),
    profileId: z.string().min(1),
  }),
]);

export async function GET(req: NextRequest) {
  const profileId = req.nextUrl.searchParams.get('profileId') ?? undefined;
  const logsOnly = req.nextUrl.searchParams.get('logs') === 'true';

  if (logsOnly) {
    const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10);
    const sniperLogs = req.nextUrl.searchParams.get('sniper') === 'true';
    if (sniperLogs) {
      return NextResponse.json({ logs: getSniperLogs(profileId, limit) });
    }
    return NextResponse.json({ logs: getMMLogs(profileId, limit) });
  }

  // Scan for active crypto markets (works without MM running)
  if (req.nextUrl.searchParams.get('scan') === 'true') {
    try {
      const assetParam = req.nextUrl.searchParams.get('asset');
      const assets = assetParam
        ? [assetParam as 'BTC' | 'ETH' | 'SOL' | 'XRP']
        : ['BTC', 'ETH', 'SOL', 'XRP'] as const;
      const targetWindow = parseFloat(req.nextUrl.searchParams.get('targetWindow') ?? '0') || undefined;
      const minMin = parseFloat(req.nextUrl.searchParams.get('minMinutes') ?? '1.5');
      const maxMin = parseFloat(req.nextUrl.searchParams.get('maxMinutes') ?? '14');
      const markets = await findActiveCryptoMarkets([...assets], minMin, maxMin, targetWindow);

      // Fetch orderbook for each market in parallel
      const enriched = await Promise.all(
        markets.map(async (m) => {
          let bestBid: number | null = null;
          let bestAsk: number | null = null;
          let midpoint: number | null = null;
          try {
            const book = await fetchBestBidAsk(m.yesTokenId);
            if (book) {
              bestBid = book.bestBid;
              bestAsk = book.bestAsk;
              if (bestBid !== null && bestAsk !== null) {
                midpoint = (bestBid + bestAsk) / 2;
              }
            }
          } catch { /* best-effort */ }
          return {
            conditionId: m.conditionId,
            question: m.question,
            cryptoAsset: m.cryptoAsset,
            endTime: m.endTime.toISOString(),
            strikePrice: m.strikePrice,
            minutesLeft: Math.max(0, (m.endTime.getTime() - Date.now()) / 60_000),
            bestBid,
            bestAsk,
            midpoint,
          };
        }),
      );

      return NextResponse.json({ markets: enriched });
    } catch {
      return NextResponse.json({ markets: [] });
    }
  }

  // Sniper detail
  if (req.nextUrl.searchParams.get('sniperDetail') === 'true' && profileId) {
    const d = getSniperDetail(profileId);
    return NextResponse.json({ sniperDetail: d });
  }

  const detail = req.nextUrl.searchParams.get('detail') === 'true';
  if (detail && profileId) {
    const d = getMMDetail(profileId);
    return NextResponse.json({ detail: d });
  }

  const states = getMMState(profileId);
  const sniperStates = getSniperState();
  return NextResponse.json({ states, sniperStates });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = mmActionSchema.safeParse(body);

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

      const state = await startMM(data.profileId, data.config);
      return NextResponse.json({ profileId: data.profileId, state });
    }

    if (data.action === 'stop') {
      const state = await stopMM(data.profileId);
      return NextResponse.json({ profileId: data.profileId, state });
    }

    if (data.action === 'start-sniper') {
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

    if (data.action === 'stop-sniper') {
      const state = await stopSniper(data.profileId);
      return NextResponse.json({ profileId: data.profileId, state });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('MM API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to control market maker' },
      { status: 500 },
    );
  }
}
