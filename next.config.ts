import type { NextConfig } from 'next';
import { normalizeBasePath } from './src/lib/basePath.ts';

const basePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

const nextConfig: NextConfig = {
  // src/pages/ holds component files, not Next.js Pages Router pages
  pageExtensions: ['tsx', 'ts'],

  /**
   * Emit a self-contained server bundle for the container image.
   *
   * Without this the runtime image has to carry the whole `node_modules` tree —
   * the AWS SDK alone is most of it. `standalone` traces what the server
   * actually imports and copies only that, which is the difference between an
   * image around 200 MB and one over a gigabyte.
   */
  output: 'standalone',

  /**
   * Serve under a sub-path (`/stats`) instead of the root, for an installation
   * with one host name. A build-time setting: see `src/lib/basePath.ts`.
   * Pages, links, static files and the API all move under it, and nothing is
   * served outside it.
   */
  ...(basePath ? { basePath } : {}),

  // The image is built once and run anywhere, so the version has to come from
  // the build rather than from a file read at runtime.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_APP_VERSION: process.env.npm_package_version ?? '0.0.0',
  },

  /**
   * Three headers on every response, none of which can break a page.
   *
   * The addresses here contain room and call ids, so they are not sent along
   * to other sites as a referrer. The dashboard has no reason to be shown
   * inside another site's frame, where a click could be steered. And a browser
   * should take a response for the type it says it is.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default nextConfig;
