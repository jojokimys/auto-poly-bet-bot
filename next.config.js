/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@polymarket/clob-client', 'ethers'],
  experimental: {
    instrumentationHook: true,
  },
}

module.exports = nextConfig
