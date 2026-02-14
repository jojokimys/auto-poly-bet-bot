'use client';

import { useEffect, useState } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  Input,
  Button,
  Checkbox,
  Divider,
  Spinner,
  useDisclosure,
} from '@heroui/react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useProfileStore, type ProfilePublic } from '@/store/useProfileStore';
import { useGlobalBotStore } from '@/store/useGlobalBotStore';
import { ProfileModal } from '@/components/ProfileModal';
import { ProfileCard } from '@/components/ProfileCard';

export default function SettingsPage() {
  const { settings, loading: settingsLoading, saving, error: settingsError, success: settingsSuccess, fetchSettings, saveSettings } =
    useSettingsStore();

  const { profiles, loading: profilesLoading, error: profilesError, success: profilesSuccess, fetchProfiles, clearMessages } =
    useProfileStore();

  const { isOpen: isModalOpen, onOpen: onModalOpen, onClose: onModalClose } = useDisclosure();
  const [editingProfile, setEditingProfile] = useState<ProfilePublic | null>(null);
  const botStates = useGlobalBotStore((s) => s.states);
  const globalPoll = useGlobalBotStore((s) => s.poll);
  const [botActionLoading, setBotActionLoading] = useState<string | null>(null);

  const [form, setForm] = useState({
    maxBetAmount: '10',
    minLiquidity: '1000',
    minVolume: '5000',
    maxSpread: '0.05',
    autoBettingEnabled: false,
    scanIntervalSeconds: '30',
  });

  useEffect(() => {
    fetchSettings();
    fetchProfiles();
  }, [fetchSettings, fetchProfiles]);

  useEffect(() => {
    if (settings) {
      setForm({
        maxBetAmount: String(settings.maxBetAmount),
        minLiquidity: String(settings.minLiquidity),
        minVolume: String(settings.minVolume),
        maxSpread: String(settings.maxSpread),
        autoBettingEnabled: settings.autoBettingEnabled,
        scanIntervalSeconds: String(settings.scanIntervalSeconds),
      });
    }
  }, [settings]);

  // Bot states come from global store (polled by HeaderBotStatus)

  const handleSaveSettings = async () => {
    const data: Record<string, unknown> = {};
    data.maxBetAmount = parseFloat(form.maxBetAmount) || 10;
    data.minLiquidity = parseFloat(form.minLiquidity) || 1000;
    data.minVolume = parseFloat(form.minVolume) || 5000;
    data.maxSpread = parseFloat(form.maxSpread) || 0.05;
    data.autoBettingEnabled = form.autoBettingEnabled;
    data.scanIntervalSeconds = parseInt(form.scanIntervalSeconds) || 30;
    await saveSettings(data);
  };

  const handleAddProfile = () => {
    setEditingProfile(null);
    clearMessages();
    onModalOpen();
  };

  const handleEditProfile = (profile: ProfilePublic) => {
    setEditingProfile(profile);
    clearMessages();
    onModalOpen();
  };

  const handleProfileSaved = () => {
    fetchProfiles();
    globalPoll();
  };

  const handleProfileDeleted = () => {
    fetchProfiles();
    globalPoll();
  };

  const handleBotAction = async (profileId: string, action: 'start' | 'stop') => {
    setBotActionLoading(profileId);
    try {
      const res = await fetch('/api/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, profileId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Failed to ${action} bot`);
      }
      await globalPoll();
    } catch (err) {
      console.error(`Bot ${action} failed:`, err);
    }
    setBotActionLoading(null);
  };

  if (settingsLoading && profilesLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h2>

      {/* ===== Bot Profiles Section ===== */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Bot Profiles
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Manage trading profiles with separate wallets and strategies
            </p>
          </div>
          <Button color="primary" size="sm" onPress={handleAddProfile}>
            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Profile
          </Button>
        </div>

        {profilesError && (
          <p className="text-sm text-danger">{profilesError}</p>
        )}
        {profilesSuccess && (
          <p className="text-sm text-success">{profilesSuccess}</p>
        )}

        {profilesLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <Card key={i}>
                <CardBody className="space-y-3">
                  <div className="h-5 w-32 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
                  <div className="h-4 w-48 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
                  <div className="flex gap-2">
                    <div className="h-6 w-20 bg-gray-200 dark:bg-gray-700 rounded-full animate-pulse" />
                    <div className="h-6 w-24 bg-gray-200 dark:bg-gray-700 rounded-full animate-pulse" />
                  </div>
                  <div className="flex gap-2 pt-2">
                    <div className="h-8 w-16 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
                    <div className="h-8 w-12 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
                    <div className="h-8 w-16 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        ) : profiles.length === 0 ? (
          <Card>
            <CardBody className="py-12 text-center">
              <svg
                className="w-12 h-12 mx-auto mb-4 text-gray-300 dark:text-gray-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
              <p className="text-gray-500 dark:text-gray-400 mb-2">
                No profiles yet. Add one to start trading.
              </p>
              <Button color="primary" size="sm" variant="flat" onPress={handleAddProfile}>
                Create Your First Profile
              </Button>
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {profiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                botState={botStates[profile.id] || null}
                onEdit={handleEditProfile}
                onDeleted={handleProfileDeleted}
                onBotAction={handleBotAction}
                botLoading={botActionLoading === profile.id}
              />
            ))}
          </div>
        )}
      </div>

      <Divider />

      {/* ===== Global Bot Parameters Section ===== */}
      <Card>
        <CardHeader>
          <div>
            <h3 className="text-lg font-semibold">Global Bot Parameters</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Default parameters applied to all bot profiles
            </p>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
              label="Scan Interval (seconds)"
              variant="bordered"
              value={form.scanIntervalSeconds}
              onValueChange={(v) => setForm((f) => ({ ...f, scanIntervalSeconds: v }))}
            />
          </div>
          <Checkbox
            isSelected={form.autoBettingEnabled}
            onValueChange={(v) => setForm((f) => ({ ...f, autoBettingEnabled: v }))}
          >
            Enable automatic betting
          </Checkbox>
        </CardBody>
      </Card>

      {settingsError && <p className="text-sm text-danger">{settingsError}</p>}
      {settingsSuccess && <p className="text-sm text-success">{settingsSuccess}</p>}

      <Button color="primary" className="w-full" onPress={handleSaveSettings} isLoading={saving}>
        Save Global Settings
      </Button>

      {/* Profile Modal */}
      <ProfileModal
        isOpen={isModalOpen}
        onClose={onModalClose}
        profile={editingProfile}
        onSaved={handleProfileSaved}
      />
    </div>
  );
}
