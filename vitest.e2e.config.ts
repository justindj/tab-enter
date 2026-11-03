import { defineConfig } from 'vitest/config';

// End-to-end tests of tab-enter itself: `pnpm test:e2e` starts the real app
// (web + worker) in demo mode on a spare port with a throwaway data folder and
// drives it with Playwright in the installed Edge or Chrome.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
