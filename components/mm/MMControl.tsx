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
import type { MMState, VolatilityRegime, CryptoAsset, MarketMode } from '@/lib/mm/types';
import { ALL_CRYPTO_ASSETS, MM_PRESETS } from '@/lib/mm/types';

const REGIME_COLORS: Record<VolatilityRegime, 'success' | 'warning' | 'danger' | 'default'> = {
  calm: 'success',
  normal: 'warning',
  elevated: 'danger',
  volatile: 'danger',
};

const MARKET_OPTIONS: { asset: CryptoAsset; mode: MarketMode; label: string }[] = [
  { asset: 'BTC', mode: '5m', label: 'BTC 5m' },
  ...ALL_CRYPTO_ASSETS.map((asset) => ({ asset, mode: '15m' as MarketMode, label: `${asset} 15m` })),
];

export function MMControl() {
  const { profiles } = useProfileStore();
  const states = useMMStore((s) => s.states);
  const detail = useMMStore((s) => s.detail);
  const selectedProfileId = useMMStore((s) => s.selectedProfileId);
  const setSelectedProfile = useMMStore((s) => s.setSelectedProfile);
  const selectedAsset = useMMStore((s) => s.selectedAsset);
  const selectedMode = useMMStore((s) => s.selectedMode);
  const setMarketOption = useMMStore((s) => s.setMarketOption);
  const loading = useMMStore((s) => s.loading);
  const error = useMMStore((s) => s.error);
  const startMM = useMMStore((s) => s.startMM);
  const stopMM = useMMStore((s) => s.stopMM);

  const [maxPositionSize, setMaxPositionSize] = useState(MM_PRESETS['15m'].maxPositionSize);

  const activeProfiles = profiles.filter((p) => p.isActive && p.hasPrivateKey && p.hasApiCredentials);

  useEffect(() => {
    if (!selectedProfileId && activeProfiles.length > 0) {
      setSelectedProfile(activeProfiles[0].id);
    }
  }, [activeProfiles.length, selectedProfileId, setSelectedProfile]);

  const selectedState: MMState | undefined = selectedProfileId ? states[selectedProfileId] : undefined;
  const isRunning = selectedState?.status === 'running';

  const regime = detail?.volatility?.regime ?? selectedState?.volatilityRegime ?? 'volatile';
  const runningConfig = detail?.config;

  const handleMarketOptionChange = (asset: CryptoAsset, mode: MarketMode) => {
    setMarketOption(asset, mode);
    setMaxPositionSize(MM_PRESETS[mode].maxPositionSize);
  };

  const handleStart = () => {
    if (!selectedProfileId) return;
    startMM(selectedProfileId, {
      mode: selectedMode,
      assets: [selectedAsset],
      maxPositionSize,
    });
  };

  return (
    <Card className="h-full">
      <CardHeader className="flex justify-between items-center">
        <h3 className="text-sm font-semibold">MM Control</h3>
        {selectedState && (
          <Chip size="sm" variant="dot" color={isRunning ? 'success' : 'default'}>
            {selectedState.status}
          </Chip>
        )}
      </CardHeader>
      <CardBody className="pt-0 space-y-4">
        <div className="flex items-center gap-2 min-w-0">
          <Select
            size="sm"
            variant="bordered"
            aria-label="Select profile"
            placeholder="Select profile"
            className="flex-1 min-w-0"
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
              if (isRunning) stopMM(selectedProfileId);
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

          <div>
            <p className="text-[11px] text-gray-500 mb-1.5">Max Position Size</p>
            {isRunning ? (
              <p className="text-sm font-mono font-semibold text-gray-900 dark:text-white">
                {runningConfig?.maxPositionSize ?? '--'} shares
              </p>
            ) : (
              <Input
                type="number"
                size="sm"
                variant="bordered"
                min={1}
                max={500}
                value={String(maxPositionSize)}
                onValueChange={(v) => {
                  const n = parseInt(v, 10);
                  if (n > 0 && n <= 500) setMaxPositionSize(n);
                }}
                endContent={<span className="text-[10px] text-gray-400">shares</span>}
              />
            )}
          </div>
        </div>

        <Divider />

        <div className="grid grid-cols-2 gap-2">
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <p className="text-[10px] text-gray-500 uppercase">Regime</p>
            <Chip size="sm" variant="flat" color={REGIME_COLORS[regime]}>
              {regime}
            </Chip>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <p className="text-[10px] text-gray-500 uppercase">Markets</p>
            <p className="text-lg font-bold text-gray-900 dark:text-white">
              {selectedState?.activeMarkets ?? 0}
            </p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <p className="text-[10px] text-gray-500 uppercase">Quotes</p>
            <p className="text-lg font-bold text-gray-900 dark:text-white">
              {selectedState?.quotesPlaced ?? 0}
            </p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <p className="text-[10px] text-gray-500 uppercase">Fills</p>
            <p className="text-lg font-bold text-gray-900 dark:text-white">
              {(selectedState?.fillsBuy ?? 0) + (selectedState?.fillsSell ?? 0)}
            </p>
          </div>
        </div>

        {detail?.volatility && (
          <div className="text-[11px] text-gray-500 space-y-1">
            <div className="flex justify-between">
              <span>ATRP Percentile</span>
              <span className="font-mono">{detail.volatility.atrpPercentile}%</span>
            </div>
            <div className="flex justify-between">
              <span>BBW Percentile</span>
              <span className="font-mono">{detail.volatility.bbwPercentile}%</span>
            </div>
            <div className="flex justify-between">
              <span>ATR Ratio</span>
              <span className="font-mono">{detail.volatility.atrRatio}</span>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
