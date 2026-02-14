'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  Button,
  Chip,
  Divider,
  Select,
  SelectItem,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
} from '@heroui/react';
import { useProfileStore } from '@/store/useProfileStore';
import { useGlobalBotStore } from '@/store/useGlobalBotStore';
import type { BotLogEntry } from '@/lib/bot/types';
import Link from 'next/link';

const LEVEL_COLORS: Record<string, 'default' | 'primary' | 'warning' | 'danger' | 'success'> = {
  info: 'primary',
  warn: 'warning',
  error: 'danger',
  trade: 'success',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function BotControl() {
  const { profiles, fetchProfiles } = useProfileStore();
  const botStates = useGlobalBotStore((s) => s.states);
  const globalPoll = useGlobalBotStore((s) => s.poll);

  const [logs, setLogs] = useState<BotLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<string>('all');
  const [logsExpanded, setLogsExpanded] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (logFilter !== 'all') {
        params.set('profileId', logFilter);
      }
      const res = await fetch(`/api/bot/logs?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch logs');
      const data = await res.json();
      setLogs(data.logs || []);
    } catch {
      // Silent fail for logs
    }
  }, [logFilter]);

  useEffect(() => {
    fetchProfiles();
    fetchLogs();
  }, [fetchProfiles, fetchLogs]);

  // Refetch logs periodically while bots are running
  const hasRunning = Object.values(botStates).some((s) => s.status === 'running');

  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(fetchLogs, 5000);
    return () => clearInterval(id);
  }, [hasRunning, fetchLogs]);

  // Refetch logs when filter changes
  useEffect(() => {
    fetchLogs();
  }, [logFilter, fetchLogs]);

  const handleStartAll = async () => {
    setLoading(true);
    setError(null);
    const activeProfiles = profiles.filter((p) => p.isActive && p.hasPrivateKey && p.hasApiCredentials);
    for (const profile of activeProfiles) {
      const existing = botStates[profile.id];
      if (existing?.status === 'running') continue;
      try {
        const res = await fetch('/api/bot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start', profileId: profile.id }),
        });
        if (!res.ok) {
          const data = await res.json();
          setError(data.error || `Failed to start bot for ${profile.name}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    }
    await globalPoll();
    setLoading(false);
  };

  const handleStopAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stopAll' }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to stop all bots');
      }
      await globalPoll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
    setLoading(false);
  };

  const handleBotAction = async (profileId: string, action: 'start' | 'stop') => {
    setActionLoading(profileId);
    setError(null);
    try {
      const res = await fetch('/api/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, profileId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Failed to ${action} bot`);
      }
      await globalPoll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
    setActionLoading(null);
  };

  const runningCount = Object.values(botStates).filter((s) => s.status === 'running').length;
  const totalProfiles = profiles.length;
  const activeProfiles = profiles.filter((p) => p.isActive);

  // No profiles state
  if (profiles.length === 0) {
    return (
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">Bot Engine</h3>
        </CardHeader>
        <CardBody className="py-8 text-center">
          <svg
            className="w-10 h-10 mx-auto mb-3 text-gray-300 dark:text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
            />
          </svg>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
            No bot profiles configured yet.
          </p>
          <Link href="/settings">
            <Button size="sm" color="primary" variant="flat">
              Go to Settings
            </Button>
          </Link>
        </CardBody>
      </Card>
    );
  }

  // Build profile rows with their bot states
  const profileRows = profiles.map((profile) => {
    const state = botStates[profile.id];
    return { profile, state };
  });

  return (
    <Card>
      <CardHeader className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">Bot Engine</h3>
          <Chip
            size="sm"
            variant="dot"
            color={runningCount > 0 ? 'success' : 'default'}
          >
            {runningCount} / {totalProfiles} running
          </Chip>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            color="success"
            variant="flat"
            isLoading={loading}
            isDisabled={activeProfiles.length === 0}
            onPress={handleStartAll}
          >
            Start All Active
          </Button>
          <Button
            size="sm"
            color="danger"
            variant="flat"
            isLoading={loading}
            isDisabled={runningCount === 0}
            onPress={handleStopAll}
          >
            Stop All
          </Button>
        </div>
      </CardHeader>

      <CardBody className="pt-0 space-y-3">
        {error && (
          <p className="text-xs text-danger">{error}</p>
        )}

        {/* Profile bot status table */}
        <Table
          aria-label="Bot profile statuses"
          removeWrapper
          classNames={{
            th: 'text-xs',
            td: 'text-xs',
          }}
        >
          <TableHeader>
            <TableColumn>Profile</TableColumn>
            <TableColumn>Status</TableColumn>
            <TableColumn>Cycles</TableColumn>
            <TableColumn>Orders</TableColumn>
            <TableColumn>Last Scan</TableColumn>
            <TableColumn>Action</TableColumn>
          </TableHeader>
          <TableBody emptyContent="No profiles configured">
            {profileRows.map(({ profile, state }) => {
              const isRunning = state?.status === 'running';
              const isError = state?.status === 'error';
              return (
                <TableRow key={profile.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium text-gray-900 dark:text-white">
                        {profile.name}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {profile.strategy === 'value-betting' ? 'Value' : 'Sniper'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="sm"
                      variant="dot"
                      color={
                        isRunning
                          ? 'success'
                          : isError
                            ? 'danger'
                            : !profile.isActive
                              ? 'warning'
                              : 'default'
                      }
                    >
                      {!profile.isActive
                        ? 'inactive'
                        : state?.status || 'stopped'}
                    </Chip>
                  </TableCell>
                  <TableCell>{state?.cycleCount ?? 0}</TableCell>
                  <TableCell>{state?.ordersPlaced ?? 0}</TableCell>
                  <TableCell>
                    {state?.lastScanAt ? formatTime(state.lastScanAt) : '--'}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      color={isRunning ? 'danger' : 'success'}
                      variant="flat"
                      isLoading={actionLoading === profile.id}
                      isDisabled={
                        !profile.isActive ||
                        !profile.hasPrivateKey ||
                        !profile.hasApiCredentials
                      }
                      onPress={() =>
                        handleBotAction(profile.id, isRunning ? 'stop' : 'start')
                      }
                    >
                      {isRunning ? 'Stop' : 'Start'}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        <Divider />

        {/* Collapsible log feed */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <button
              className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              onClick={() => setLogsExpanded((v) => !v)}
            >
              <svg
                className={`w-3 h-3 transition-transform ${logsExpanded ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
              Recent Activity
            </button>
            <Select
              size="sm"
              variant="flat"
              aria-label="Filter logs by profile"
              className="w-40"
              items={[
                { key: 'all', label: 'All Profiles' },
                ...profiles.map((p) => ({ key: p.id, label: p.name })),
              ]}
              selectedKeys={[logFilter]}
              onSelectionChange={(keys) => {
                const selected = Array.from(keys)[0] as string;
                if (selected) setLogFilter(selected);
              }}
            >
              {(item) => <SelectItem key={item.key}>{item.label}</SelectItem>}
            </Select>
          </div>

          {logsExpanded && (
            <div className="max-h-[250px] overflow-y-auto space-y-1">
              {logs.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-4">No activity yet</p>
              ) : (
                [...logs].reverse().map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-start gap-2 text-xs py-1 border-b border-gray-100 dark:border-gray-800 last:border-0"
                  >
                    <span className="text-gray-400 shrink-0 w-16 font-mono">
                      {formatTime(entry.createdAt)}
                    </span>
                    {entry.profileName && (
                      <Chip size="sm" variant="flat" color="default" className="shrink-0">
                        {entry.profileName}
                      </Chip>
                    )}
                    <Chip
                      size="sm"
                      variant="flat"
                      color={LEVEL_COLORS[entry.level] || 'default'}
                      className="shrink-0"
                    >
                      {entry.event}
                    </Chip>
                    <span className="text-gray-700 dark:text-gray-300 break-words min-w-0">
                      {entry.message}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
