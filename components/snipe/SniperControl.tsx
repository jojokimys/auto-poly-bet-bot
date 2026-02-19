'use client';

import { useState, useEffect } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  Button,
  Chip,
  Select,
  SelectItem,
  Input,
  Divider,
} from '@heroui/react';
import { useMMStore } from '@/store/useMMStore';
import { useProfileStore } from '@/store/useProfileStore';
import type { SniperState, MarketSelection } from '@/lib/mm/types';
import { ALL_MARKET_SELECTIONS, DEFAULT_SNIPER_CONFIG } from '@/lib/mm/types';

function selKey(s: MarketSelection): string {
  return `${s.asset}_${s.mode}`;
}

export function SniperControl() {
  const { profiles } = useProfileStore();
  const sniperStates = useMMStore((s) => s.sniperStates);
  const sniperDetail = useMMStore((s) => s.sniperDetail);
  const selectedProfileId = useMMStore((s) => s.selectedProfileId);
  const setSelectedProfile = useMMStore((s) => s.setSelectedProfile);
  const loading = useMMStore((s) => s.loading);
  const error = useMMStore((s) => s.error);
  const startSniper = useMMStore((s) => s.startSniper);
  const stopSniper = useMMStore((s) => s.stopSniper);

  // Multi-select market selections — default all selected
  const [selectedSelections, setSelectedSelections] = useState<Set<string>>(
    () => new Set(DEFAULT_SNIPER_CONFIG.selections.map(selKey))
  );
  const [maxPositionSize, setMaxPositionSize] = useState(DEFAULT_SNIPER_CONFIG.maxPositionSize);
  const [minPriceDiffPct, setMinPriceDiffPct] = useState(DEFAULT_SNIPER_CONFIG.minPriceDiffPct * 100);

  const activeProfiles = profiles.filter((p) => p.isActive && p.hasPrivateKey && p.hasApiCredentials);

  useEffect(() => {
    if (!selectedProfileId && activeProfiles.length > 0) {
      setSelectedProfile(activeProfiles[0].id);
    }
  }, [activeProfiles.length, selectedProfileId, setSelectedProfile]);

  const selectedState: SniperState | undefined = selectedProfileId ? sniperStates[selectedProfileId] : undefined;
  const isRunning = selectedState?.status === 'running';
  const runningConfig = sniperDetail?.config;

  const toggleSelection = (sel: MarketSelection) => {
    if (isRunning) return;
    const key = selKey(sel);
    setSelectedSelections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key); // keep at least 1
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleStart = () => {
    if (!selectedProfileId) return;
    const selections = ALL_MARKET_SELECTIONS.filter((s) => selectedSelections.has(selKey(s)));
    startSniper(selectedProfileId, {
      selections,
      maxPositionSize,
      minPriceDiffPct: minPriceDiffPct / 100,
    });
  };

  const winRate = selectedState && selectedState.totalTrades > 0
    ? ((selectedState.wins / (selectedState.wins + selectedState.losses)) * 100)
    : 0;

  // Running config selections for display
  const runningSelKeys = new Set(
    runningConfig?.selections.map(selKey) ?? []
  );

  return (
    <Card className="h-full">
      <CardHeader className="flex justify-between items-center">
        <h3 className="text-sm font-semibold">Sniper Control</h3>
        {selectedState && (
          <Chip size="sm" variant="dot" color={isRunning ? 'success' : 'default'}>
            {selectedState.status}
          </Chip>
        )}
      </CardHeader>
      <CardBody className="pt-0 space-y-4">
        <div className="flex items-center gap-2">
          <Select
            size="sm"
            variant="bordered"
            aria-label="Select profile"
            placeholder="Select profile"
            className="flex-1"
            selectedKeys={selectedProfileId ? [selectedProfileId] : []}
            onSelectionChange={(keys) => {
              const id = Array.from(keys)[0] as string;
              if (id) setSelectedProfile(id);
            }}
          >
            {activeProfiles.map((p) => (
              <SelectItem key={p.id}>{p.name}</SelectItem>
            ))}
          </Select>
          <Button
            size="sm"
            color={isRunning ? 'danger' : 'success'}
            variant="flat"
            isLoading={loading}
            isDisabled={!selectedProfileId}
            onPress={() => {
              if (!selectedProfileId) return;
              if (isRunning) stopSniper(selectedProfileId);
              else handleStart();
            }}
          >
            {isRunning ? 'Stop' : 'Start'}
          </Button>
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="space-y-3">
          <p className="text-[10px] text-gray-500 uppercase font-semibold">
            {isRunning ? 'Running Config' : 'Configuration'}
          </p>

          <div>
            <p className="text-[11px] text-gray-500 mb-1.5">Markets (multi-select)</p>
            <div className="flex flex-wrap gap-2">
              {ALL_MARKET_SELECTIONS.map((sel) => {
                const key = selKey(sel);
                const label = `${sel.asset} ${sel.mode}`;
                const isActive = isRunning
                  ? runningSelKeys.has(key)
                  : selectedSelections.has(key);
                return (
                  <Chip
                    key={key}
                    size="sm"
                    variant={isActive ? 'solid' : 'bordered'}
                    color={isActive ? 'secondary' : 'default'}
                    className={isRunning ? '' : 'cursor-pointer'}
                    onClick={() => toggleSelection(sel)}
                  >
                    {label}
                  </Chip>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[11px] text-gray-500 mb-1.5">Max Position Size</p>
            {isRunning ? (
              <p className="text-sm font-mono font-semibold text-gray-900 dark:text-white">
                ${runningConfig?.maxPositionSize ?? '--'}
              </p>
            ) : (
              <Input
                type="number"
                size="sm"
                variant="bordered"
                min={1}
                max={100}
                value={String(maxPositionSize)}
                onValueChange={(v) => {
                  const n = parseInt(v, 10);
                  if (n > 0 && n <= 100) setMaxPositionSize(n);
                }}
                endContent={<span className="text-[10px] text-gray-400">USDC</span>}
              />
            )}
          </div>

          <div>
            <p className="text-[11px] text-gray-500 mb-1.5">Min Price Diff</p>
            {isRunning ? (
              <p className="text-sm font-mono font-semibold text-gray-900 dark:text-white">
                {runningConfig ? (runningConfig.minPriceDiffPct * 100).toFixed(2) : '--'}%
              </p>
            ) : (
              <Input
                type="number"
                size="sm"
                variant="bordered"
                min={0.01}
                max={10}
                step={0.01}
                value={String(minPriceDiffPct)}
                onValueChange={(v) => {
                  const n = parseFloat(v);
                  if (n > 0 && n <= 10) setMinPriceDiffPct(n);
                }}
                endContent={<span className="text-[10px] text-gray-400">%</span>}
              />
            )}
          </div>
        </div>

        <Divider />

        <div className="grid grid-cols-2 gap-2">
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <p className="text-[10px] text-gray-500 uppercase">Markets</p>
            <p className="text-lg font-bold text-gray-900 dark:text-white">
              {selectedState?.activeMarkets ?? 0}
            </p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <p className="text-[10px] text-gray-500 uppercase">Trades</p>
            <p className="text-lg font-bold text-gray-900 dark:text-white">
              {selectedState?.totalTrades ?? 0}
            </p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <p className="text-[10px] text-gray-500 uppercase">Win Rate</p>
            <p className={`text-lg font-bold ${winRate >= 50 ? 'text-green-600' : 'text-red-500'}`}>
              {selectedState && (selectedState.wins + selectedState.losses) > 0
                ? `${winRate.toFixed(0)}%`
                : '--'}
            </p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <p className="text-[10px] text-gray-500 uppercase">PnL</p>
            <p className={`text-lg font-bold font-mono ${(selectedState?.grossPnl ?? 0) >= 0 ? 'text-green-600' : 'text-red-500'}`}>
              {selectedState ? `${selectedState.grossPnl >= 0 ? '+' : ''}$${selectedState.grossPnl.toFixed(2)}` : '--'}
            </p>
          </div>
        </div>

        {isRunning && (
          <div className="text-[11px] text-gray-500 space-y-1">
            <div className="flex justify-between">
              <span>Exposure</span>
              <span className="font-mono">${selectedState?.totalExposure?.toFixed(2) ?? '0.00'} / ${runningConfig?.maxTotalExposure ?? 30}</span>
            </div>
            <div className="flex justify-between">
              <span>W / L</span>
              <span className="font-mono">{selectedState?.wins ?? 0} / {selectedState?.losses ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span>Entry Window</span>
              <span className="font-mono">{runningConfig?.minMinutesLeft ?? 0.5} - {runningConfig?.maxMinutesLeft ?? 3.0}m</span>
            </div>
            <div className="flex justify-between">
              <span>Max Token Price</span>
              <span className="font-mono">{runningConfig?.maxTokenPrice ?? 0.93}</span>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
