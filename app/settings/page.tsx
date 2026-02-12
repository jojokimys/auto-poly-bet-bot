'use client';

import { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader, Input, Button, Checkbox, Chip, Divider, Spinner } from '@heroui/react';
import { useSettingsStore } from '@/store/useSettingsStore';

export default function SettingsPage() {
  const { settings, loading, saving, error, success, fetchSettings, saveSettings, testConnection } =
    useSettingsStore();

  const [form, setForm] = useState({
    privateKey: '',
    funderAddress: '',
    apiKey: '',
    apiSecret: '',
    apiPassphrase: '',
    maxBetAmount: '10',
    minLiquidity: '1000',
    minVolume: '5000',
    maxSpread: '0.05',
    autoBettingEnabled: false,
    scanIntervalMinutes: '5',
  });

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (settings) {
      setForm((prev) => ({
        ...prev,
        funderAddress: settings.funderAddress || '',
        apiKey: settings.apiKey || '',
        maxBetAmount: String(settings.maxBetAmount),
        minLiquidity: String(settings.minLiquidity),
        minVolume: String(settings.minVolume),
        maxSpread: String(settings.maxSpread),
        autoBettingEnabled: settings.autoBettingEnabled,
        scanIntervalMinutes: String(settings.scanIntervalMinutes),
      }));
    }
  }, [settings]);

  const handleSave = async () => {
    const data: Record<string, unknown> = {};
    if (form.privateKey) data.privateKey = form.privateKey;
    if (form.apiSecret) data.apiSecret = form.apiSecret;
    if (form.apiPassphrase) data.apiPassphrase = form.apiPassphrase;
    data.funderAddress = form.funderAddress;
    data.apiKey = form.apiKey;
    data.maxBetAmount = parseFloat(form.maxBetAmount) || 10;
    data.minLiquidity = parseFloat(form.minLiquidity) || 1000;
    data.minVolume = parseFloat(form.minVolume) || 5000;
    data.maxSpread = parseFloat(form.maxSpread) || 0.05;
    data.autoBettingEnabled = form.autoBettingEnabled;
    data.scanIntervalMinutes = parseInt(form.scanIntervalMinutes) || 5;
    await saveSettings(data);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h2>

      <Card>
        <CardHeader className="flex justify-between items-center">
          <h3 className="text-lg font-semibold">Connection</h3>
          <div className="flex gap-2">
            {settings?.hasPrivateKey && (
              <Chip size="sm" color="success" variant="flat">Wallet configured</Chip>
            )}
            {settings?.hasApiCredentials && (
              <Chip size="sm" color="success" variant="flat">API keys set</Chip>
            )}
          </div>
        </CardHeader>
        <CardBody>
          <Button size="sm" variant="bordered" onPress={testConnection}>
            Test Connection
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold">Wallet Configuration</h3>
        </CardHeader>
        <CardBody className="space-y-4">
          <Input
            type="password"
            label="Private Key"
            placeholder={settings?.hasPrivateKey ? '••••••••' : 'Enter private key'}
            variant="bordered"
            value={form.privateKey}
            onValueChange={(v) => setForm((f) => ({ ...f, privateKey: v }))}
            description="Your Polygon wallet private key"
          />
          <Input
            label="Funder Address"
            placeholder="0x..."
            variant="bordered"
            value={form.funderAddress}
            onValueChange={(v) => setForm((f) => ({ ...f, funderAddress: v }))}
            description="Polymarket proxy wallet address"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold">API Credentials</h3>
        </CardHeader>
        <CardBody className="space-y-4">
          <Input
            label="API Key"
            placeholder="Enter API key"
            variant="bordered"
            value={form.apiKey}
            onValueChange={(v) => setForm((f) => ({ ...f, apiKey: v }))}
          />
          <Input
            type="password"
            label="API Secret"
            placeholder={settings?.hasApiCredentials ? '••••••••' : 'Enter API secret'}
            variant="bordered"
            value={form.apiSecret}
            onValueChange={(v) => setForm((f) => ({ ...f, apiSecret: v }))}
          />
          <Input
            type="password"
            label="API Passphrase"
            placeholder={settings?.hasApiCredentials ? '••••••••' : 'Enter passphrase'}
            variant="bordered"
            value={form.apiPassphrase}
            onValueChange={(v) => setForm((f) => ({ ...f, apiPassphrase: v }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold">Bot Parameters</h3>
        </CardHeader>
        <CardBody className="space-y-4">
          <Input
            type="number"
            label="Max Bet Amount (USDC)"
            variant="bordered"
            value={form.maxBetAmount}
            onValueChange={(v) => setForm((f) => ({ ...f, maxBetAmount: v }))}
          />
          <Input
            type="number"
            label="Min Liquidity"
            variant="bordered"
            value={form.minLiquidity}
            onValueChange={(v) => setForm((f) => ({ ...f, minLiquidity: v }))}
          />
          <Input
            type="number"
            label="Min Volume"
            variant="bordered"
            value={form.minVolume}
            onValueChange={(v) => setForm((f) => ({ ...f, minVolume: v }))}
          />
          <Input
            type="number"
            label="Max Spread"
            variant="bordered"
            value={form.maxSpread}
            onValueChange={(v) => setForm((f) => ({ ...f, maxSpread: v }))}
            description="Between 0 and 1"
          />
          <Input
            type="number"
            label="Scan Interval (minutes)"
            variant="bordered"
            value={form.scanIntervalMinutes}
            onValueChange={(v) => setForm((f) => ({ ...f, scanIntervalMinutes: v }))}
          />
          <Checkbox
            isSelected={form.autoBettingEnabled}
            onValueChange={(v) => setForm((f) => ({ ...f, autoBettingEnabled: v }))}
          >
            Enable automatic betting
          </Checkbox>
        </CardBody>
      </Card>

      <Divider />

      {error && <p className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm text-success">{success}</p>}

      <Button color="primary" className="w-full" onPress={handleSave} isLoading={saving}>
        Save Settings
      </Button>
    </div>
  );
}
