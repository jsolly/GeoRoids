import type { VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  framework: null,
  buildCommand: 'npm run build',
  git: {
    deploymentEnabled: {
      main: true,
      '*': false,
      '*/*': false,
      '*/*/*': false,
      '*/*/*/*': false,
      '**': false,
    },
  },
  headers: [
    {
      source: '/(.*)',
      headers: [
        {
          key: 'Link',
          value:
            '<https://context7.com/api/v2/ask?siteKey=ask_10533b7684feb0762503b0e7>; rel="search"; type="text/plain"; title="Search georoids.com"',
        },
      ],
    },
    {
      source: '/debug/:path*',
      headers: [
        {
          key: 'X-Robots-Tag',
          value: 'noindex, nofollow',
        },
      ],
    },
    {
      source: '/release.json',
      headers: [
        {
          key: 'Cache-Control',
          value: 'no-store',
        },
      ],
    },
    {
      source: '/client-assets.json',
      headers: [
        {
          key: 'Cache-Control',
          value: 'no-store',
        },
      ],
    },
  ],
};
