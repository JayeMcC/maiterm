import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Embed build identity into the frontend bundle so the running app can log
// exactly which source it was built from (white-screen triage: "is this the
// latest?"). Kept in sync with the Rust-side MAITERM_GIT_SHA (build.rs).
function gitSha(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    const dirty = execSync('git status --porcelain').toString().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}
const appVersion = (() => {
  try {
    return JSON.parse(readFileSync('package.json', 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export default defineConfig({
  plugins: [sveltekit()],
  define: {
    __GIT_SHA__: JSON.stringify(gitSha()),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Only ignore src-tauri; Vite already ignores node_modules/.git.
      // Note: editing project files in the maiTerm editor tab will trigger
      // HMR in dev mode — this is expected and harmless in production.
      ignored: ['**/src-tauri/**'],
    },
  },
});
