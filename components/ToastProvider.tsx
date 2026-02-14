'use client';

import { Toaster } from 'sonner';
import { useAppStore } from '@/store/useAppStore';

export function ToastProvider() {
  const theme = useAppStore((state) => state.theme);

  return (
    <Toaster
      theme={theme as 'light' | 'dark'}
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{
        duration: 5000,
      }}
    />
  );
}
