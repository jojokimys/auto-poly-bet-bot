import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/ThemeProvider';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { HeroUIProvider } from '@heroui/react';

export const metadata: Metadata = {
  title: 'Auto Poly Bet Bot',
  description: 'Automated betting bot for Polymarket',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <HeroUIProvider>
          <ThemeProvider>
            <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
              <Header />
              <div className="flex">
                <Sidebar />
                <main className="flex-1 p-6">
                  {children}
                </main>
              </div>
            </div>
          </ThemeProvider>
        </HeroUIProvider>
      </body>
    </html>
  );
}
