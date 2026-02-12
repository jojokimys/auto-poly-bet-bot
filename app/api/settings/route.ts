import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import type { BotSettingsPublic } from '@/lib/types/app';

const updateSettingsSchema = z.object({
  privateKey: z.string().optional(),
  funderAddress: z.string().optional(),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  apiPassphrase: z.string().optional(),
  maxBetAmount: z.number().positive().optional(),
  minLiquidity: z.number().min(0).optional(),
  minVolume: z.number().min(0).optional(),
  maxSpread: z.number().min(0).max(1).optional(),
  autoBettingEnabled: z.boolean().optional(),
  scanIntervalMinutes: z.number().int().min(1).max(1440).optional(),
});

function toPublic(settings: any): BotSettingsPublic {
  return {
    id: settings.id,
    funderAddress: settings.funderAddress,
    apiKey: settings.apiKey,
    maxBetAmount: settings.maxBetAmount,
    minLiquidity: settings.minLiquidity,
    minVolume: settings.minVolume,
    maxSpread: settings.maxSpread,
    autoBettingEnabled: settings.autoBettingEnabled,
    scanIntervalMinutes: settings.scanIntervalMinutes,
    updatedAt: settings.updatedAt.toISOString(),
    hasPrivateKey: !!settings.privateKey,
    hasApiCredentials: !!(settings.apiKey && settings.apiSecret && settings.apiPassphrase),
  };
}

export async function GET() {
  try {
    let settings = await prisma.botSettings.findUnique({
      where: { id: 'default' },
    });

    if (!settings) {
      settings = await prisma.botSettings.create({
        data: { id: 'default' },
      });
    }

    return NextResponse.json(toPublic(settings));
  } catch (error) {
    console.error('Failed to fetch settings:', error);
    return NextResponse.json(
      { error: 'Failed to fetch settings' },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const parsed = updateSettingsSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid settings', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const settings = await prisma.botSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...parsed.data },
      update: parsed.data,
    });

    return NextResponse.json(toPublic(settings));
  } catch (error) {
    console.error('Failed to save settings:', error);
    return NextResponse.json(
      { error: 'Failed to save settings' },
      { status: 500 },
    );
  }
}
