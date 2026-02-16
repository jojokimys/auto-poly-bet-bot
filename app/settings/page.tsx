'use client';

import { useEffect, useState } from 'react';
import {
  Card,
  CardBody,
  Button,
  Spinner,
  useDisclosure,
} from '@heroui/react';
import { useProfileStore, type ProfilePublic } from '@/store/useProfileStore';
import { useGlobalBotStore } from '@/store/useGlobalBotStore';
import { ProfileModal } from '@/components/ProfileModal';
import { ProfileCard } from '@/components/ProfileCard';

export default function SettingsPage() {
  const { profiles, loading: profilesLoading, error: profilesError, success: profilesSuccess, fetchProfiles, clearMessages } =
    useProfileStore();

  const { isOpen: isModalOpen, onOpen: onModalOpen, onClose: onModalClose } = useDisclosure();
  const [editingProfile, setEditingProfile] = useState<ProfilePublic | null>(null);
  const botStates = useGlobalBotStore((s) => s.states);
  const globalPoll = useGlobalBotStore((s) => s.poll);
  const [botActionLoading, setBotActionLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

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

  if (profilesLoading) {
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
