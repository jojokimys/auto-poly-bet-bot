import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { Wallet } from '@ethersproject/wallet';
import { getEnv, getBuilderConfig } from '@/lib/config/env';
import { prisma } from '@/lib/db/prisma';
import { clearProfileClient } from '@/lib/bot/profile-client';

const CHAIN_ID = 137;

const deriveKeysSchema = z.object({
  privateKey: z.string().optional(),
  funderAddress: z.string().optional(),
  profileId: z.string().optional(),
});

function toPublic(profile: {
  id: string;
  name: string;
  funderAddress: string;
  privateKey: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  builderApiKey: string;
  builderApiSecret: string;
  builderApiPassphrase: string;
  isActive: boolean;
  enabledStrategies: string;
  createdAt: Date;
}) {
  let strategies: string[];
  try {
    strategies = JSON.parse(profile.enabledStrategies);
  } catch {
    strategies = ['value-betting'];
  }
  return {
    id: profile.id,
    name: profile.name,
    funderAddress: profile.funderAddress,
    hasPrivateKey: !!profile.privateKey,
    hasApiCredentials: !!(profile.apiKey && profile.apiSecret && profile.apiPassphrase),
    hasBuilderCredentials: !!(profile.builderApiKey && profile.builderApiSecret && profile.builderApiPassphrase),
    isActive: profile.isActive,
    enabledStrategies: strategies,
    createdAt: profile.createdAt.toISOString(),
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = deriveKeysSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { profileId, funderAddress: inputFunder } = parsed.data;
    let { privateKey } = parsed.data;
    let funderAddress = inputFunder ?? '';

    // If profileId provided but no privateKey, load from DB
    if (profileId && !privateKey) {
      const existing = await prisma.botProfile.findUnique({ where: { id: profileId } });
      if (!existing) {
        return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
      }
      if (!existing.privateKey) {
        return NextResponse.json(
          { error: 'No private key stored for this profile. Enter one to derive API keys.' },
          { status: 400 },
        );
      }
      privateKey = existing.privateKey;
      if (!inputFunder) funderAddress = existing.funderAddress;
    }

    if (!privateKey) {
      return NextResponse.json(
        { error: 'Private key is required to derive API keys' },
        { status: 400 },
      );
    }

    const env = getEnv();

    // Validate private key format
    let wallet: InstanceType<typeof Wallet>;
    try {
      wallet = new Wallet(privateKey);
    } catch {
      return NextResponse.json(
        { error: 'Invalid private key format. Must be a hex string (with or without 0x prefix).' },
        { status: 400 },
      );
    }

    const sigType = funderAddress
      ? SignatureType.POLY_PROXY
      : SignatureType.EOA;

    const client = new ClobClient(
      env.CLOB_API_URL,
      CHAIN_ID,
      wallet,
      undefined,
      sigType,
      funderAddress || undefined,
      undefined,          // geoBlockToken
      undefined,          // useServerTime
      getBuilderConfig(), // builderConfig
    );

    const creds = await client.createOrDeriveApiKey();

    // If profileId provided, persist derived keys to the profile
    if (profileId) {
      const updateData: Record<string, string> = {
        apiKey: creds.key,
        apiSecret: creds.secret,
        apiPassphrase: creds.passphrase,
      };
      // Also save privateKey/funderAddress if user provided new ones
      if (parsed.data.privateKey) updateData.privateKey = parsed.data.privateKey;
      if (inputFunder !== undefined) updateData.funderAddress = funderAddress;

      const updated = await prisma.botProfile.update({
        where: { id: profileId },
        data: updateData,
      });

      // Clear cached client so next bot cycle picks up new creds
      clearProfileClient(profileId);

      return NextResponse.json({
        apiKey: creds.key,
        apiSecret: creds.secret,
        apiPassphrase: creds.passphrase,
        walletAddress: wallet.address,
        profile: toPublic(updated),
      });
    }

    return NextResponse.json({
      apiKey: creds.key,
      apiSecret: creds.secret,
      apiPassphrase: creds.passphrase,
      walletAddress: wallet.address,
    });
  } catch (error) {
    console.error('Failed to derive API keys:', error);

    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('could not find')) {
      return NextResponse.json(
        { error: 'Wallet not found on Polymarket. Make sure the wallet has deposited USDC on Polymarket first.' },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: `Failed to derive API keys: ${message}` },
      { status: 500 },
    );
  }
}
