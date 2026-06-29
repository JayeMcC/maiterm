/**
 * E2E: spawn a real maiTerm binary, connect via MCP, call the new
 * `openTab` and `sendKeysToTab` tools, assert that maiTerm's state
 * actually reflects the operations.
 *
 * The runner sets MAITERM_BINARY to the path of the built debug binary
 * (see .github/workflows/e2e.yml). For local runs, set the same env var
 * to the binary you want to drive.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnMaiterm, type MaitermHandle } from './harness/spawn.ts';
import { McpClient } from './harness/mcp-client.ts';

const BIN = process.env.MAITERM_BINARY;

if (!BIN) {
  // Skip the suite when run outside the CI / local-with-env shape. Better
  // than failing loudly: developers running `npm test` casually shouldn't
  // need a built binary on disk.
  describe.skip('maiTerm E2E (MAITERM_BINARY not set)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('maiTerm E2E', () => {
    let handle: MaitermHandle;
    let client: McpClient;

    beforeAll(async () => {
      const t0 = Date.now();
      const log = (msg: string) =>
        // eslint-disable-next-line no-console
        console.error(`[e2e beforeAll +${Date.now() - t0}ms] ${msg}`);
      log('spawning maiTerm');
      handle = await spawnMaiterm({ binary: BIN!, timeoutMs: 90_000 });
      log(`spawned, port=${handle.lock.serverPort}`);
      client = new McpClient(handle.lock);
      log('initializing client');
      await client.initialize();
      log('client initialized, waiting for frontend listener');
      // Crucial: Tauri events emitted before the agent-ide-tool listener
      // is registered are dropped, not queued. The Svelte layout's
      // onMount registers the listener; this poll spins until a
      // frontend-handled tool actually responds, proving the listener
      // is up. Without this, the first openTab call races the listener
      // (~1s after maiTerm starts) and silently hangs.
      await client.waitForFrontendReady({ timeoutMs: 60_000 });
      log('beforeAll done');
    }, 180_000);

    afterAll(async () => {
      if (handle) await handle.kill();
    });

    it('advertises the new openTab and sendKeysToTab tools', async () => {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('openTab');
      expect(names).toContain('sendKeysToTab');
    });

    it('openTab creates a named terminal tab', async () => {
      const result = await client.callTool('openTab', { name: 'e2e-spawn-test' });
      expect(result.isError).toBeFalsy();
      const parsed = client.parseToolResult<{
        action: 'created' | 'focused';
        tabId: string;
        displayName: string;
      }>(result);
      expect(parsed.action).toBe('created');
      expect(parsed.tabId).toBeTruthy();
      expect(parsed.displayName).toBe('e2e-spawn-test');
    });

    it('openTab with reuseExisting focuses the existing tab', async () => {
      // First call: create
      const first = client.parseToolResult<{ tabId: string; action: string }>(
        await client.callTool('openTab', { name: 'e2e-reuse-test' }),
      );
      expect(first.action).toBe('created');
      // Second call with reuseExisting: should focus the same tab.
      const second = client.parseToolResult<{ tabId: string; action: string }>(
        await client.callTool('openTab', {
          name: 'e2e-reuse-test',
          reuseExisting: true,
        }),
      );
      expect(second.action).toBe('focused');
      expect(second.tabId).toBe(first.tabId);
    });

    it('sendKeysToTab writes into a tab created via openTab', async () => {
      const opened = client.parseToolResult<{ tabId: string; ptyId: string | null }>(
        await client.callTool('openTab', { name: 'e2e-sendkeys-test' }),
      );
      expect(opened.tabId).toBeTruthy();
      // The Terminal component spawns the PTY shortly after the tab is
      // created; give it a moment to settle before writing.
      await new Promise(r => setTimeout(r, 500));
      const sent = client.parseToolResult<{ success: boolean; bytes: number }>(
        await client.callTool('sendKeysToTab', {
          tabId: opened.tabId,
          text: 'echo hello-from-e2e\n',
        }),
      );
      expect(sent.success).toBe(true);
      expect(sent.bytes).toBeGreaterThan(0);
    });
  });
}
