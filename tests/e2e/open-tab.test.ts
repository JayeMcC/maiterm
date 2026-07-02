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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      handle = await spawnMaiterm({ binary: BIN!, timeoutMs: 90_000 });
      client = new McpClient(handle.lock);
      await client.initialize();
      // No waitForFrontendReady poll here: the server-side queue in
      // pending_frontend_emits (state/app_state.rs) holds frontend-emitted
      // tool calls that land before the layout's listener attaches, and
      // mark_frontend_ready flushes them once `appWindow.listen` resolves.
      // If this test passes without the poll, the queue fix is working
      // end-to-end. If it hangs, the fix isn't sufficient — add the
      // poll back as a workaround and dig into the server.
    }, 180_000);

    afterAll(async () => {
      if (handle) await handle.kill();
    });

    it('advertises the new openTab and sendKeysToTab tools', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
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
      const first = client.parseToolResult<{ tabId: string; action: string }>(await client.callTool('openTab', { name: 'e2e-reuse-test' }));
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
      const opened = client.parseToolResult<{ tabId: string; ptyId: string | null }>(await client.callTool('openTab', { name: 'e2e-sendkeys-test' }));
      expect(opened.tabId).toBeTruthy();
      // The Terminal component spawns the PTY shortly after the tab is
      // created; give it a moment to settle before writing.
      await new Promise((r) => setTimeout(r, 500));
      const sent = client.parseToolResult<{ success: boolean; bytes: number }>(
        await client.callTool('sendKeysToTab', {
          tabId: opened.tabId,
          text: 'echo hello-from-e2e\n',
        }),
      );
      expect(sent.success).toBe(true);
      expect(sent.bytes).toBeGreaterThan(0);
    });

    /** Poll getTabContext until `needle` shows up in the tab's content. */
    async function waitForTabContent(tabId: string, needle: string, timeoutMs = 20_000): Promise<boolean> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const res = client.parseToolResult<{ tabs: Array<{ id?: string; content?: string }> }>(await client.callTool('getTabContext', { tabIds: [tabId], lines: 50 }));
        const tab = Array.isArray(res.tabs) ? res.tabs[0] : undefined;
        if (tab?.content?.includes(needle)) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    }

    // Regression: rapid successive openTab calls used to steal pane focus
    // from each other, so earlier tabs never mounted and their commands were
    // dropped — sometimes with no warning at all (fork issue #3). The fix
    // queues the command (take-once) and force-activates the tab.
    it('openTab delivers commands on ALL tabs created in rapid succession', async () => {
      const opened: Array<{ tabId: string; marker: string }> = [];
      for (const n of [1, 2, 3]) {
        const marker = `e2e-burst-marker-${n}`;
        const r = client.parseToolResult<{ tabId: string; ptyId: string | null; queued?: boolean }>(
          await client.callTool('openTab', { name: `e2e-burst-${n}`, command: `echo ${marker}` }),
        );
        expect(r.tabId).toBeTruthy();
        opened.push({ tabId: r.tabId, marker });
      }
      // getTabContext needs a session — borrow the first created tab's id.
      await client.callTool('initSession', { tabId: opened[0]!.tabId });
      for (const { tabId, marker } of opened) {
        expect(await waitForTabContent(tabId, marker), `command output for ${marker} in ${tabId}`).toBe(true);
      }
    });

    // Regression: reuseExisting used to silently skip the command write when
    // the reused tab had no live PTY (fork issue #4). With a live PTY it must
    // rewrite; the result must never drop the command without a queued flag.
    it('openTab reuseExisting re-runs the command on the reused tab', async () => {
      const first = client.parseToolResult<{ tabId: string }>(await client.callTool('openTab', { name: 'e2e-rewrite-test', command: 'echo e2e-rewrite-first' }));
      await client.callTool('initSession', { tabId: first.tabId });
      expect(await waitForTabContent(first.tabId, 'e2e-rewrite-first')).toBe(true);
      const second = client.parseToolResult<{ tabId: string; action: string; ptyId: string | null; queued?: boolean }>(
        await client.callTool('openTab', { name: 'e2e-rewrite-test', command: 'echo e2e-rewrite-second', reuseExisting: true }),
      );
      expect(second.action).toBe('focused');
      expect(second.tabId).toBe(first.tabId);
      if (!second.queued) expect(second.ptyId).toBeTruthy();
      expect(await waitForTabContent(first.tabId, 'e2e-rewrite-second')).toBe(true);
    });

    // Regression: switchTab did not remount a PTY-less tab, so sendKeysToTab's
    // own "Try switchTab first to remount, then retry" advice never worked
    // (fork issue #5).
    it('switchTab remounts a PTY-less tab so sendKeysToTab succeeds after it', async () => {
      // Create two tabs without commands back-to-back: the second steals pane
      // focus, so the first may never mount (no force-activation without a
      // command — that's the scenario the advice is for).
      const a = client.parseToolResult<{ tabId: string }>(await client.callTool('openTab', { name: 'e2e-remount-a' }));
      const b = client.parseToolResult<{ tabId: string }>(await client.callTool('openTab', { name: 'e2e-remount-b' }));
      expect(b.tabId).toBeTruthy();

      const firstTry = await client.callTool('sendKeysToTab', { tabId: a.tabId, text: 'echo e2e-remount-early\n' });
      const firstParsed = client.parseToolResult<{ success?: boolean; error?: string }>(firstTry);
      if (!firstParsed.success) {
        // Tab never mounted — exactly the bug. Follow the advice: switchTab
        // initiates the remount; the PTY may outlast its wait window under
        // load, so retry sendKeysToTab with patience (the real caller
        // contract) instead of hard-asserting ptyId in the switch result.
        const switched = client.parseToolResult<{ success: boolean; ptyId: string | null }>(await client.callTool('switchTab', { tabId: a.tabId }));
        expect(switched.success).toBe(true);
        const start = Date.now();
        let delivered = false;
        while (Date.now() - start < 20_000 && !delivered) {
          const retry = client.parseToolResult<{ success?: boolean }>(await client.callTool('sendKeysToTab', { tabId: a.tabId, text: 'echo e2e-remount-late\n' }));
          delivered = !!retry.success;
          if (!delivered) await new Promise((r) => setTimeout(r, 1000));
        }
        expect(delivered, 'sendKeysToTab succeeds after switchTab-initiated remount').toBe(true);
      }
      // Either way the tab must be writable by now.
      const final = client.parseToolResult<{ success: boolean }>(await client.callTool('sendKeysToTab', { tabId: a.tabId, text: 'echo e2e-remount-final\n' }));
      expect(final.success).toBe(true);
    });
  });

  // Regression: a tab restored after an app RESTART keeps its persisted
  // pty_id, but that PTY died with the old process. reuseExisting used to
  // trust the stale id and write the command into a dead PTY.
  describe('maiTerm E2E — restart (stale pty_id reuse)', () => {
    /** Find this instance's persisted state file inside its hermetic HOME. */
    function findStateFile(home: string): string | null {
      const base = join(home, 'Library', 'Application Support');
      try {
        for (const dir of readdirSync(base)) {
          const p = join(base, dir, 'aiterm-state.json');
          if (existsSync(p)) return p;
        }
      } catch {
        /* not written yet */
      }
      return null;
    }

    it('reuseExisting delivers the command to a tab restored after a restart', async () => {
      // The test owns the HOME (both spawns receive it) — a spawn-owned HOME
      // would be deleted by the first kill(), leaving nothing to restore.
      const home = mkdtempSync(join(tmpdir(), 'maiterm-e2e-restart-'));
      const first = await spawnMaiterm({ binary: BIN!, timeoutMs: 90_000, home });
      try {
        const c1 = new McpClient(first.lock);
        await c1.initialize();
        const created = c1.parseToolResult<{ tabId: string }>(
          await c1.callTool('openTab', { name: 'e2e-restart-test', command: 'echo e2e-restart-first' }),
        );
        expect(created.tabId).toBeTruthy();

        // Wait for the tab to be persisted before killing, so the second
        // instance genuinely restores it (with its now-stale pty_id).
        const persistStart = Date.now();
        let persisted = false;
        while (Date.now() - persistStart < 20_000 && !persisted) {
          const stateFile = findStateFile(home);
          persisted = !!stateFile && readFileSync(stateFile, 'utf8').includes('e2e-restart-test');
          if (!persisted) await new Promise((r) => setTimeout(r, 500));
        }
        expect(persisted, 'tab persisted to state before restart').toBe(true);
        await first.kill(); // caller-owned home survives

        const second = await spawnMaiterm({ binary: BIN!, timeoutMs: 90_000, home });
        try {
          const c2 = new McpClient(second.lock);
          await c2.initialize();

          // Workspace restore is async after boot; give the frontend a
          // moment to rebuild the tab tree before reusing. (initSession is
          // NOT a valid restore probe — it cannot see a restored tab until
          // that tab has a live PTY again.)
          await new Promise((res) => setTimeout(res, 5000));

          const reused = c2.parseToolResult<{ action: string; tabId: string; ptyId: string | null; queued?: boolean }>(
            await c2.callTool('openTab', { name: 'e2e-restart-test', command: 'echo e2e-restart-second', reuseExisting: true }),
          );
          // 'focused' + same id proves the RESTORED tab (pty_id nulled by
          // persistence) was found and taken down the queue-and-mount path.
          expect(reused.action).toBe('focused');
          expect(reused.tabId).toBe(created.tabId);

          // The reuse gave the tab a live PTY, so a session can bind now.
          await c2.callTool('initSession', { tabId: reused.tabId });
          const start = Date.now();
          let seen = false;
          while (Date.now() - start < 20_000 && !seen) {
            const res = c2.parseToolResult<{ tabs: Array<{ content?: string }> }>(
              await c2.callTool('getTabContext', { tabIds: [reused.tabId], lines: 50 }),
            );
            seen = !!res.tabs?.[0]?.content?.includes('e2e-restart-second');
            if (!seen) await new Promise((r) => setTimeout(r, 500));
          }
          expect(seen, 'command delivered to the restored tab').toBe(true);
        } finally {
          await second.kill();
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }, 300_000);
  });
}
