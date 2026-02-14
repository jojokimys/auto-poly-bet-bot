import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { stopBot } from '@/lib/bot/skill-engine';
import { clearProfileClient } from '@/lib/bot/profile-client';

const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  privateKey: z.string().min(1).optional(),
  funderAddress: z.string().optional(),
  apiKey: z.string().min(1).optional(),
  apiSecret: z.string().min(1).optional(),
  apiPassphrase: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  strategy: z.string().optional(),
});

interface ProfilePublicResponse {
  id: string;
  name: string;
  funderAddress: string;
  hasPrivateKey: boolean;
  hasApiCredentials: boolean;
  isActive: boolean;
  strategy: string;
  createdAt: string;
}

function toPublic(profile: {
  id: string;
  name: string;
  funderAddress: string;
  privateKey: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  isActive: boolean;
  strategy: string;
  createdAt: Date;
}): ProfilePublicResponse {
  return {
    id: profile.id,
    name: profile.name,
    funderAddress: profile.funderAddress,
    hasPrivateKey: !!profile.privateKey,
    hasApiCredentials: !!(profile.apiKey && profile.apiSecret && profile.apiPassphrase),
    isActive: profile.isActive,
    strategy: profile.strategy,
    createdAt: profile.createdAt.toISOString(),
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const profile = await prisma.botProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    return NextResponse.json(toPublic(profile));
  } catch (error) {
    console.error('Failed to fetch profile:', error);
    return NextResponse.json(
      { error: 'Failed to fetch profile' },
      { status: 500 },
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const parsed = updateProfileSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const existing = await prisma.botProfile.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    // Only update fields that are explicitly provided
    const updateData: Record<string, unknown> = {};
    const data = parsed.data;

    if (data.name !== undefined) updateData.name = data.name;
    if (data.privateKey !== undefined) updateData.privateKey = data.privateKey;
    if (data.funderAddress !== undefined) updateData.funderAddress = data.funderAddress;
    if (data.apiKey !== undefined) updateData.apiKey = data.apiKey;
    if (data.apiSecret !== undefined) updateData.apiSecret = data.apiSecret;
    if (data.apiPassphrase !== undefined) updateData.apiPassphrase = data.apiPassphrase;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.strategy !== undefined) updateData.strategy = data.strategy;

    const profile = await prisma.botProfile.update({
      where: { id },
      data: updateData,
    });

    // If credentials changed, clear the cached client so it gets recreated
    if (data.privateKey || data.apiKey || data.apiSecret || data.apiPassphrase || data.funderAddress !== undefined) {
      clearProfileClient(id);
    }

    return NextResponse.json(toPublic(profile));
  } catch (error) {
    console.error('Failed to update profile:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update profile' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const existing = await prisma.botProfile.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    // Stop the bot for this profile if it is running
    try {
      await stopBot(id);
    } catch {
      // Bot may not be running, that's fine
    }

    // Clear the cached client
    clearProfileClient(id);

    await prisma.botProfile.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete profile:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete profile' },
      { status: 500 },
    );
  }
}
