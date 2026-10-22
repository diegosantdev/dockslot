import type { NextConfig } from 'next';
const config: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/v1/:path*',
        destination: `${process.env.API_INTERNAL_URL || 'http://localhost:4000'}/v1/:path*`,
      },
    ];
  },
};
export default config;
