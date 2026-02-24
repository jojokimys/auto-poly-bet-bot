import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/Providers';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';

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
        <Providers>
          <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
            <Header />
            <div className="flex">
              <Sidebar />
              <main className="flex-1 min-w-0 p-6 overflow-hidden">
                {children}
              </main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
