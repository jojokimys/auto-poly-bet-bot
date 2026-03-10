import { NextResponse } from 'next/server';
import {
  EdgeEngine,
  getActiveEngine,
  setActiveEngine,
  type EngineConfig,
} from '@/lib/edge/engine';
import { getTradeStats, getConfidenceBuckets, getRecentTrades } from '@/lib/edge/trade-logger';
import { fetchClaimablePositions, redeemPositionsRPC, type RedeemProfile } from '@/lib/polymarket/redeem';
import { loadProfile } from '@/lib/bot/profile-client';

/**
 * GET /api/edge — Engine status + trade analytics
 *
 * Query params:
 *   ?stats=true — include trade stats
 *   ?strategy=latency-arb|expiry-sniper — filter stats by strategy
 *   ?hours=24 — lookback window
 *   ?buckets=true — include confidence bucket breakdown
 *   ?trades=true&limit=50 — recent trade entries
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const engine = getActiveEngine();

  const result: Record<string, unknown> = {
    engine: engine ? engine.getStatus() : { running: false },
  };

  const profileId = url.searchParams.get('profileId');
  const strategy = url.searchParams.get('strategy') as 'latency-arb' | 'expiry-sniper' | null;
  const hours = parseInt(url.searchParams.get('hours') ?? '24');

  if (profileId && url.searchParams.has('stats')) {
    if (strategy) {
      result.stats = await getTradeStats(profileId, strategy, hours);
    } else {
      const [arb, sniper] = await Promise.all([
        getTradeStats(profileId, 'latency-arb', hours),
        getTradeStats(profileId, 'expiry-sniper', hours),
      ]);
      result.stats = { 'latency-arb': arb, 'expiry-sniper': sniper };
    }
  }

  if (profileId && url.searchParams.has('buckets') && strategy) {
    result.confidenceBuckets = await getConfidenceBuckets(profileId, strategy, hours);
  }

  if (profileId && url.searchParams.has('trades')) {
    const limit = parseInt(url.searchParams.get('limit') ?? '50');
    result.recentTrades = await getRecentTrades(profileId, strategy ?? undefined, limit);
  }

  return NextResponse.json(result);
}

/**
 * POST /api/edge — Start/stop engine
 *
 * Body:
 *   { action: "start", profileId, config? }
 *   { action: "stop" }
 *   { action: "settlement", conditionId, finalPrice, refPrice }
 */
export async function POST(req: Request) {
  const body = await req.json();
  const { action } = body;

  if (action === 'start') {
    const { profileId, config } = body as {
      profileId: string;
      config?: Partial<EngineConfig>;
    };

    if (!profileId) {
      return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    }

    const existing = getActiveEngine();
    if (existing?.isRunning()) {
      existing.stop();
    }

    const engine = new EdgeEngine({
      profileId,
      ...config,
    });

    setActiveEngine(engine);
    await engine.start();

    return NextResponse.json({ status: 'started', engine: engine.getStatus() });
  }

  if (action === 'stop') {
    const engine = getActiveEngine();
    if (engine) {
      engine.stop();
      setActiveEngine(null);
    }
    return NextResponse.json({ status: 'stopped' });
  }

  if (action === 'settlement') {
    const { conditionId, finalPrice, refPrice } = body;
    const engine = getActiveEngine();
    if (engine) {
      await engine.recordSettlement(conditionId, finalPrice, refPrice);
    }
    return NextResponse.json({ status: 'recorded' });
  }

  if (action === 'redeem') {
    const { profileId } = body;
    if (!profileId) return NextResponse.json({ error: 'profileId required' }, { status: 400 });

    const profile = await loadProfile(profileId);
    if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

    const claimable = await fetchClaimablePositions(profile.funderAddress);
    if (claimable.length === 0) return NextResponse.json({ status: 'nothing to redeem', count: 0 });

    const redeemProfile: RedeemProfile = {
      privateKey: profile.privateKey,
      funderAddress: profile.funderAddress,
      signatureType: profile.signatureType,
      apiKey: profile.apiKey,
      apiSecret: profile.apiSecret,
      apiPassphrase: profile.apiPassphrase,
      builderApiKey: profile.builderApiKey,
      builderApiSecret: profile.builderApiSecret,
      builderApiPassphrase: profile.builderApiPassphrase,
    };

    const results = [];
    for (const pos of claimable) {
      try {
        const r = await redeemPositionsRPC(
          redeemProfile,
          pos.conditionId,
          pos.negativeRisk,
          pos.asset,
          pos.oppositeAsset,
        );
        results.push({ title: pos.title, size: pos.size, ...r });
        if (r.success) console.log(`[redeem] ${pos.title} — $${pos.size.toFixed(2)} redeemed`);
      } catch (err) {
        results.push({ title: pos.title, size: pos.size, success: false, error: (err as Error).message });
      }
    }

    const redeemed = results.filter(r => r.success).length;
    return NextResponse.json({ status: 'done', total: claimable.length, redeemed, results });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
