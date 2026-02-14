'use client';

import { useEffect } from 'react';
import { Chip, Tooltip } from '@heroui/react';
import { useGlobalBotStore } from '@/store/useGlobalBotStore';
import { toast } from 'sonner';

export function HeaderBotStatus() {
  const { states, apiUsage, newLogs, clearNewLogs, startPolling } =
    useGlobalBotStore();

  // Start global polling on mount
  useEffect(() => {
    startPolling();
  }, [startPolling]);

  // Show toasts for new notable logs
  useEffect(() => {
    if (newLogs.length === 0) return;

    for (const log of newLogs) {
      if (log.level === 'trade') {
        toast.success(log.message, {
          description: log.event === 'order' ? 'Order executed' : log.event,
          duration: 5000,
        });
      } else if (log.level === 'error') {
        toast.error(log.message, {
          description: log.event,
          duration: 8000,
        });
      } else if (log.level === 'warn') {
        toast.warning(log.message, {
          description: log.event,
          duration: 5000,
        });
      }
    }

    clearNewLogs();
  }, [newLogs, clearNewLogs]);

  const stateValues = Object.values(states);
  const runningCount = stateValues.filter((s) => s.status === 'running').length;
  const totalOrders = stateValues.reduce((sum, s) => sum + s.ordersPlaced, 0);
  const totalCycles = stateValues.reduce((sum, s) => sum + s.cycleCount, 0);

  if (runningCount === 0 && stateValues.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      {/* Bot running indicator */}
      <Tooltip
        content={
          <div className="text-xs p-1 space-y-1">
            <p>Cycles: {totalCycles}</p>
            <p>Orders: {totalOrders}</p>
            {apiUsage && (
              <>
                <p className="pt-1 border-t border-gray-600">
                  API Calls: {apiUsage.totalCalls}
                </p>
                <p>Gamma: {apiUsage.gammaApiCalls}</p>
                <p>CLOB: {apiUsage.clobApiCalls + apiUsage.clobAuthCalls}</p>
              </>
            )}
          </div>
        }
      >
        <Chip
          size="sm"
          variant="dot"
          color={runningCount > 0 ? 'success' : 'default'}
          className="cursor-default"
        >
          {runningCount > 0 ? (
            <span className="flex items-center gap-1">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              {runningCount} bot{runningCount > 1 ? 's' : ''}
            </span>
          ) : (
            'Idle'
          )}
        </Chip>
      </Tooltip>

      {/* API usage pill */}
      {apiUsage && apiUsage.totalCalls > 0 && (
        <Tooltip
          content={
            <div className="text-xs p-1">
              <p>Since: {new Date(apiUsage.startedAt).toLocaleTimeString()}</p>
              <p>Gamma API: {apiUsage.gammaApiCalls}</p>
              <p>CLOB API: {apiUsage.clobApiCalls}</p>
              <p>CLOB Auth: {apiUsage.clobAuthCalls}</p>
            </div>
          }
        >
          <Chip size="sm" variant="flat" color="default" className="cursor-default">
            {apiUsage.totalCalls} calls
          </Chip>
        </Tooltip>
      )}
    </div>
  );
}
