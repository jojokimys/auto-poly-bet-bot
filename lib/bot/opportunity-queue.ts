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

// ─── Queue ──────────────────────────────────────────────

const MAX_QUEUE_SIZE = 50;

const TIME_WINDOW_MS: Record<Opportunity['timeWindow'], number> = {
  urgent: 5 * 60 * 1000,    // 5 minutes
  minutes: 15 * 60 * 1000,  // 15 minutes
  hours: 60 * 60 * 1000,    // 1 hour
};

const queue: QueuedOpportunity[] = [];

/** Dedupe key: same conditionId + strategy = same opportunity */
function dedupeKey(opp: Opportunity): string {
  return `${opp.conditionId}:${opp.type}`;
}

// ─── Public API ─────────────────────────────────────────

export function addOpportunity(opp: Opportunity): QueuedOpportunity | null {
  // Expire stale entries first
  expireStale();

  // Check for duplicate (same conditionId + strategy type)
  const key = dedupeKey(opp);
  const existing = queue.find(
    (q) => dedupeKey(q.opportunity) === key && q.status === 'pending',
  );
  if (existing) return null;

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

  // FIFO: remove oldest if over limit
  while (queue.length > MAX_QUEUE_SIZE) {
    queue.shift();
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
  return entry;
}

export function rejectOpportunity(id: string): QueuedOpportunity | null {
  const entry = queue.find((q) => q.id === id);
  if (!entry || entry.status !== 'pending') return null;
  entry.status = 'rejected';
  return entry;
}

export function markAutoExecuted(id: string): QueuedOpportunity | null {
  const entry = queue.find((q) => q.id === id);
  if (!entry || entry.status !== 'pending') return null;
  entry.status = 'auto-executed';
  return entry;
}

export function expireStale(): number {
  const now = Date.now();
  let expired = 0;
  for (const entry of queue) {
    if (entry.status === 'pending' && now >= entry.expiresAt) {
      entry.status = 'expired';
      expired++;
    }
  }
  return expired;
}

export function clearQueue(): void {
  queue.length = 0;
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
