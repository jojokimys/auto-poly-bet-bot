/**
 * Market Scanner Bot — standalone CLI script
 *
 * Fetches active markets from Gamma API, scores them by various criteria,
 * and outputs the top opportunities.
 *
 * Usage:
 *   npx tsx scripts/market-scanner.ts [--save] [--limit 50]
 */

const GAMMA_API_URL = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';

interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  liquidity: string;
  volume: string;
  active: boolean;
  closed: boolean;
  outcomes: string;
  outcomePrices: string;
  volume24hr?: string;
  spread?: string;
}

interface ScoredMarket {
  question: string;
  conditionId: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  volume24hr: number;
  liquidity: number;
  spread: number;
  dislocation: number;
  hoursToExpiry: number;
  score: number;
}

async function fetchActiveMarkets(limit: number): Promise<GammaMarket[]> {
  const url = `${GAMMA_API_URL}/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);
  return res.json();
}

function scoreMarket(gm: GammaMarket): ScoredMarket | null {
  const volume = parseFloat(gm.volume) || 0;
  const volume24hr = parseFloat(gm.volume24hr || '0');
  const liquidity = parseFloat(gm.liquidity) || 0;
  const spread = parseFloat(gm.spread || '0');

  let yesPrice = 0;
  let noPrice = 0;
  try {
    const prices: number[] = JSON.parse(gm.outcomePrices || '[]');
    yesPrice = prices[0] || 0;
    noPrice = prices[1] || 0;
  } catch {
    return null;
  }

  if (yesPrice === 0 && noPrice === 0) return null;

  // Dislocation: how far from 50/50 — markets near edges are more "decided"
  const dislocation = Math.abs(yesPrice - 0.5);

  // Time to expiry
  const endDate = new Date(gm.endDate);
  const hoursToExpiry = Math.max(0, (endDate.getTime() - Date.now()) / (1000 * 60 * 60));

  // Scoring formula (higher = better opportunity):
  // - High volume24hr indicates active interest
  // - High liquidity means tradeable
  // - Low spread means tight market
  // - Moderate dislocation (0.1-0.3) means there's a lean but not decided
  // - Reasonable time to expiry (not about to close)

  let score = 0;

  // Volume score (log scale, 0-30 pts)
  score += Math.min(30, Math.log10(Math.max(1, volume24hr)) * 6);

  // Liquidity score (0-20 pts)
  score += Math.min(20, Math.log10(Math.max(1, liquidity)) * 4);

  // Spread score (tighter = better, 0-20 pts)
  const spreadPenalty = Math.min(20, spread * 200);
  score += 20 - spreadPenalty;

  // Dislocation score (moderate dislocation preferred, 0-15 pts)
  if (dislocation >= 0.05 && dislocation <= 0.35) {
    score += 15 * (1 - Math.abs(dislocation - 0.2) / 0.2);
  }

  // Time decay score (too close or too far is bad, 0-15 pts)
  if (hoursToExpiry > 24 && hoursToExpiry < 720) {
    score += 15;
  } else if (hoursToExpiry > 6 && hoursToExpiry <= 24) {
    score += 10;
  } else if (hoursToExpiry >= 720 && hoursToExpiry < 2160) {
    score += 8;
  }

  return {
    question: gm.question,
    conditionId: gm.conditionId,
    yesPrice,
    noPrice,
    volume,
    volume24hr,
    liquidity,
    spread,
    dislocation,
    hoursToExpiry,
    score,
  };
}

function formatRow(m: ScoredMarket, rank: number): string {
  const question = m.question.length > 60 ? m.question.slice(0, 57) + '...' : m.question;
  const vol24h = m.volume24hr >= 1000 ? `$${(m.volume24hr / 1000).toFixed(1)}K` : `$${m.volume24hr.toFixed(0)}`;
  const liq = m.liquidity >= 1000 ? `$${(m.liquidity / 1000).toFixed(1)}K` : `$${m.liquidity.toFixed(0)}`;
  const expiry = m.hoursToExpiry > 48 ? `${(m.hoursToExpiry / 24).toFixed(0)}d` : `${m.hoursToExpiry.toFixed(0)}h`;

  return `${String(rank).padStart(3)} | ${question.padEnd(62)} | Yes:${(m.yesPrice * 100).toFixed(0).padStart(3)}¢ No:${(m.noPrice * 100).toFixed(0).padStart(3)}¢ | Vol24h:${vol24h.padStart(8)} | Liq:${liq.padStart(8)} | Exp:${expiry.padStart(5)} | Score:${m.score.toFixed(1).padStart(5)}`;
}

async function main() {
  const args = process.argv.slice(2);
  const shouldSave = args.includes('--save');
  const limitIndex = args.indexOf('--limit');
  const fetchLimit = limitIndex >= 0 ? parseInt(args[limitIndex + 1]) || 100 : 100;
  const displayLimit = 20;

  console.log('='.repeat(120));
  console.log(`  POLYMARKET MARKET SCANNER — ${new Date().toISOString()}`);
  console.log(`  Fetching top ${fetchLimit} markets from Gamma API...`);
  console.log('='.repeat(120));

  const markets = await fetchActiveMarkets(fetchLimit);
  console.log(`  Fetched ${markets.length} active markets\n`);

  const scored = markets
    .map(scoreMarket)
    .filter((m): m is ScoredMarket => m !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, displayLimit);

  console.log(`  TOP ${displayLimit} MARKET OPPORTUNITIES`);
  console.log('-'.repeat(120));

  for (let i = 0; i < scored.length; i++) {
    console.log(formatRow(scored[i], i + 1));
  }

  console.log('-'.repeat(120));
  console.log(`  Scanned ${markets.length} markets, showing top ${scored.length} by opportunity score.`);

  if (shouldSave) {
    const fs = await import('fs');
    const outPath = `scanner-results-${Date.now()}.json`;
    fs.writeFileSync(outPath, JSON.stringify(scored, null, 2));
    console.log(`  Results saved to ${outPath}`);
  }

  console.log('='.repeat(120));
}

main().catch((err) => {
  console.error('Scanner failed:', err);
  process.exit(1);
});
