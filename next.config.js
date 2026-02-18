/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@polymarket/clob-client', 'ethers', 'ws', 'bufferutil', 'utf-8-validate'],
  experimental: {
    instrumentationHook: true,
  },
}

module.exports = nextConfig
