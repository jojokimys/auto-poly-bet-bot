'use client';

import { useState } from 'react';
import { Card, CardBody, Chip } from '@heroui/react';
import { useMMStore } from '@/store/useMMStore';

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

export function SniperLogFeed() {
  const logs = useMMStore((s) => s.sniperLogs);
  const [expanded, setExpanded] = useState(true);

  return (
    <Card>
      <CardBody className="py-3">
        <button
          className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors mb-2"
          onClick={() => setExpanded((v) => !v)}
        >
          <svg
            className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Sniper Activity Log
          <span className="text-gray-400 ml-1">({logs.length})</span>
        </button>

        {expanded && (
          <div className="max-h-[250px] overflow-y-auto space-y-1">
            {logs.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">No sniper activity yet</p>
            ) : (
              [...logs].reverse().map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 text-xs py-1 border-b border-gray-100 dark:border-gray-800 last:border-0"
                >
                  <span className="text-gray-400 shrink-0 w-16 font-mono">
                    {formatTime(entry.createdAt)}
                  </span>
                  <Chip size="sm" variant="flat" color={LEVEL_COLORS[entry.level] || 'default'} className="shrink-0">
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
      </CardBody>
    </Card>
  );
}
