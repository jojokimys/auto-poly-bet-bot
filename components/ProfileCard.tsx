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
  botState?: {
    status: string;
    cycleCount: number;
    ordersPlaced: number;
    lastScanAt: string | null;
  } | null;
  onEdit: (profile: ProfilePublic) => void;
  onDeleted: () => void;
  onBotAction: (profileId: string, action: 'start' | 'stop') => void;
  botLoading?: boolean;
}

function truncateAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr || '--';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function strategyLabel(strategy: string): string {
  const labels: Record<string, string> = {
    'value-betting': 'Value Betting',
    'near-expiry-sniper': 'Near Expiry Sniper',
    'micro-scalper': 'Micro Scalper',
    'complement-arb': 'Complement Arb',
    'panic-reversal': 'Panic Reversal',
    'crypto-latency': 'Crypto Latency Arb',
    'multi-outcome-arb': 'Multi-Outcome Arb',
    'crypto-scalper': 'Crypto Scalper',
  };
  return labels[strategy] || strategy;
}

export function ProfileCard({
  profile,
  botState,
  onEdit,
  onDeleted,
  onBotAction,
  botLoading,
}: ProfileCardProps) {
  const { deleteProfile, updateProfile } = useProfileStore();
  const { isOpen: isDeleteOpen, onOpen: onDeleteOpen, onClose: onDeleteClose } = useDisclosure();
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const isBotRunning = botState?.status === 'running';

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
    onDeleted(); // Reuse callback to trigger refresh
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
          <div className="flex items-center gap-2">
            <Chip
              size="sm"
              variant="flat"
              color={profile.isActive ? 'success' : 'default'}
            >
              {profile.isActive ? 'Active' : 'Inactive'}
            </Chip>
          </div>
        </CardHeader>

        <CardBody className="pt-0 space-y-3">
          {/* Configuration chips */}
          <div className="flex flex-wrap gap-1.5">
            <Chip
              size="sm"
              variant="flat"
              color="secondary"
            >
              {strategyLabel(profile.strategy)}
            </Chip>
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

          {/* Key setup prompt */}
          {(!profile.hasPrivateKey || !profile.hasApiCredentials) && (
            <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg px-3 py-2">
              <svg className="w-4 h-4 text-warning flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <p className="text-xs text-warning-700 dark:text-warning-300 flex-1">
                {!profile.hasPrivateKey && !profile.hasApiCredentials
                  ? 'Wallet and API keys required to start trading'
                  : !profile.hasPrivateKey
                    ? 'Wallet private key required to start trading'
                    : 'API credentials required to start trading'}
              </p>
              <Button
                size="sm"
                color="warning"
                variant="flat"
                onPress={() => onEdit(profile)}
              >
                Setup Keys
              </Button>
            </div>
          )}

          {/* Bot state summary (if running) */}
          {botState && isBotRunning && (
            <div className="grid grid-cols-3 gap-2 text-xs bg-gray-50 dark:bg-gray-800/50 rounded-lg p-2">
              <div>
                <span className="text-gray-500 dark:text-gray-400">Cycles</span>
                <p className="font-semibold text-gray-900 dark:text-white">
                  {botState.cycleCount}
                </p>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400">Orders</span>
                <p className="font-semibold text-gray-900 dark:text-white">
                  {botState.ordersPlaced}
                </p>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400">Last Scan</span>
                <p className="font-semibold text-gray-900 dark:text-white">
                  {botState.lastScanAt ? formatTime(botState.lastScanAt) : '--'}
                </p>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="flat"
              color={isBotRunning ? 'danger' : 'success'}
              isLoading={botLoading}
              isDisabled={!profile.isActive || !profile.hasPrivateKey || !profile.hasApiCredentials}
              onPress={() => onBotAction(profile.id, isBotRunning ? 'stop' : 'start')}
            >
              {isBotRunning ? 'Stop' : 'Start'}
            </Button>
            <Button
              size="sm"
              variant="light"
              onPress={() => onEdit(profile)}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="light"
              isLoading={toggling}
              onPress={handleToggleActive}
            >
              {profile.isActive ? 'Deactivate' : 'Activate'}
            </Button>
            <Button
              size="sm"
              variant="light"
              color="danger"
              onPress={onDeleteOpen}
            >
              Delete
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* Delete confirmation modal */}
      <Modal isOpen={isDeleteOpen} onClose={onDeleteClose} size="sm">
        <ModalContent>
          <ModalHeader>
            <h3 className="text-lg font-semibold">Delete Profile</h3>
          </ModalHeader>
          <ModalBody>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              Are you sure you want to delete <strong>{profile.name}</strong>? This action
              cannot be undone. Any running bot for this profile will be stopped.
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onDeleteClose}>
              Cancel
            </Button>
            <Button color="danger" onPress={handleDelete} isLoading={deleting}>
              Delete
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
