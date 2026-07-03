import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpClientLike, McpToolCallResult } from '@forwood/task-engine';
import { runFireMode } from '../fire-mode.ts';

const TASKS_JSONC = `{
  "version": "2.0.0",
  "tasks": [
    { "label": "Require devcontainer", "type": "shell", "command": "bash \${workspaceFolder}/.vscode/scripts/tasks/require-devcontainer.sh", "presentation": { "panel": "shared", "reveal": "silent" } },
    { "label": "API", "type": "shell", "command": "bash \${workspaceFolder}/api.sh", "dependsOn": ["Require devcontainer"], "presentation": { "panel": "dedicated", "group": "API" } },
    { "label": "Open browser", "type": "shell", "command": "open http://x" }
  ]
}`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fire-mode-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeRepo(): string {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.vscode/scripts/tasks'), { recursive: true });
  writeFileSync(join(repo, '.vscode/tasks.json'), TASKS_JSONC);
  writeFileSync(join(repo, '.vscode/scripts/tasks/require-devcontainer.sh'), '#!/bin/bash\n');
  mkdirSync(join(repo, '.devcontainer'), { recursive: true });
  writeFileSync(
    join(repo, '.devcontainer/devcontainer.json'),
    '{ "workspaceFolder": "/workspaces/x" }\n',
  );
  mkdirSync(join(repo, 'web/app'), { recursive: true });
  return repo;
}

function makeFakeClient(): {
  client: McpClientLike;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let n = 0;
  return {
    calls,
    client: {
      async callTool(req) {
        calls.push(req);
        const result: McpToolCallResult = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'created',
                tabId: `tab-${++n}`,
                ptyId: `pty-${n}`,
                workspaceId: 'ws',
                paneId: 'pane',
                displayName: String(req.arguments['name']),
              }),
            },
          ],
        };
        return result;
      },
    },
  };
}

describe('runFireMode', () => {
  it('fires a known label with dir-resolved host folder, container path, and gate prelude', async () => {
    const repo = makeRepo();
    const { client, calls } = makeFakeClient();
    const r = await runFireMode(join(repo, 'web/app'), 'API', { client });
    expect(r.exitCode).toBe(0);

    const apiCall = calls
      .map(c => String(c.arguments['command']))
      .find(c => c.includes('api.sh'));
    expect(apiCall).toBeDefined();
    // Container-side ${workspaceFolder} inside the exec'd command.
    expect(apiCall).toContain('/workspaces/x/api.sh');
    // Host repo root as the devcontainer exec workspace folder.
    expect(apiCall).toContain(`devcontainer exec --workspace-folder '${repo}'`);
    // Idempotent host-or-in-container wrapper: host branch guards on the repo
    // root existing, runs the gate prelude, then execs into the container.
    expect(apiCall).toMatch(new RegExp(`^if \\[ -e '${repo}' \\]; then `));
    expect(apiCall).toMatch(/bash '.*require-devcontainer\.sh' && devcontainer exec /);
    // The invoking context is never the target: dispatch goes via openTab.
    expect(calls.every(c => c.name === 'openTab')).toBe(true);
  });

  it('unknown label → non-zero with available labels on stderr', async () => {
    const repo = makeRepo();
    const { client } = makeFakeClient();
    const r = await runFireMode(repo, 'No Such Task', { client });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/Task not found/);
    expect(r.stderr).toContain('API');
  });

  it('exit 3 when the dir has no tasks.json up-tree', async () => {
    const bare = join(root, 'bare');
    mkdirSync(bare, { recursive: true });
    const { client } = makeFakeClient();
    const r = await runFireMode(bare, 'API', { client });
    expect(r.exitCode).toBe(3);
  });

  it('emits machine-parseable steps with no TTY involved (FR-012)', async () => {
    const repo = makeRepo();
    const { client } = makeFakeClient();
    const r = await runFireMode(repo, 'API', { client });
    const steps = JSON.parse(r.stdout);
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.some((s: { taskLabel: string }) => s.taskLabel === 'API')).toBe(true);
  });
});
