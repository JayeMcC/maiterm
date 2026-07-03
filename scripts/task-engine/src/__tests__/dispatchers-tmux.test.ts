import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveTask, buildTaskTree } from '../index.ts';
import {
  emitTmuxDispatch,
  shQuote,
  paneTitle,
  type TmuxDispatchContext,
} from '../dispatchers/tmux.ts';
import type { VariableContext } from '../variables.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (name: string) => join(HERE, 'fixtures', name);

const TMUX_CTX: TmuxDispatchContext = {
  targetWindow: 'devcontainers:developing',
  workspaceFolderHost: '/Users/me/proj/forwood-one_developing',
};

function ctx(workspaceFolder: string): VariableContext {
  return { workspaceFolder, env: { API_PORT: '4000' } };
}

describe('shQuote', () => {
  it('wraps a simple string in single quotes', () => {
    expect(shQuote('pnpm dev')).toBe(`'pnpm dev'`);
  });

  it('escapes embedded single quotes via end-quote / escape / start-quote', () => {
    // bash idiom for an embedded ' inside single-quoted text.
    expect(shQuote("it's fine")).toBe(`'it'\\''s fine'`);
  });

  it('preserves backslashes and double quotes literally', () => {
    expect(shQuote('say "hi" \\n')).toBe(`'say "hi" \\n'`);
  });
});

describe('paneTitle', () => {
  it('passes alphanumerics, dot, underscore, hyphen unchanged', () => {
    expect(paneTitle('API_v1.2-final')).toBe('API_v1.2-final');
  });

  it('replaces spaces and special chars with underscore', () => {
    expect(paneTitle('Kill all, branch setup')).toBe('Kill_all__branch_setup');
  });
});

describe('emitTmuxDispatch — shared panel', () => {
  it('emits a single tmux send-keys to pane .0 for a shared task', () => {
    const tree = resolveTask(FIXTURE('basic'), 'API', ctx('/workspace/forwood-one_developing'));
    // The basic fixture's API task uses panel: dedicated; override for this test
    // by handing the dispatcher a hand-built shared node.
    const out = emitTmuxDispatch(
      {
        task: { label: 'Helper', command: 'echo hi', presentation: { panel: 'shared' } },
        dependsOn: [],
        dependsOrder: 'parallel',
        executionContext: 'host',
      },
      TMUX_CTX,
    );
    expect(out).toContain('# task: Helper');
    expect(out).toContain(
      `tmux send-keys -t 'devcontainers:developing.0' 'echo hi' Enter`,
    );
    // Suppress unused-var lint for the resolveTask call above (referenced for
    // signature coverage; real assertion is on the hand-built node).
    expect(tree.task.label).toBe('API');
  });
});

describe('emitTmuxDispatch — dedicated panel', () => {
  it('emits find-or-create pane logic (host context — no gate edge in fixture)', () => {
    const tree = resolveTask(
      FIXTURE('basic'),
      'API',
      ctx('/workspaces/website'),
    );
    const out = emitTmuxDispatch(tree, TMUX_CTX);

    // Header comment present.
    expect(out).toMatch(/^# task: API$/m);

    // Find-pane-by-title.
    expect(out).toContain('tmux list-panes -t');
    expect(out).toContain("'API'"); // pane title (group: "API", already alnum)
    expect(out).toContain('$2==t');

    // If pane exists: select, Ctrl-C, send command.
    expect(out).toContain('tmux select-pane -t "$pane_id"');
    expect(out).toContain(
      'tmux send-keys -t "$pane_id" C-c 2>/dev/null || true',
    );

    // If pane doesn't exist: split-window in a plain host shell — the basic
    // fixture's API has no gate edge, so it derives host context (ADR 0006).
    // Container-context wrapping is covered by the PLAN-15 block below.
    expect(out).not.toContain('devcontainer exec');
    // Nested quoting: the inner shQuote escapes single quotes via the bash
    // idiom `'\''` inside the outer shQuote wrapping the whole split arg.
    expect(out).toContain(`bash -lc '\\''__t0=$SECONDS`);
    expect(out).toContain('__t0=$SECONDS');
    expect(out).toContain('✓ task succeeded');
    expect(out).toContain('✗ task failed');
    expect(out).toContain('press any key to close');

    // The command itself was variable-substituted by resolveTask.
    expect(out).toContain(
      'bash /workspaces/website/.vscode/scripts/tasks/dev-api.sh',
    );

    // Pane title set on split.
    expect(out).toContain(`tmux select-pane -t "$pane_id" -T 'API'`);
  });
});

describe('emitTmuxDispatch — composite task', () => {
  it('emits each dependency in declaration order, then the parent (if it has a command)', () => {
    const tree = resolveTask(
      FIXTURE('composite'),
      'Spin up dev servers',
      ctx('/workspaces/website'),
    );
    const out = emitTmuxDispatch(tree, TMUX_CTX);

    // "Spin up dev servers" is an aggregator with no command of its own —
    // we expect every child to emit, parent to be a no-op.
    expect(out).toContain('# task: Require devcontainer');
    expect(out).toContain('# task: API');
    expect(out).toContain('# task: WEB');
    // Aggregator label is NOT in the output (no command to dispatch).
    expect(out).not.toContain('# task: Spin up dev servers');

    // Order matches the dependsOn declaration order.
    const idxReq = out.indexOf('# task: Require devcontainer');
    const idxApi = out.indexOf('# task: API');
    const idxWeb = out.indexOf('# task: WEB');
    expect(idxReq).toBeLessThan(idxApi);
    expect(idxApi).toBeLessThan(idxWeb);
  });

  it('deduplicates a shared dependency referenced from multiple parents', () => {
    const tasks = [
      { label: 'root', dependsOn: ['a', 'b'] },
      { label: 'a', dependsOn: ['shared'] },
      { label: 'b', dependsOn: ['shared'] },
      { label: 'shared', command: 'echo once', presentation: { panel: 'shared' as const } },
    ];
    // buildTaskTree builds the structural tree; dispatcher dedupes by label.
    const tree = {
      task: tasks[0]!,
      dependsOrder: 'parallel' as const,
      executionContext: 'host' as const,
      dependsOn: [
        {
          task: tasks[1]!,
          dependsOrder: 'parallel' as const,
          executionContext: 'host' as const,
          dependsOn: [
            { task: tasks[3]!, dependsOrder: 'parallel' as const, executionContext: 'host' as const, dependsOn: [] },
          ],
        },
        {
          task: tasks[2]!,
          dependsOrder: 'parallel' as const,
          executionContext: 'host' as const,
          dependsOn: [
            { task: tasks[3]!, dependsOrder: 'parallel' as const, executionContext: 'host' as const, dependsOn: [] },
          ],
        },
      ],
    };
    const out = emitTmuxDispatch(tree, TMUX_CTX);
    const hits = (out.match(/# task: shared/g) ?? []).length;
    expect(hits).toBe(1);
  });
});

describe('emitTmuxDispatch — aggregator task with no command', () => {
  it('emits nothing of its own when given a bare aggregator (no children)', () => {
    const out = emitTmuxDispatch(
      {
        task: { label: 'empty' },
        dependsOn: [],
        dependsOrder: 'parallel',
        executionContext: 'host',
      },
      TMUX_CTX,
    );
    expect(out).toBe('');
  });
});

describe('emitTmuxDispatch — execution context (PLAN-15 / ADR 0006)', () => {
  const gate = {
    label: 'Require devcontainer',
    command: 'bash gate.sh',
    presentation: { reveal: 'silent' as const, panel: 'shared' as const },
  };
  const hostTask = {
    label: 'Hard snapshot',
    command: 'bash hard-snapshot.sh',
    presentation: { panel: 'dedicated' as const, group: 'snapshot' },
  };
  const containerTask = {
    label: 'API',
    command: 'bash dev-api.sh',
    dependsOn: ['Require devcontainer'],
    presentation: { panel: 'dedicated' as const, group: 'API' },
  };
  const all = [gate, hostTask, containerTask];

  it('keeps devcontainer exec for container-context dedicated tasks', () => {
    const out = emitTmuxDispatch(buildTaskTree('API', all), TMUX_CTX);
    expect(out).toContain('devcontainer exec');
  });

  it('omits devcontainer exec for host-context dedicated tasks', () => {
    const out = emitTmuxDispatch(buildTaskTree('Hard snapshot', all), TMUX_CTX);
    expect(out).not.toContain('devcontainer exec');
    expect(out).toContain('bash hard-snapshot.sh');
  });
});
