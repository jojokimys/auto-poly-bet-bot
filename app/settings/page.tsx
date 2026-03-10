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
import { ProfileModal } from '@/components/ProfileModal';
import { ProfileCard } from '@/components/ProfileCard';

export default function SettingsPage() {
  const { profiles, loading: profilesLoading, error: profilesError, success: profilesSuccess, fetchProfiles, clearMessages } =
    useProfileStore();

  const { isOpen: isModalOpen, onOpen: onModalOpen, onClose: onModalClose } = useDisclosure();
  const [editingProfile, setEditingProfile] = useState<ProfilePublic | null>(null);

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
  };

  const handleProfileDeleted = () => {
    fetchProfiles();
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

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Bot Profiles
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Manage trading profiles with separate wallets
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

        {profiles.length === 0 ? (
          <Card>
            <CardBody className="py-12 text-center">
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
                onEdit={handleEditProfile}
                onDeleted={handleProfileDeleted}
              />
            ))}
          </div>
        )}
      </div>

      <ProfileModal
        isOpen={isModalOpen}
        onClose={onModalClose}
        profile={editingProfile}
        onSaved={handleProfileSaved}
      />
    </div>
  );
}
