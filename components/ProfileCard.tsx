'use client';

import { useState } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  Button,
  Chip,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from '@heroui/react';
import { useProfileStore, type ProfilePublic } from '@/store/useProfileStore';

interface ProfileCardProps {
  profile: ProfilePublic;
  onEdit: (profile: ProfilePublic) => void;
  onDeleted: () => void;
}

function truncateAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr || '--';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function ProfileCard({ profile, onEdit, onDeleted }: ProfileCardProps) {
  const { deleteProfile, updateProfile } = useProfileStore();
  const { isOpen: isDeleteOpen, onOpen: onDeleteOpen, onClose: onDeleteClose } = useDisclosure();
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    const ok = await deleteProfile(profile.id);
    setDeleting(false);
    if (ok) {
      onDeleteClose();
      onDeleted();
    }
  };

  const handleToggleActive = async () => {
    setToggling(true);
    await updateProfile(profile.id, { isActive: !profile.isActive });
    setToggling(false);
    onDeleted();
  };

  return (
    <>
      <Card className="w-full">
        <CardHeader className="flex justify-between items-start pb-2">
          <div className="flex flex-col gap-1">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
              {profile.name}
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">
              {truncateAddress(profile.funderAddress)}
            </p>
          </div>
          <Chip
            size="sm"
            variant="flat"
            color={profile.isActive ? 'success' : 'default'}
          >
            {profile.isActive ? 'Active' : 'Inactive'}
          </Chip>
        </CardHeader>

        <CardBody className="pt-0 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            <Chip size="sm" variant="flat" color={profile.hasPrivateKey ? 'success' : 'warning'}>
              {profile.hasPrivateKey ? 'Wallet configured' : 'Wallet not set'}
            </Chip>
            <Chip size="sm" variant="flat" color={profile.hasApiCredentials ? 'success' : 'warning'}>
              {profile.hasApiCredentials ? 'API keys set' : 'API keys not set'}
            </Chip>
            <Chip size="sm" variant="flat" color={profile.hasBuilderCredentials ? 'success' : 'warning'}>
              {profile.hasBuilderCredentials ? 'Builder keys set' : 'Builder keys not set'}
            </Chip>
          </div>

          {(!profile.hasPrivateKey || !profile.hasApiCredentials) && (
            <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg px-3 py-2">
              <p className="text-xs text-warning-700 dark:text-warning-300 flex-1">
                {!profile.hasPrivateKey && !profile.hasApiCredentials
                  ? 'Wallet and API keys required'
                  : !profile.hasPrivateKey
                    ? 'Wallet private key required'
                    : 'API credentials required'}
              </p>
              <Button size="sm" color="warning" variant="flat" onPress={() => onEdit(profile)}>
                Setup Keys
              </Button>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant="light" onPress={() => onEdit(profile)}>
              Edit
            </Button>
            <Button size="sm" variant="light" isLoading={toggling} onPress={handleToggleActive}>
              {profile.isActive ? 'Deactivate' : 'Activate'}
            </Button>
            <Button size="sm" variant="light" color="danger" onPress={onDeleteOpen}>
              Delete
            </Button>
          </div>
        </CardBody>
      </Card>

      <Modal isOpen={isDeleteOpen} onClose={onDeleteClose} size="sm">
        <ModalContent>
          <ModalHeader>Delete Profile</ModalHeader>
          <ModalBody>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              Are you sure you want to delete <strong>{profile.name}</strong>? This cannot be undone.
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onDeleteClose}>Cancel</Button>
            <Button color="danger" onPress={handleDelete} isLoading={deleting}>Delete</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
