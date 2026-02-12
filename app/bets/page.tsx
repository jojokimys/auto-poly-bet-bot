'use client';

import { useEffect } from 'react';
import { Card, CardBody, CardHeader, Input, Spinner } from '@heroui/react';
import { MarketCard } from '@/components/MarketCard';
import { MarketDetail } from '@/components/MarketDetail';
import { useMarketStore } from '@/store/useMarketStore';

export default function BetsPage() {
  const {
    loading,
    error,
    searchQuery,
    selectedMarket,
    fetchMarkets,
    setSearchQuery,
    setSelectedMarket,
    filteredMarkets,
  } = useMarketStore();

  useEffect(() => {
    fetchMarkets(100);
  }, [fetchMarkets]);

  const markets = filteredMarkets();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Markets</h2>
      </div>

      <Input
        placeholder="Search markets..."
        value={searchQuery}
        onValueChange={setSearchQuery}
        size="lg"
        variant="bordered"
        startContent={
          <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner size="lg" />
            </div>
          ) : error ? (
            <Card>
              <CardBody>
                <p className="text-danger">{error}</p>
              </CardBody>
            </Card>
          ) : markets.length === 0 ? (
            <Card>
              <CardBody>
                <p className="text-gray-500">
                  {searchQuery ? 'No markets match your search' : 'No active markets found'}
                </p>
              </CardBody>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {markets.map((market) => (
                <MarketCard
                  key={market.conditionId}
                  market={market}
                  onClick={setSelectedMarket}
                />
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-1">
          {selectedMarket ? (
            <MarketDetail market={selectedMarket} />
          ) : (
            <Card>
              <CardHeader>
                <h3 className="text-lg font-semibold">Market Detail</h3>
              </CardHeader>
              <CardBody>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Click a market to view details and place orders.
                </p>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
