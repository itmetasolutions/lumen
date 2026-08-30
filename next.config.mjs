/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Emits .next/standalone with a self-contained server.js and only the
  // node_modules it actually needs. This is what Electron boots as a child
  // process — without it the packaged app would have to ship all of node_modules.
  output: 'standalone',
  serverExternalPackages: ['playwright-core', 'exceljs', 'bullmq', 'ioredis'],
  experimental: {
    // Route handlers that stream exports need a generous body/time budget.
    proxyTimeout: 120_000,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
}

export default nextConfig
