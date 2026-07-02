/// <reference types="@sveltejs/kit" />

declare global {
  namespace App {}
  // Build-identity constants injected by vite.config.ts `define`.
  const __GIT_SHA__: string;
  const __APP_VERSION__: string;
}

export {};
