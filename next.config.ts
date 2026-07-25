import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Emits .next/standalone with only the files the server actually needs,
  // which keeps the production image around 150MB instead of 1GB.
  output: 'standalone',
}

export default nextConfig
