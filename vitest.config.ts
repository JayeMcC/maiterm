import { defineConfig } from 'vitest/config';

// Standalone Vitest config — deliberately does NOT extend vite.config.ts (no SvelteKit
// plugin), so pure-logic modules (e.g. agentDelivery.ts) run in plain Node with no runes
// compilation or $lib alias resolution. Unit tests live next to their module as *.test.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
