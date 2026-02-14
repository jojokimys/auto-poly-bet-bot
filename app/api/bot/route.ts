import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { startBot, stopBot, stopAllBots, getBotState } from '@/lib/bot/skill-engine';
import { getApiUsageStats } from '@/lib/bot/api-tracker';
import { prisma } from '@/lib/db/prisma';

const botActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    profileId: z.string().min(1, 'profileId is required'),
  }),
  z.object({
    action: z.literal('stop'),
    profileId: z.string().min(1, 'profileId is required'),
  }),
  z.object({
    action: z.literal('stopAll'),
  }),
]);

export async function GET() {
  const states = getBotState();
  const apiUsage = getApiUsageStats();
  return NextResponse.json({ states, apiUsage });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = botActionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = parsed.data;

    if (data.action === 'start') {
      // Validate profile exists and is active
      const profile = await prisma.botProfile.findUnique({
        where: { id: data.profileId },
      });

      if (!profile) {
        return NextResponse.json(
          { error: 'Profile not found' },
          { status: 404 },
        );
      }

      if (!profile.isActive) {
        return NextResponse.json(
          { error: 'Profile is inactive. Activate it before starting.' },
          { status: 400 },
        );
      }

      if (!profile.privateKey || !profile.apiKey || !profile.apiSecret || !profile.apiPassphrase) {
        return NextResponse.json(
          { error: 'Profile is missing required credentials (privateKey, apiKey, apiSecret, apiPassphrase).' },
          { status: 400 },
        );
      }

      const state = await startBot(data.profileId);
      return NextResponse.json({ profileId: data.profileId, state });
    }

    if (data.action === 'stop') {
      const state = await stopBot(data.profileId);
      return NextResponse.json({ profileId: data.profileId, state });
    }

    if (data.action === 'stopAll') {
      const states = await stopAllBots();
      return NextResponse.json({ states });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Bot API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to control bot' },
      { status: 500 },
    );
  }
}
