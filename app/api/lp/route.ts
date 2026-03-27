import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);

  // GET /api/lp?balance=true&profileId=xxx — fetch balance without starting engine
  if (url.searchParams.get('balance') === 'true') {
    const pid = url.searchParams.get('profileId');
    if (!pid) return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    try {
      const { loadProfile, getProfileBalance } = await import('@/lib/bot/profile-client');
      const profile = await loadProfile(pid);
      if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
      const balance = await getProfileBalance(profile);
      return NextResponse.json({ balance, profileName: profile.name });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // GET /api/lp?earnings=true&profileId=xxx — fetch daily earnings
  if (url.searchParams.get('earnings') === 'true') {
    const pid = url.searchParams.get('profileId');
    if (!pid) return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    try {
      const { loadProfile, getClientForProfile } = await import('@/lib/bot/profile-client');
      const profile = await loadProfile(pid);
      if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
      const client = getClientForProfile(profile);
      const today = new Date().toISOString().slice(0, 10);
      const [earnings, totalEarnings, marketsConfig] = await Promise.all([
        client.getEarningsForUserForDay(today),
        client.getTotalEarningsForUserForDay(today),
        client.getUserEarningsAndMarketsConfig(today),
      ]);
      return NextResponse.json({ earnings, totalEarnings, marketsConfig, date: today });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // GET /api/lp?positions=true&profileId=xxx — fetch all open positions
  if (url.searchParams.get('positions') === 'true') {
    const pid = url.searchParams.get('profileId') ?? 'cmlmpyou700bn0y09gh4fem6y';
    try {
      const { loadProfile, getProfilePositions } = await import('@/lib/bot/profile-client');
      const profile = await loadProfile(pid);
      if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
      const positions = await getProfilePositions(profile);
      return NextResponse.json({ positions, profileName: profile.name });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // GET /api/lp?bots=true — get all active bot statuses + logs
  if (url.searchParams.get('bots') === 'true') {
    const { getBotManager } = await import('@/lib/lp/market-bot');
    const mgr = getBotManager();
    const limit = parseInt(url.searchParams.get('limit') ?? '200', 10);
    return NextResponse.json({
      bots: mgr.getAllStatuses(),
      logs: mgr.getAllLogs(limit),
    });
  }

  // GET /api/lp?scan=true — scan all reward markets (no engine filters applied)
  if (url.searchParams.get('scan') === 'true') {
    try {
      const { scanRewardMarkets } = await import('@/lib/lp/scanner');
      const { rankMarketsByEfficiency } = await import('@/lib/lp/scoring');
      const { checkWall } = await import('@/lib/lp/engine');
      const { getReadClient } = await import('@/lib/polymarket/client');
      const allMarkets = await scanRewardMarkets();
      const capitalPerMarket = parseInt(url.searchParams.get('capital') ?? '50', 10);
      const topN = parseInt(url.searchParams.get('topN') ?? '100', 10);
      const minWall = parseInt(url.searchParams.get('wall') ?? '100', 10);

      // No expiry/midpoint/liquidity filter for scan — show everything with rewards
      // Sort by daily rate descending so high-reward markets are always included
      const withRates = allMarkets
        .filter((m) => m.rewardsDailyRate > 0)
        .sort((a, b) => b.rewardsDailyRate - a.rewardsDailyRate)
        .slice(0, topN * 3);

      // Wall check top candidates
      const client = getReadClient();
      const results: Array<{
        market: typeof allMarkets[0];
        wallYes: number;
        wallNo: number;
        yesDistCents: number;
        noDistCents: number;
      }> = [];

      for (const market of withRates) {
        if (results.length >= topN) break;

        try {
          const yesBook = await client.getOrderBook(market.clobTokenIds[0]);
          const yesWall = checkWall(yesBook.bids ?? [], market.midpoint, market.rewardsMaxSpread, minWall);

          const noBook = await client.getOrderBook(market.clobTokenIds[1]);
          const noMid = 1 - market.midpoint;
          const noWall = checkWall(noBook.bids ?? [], noMid, market.rewardsMaxSpread, minWall);

          results.push({
            market,
            wallYes: yesWall?.wallSize ?? 0,
            wallNo: noWall?.wallSize ?? 0,
            yesDistCents: yesWall ? (market.midpoint - yesWall.price) * 100 : -1,
            noDistCents: noWall ? (noMid - noWall.price) * 100 : -1,
          });
        } catch {
          // Still include market without wall data
          results.push({ market, wallYes: 0, wallNo: 0, yesDistCents: -1, noDistCents: -1 });
        }
      }

      // Sort by daily rate descending for display
      results.sort((a, b) => b.market.rewardsDailyRate - a.market.rewardsDailyRate);

      const daysToExpiry = (m: typeof allMarkets[0]) =>
        Math.max(0, (new Date(m.endDate).getTime() - Date.now()) / 86400000);

      return NextResponse.json({
        totalRewardMarkets: allMarkets.length,
        withRewards: allMarkets.filter((m) => m.rewardsDailyRate > 0).length,
        displayed: results.length,
        ranked: results.map((r) => {
          const m = r.market;
          const comp = m.competitiveness > 0 ? m.competitiveness : m.liquidity;
          const estDailyReward = comp > 0 ? m.rewardsDailyRate * capitalPerMarket / (capitalPerMarket + comp) : 0;

          return {
            id: m.id,
            question: m.question,
            slug: m.slug,
            midpoint: m.midpoint,
            spread: m.spread,
            liquidity: m.liquidity,
            volume24hr: m.volume24hr,
            rewardsMaxSpread: m.rewardsMaxSpread,
            rewardsMinSize: m.rewardsMinSize,
            rewardsDailyRate: m.rewardsDailyRate,
            qScorePerDollar: 0,
            qScore: 0,
            rewardRatio: comp > 0 ? m.rewardsDailyRate / comp : 0,
            bestBid: m.bestBid,
            bestAsk: m.bestAsk,
            eventTitle: m.eventTitle,
            outcomes: m.outcomes,
            outcomePrices: m.outcomePrices,
            clobTokenIds: m.clobTokenIds,
            conditionId: m.conditionId,
            endDate: m.endDate,
            negRisk: m.negRisk,
            competitiveness: m.competitiveness,
            estDailyReward,
            minCapital: m.rewardsMinSize,
            roiAtMin: comp > 0 ? (m.rewardsDailyRate / comp) * 100 : 0,
            roiAtConfig: 0,
            wallYes: r.wallYes,
            wallNo: r.wallNo,
            yesDistCents: r.yesDistCents,
            noDistCents: r.noDistCents,
            daysToExpiry: daysToExpiry(m),
          };
        }),
      });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // Default: engine + bot statuses
  const { getBotManager } = await import('@/lib/lp/market-bot');
  const { getLpEngine } = await import('@/lib/lp/engine');
  const engine = getLpEngine();
  return NextResponse.json({
    engine: engine.getStatus(),
    engineLogs: engine.getLogs(200),
    bots: getBotManager().getAllStatuses(),
  });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { action } = body;

  // ── Auto Engine start/stop ──
  if (action === 'start') {
    const { profileId, maxMarkets, allowTightSpread } = body;
    if (!profileId) return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    try {
      const { getLpEngine } = await import('@/lib/lp/engine');
      const engine = getLpEngine();
      const configUpdates: Record<string, any> = {};
      if (maxMarkets != null) configUpdates.maxMarkets = Number(maxMarkets);
      if (allowTightSpread != null) configUpdates.allowTightSpread = Boolean(allowTightSpread);
      if (Object.keys(configUpdates).length > 0) engine.updateConfig(configUpdates);
      await engine.start(profileId);
      return NextResponse.json({ ok: true, status: engine.getStatus() });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  if (action === 'stop') {
    try {
      const { getLpEngine } = await import('@/lib/lp/engine');
      const engine = getLpEngine();
      await engine.stop();
      return NextResponse.json({ ok: true });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // ── Engine status ──
  if (action === 'status') {
    try {
      const { getLpEngine } = await import('@/lib/lp/engine');
      const engine = getLpEngine();
      return NextResponse.json({
        engine: engine.getStatus(),
        logs: engine.getLogs(200),
      });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // Per-market bot start
  if (action === 'start-bot') {
    const { marketData, profileId, capital } = body;
    if (!marketData || !profileId || !capital) {
      return NextResponse.json({ error: 'marketData, profileId, capital required' }, { status: 400 });
    }
    try {
      const { getBotManager } = await import('@/lib/lp/market-bot');
      const mgr = getBotManager();
      // Convert scan row back to RewardMarket shape
      const market = {
        id: marketData.id,
        question: marketData.question,
        conditionId: marketData.conditionId,
        slug: marketData.slug,
        endDate: marketData.endDate,
        liquidity: marketData.liquidity,
        volume: marketData.volume24hr ?? 0,
        volume24hr: marketData.volume24hr ?? 0,
        spread: marketData.spread ?? 0,
        bestBid: marketData.bestBid ?? 0,
        bestAsk: marketData.bestAsk ?? 1,
        midpoint: marketData.midpoint,
        outcomes: marketData.outcomes ?? ['Yes', 'No'],
        outcomePrices: marketData.outcomePrices ?? [marketData.midpoint, 1 - marketData.midpoint],
        clobTokenIds: marketData.clobTokenIds,
        rewardsMinSize: marketData.rewardsMinSize,
        rewardsMaxSpread: marketData.rewardsMaxSpread,
        rewardsDailyRate: marketData.rewardsDailyRate ?? 0,
        competitiveness: marketData.competitiveness ?? 0,
        negRisk: marketData.negRisk ?? false,
      };
      const status = await mgr.startBot(market, profileId, capital);
      return NextResponse.json({ ok: true, status });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // Per-market bot stop
  if (action === 'stop-bot') {
    const { marketId } = body;
    if (!marketId) return NextResponse.json({ error: 'marketId required' }, { status: 400 });
    try {
      const { getBotManager } = await import('@/lib/lp/market-bot');
      await getBotManager().stopBot(marketId);
      return NextResponse.json({ ok: true });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // Manual sell single position
  if (action === 'sell') {
    const { tokenId, price, size, profileId: pid } = body;
    if (!tokenId || !price || !size) {
      return NextResponse.json({ error: 'tokenId, price, size required' }, { status: 400 });
    }
    const targetPid = pid ?? 'cmlmpyou700bn0y09gh4fem6y';
    try {
      const { loadProfile, placeProfileOrder } = await import('@/lib/bot/profile-client');
      const profile = await loadProfile(targetPid);
      if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
      const result = await placeProfileOrder(profile, {
        tokenId,
        side: 'SELL',
        price: Number(price),
        size: Number(size),
        postOnly: false,
      });
      return NextResponse.json({ ok: true, result });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // Sell all open positions at best bid
  if (action === 'sell-all') {
    const targetPid = body.profileId ?? 'cmlmpyou700bn0y09gh4fem6y';
    try {
      const { loadProfile, getProfilePositions, placeProfileOrder } = await import('@/lib/bot/profile-client');
      const { getReadClient } = await import('@/lib/polymarket/client');
      const profile = await loadProfile(targetPid);
      if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

      const positions = await getProfilePositions(profile);
      if (positions.length === 0) return NextResponse.json({ ok: true, message: 'No positions to sell', results: [] });

      const client = getReadClient();
      const results: Array<{ title: string; outcome: string; size: number; price: number; received: number; error?: string }> = [];

      for (const pos of positions) {
        if (pos.redeemable) {
          results.push({ title: pos.title, outcome: pos.outcome, size: pos.size, price: 0, received: 0, error: 'redeemable — use redeem instead' });
          continue;
        }
        try {
          // Get best bid from orderbook
          const book = await client.getOrderBook(pos.asset);
          const bids = (book.bids ?? [])
            .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
            .filter((b: any) => b.size > 0)
            .sort((a: any, b: any) => b.price - a.price);

          if (bids.length === 0) {
            results.push({ title: pos.title, outcome: pos.outcome, size: pos.size, price: 0, received: 0, error: 'no bids in orderbook' });
            continue;
          }

          const bestBid = bids[0].price;
          const result = await placeProfileOrder(profile, {
            tokenId: pos.asset,
            side: 'SELL',
            price: bestBid,
            size: pos.size,
            postOnly: false,
          });
          const received = parseFloat((result as any)?.takingAmount ?? '0');
          results.push({ title: pos.title, outcome: pos.outcome, size: pos.size, price: bestBid, received });
        } catch (err: any) {
          results.push({ title: pos.title, outcome: pos.outcome, size: pos.size, price: 0, received: 0, error: err.message });
        }
      }

      const totalReceived = results.reduce((s, r) => s + r.received, 0);
      return NextResponse.json({ ok: true, totalReceived, results });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
