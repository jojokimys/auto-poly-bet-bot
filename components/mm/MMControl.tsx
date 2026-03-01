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
  DateRangePicker,
  Progress,
  Spinner,
} from '@heroui/react';
import { today, getLocalTimeZone, parseDate, type CalendarDate } from '@internationalized/date';
import { useMMStore } from '@/store/useMMStore';
import { useProfileStore } from '@/store/useProfileStore';
import type { MMState, CryptoAsset, MarketMode } from '@/lib/mm/types';
import { ALL_CRYPTO_ASSETS, MM_PRESETS } from '@/lib/mm/types';

const MARKET_OPTIONS: { asset: CryptoAsset; mode: MarketMode; label: string }[] = [
  { asset: 'BTC', mode: '5m', label: 'BTC 5m' },
  ...ALL_CRYPTO_ASSETS.map((asset) => ({ asset, mode: '15m' as MarketMode, label: `${asset} 15m` })),
];

function toCalendarDate(iso: string): CalendarDate {
  return parseDate(iso);
}

function toISODate(d: CalendarDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

export function MMControl() {
  const { profiles } = useProfileStore();
  const states = useMMStore((s) => s.states);
  const detail = useMMStore((s) => s.detail);
  const portfolioStats = useMMStore((s) => s.portfolioStats);
  const portfolioLoading = useMMStore((s) => s.portfolioLoading);
  const portfolioRange = useMMStore((s) => s.portfolioRange);
  const setPortfolioRange = useMMStore((s) => s.setPortfolioRange);
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

  const dateRangeValue = {
    start: portfolioRange.after
      ? toCalendarDate(portfolioRange.after)
      : today(getLocalTimeZone()),
    end: portfolioRange.before
      ? toCalendarDate(portfolioRange.before)
      : today(getLocalTimeZone()),
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

        <div className="space-y-2">
          <p className="text-[10px] text-gray-500 uppercase font-semibold">Performance</p>

          <DateRangePicker
            size="sm"
            variant="bordered"
            aria-label="Date range"
            maxValue={today(getLocalTimeZone())}
            value={dateRangeValue}
            onChange={(val) => {
              if (!val) return;
              setPortfolioRange({
                after: toISODate(val.start),
                before: toISODate(val.end),
              });
            }}
          />

          {portfolioLoading && (
            <Progress size="sm" isIndeterminate aria-label="Loading portfolio" className="w-full" />
          )}

          <div className="relative">
            {portfolioLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/60 dark:bg-black/40 rounded-lg z-10">
                <Spinner size="sm" />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <p className="text-[10px] text-gray-500 uppercase">Win Rate</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">
                  {portfolioStats && (portfolioStats.wins + portfolioStats.losses) > 0
                    ? `${(portfolioStats.winRate * 100).toFixed(0)}% (${portfolioStats.wins}/${portfolioStats.wins + portfolioStats.losses})`
                    : '--'}
                </p>
              </div>
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <p className="text-[10px] text-gray-500 uppercase">PnL</p>
                <p className={`text-lg font-bold font-mono ${(portfolioStats?.totalPnl ?? 0) >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                  {portfolioStats ? `${portfolioStats.totalPnl >= 0 ? '+' : ''}$${portfolioStats.totalPnl.toFixed(2)}` : '--'}
                </p>
              </div>
            </div>
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
