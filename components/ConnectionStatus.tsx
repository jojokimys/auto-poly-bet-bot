'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { Tooltip } from '@heroui/react';

export function ConnectionStatus() {
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const setConnectionStatus = useAppStore((s) => s.setConnectionStatus);

  useEffect(() => {
    async function checkConnection() {
      try {
        const res = await fetch('/api/markets?limit=1');
        if (res.ok) {
          setConnectionStatus('connected');
        } else {
          setConnectionStatus('degraded');
        }
      } catch {
        setConnectionStatus('disconnected');
      }
    }

    checkConnection();
    const interval = setInterval(checkConnection, 30_000);
    return () => clearInterval(interval);
  }, [setConnectionStatus]);

  const colors = {
    connected: 'bg-green-500',
    degraded: 'bg-yellow-500',
    disconnected: 'bg-red-500',
  };

  const labels = {
    connected: 'Connected to Polymarket',
    degraded: 'API issues detected',
    disconnected: 'Disconnected',
  };

  return (
    <Tooltip content={labels[connectionStatus]}>
      <div className="flex items-center gap-2 cursor-default">
        <div className={`w-2.5 h-2.5 rounded-full ${colors[connectionStatus]}`} />
        <span className="text-xs text-gray-500 dark:text-gray-400 hidden sm:inline">
          {connectionStatus === 'connected' ? 'Live' : connectionStatus === 'degraded' ? 'Issues' : 'Offline'}
        </span>
      </div>
    </Tooltip>
  );
}
