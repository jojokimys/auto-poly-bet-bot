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
import type { SniperState, CryptoAsset, MarketMode } from '@/lib/mm/types';
import { ALL_CRYPTO_ASSETS, DEFAULT_SNIPER_CONFIG } from '@/lib/mm/types';

// 5m markets only exist for BTC on Polymarket; 15m available for all assets
const MARKET_OPTIONS: { asset: CryptoAsset; mode: MarketMode; label: string }[] = [
  { asset: 'BTC', mode: '5m', label: 'BTC 5m' },
  ...ALL_CRYPTO_ASSETS.map((asset) => ({ asset, mode: '15m' as MarketMode, label: `${asset} 15m` })),
];

export function MMControl() {
  const { profiles } = useProfileStore();
  const sniperStates = useMMStore((s) => s.sniperStates);
  const sniperDetail = useMMStore((s) => s.sniperDetail);
  const selectedProfileId = useMMStore((s) => s.selectedProfileId);
  const setSelectedProfile = useMMStore((s) => s.setSelectedProfile);
  const selectedAsset = useMMStore((s) => s.selectedAsset);
  const selectedMode = useMMStore((s) => s.selectedMode);
  const setMarketOption = useMMStore((s) => s.setMarketOption);
  const loading = useMMStore((s) => s.loading);
  const error = useMMStore((s) => s.error);
  const startSniper = useMMStore((s) => s.startSniper);
  const stopSniper = useMMStore((s) => s.stopSniper);

  const [maxPositionSize, setMaxPositionSize] = useState(DEFAULT_SNIPER_CONFIG.maxPositionSize);
  const [minPriceDiffPct, setMinPriceDiffPct] = useState(DEFAULT_SNIPER_CONFIG.minPriceDiffPct * 100); // display as %

  const activeProfiles = profiles.filter((p) => p.isActive && p.hasPrivateKey && p.hasApiCredentials);

  // Auto-select first profile on load
  useEffect(() => {
    if (!selectedProfileId && activeProfiles.length > 0) {
      setSelectedProfile(activeProfiles[0].id);
    }
  }, [activeProfiles.length, selectedProfileId, setSelectedProfile]);

  const selectedState: SniperState | undefined = selectedProfileId ? sniperStates[selectedProfileId] : undefined;
  const isRunning = selectedState?.status === 'running';

  const runningConfig = sniperDetail?.config;

  const handleMarketOptionChange = (asset: CryptoAsset, mode: MarketMode) => {
    setMarketOption(asset, mode);
  };

  const handleStart = () => {
    if (!selectedProfileId) return;
    startSniper(selectedProfileId, {
      mode: selectedMode,
      assets: [selectedAsset],
      maxPositionSize,
      minPriceDiffPct: minPriceDiffPct / 100, // convert back to decimal
    });
  };

  const winRate = selectedState && selectedState.totalTrades > 0
    ? ((selectedState.wins / (selectedState.wins + selectedState.losses)) * 100)
    : 0;

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
        {/* Profile selector */}
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

        {/* Config section */}
        <div className="space-y-3">
          <p className="text-[10px] text-gray-500 uppercase font-semibold">
            {isRunning ? 'Running Config' : 'Configuration'}
          </p>

          {/* Market Option */}
          <div>
            <p className="text-[11px] text-gray-500 mb-1.5">Market Option</p>
            <div className="flex flex-wrap gap-2">
              {MARKET_OPTIONS.map((opt) => {
                const isActive = isRunning
                  ? runningConfig?.mode === opt.mode && runningConfig?.assets.includes(opt.asset)
                  : selectedAsset === opt.asset && selectedMode === opt.mode;
                return (
                  <Chip
                    key={opt.label}
                    size="sm"
                    variant={isActive ? 'solid' : 'bordered'}
                    color={isActive ? 'secondary' : 'default'}
                    className={isRunning ? '' : 'cursor-pointer'}
                    onClick={() => {
                      if (!isRunning) handleMarketOptionChange(opt.asset, opt.mode);
                    }}
                  >
                    {opt.label}
                  </Chip>
                );
              })}
            </div>
          </div>

          {/* Max Position Size */}
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

          {/* Min Price Diff */}
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

        {/* Stats grid */}
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

        {/* Exposure info */}
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
