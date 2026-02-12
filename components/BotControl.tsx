'use client';

import { useEffect, useRef } from 'react';
import { Card, CardBody, CardHeader, Button, Chip, Divider } from '@heroui/react';
import { useBotStore } from '@/store/useBotStore';

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
  const { state: botState, logs, loading, error, fetchState, fetchLogs, startBot, stopBot } =
    useBotStore();

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchState();
    fetchLogs();
  }, [fetchState, fetchLogs]);

  // Poll while running
  useEffect(() => {
    if (botState.status === 'running') {
      pollRef.current = setInterval(() => {
        fetchState();
        fetchLogs();
      }, 5000);
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [botState.status, fetchState, fetchLogs]);

  const isRunning = botState.status === 'running';

  return (
    <Card>
      <CardHeader className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">Bot Engine</h3>
          <Chip
            size="sm"
            variant="dot"
            color={isRunning ? 'success' : botState.status === 'error' ? 'danger' : 'default'}
          >
            {botState.status}
          </Chip>
        </div>
        <Button
          size="sm"
          color={isRunning ? 'danger' : 'success'}
          variant={isRunning ? 'flat' : 'solid'}
          isLoading={loading}
          onPress={isRunning ? stopBot : startBot}
        >
          {isRunning ? 'Stop Bot' : 'Start Bot'}
        </Button>
      </CardHeader>

      <CardBody className="pt-0 space-y-3">
        {error && (
          <p className="text-xs text-danger">{error}</p>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div>
            <span className="text-gray-500 dark:text-gray-400">Cycles</span>
            <p className="font-semibold">{botState.cycleCount}</p>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">Opportunities</span>
            <p className="font-semibold">{botState.opportunitiesFound}</p>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">Orders Placed</span>
            <p className="font-semibold">{botState.ordersPlaced}</p>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">Last Scan</span>
            <p className="font-semibold">
              {botState.lastScanAt ? formatTime(botState.lastScanAt) : '--'}
            </p>
          </div>
        </div>

        <Divider />

        {/* Log feed */}
        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            Recent Activity
          </p>
          <div className="max-h-[200px] overflow-y-auto space-y-1">
            {logs.length === 0 ? (
              <p className="text-xs text-gray-400">No activity yet</p>
            ) : (
              [...logs].reverse().map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 text-xs py-1 border-b border-gray-100 dark:border-gray-800 last:border-0"
                >
                  <span className="text-gray-400 shrink-0 w-16 font-mono">
                    {formatTime(entry.createdAt)}
                  </span>
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
        </div>
      </CardBody>
    </Card>
  );
}
