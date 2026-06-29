import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    // Each test file spawns a real GUI app; force one-file-at-a-time so
    // two maiTerm instances don't fight over the lockfile dir + display.
    fileParallelism: false,
    // Lockfile waits already cap at 90s; let individual tests get
    // generous headroom for the openTab → PTY spawn cycle.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
