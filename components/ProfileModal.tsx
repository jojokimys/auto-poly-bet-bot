'use client';

import { useState, useEffect } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Input,
  Button,
  Checkbox,
  CheckboxGroup,
  Slider,
  Chip,
} from '@heroui/react';
import { useProfileStore, type ProfilePublic } from '@/store/useProfileStore';
import { STRATEGY_META } from '@/lib/bot/strategy-meta';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile?: ProfilePublic | null;
  onSaved: () => void;
}

export function ProfileModal({ isOpen, onClose, profile, onSaved }: ProfileModalProps) {
  const { createProfile, updateProfile, saving, error, success, clearMessages, fetchProfiles } =
    useProfileStore();

  const isEditMode = !!profile;

  const [form, setForm] = useState({
    name: '',
    privateKey: '',
    funderAddress: '',
    apiKey: '',
    apiSecret: '',
    apiPassphrase: '',
    builderApiKey: '',
    builderApiSecret: '',
    builderApiPassphrase: '',
    enabledStrategies: ['value-betting'] as string[],
    maxPortfolioExposure: 40, // percent
  });

  const [localError, setLocalError] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [deriveSuccess, setDeriveSuccess] = useState<string | null>(null);

  // Whether API keys exist (derived or pre-existing)
  const hasApiKeys = !!(form.apiKey && form.apiSecret && form.apiPassphrase);
  const apiKeysConfigured = hasApiKeys || (isEditMode && profile?.hasApiCredentials);

  // Reset form when modal opens or profile changes
  useEffect(() => {
    if (isOpen) {
      clearMessages();
      setLocalError(null);
      setDeriveSuccess(null);
      if (profile) {
        setForm({
          name: profile.name,
          privateKey: '',
          funderAddress: profile.funderAddress || '',
          apiKey: '',
          apiSecret: '',
          apiPassphrase: '',
          builderApiKey: '',
          builderApiSecret: '',
          builderApiPassphrase: '',
          enabledStrategies: profile.enabledStrategies?.length ? profile.enabledStrategies : ['value-betting'],
          maxPortfolioExposure: Math.round((profile.maxPortfolioExposure ?? 0.4) * 100),
        });
      } else {
        setForm({
          name: '',
          privateKey: '',
          funderAddress: '',
          apiKey: '',
          apiSecret: '',
          apiPassphrase: '',
          builderApiKey: '',
          builderApiSecret: '',
          builderApiPassphrase: '',
          enabledStrategies: ['value-betting'],
          maxPortfolioExposure: 40,
        });
      }
    }
  }, [isOpen, profile, clearMessages]);

  const handleDeriveKeys = async () => {
    setLocalError(null);
    setDeriveSuccess(null);

    if (!isEditMode && !form.privateKey) {
      setLocalError('Enter your private key first to derive API credentials');
      return;
    }
    if (isEditMode && !form.privateKey && !profile?.hasPrivateKey) {
      setLocalError('Enter your private key first to derive API credentials');
      return;
    }

    setDeriving(true);
    try {
      const payload: Record<string, string> = {};
      if (form.privateKey) payload.privateKey = form.privateKey;
      if (form.funderAddress) payload.funderAddress = form.funderAddress;
      if (isEditMode && profile) payload.profileId = profile.id;

      const res = await fetch('/api/profiles/derive-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setLocalError(data.error || 'Failed to derive API keys');
        return;
      }

      setForm((f) => ({
        ...f,
        apiKey: data.apiKey,
        apiSecret: data.apiSecret,
        apiPassphrase: data.apiPassphrase,
      }));

      const addr = `${data.walletAddress.slice(0, 6)}...${data.walletAddress.slice(-4)}`;

      if (data.profile) {
        await fetchProfiles();
        onSaved();
        setDeriveSuccess(`API keys derived and saved for ${addr}`);
      } else {
        setDeriveSuccess(`API keys derived for ${addr} — save profile to apply`);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to derive API keys');
    } finally {
      setDeriving(false);
    }
  };

  const handleSave = async () => {
    setLocalError(null);
    setDeriveSuccess(null);

    if (!form.name.trim()) {
      setLocalError('Name is required');
      return;
    }

    if (!isEditMode && !form.privateKey) {
      setLocalError('Private key is required for new profiles');
      return;
    }

    if (!isEditMode && !hasApiKeys) {
      setLocalError('Click "Setup API Keys" to derive credentials before saving');
      return;
    }

    let ok = false;

    if (isEditMode && profile) {
      const data: Record<string, unknown> = { name: form.name.trim() };
      if (form.privateKey) data.privateKey = form.privateKey;
      if (form.funderAddress) data.funderAddress = form.funderAddress;
      if (form.apiKey) data.apiKey = form.apiKey;
      if (form.apiSecret) data.apiSecret = form.apiSecret;
      if (form.apiPassphrase) data.apiPassphrase = form.apiPassphrase;
      if (form.builderApiKey) data.builderApiKey = form.builderApiKey;
      if (form.builderApiSecret) data.builderApiSecret = form.builderApiSecret;
      if (form.builderApiPassphrase) data.builderApiPassphrase = form.builderApiPassphrase;
      data.enabledStrategies = form.enabledStrategies;
      data.maxPortfolioExposure = form.maxPortfolioExposure / 100;
      ok = await updateProfile(profile.id, data);
    } else {
      const data: Record<string, unknown> = {
        name: form.name.trim(),
        privateKey: form.privateKey,
        apiKey: form.apiKey,
        apiSecret: form.apiSecret,
        apiPassphrase: form.apiPassphrase,
        enabledStrategies: form.enabledStrategies,
        maxPortfolioExposure: form.maxPortfolioExposure / 100,
      };
      if (form.funderAddress) data.funderAddress = form.funderAddress;
      if (form.builderApiKey) data.builderApiKey = form.builderApiKey;
      if (form.builderApiSecret) data.builderApiSecret = form.builderApiSecret;
      if (form.builderApiPassphrase) data.builderApiPassphrase = form.builderApiPassphrase;
      ok = await createProfile(data);
    }

    if (ok) {
      onSaved();
      onClose();
    }
  };

  const displayError = localError || error;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <h3 className="text-lg font-semibold">
            {isEditMode ? 'Edit Profile' : 'Add Profile'}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 font-normal">
            {isEditMode
              ? 'Update profile credentials and strategy'
              : 'Configure a new bot trading profile'}
          </p>
        </ModalHeader>

        <ModalBody className="space-y-4">
          <Input
            label="Name"
            placeholder="e.g. Main Trading Account"
            variant="bordered"
            isRequired
            value={form.name}
            onValueChange={(v) => setForm((f) => ({ ...f, name: v }))}
          />

          {/* Wallet + API Keys Section */}
          <div className="space-y-3">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Wallet Configuration
            </p>
            <Input
              type="password"
              label="Private Key"
              placeholder={isEditMode && profile?.hasPrivateKey ? '••••••••' : 'Enter private key'}
              variant="bordered"
              value={form.privateKey}
              onValueChange={(v) => setForm((f) => ({ ...f, privateKey: v }))}
              description={
                isEditMode
                  ? 'Leave empty to keep existing key'
                  : 'Your Polygon wallet private key'
              }
            />
            <Input
              label="Funder Address"
              placeholder="0x..."
              variant="bordered"
              value={form.funderAddress}
              onValueChange={(v) => setForm((f) => ({ ...f, funderAddress: v }))}
              description="Polymarket proxy wallet address (optional)"
            />

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-700 dark:text-gray-300">API Credentials</span>
                <Chip
                  size="sm"
                  variant="flat"
                  color={apiKeysConfigured ? 'success' : 'warning'}
                >
                  {apiKeysConfigured ? 'Configured' : 'Not set'}
                </Chip>
              </div>
              <Button
                size="sm"
                color="secondary"
                variant="flat"
                isLoading={deriving}
                onPress={handleDeriveKeys}
                isDisabled={!form.privateKey && !(isEditMode && profile?.hasPrivateKey)}
              >
                {deriving ? 'Deriving...' : apiKeysConfigured ? 'Re-derive' : 'Setup API Keys'}
              </Button>
            </div>

            {deriveSuccess && (
              <p className="text-xs text-success">{deriveSuccess}</p>
            )}
          </div>

          {/* Builder API Credentials Section */}
          <div className="space-y-3">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Builder API Credentials
              {isEditMode && profile?.hasBuilderCredentials && (
                <span className="ml-2 text-xs text-success">Configured</span>
              )}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              From{' '}
              <a
                href="https://polymarket.com/settings?tab=builder"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                builders.polymarket.com
              </a>
              {' '}— required for order placement
            </p>
            <Input
              label="Builder API Key"
              placeholder={
                isEditMode && profile?.hasBuilderCredentials ? '••••••••' : 'Enter builder API key'
              }
              variant="bordered"
              value={form.builderApiKey}
              onValueChange={(v) => setForm((f) => ({ ...f, builderApiKey: v }))}
            />
            <Input
              type="password"
              label="Builder API Secret"
              placeholder={
                isEditMode && profile?.hasBuilderCredentials ? '••••••••' : 'Enter builder secret'
              }
              variant="bordered"
              value={form.builderApiSecret}
              onValueChange={(v) => setForm((f) => ({ ...f, builderApiSecret: v }))}
            />
            <Input
              type="password"
              label="Builder API Passphrase"
              placeholder={
                isEditMode && profile?.hasBuilderCredentials ? '••••••••' : 'Enter builder passphrase'
              }
              variant="bordered"
              value={form.builderApiPassphrase}
              onValueChange={(v) => setForm((f) => ({ ...f, builderApiPassphrase: v }))}
            />
          </div>

          {/* Portfolio Exposure Limit */}
          <div className="space-y-2">
            <Slider
              label="Max Portfolio Exposure"
              step={5}
              minValue={10}
              maxValue={100}
              value={form.maxPortfolioExposure}
              onChange={(v) =>
                setForm((f) => ({ ...f, maxPortfolioExposure: v as number }))
              }
              getValue={(v) => `${v}%`}
              className="max-w-full"
              size="sm"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Maximum percentage of balance that can be used for open positions
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Enabled Strategies
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Select one or more strategies for this profile to run
            </p>
            <CheckboxGroup
              value={form.enabledStrategies}
              onValueChange={(values) =>
                setForm((f) => ({
                  ...f,
                  enabledStrategies: values.length > 0 ? values : ['value-betting'],
                }))
              }
            >
              {STRATEGY_META.map((s) => (
                <Checkbox key={s.key} value={s.key} size="sm">
                  <span className="text-sm">{s.label}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 ml-1.5">
                    — {s.description}
                  </span>
                </Checkbox>
              ))}
            </CheckboxGroup>
          </div>

          {displayError && (
            <p className="text-sm text-danger">{displayError}</p>
          )}
          {success && (
            <p className="text-sm text-success">{success}</p>
          )}
        </ModalBody>

        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            Cancel
          </Button>
          <Button color="primary" onPress={handleSave} isLoading={saving}>
            {isEditMode ? 'Update Profile' : 'Create Profile'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
