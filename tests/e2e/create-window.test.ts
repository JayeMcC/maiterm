/**
 * E2E: exercise the "New Window" flow end-to-end and prove the new webview
 * isn't blank.
 *
 * The regression this covers: Cmd+N (or a menu click) would open a window
 * whose Svelte layout never finished `workspacesStore.load()` because its
 * WindowData entry vanished under a competing writer (side-by-side installs
 * of the fork racing on the same state file). The window stayed on the
 * loading logo — visually "blank and white" — and no error surfaced.
 *
 * The test:
 *  1. Boots maiTerm and connects over MCP.
 *  2. Snapshots the initial listWindows count.
 *  3. Calls the `createWindow` MCP tool with a readiness wait.
 *  4. Asserts the tool reports `frontendReady: true` (webview registered +
 *     state entry survived), and that listWindows now shows one more window
 *     with the returned label.
 *
 * `frontendReady` is the CI-friendly proxy for "the webview rendered, not
 * blank" — it's true only after the Svelte layout has re-loaded its
 * WindowData successfully. A pixel-diff screenshot would also work, but
 * it's noisy on cross-machine renders; the DOM-round-trip is deterministic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnMaiterm, type MaitermHandle } from './harness/spawn.ts';
import { McpClient } from './harness/mcp-client.ts';

const BIN = process.env.MAITERM_BINARY;

if (!BIN) {
  describe.skip('maiTerm createWindow E2E (MAITERM_BINARY not set)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('maiTerm createWindow E2E', () => {
    let handle: MaitermHandle;
    let client: McpClient;

    beforeAll(async () => {
      handle = await spawnMaiterm({ binary: BIN!, timeoutMs: 90_000 });
      client = new McpClient(handle.lock);
      await client.initialize();
    }, 180_000);

    afterAll(async () => {
      if (handle) await handle.kill();
    });

    it('advertises the createWindow tool', async () => {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('createWindow');
    });

    it('createWindow opens a webview whose frontend reaches ready', async () => {
      // Snapshot how many windows exist before we spawn one so we can assert
      // the delta rather than a specific count (initial windows depend on
      // whatever state file the runner inherited).
      const before = client.parseToolResult<{ windows: { windowLabel: string }[] }>(
        await client.callTool('listWindows', {}),
      );
      const beforeLabels = new Set(before.windows.map(w => w.windowLabel));

      const created = client.parseToolResult<{
        windowLabel: string;
        frontendReady: boolean;
        webviewOpen: boolean;
        stateEntryPresent: boolean;
      }>(await client.callTool('createWindow', { readyTimeoutMs: 15_000 }));

      // The regression: `stateEntryPresent` flipped to false when a
      // sibling process (upstream maiTerm sharing com.aiterm.app) clobbered
      // the state file after we pushed the new WindowData but before its
      // webview looked it up. If this fails on CI, the fork isolation
      // (state/persistence.rs::app_data_slug) has regressed.
      expect(created.stateEntryPresent).toBe(true);
      expect(created.webviewOpen).toBe(true);
      expect(created.frontendReady).toBe(true);
      expect(created.windowLabel).toMatch(/^window-[0-9a-f-]+$/);

      // Now confirm the frontend sees it too.
      const after = client.parseToolResult<{
        windows: { windowLabel: string; workspaceCount: number }[];
      }>(await client.callTool('listWindows', {}));
      expect(after.windows.length).toBe(before.windows.length + 1);
      const added = after.windows.find(w => !beforeLabels.has(w.windowLabel));
      expect(added).toBeDefined();
      expect(added!.windowLabel).toBe(created.windowLabel);
      // A fresh window ships with one default workspace; if this is 0 the
      // WindowData constructor is broken (or state got trimmed under us).
      expect(added!.workspaceCount).toBeGreaterThan(0);
    }, 60_000);
  });
}
