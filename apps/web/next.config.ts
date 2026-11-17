import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** Where the Next server proxies /api/* to (inside docker: http://api:4000). */
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  // Docker sets NEXT_OUTPUT=standalone; the standalone trace needs symlinks, which plain Windows lacks.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  outputFileTracingRoot: path.join(__dirname, '../../'),
  reactStrictMode: true,
  // Compression buffers chunks and would delay server-sent events.
  compress: false,
  poweredByHeader: false,
  // Linting runs as its own step (pnpm lint / CI), not inside next build.
  eslint: { ignoreDuringBuilds: true },
  // Same-origin API access: the session cookie works without CORS, locally and in docker.
  rewrites: () =>
    Promise.resolve([{ source: '/api/:path*', destination: `${API_INTERNAL_URL}/:path*` }]),
};

export default withNextIntl(nextConfig);
