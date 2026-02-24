/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@polymarket/clob-client', 'ethers', 'ws', 'bufferutil', 'utf-8-validate'],
  experimental: {
    instrumentationHook: true,
  },
  // Disable fetch response caching to prevent disk bloat (server-side API calls)
  fetchCache: 'default-no-store',
}

module.exports = nextConfig
