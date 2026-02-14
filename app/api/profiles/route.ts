import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';

const createProfileSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  privateKey: z.string().min(1, 'Private key is required'),
  funderAddress: z.string().optional().default(''),
  signatureType: z.number().int().min(0).max(2).optional().default(2),
  apiKey: z.string().min(1, 'API key is required'),
  apiSecret: z.string().min(1, 'API secret is required'),
  apiPassphrase: z.string().min(1, 'API passphrase is required'),
  strategy: z.string().optional().default('value-betting'),
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

export async function GET() {
  try {
    const profiles = await prisma.botProfile.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({
      profiles: profiles.map(toPublic),
    });
  } catch (error) {
    console.error('Failed to fetch profiles:', error);
    return NextResponse.json(
      { error: 'Failed to fetch profiles' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = createProfileSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const profile = await prisma.botProfile.create({
      data: parsed.data,
    });

    return NextResponse.json(toPublic(profile), { status: 201 });
  } catch (error) {
    console.error('Failed to create profile:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create profile' },
      { status: 500 },
    );
  }
}
