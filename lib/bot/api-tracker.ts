import 'server-only';

/**
 * Tracks API call counts for monitoring usage/cost.
 * In-memory counters reset on server restart.
 */

interface ApiUsageStats {
  gammaApiCalls: number;
  clobApiCalls: number;
  clobAuthCalls: number;
  totalCalls: number;
  startedAt: string;
}

const stats: ApiUsageStats = {
  gammaApiCalls: 0,
  clobApiCalls: 0,
  clobAuthCalls: 0,
  totalCalls: 0,
  startedAt: new Date().toISOString(),
};

export function trackGammaCall() {
  stats.gammaApiCalls++;
  stats.totalCalls++;
}

export function trackClobCall() {
  stats.clobApiCalls++;
  stats.totalCalls++;
}

export function trackClobAuthCall() {
  stats.clobAuthCalls++;
  stats.totalCalls++;
}

export function getApiUsageStats(): ApiUsageStats {
  return { ...stats };
}
