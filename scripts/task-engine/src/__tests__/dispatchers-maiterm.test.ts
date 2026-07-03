import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveTask, buildTaskTree } from '../index.ts';
import {
  dispatchMaiterm,
  buildOpenTabArgs,
  wrapForContainer,
  type McpClientLike,
  type McpToolCallResult,
} from '../dispatchers/maiterm.ts';
import type { Task, ResolvedTask, TaskTreeNode } from '../types.ts';
import type { VariableContext } from '../variables.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (name: string) => join(HERE, 'fixtures', name);

/**
 * A recording fake MCP client. Captures every `callTool` invocation and
 * replays a queued response (or a default-success response if the queue
 * is empty). Lets us assert on the *exact* arguments the dispatcher sent.
 */
function makeFakeClient(opts: {
  queuedResponses?: Array<Partial<McpToolCallResult>>;
} = {}): {
  client: McpClientLike;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const queue = [...(opts.queuedResponses ?? [])];
  let counter = 0;
  return {
    calls,
    client: {
      async callTool(req) {
        calls.push(req);
        const next = queue.shift();
        const defaultResult: McpToolCallResult = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'created',
                tabId: `tab-${++counter}`,
                ptyId: `pty-${counter}`,
                workspaceId: 'ws-1',
                paneId: 'pane-1',
                displayName: req.arguments['name'] as string,
              }),
            },
          ],
        };
        return next
          ? ({ ...defaultResult, ...next } as McpToolCallResult)
          : defaultResult;
      },
    },
  };
}

function ctx(workspaceFolder: string): VariableContext {
  return { workspaceFolder, env: {} };
}

describe('buildOpenTabArgs', () => {
  it('maps presentation.panel: dedicated to reuseExisting=true, name=group', () => {
    const task: ResolvedTask = {
      label: 'API',
      command: 'pnpm dev:api',
      presentation: { panel: 'dedicated', group: 'API' },
    };
    const args = buildOpenTabArgs(task, {});
    expect(args['name']).toBe('API');
    expect(args['reuseExisting']).toBe(true);
    // dedicated (persistent) tab → keep-alive login shell appended.
    expect(args['command']).toBe(`pnpm dev:api; exec "\${SHELL:-/bin/bash}" -l`);
  });

  it('falls back to label when group is missing', () => {
    const task: ResolvedTask = {
      label: 'Storybook',
      command: 'pnpm storybook',
      presentation: { panel: 'dedicated' },
    };
    expect((buildOpenTabArgs(task, {}) as any).name).toBe('Storybook');
  });

  it('maps presentation.panel: shared to a fixed `shared` tab name', () => {
    const task: ResolvedTask = {
      label: 'Lint',
      command: 'pnpm lint',
      presentation: { panel: 'shared' },
    };
    expect((buildOpenTabArgs(task, {}) as any).name).toBe('shared');
    expect((buildOpenTabArgs(task, {}) as any).reuseExisting).toBe(true);
  });

  it('maps presentation.panel: new to reuseExisting=false', () => {
    const task: ResolvedTask = {
      label: 'One-shot',
      command: 'pnpm test',
      presentation: { panel: 'new' },
    };
    expect((buildOpenTabArgs(task, {}) as any).reuseExisting).toBe(false);
  });

  it('forwards workspaceName when provided', () => {
    const task: ResolvedTask = { label: 'X', command: 'echo' };
    expect((buildOpenTabArgs(task, { workspaceName: 'developing' }) as any).workspaceName).toBe(
      'developing',
    );
  });

  it('wraps command with devcontainer exec when workspaceFolderHost is set (idempotent host/container)', () => {
    const task: ResolvedTask = { label: 'X', command: 'pnpm dev' };
    const args = buildOpenTabArgs(task, {
      workspaceFolderHost: '/host/path with space',
    });
    const cmd = String((args as any).command);
    expect(cmd).toMatch(/^if \[ -e '\/host\/path with space' \]; then /);
    expect(cmd).toContain(
      `devcontainer exec --workspace-folder '/host/path with space' bash -lc 'pnpm dev'`,
    );
    // else branch: run directly in the container, no devcontainer exec.
    expect(cmd).toContain('; else pnpm dev; fi');
  });
});

describe('wrapForContainer', () => {
  it('returns the command unchanged when no host path is given', () => {
    expect(wrapForContainer('pnpm dev', undefined)).toBe('pnpm dev');
  });

  it('wraps with devcontainer exec when host path is given', () => {
    expect(wrapForContainer('pnpm dev', '/host')).toBe(
      `devcontainer exec --workspace-folder '/host' bash -lc 'pnpm dev'`,
    );
  });
});

describe('dispatchMaiterm', () => {
  it('calls openTab for each leaf task in a composite tree', async () => {
    const tree = resolveTask(FIXTURE('composite'), 'Spin up dev servers', ctx('/ws'));
    const { client, calls } = makeFakeClient();
    const steps = await dispatchMaiterm(tree, { client });

    // Three leaf tasks (Require devcontainer, API, WEB) + the aggregator
    // root (Spin up dev servers) skipped because it has no command.
    // Note: "Require devcontainer" has no `presentation` field → panel
    // defaults to `shared`, so its tab name is the fixed `shared` rather
    // than the label. API and WEB declare panel:dedicated + group, so
    // they use their group names directly.
    expect(calls.map(c => c.name)).toEqual(['openTab', 'openTab', 'openTab']);
    expect(calls.map(c => c.arguments['name'])).toEqual([
      'shared',
      'API',
      'WEB',
    ]);
    expect(steps.map(s => ({ label: s.taskLabel, skipped: s.skipped }))).toEqual([
      { label: 'Require devcontainer', skipped: false },
      { label: 'API', skipped: false },
      { label: 'WEB', skipped: false },
      { label: 'Spin up dev servers', skipped: true },
    ]);
  });

  it('deduplicates shared dependencies across multiple parents', async () => {
    const shared: ResolvedTask = {
      label: 'shared',
      command: 'echo once',
      presentation: { panel: 'shared' },
    };
    const tree: TaskTreeNode = {
      task: { label: 'root', dependsOn: ['a', 'b'] },
      dependsOrder: 'parallel',
      executionContext: 'host',
      dependsOn: [
        {
          task: { label: 'a', dependsOn: ['shared'] },
          dependsOrder: 'parallel',
          executionContext: 'host',
          dependsOn: [{ task: shared, dependsOrder: 'parallel', executionContext: 'host', dependsOn: [] }],
        },
        {
          task: { label: 'b', dependsOn: ['shared'] },
          dependsOrder: 'parallel',
          executionContext: 'host',
          dependsOn: [{ task: shared, dependsOrder: 'parallel', executionContext: 'host', dependsOn: [] }],
        },
      ],
    };
    const { client, calls } = makeFakeClient();
    await dispatchMaiterm(tree, { client });
    // `shared` should only fire once, even though referenced twice.
    expect(calls.filter(c => c.arguments['name'] === 'shared')).toHaveLength(1);
  });

  it('throws if the MCP tool returns isError', async () => {
    const tree = resolveTask(FIXTURE('basic'), 'API', ctx('/ws'));
    const fake = makeFakeClient({
      queuedResponses: [
        {
          isError: true,
          content: [{ type: 'text', text: 'Workspace not found: ghost' }],
        },
      ],
    });
    await expect(dispatchMaiterm(tree, { client: fake.client })).rejects.toThrow(
      /openTab failed for task 'API'.*ghost/,
    );
  });

  it('returns the parsed openTab result on each step', async () => {
    const tree = resolveTask(FIXTURE('basic'), 'API', ctx('/ws'));
    const fake = makeFakeClient();
    const [step] = await dispatchMaiterm(tree, { client: fake.client });
    expect(step?.result?.tabId).toBe('tab-1');
    expect(step?.result?.action).toBe('created');
  });
});

describe('dispatchMaiterm — execution context (PLAN-15 / ADR 0006)', () => {
  const gate: Task = {
    label: 'Require devcontainer',
    command: 'bash gate.sh',
    presentation: { reveal: 'silent', panel: 'shared' },
  };
  const api: Task = {
    label: 'API',
    command: 'bash dev-api.sh',
    dependsOn: ['Require devcontainer'],
    presentation: { panel: 'dedicated', group: 'API' },
  };
  const browser: Task = {
    label: 'Open browser to root dev',
    command: 'bash open-browser.sh',
    presentation: { panel: 'dedicated', group: 'browser' },
  };
  const spinUp: Task = {
    label: 'Spin up dev servers',
    dependsOn: ['Require devcontainer', 'API', 'Open browser to root dev'],
  };

  it('wraps container-context commands; host-context commands stay bare', async () => {
    const tree = buildTaskTree('Spin up dev servers', [gate, api, browser, spinUp]);
    const { client, calls } = makeFakeClient();
    await dispatchMaiterm(tree, {
      client,
      workspaceFolderHost: '/hosts/forwood-one_developing',
    });

    const commandContaining = (needle: string): string => {
      const hit = calls
        .map(c => String(c.arguments['command']))
        .find(c => c.includes(needle));
      if (!hit) throw new Error(`no openTab call whose command mentions ${needle}`);
      return hit;
    };

    // Container-context leaf → devcontainer exec composition.
    expect(commandContaining('dev-api.sh')).toContain('devcontainer exec');
    // The gate itself always runs host-side (it IS the bring-up there).
    expect(commandContaining('gate.sh')).not.toContain('devcontainer exec');
    // Host-context leaf (no gate in its chain) → bare.
    expect(commandContaining('open-browser.sh')).not.toContain('devcontainer exec');
  });
});

describe('dispatchMaiterm — containerPrelude (PLAN-15 cold-start)', () => {
  const gate: Task = {
    label: 'Require devcontainer',
    command: 'bash gate.sh',
    presentation: { reveal: 'silent', panel: 'shared' },
  };
  const api: Task = {
    label: 'API',
    command: 'bash dev-api.sh',
    dependsOn: ['Require devcontainer'],
    presentation: { panel: 'dedicated', group: 'API' },
  };
  const browser: Task = { label: 'Browser', command: 'bash open-browser.sh' };
  const spinUp: Task = { label: 'Spin up', dependsOn: ['Require devcontainer', 'API', 'Browser'] };

  it('prefixes container commands with the prelude; host commands untouched', async () => {
    const tree = buildTaskTree('Spin up', [gate, api, browser, spinUp]);
    const { client, calls } = makeFakeClient();
    await dispatchMaiterm(tree, {
      client,
      workspaceFolderHost: '/hosts/clone',
      containerPrelude: "bash '/hosts/clone/.vscode/scripts/tasks/require-devcontainer.sh'",
    });
    const commandContaining = (needle: string): string => {
      const hit = calls.map(c => String(c.arguments['command'])).find(c => c.includes(needle));
      if (!hit) throw new Error(`no openTab call whose command mentions ${needle}`);
      return hit;
    };
    // Container task: idempotent — host branch does prelude && devcontainer exec.
    const apiCmd = commandContaining('dev-api.sh');
    expect(apiCmd).toMatch(/^if \[ -e '\/hosts\/clone' \]; then /);
    expect(apiCmd).toContain(
      "bash '/hosts/clone/.vscode/scripts/tasks/require-devcontainer.sh' && devcontainer exec ",
    );
    // Host tasks: no prelude, no wrap.
    expect(commandContaining('gate.sh')).toBe('bash gate.sh');
    expect(commandContaining('open-browser.sh')).toBe('bash open-browser.sh');
  });
});

describe('keepInteractiveShellAtRoot (dev-server tabs land at project root)', () => {
  it('returns to root and execs an interactive login shell after the command', async () => {
    const { keepInteractiveShellAtRoot } = await import('../dispatchers/maiterm.ts');
    const out = keepInteractiveShellAtRoot('bash dev-api.sh', '/workspaces/website');
    // cd root; cmd; cd root; exec login shell — `;` so the return runs even on failure.
    expect(out).toBe(
      `cd '/workspaces/website' 2>/dev/null; bash dev-api.sh; cd '/workspaces/website' 2>/dev/null; exec "\${SHELL:-/bin/bash}" -l`,
    );
  });

  it('dedicated container task: idempotent host/container dispatch, converges in-container', () => {
    const task: Task = {
      label: 'API',
      command: 'bash /workspaces/website/dev-api.sh',
      options: { cwd: '/workspaces/website' },
      presentation: { panel: 'dedicated', group: 'API' },
    };
    const args = buildOpenTabArgs(
      task,
      { workspaceFolderHost: '/host/clone', containerPrelude: "bash '/host/clone/gate.sh'" },
      'container',
    );
    const cmd = String(args['command']);
    // Self-detecting: host clone path exists only on the host.
    expect(cmd).toMatch(/^if \[ -e '\/host\/clone' \]; then /);
    expect(cmd).toContain('fi');
    // HOST branch: gate + devcontainer exec into the container.
    expect(cmd).toContain("bash '/host/clone/gate.sh' && devcontainer exec --workspace-folder '/host/clone' bash -lc ");
    // CONTAINER branch (else): run directly, NO gate, NO nested devcontainer exec.
    const elseBranch = cmd.slice(cmd.indexOf('; else ') + 7, cmd.lastIndexOf('; fi'));
    expect(elseBranch).toContain('dev-api.sh');
    expect(elseBranch).not.toContain('devcontainer exec');
    expect(elseBranch).not.toContain('gate.sh');
    // Both branches end in a container shell at the root.
    expect(cmd).toContain(`exec "\${SHELL:-/bin/bash}" -l`);
  });

  it('shared task stays plain (no keep-alive shell)', () => {
    const task: Task = {
      label: 'Open browser',
      command: 'open http://x',
      options: { cwd: '/host/clone' },
      presentation: { panel: 'shared' },
    };
    const args = buildOpenTabArgs(task, { workspaceFolderHost: '/host/clone' }, 'host');
    expect(args['command']).toBe('open http://x');
  });
});
