import 'server-only';

import type { Opportunity } from '@/lib/skills/types';

// ─── Types ──────────────────────────────────────────────

export interface QueuedOpportunity {
  id: string;
  opportunity: Opportunity;
  strategy: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'auto-executed';
  createdAt: number;
  expiresAt: number;
  autoExecutable: boolean;
}

// ─── Queue (globalThis to survive Next.js HMR) ─────────

const MAX_QUEUE_SIZE = 50;

const TIME_WINDOW_MS: Record<Opportunity['timeWindow'], number> = {
  urgent: 5 * 60 * 1000,    // 5 minutes
  minutes: 15 * 60 * 1000,  // 15 minutes
  hours: 60 * 60 * 1000,    // 1 hour
};

const EXECUTED_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown after execution

const globalForQueue = globalThis as unknown as {
  __opportunityQueue: QueuedOpportunity[];
  __opportunityPendingKeys: Set<string>;
  __executedCooldowns: Map<string, number>;
};
globalForQueue.__opportunityQueue ??= [];
globalForQueue.__opportunityPendingKeys ??= new Set<string>();
globalForQueue.__executedCooldowns ??= new Map<string, number>();

const queue = globalForQueue.__opportunityQueue;
const pendingKeys = globalForQueue.__opportunityPendingKeys;
const executedCooldowns = globalForQueue.__executedCooldowns;

/** Dedupe key: same conditionId + strategy = same opportunity */
function dedupeKey(opp: Opportunity): string {
  return `${opp.conditionId}:${opp.type}`;
}

/** Cooldown key: conditionId only — block ALL strategies on same market after execution */
function cooldownKey(opp: Opportunity): string {
  return opp.conditionId;
}

// ─── Public API ─────────────────────────────────────────

export function addOpportunity(opp: Opportunity): QueuedOpportunity | null {
  // Expire stale entries first
  expireStale();

  // Check for duplicate (same conditionId + strategy type)
  const key = dedupeKey(opp);
  if (pendingKeys.has(key)) return null;

  // Check cooldown — block re-entry on same market after recent execution
  const cdKey = cooldownKey(opp);
  const cdExpiry = executedCooldowns.get(cdKey);
  if (cdExpiry && Date.now() < cdExpiry) return null;

  const now = Date.now();
  const ttl = TIME_WINDOW_MS[opp.timeWindow] ?? TIME_WINDOW_MS.hours;

  const entry: QueuedOpportunity = {
    id: crypto.randomUUID(),
    opportunity: opp,
    strategy: opp.type,
    status: 'pending',
    createdAt: now,
    expiresAt: now + ttl,
    autoExecutable: opp.autoExecutable,
  };

  queue.push(entry);
  pendingKeys.add(key);

  // FIFO: remove oldest if over limit
  while (queue.length > MAX_QUEUE_SIZE) {
    const removed = queue.shift();
    if (removed && removed.status === 'pending') {
      pendingKeys.delete(dedupeKey(removed.opportunity));
    }
  }

  return entry;
}

export function getPendingOpportunities(): QueuedOpportunity[] {
  expireStale();
  return queue.filter((q) => q.status === 'pending');
}

export function getAutoExecutableOpportunities(): QueuedOpportunity[] {
  expireStale();
  return queue.filter((q) => q.status === 'pending' && q.autoExecutable);
}

export function approveOpportunity(id: string): QueuedOpportunity | null {
  const entry = queue.find((q) => q.id === id);
  if (!entry || entry.status !== 'pending') return null;
  entry.status = 'approved';
  pendingKeys.delete(dedupeKey(entry.opportunity));
  // Cooldown: prevent same market re-entry
  executedCooldowns.set(cooldownKey(entry.opportunity), Date.now() + EXECUTED_COOLDOWN_MS);
  return entry;
}

export function rejectOpportunity(id: string): QueuedOpportunity | null {
  const entry = queue.find((q) => q.id === id);
  if (!entry || entry.status !== 'pending') return null;
  entry.status = 'rejected';
  pendingKeys.delete(dedupeKey(entry.opportunity));
  return entry;
}

export function markAutoExecuted(id: string): QueuedOpportunity | null {
  const entry = queue.find((q) => q.id === id);
  if (!entry || entry.status !== 'pending') return null;
  entry.status = 'auto-executed';
  pendingKeys.delete(dedupeKey(entry.opportunity));
  // Cooldown: prevent same market re-entry
  executedCooldowns.set(cooldownKey(entry.opportunity), Date.now() + EXECUTED_COOLDOWN_MS);
  return entry;
}

export function expireStale(): number {
  const now = Date.now();
  let expired = 0;

  // Clean expired cooldowns
  for (const [key, expiry] of executedCooldowns) {
    if (now >= expiry) executedCooldowns.delete(key);
  }

  for (const entry of queue) {
    if (entry.status === 'pending' && now >= entry.expiresAt) {
      entry.status = 'expired';
      pendingKeys.delete(dedupeKey(entry.opportunity));
      expired++;
    }
  }
  return expired;
}

export function clearQueue(): void {
  queue.length = 0;
  pendingKeys.clear();
  executedCooldowns.clear();
}

export function getQueueStats() {
  expireStale();
  let pending = 0, approved = 0, rejected = 0, expired = 0, autoExecuted = 0;
  for (const q of queue) {
    switch (q.status) {
      case 'pending': pending++; break;
      case 'approved': approved++; break;
      case 'rejected': rejected++; break;
      case 'expired': expired++; break;
      case 'auto-executed': autoExecuted++; break;
    }
  }
  return { total: queue.length, pending, approved, rejected, expired, autoExecuted };
}
