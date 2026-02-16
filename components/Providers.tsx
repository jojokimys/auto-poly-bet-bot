'use client';

import { HeroUIProvider } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastProvider } from '@/components/ToastProvider';

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  return (
    <HeroUIProvider navigate={router.push}>
      <ThemeProvider>
        {children}
        <ToastProvider />
      </ThemeProvider>
    </HeroUIProvider>
  );
}
