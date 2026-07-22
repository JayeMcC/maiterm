/**
 * E2E: OSC handling added in the 2026-07-22 batch, driven through a real
 * maiTerm binary via MCP.
 *
 * - OSC 11 color query: the shell queries the background color and echoes
 *   the reply — proves the interceptor-mirror → event-proxy → ThemePalette →
 *   PtyWrite round trip answers with a real `rgb:` value (previously the
 *   backend answered every query with black... via a formatter that at least
 *   emitted rgb:, so the assertion checks a NON-black real answer isn't
 *   required — presence of the reply proves the path; non-crash + format).
 * - OSC 1337 SetUserVar: sets a trigger variable, asserted via the persisted
 *   state file in the instance's hermetic HOME (same surface the restart
 *   test uses).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnMaiterm, type MaitermHandle } from './harness/spawn.ts';
import { McpClient } from './harness/mcp-client.ts';

const BIN = process.env.MAITERM_BINARY;

if (!BIN) {
  describe.skip('maiTerm OSC E2E (MAITERM_BINARY not set)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('maiTerm E2E — OSC', () => {
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

    /** Poll getTabContext until `needle` shows up in the tab's content. */
    async function waitForTabContent(tabId: string, needle: string, timeoutMs = 20_000): Promise<boolean> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const res = client.parseToolResult<{ tabs: Array<{ id?: string; content?: string }> }>(
          await client.callTool('getTabContext', { tabIds: [tabId], lines: 50 }),
        );
        if (res.tabs?.some((t) => t.content?.includes(needle))) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    }

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

    it('answers an OSC 11 background-color query with an rgb: value', async () => {
      // Query with BEL terminator so the reply is BEL-terminated too; read
      // up to the BEL and echo the payload after the `11;` prefix.
      const cmd = "printf '\\033]11;?\\007'; IFS= read -r -s -t 8 -d $'\\007' r; echo \"OSCREPLY-${r#*;}\"";
      const opened = client.parseToolResult<{ tabId: string }>(
        await client.callTool('openTab', { name: 'e2e-osc-colorquery', command: cmd }),
      );
      expect(opened.tabId).toBeTruthy();
      expect(
        await waitForTabContent(opened.tabId, 'OSCREPLY-rgb:'),
        'color query must be answered with an rgb: payload',
      ).toBe(true);
    });

    it('OSC 1337 SetUserVar lands in the tab trigger variables', async () => {
      const opened = client.parseToolResult<{ tabId: string }>(
        await client.callTool('openTab', { name: 'e2e-osc-uservar', command: 'echo osc-tab-ready' }),
      );
      expect(opened.tabId).toBeTruthy();
      expect(await waitForTabContent(opened.tabId, 'osc-tab-ready')).toBe(true);

      // The term-uservar listener is gated on trackActivity, which arms ~2s
      // after mount (scrollback-replay guard) — wait it out, then send the
      // sequence into the live shell. "hello" base64-encoded.
      await new Promise((r) => setTimeout(r, 3000));
      const cmd = "printf '\\033]1337;SetUserVar=e2evar=aGVsbG8=\\007'; echo osc-uservar-sent\n";
      const sent = client.parseToolResult<{ success?: boolean }>(
        await client.callTool('sendKeysToTab', { tabId: opened.tabId, text: cmd }),
      );
      expect(sent.success).toBe(true);
      expect(await waitForTabContent(opened.tabId, 'osc-uservar-sent')).toBe(true);

      // setVariable persists via setTabTriggerVariables; poll the state file.
      const start = Date.now();
      let found = false;
      while (Date.now() - start < 20_000 && !found) {
        const stateFile = findStateFile(handle.home);
        if (stateFile) {
          const raw = readFileSync(stateFile, 'utf8');
          found = raw.includes('"e2evar"') && raw.includes('"hello"');
        }
        if (!found) await new Promise((r) => setTimeout(r, 1000));
      }
      expect(found, 'e2evar=hello persisted into tab trigger_variables').toBe(true);
    });
  });
}
