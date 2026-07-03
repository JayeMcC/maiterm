/**
 * End-to-end CLI tests: actually spawn `node src/cli.ts` as a child process
 * and assert on its real stdout / stderr / exit code. Unlike the module
 * tests, these catch integration bugs at the CLI boundary — arg parsing,
 * error-to-stderr routing, JSON formatting, exit code propagation. No
 * imports of the engine's internals (only the binary contract).
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'cli.ts');
const FIXTURE = (name: string) => join(HERE, 'fixtures', name);

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('CLI: usage / unknown command', () => {
  it('prints usage with no args', () => {
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('task-engine list');
    expect(r.stdout).toContain('task-engine resolve');
    expect(r.stdout).toContain('task-engine dispatch tmux');
    expect(r.stdout).toContain('task-engine dispatch maiterm');
  });

  it('--help is equivalent to no args', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('unknown command exits non-zero with a stderr message', () => {
    const r = runCli(['frobnicate']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('task-engine');
    expect(r.stderr).toMatch(/unknown command/);
  });
});

describe('CLI: list', () => {
  it('emits JSON array of task records', () => {
    const r = runCli(['list', FIXTURE('basic')]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((t: { label: string }) => t.label)).toEqual(['API', 'WEB']);
  });

  it('omits hidden tasks by default', () => {
    const r = runCli(['list', FIXTURE('basic')]);
    const parsed = JSON.parse(r.stdout) as { label: string }[];
    expect(parsed.map(t => t.label)).not.toContain('Hidden helper');
  });

  it('--include-hidden surfaces hidden tasks', () => {
    const r = runCli(['list', FIXTURE('basic'), '--include-hidden']);
    const parsed = JSON.parse(r.stdout) as { label: string }[];
    expect(parsed.map(t => t.label)).toContain('Hidden helper');
  });

  it('fails when the clone path is missing', () => {
    const r = runCli(['list']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/missing <clone-path>/);
  });

  it('fails with a clear error when tasks.json does not exist', () => {
    const r = runCli(['list', '/var/empty/no-such-clone']);
    expect(r.status).not.toBe(0);
    // The reader throws via Node's uncaught-error path; the message
    // includes the expected path so debuggers can pinpoint it.
    expect(r.stderr).toMatch(/tasks\.json/);
  });
});

describe('CLI: resolve', () => {
  it('resolves a leaf task and emits a TaskTreeNode JSON', () => {
    const r = runCli(['resolve', FIXTURE('basic'), 'API']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const tree = JSON.parse(r.stdout);
    expect(tree.task.label).toBe('API');
    expect(tree.dependsOn).toEqual([]);
    expect(tree.task.command).toContain('/.vscode/scripts/tasks/dev-api.sh');
  });

  it('resolves a composite task with the full dependsOn tree', () => {
    const r = runCli(['resolve', FIXTURE('composite'), 'Spin up dev servers']);
    expect(r.status).toBe(0);
    const tree = JSON.parse(r.stdout);
    expect(tree.task.label).toBe('Spin up dev servers');
    expect(tree.dependsOrder).toBe('parallel');
    expect(tree.dependsOn.map((d: { task: { label: string } }) => d.task.label)).toEqual([
      'Require devcontainer',
      'API',
      'WEB',
    ]);
  });

  it('substitutes ${input:id} when --input id=value is passed', () => {
    const r = runCli([
      'resolve',
      FIXTURE('inputs'),
      'Lint branch diff',
      '--input',
      'lintBranchTarget=release/9.9.9',
    ]);
    expect(r.status).toBe(0);
    const tree = JSON.parse(r.stdout);
    expect(tree.task.command).toBe('lint --base release/9.9.9');
  });

  it('fails when the task label does not exist', () => {
    const r = runCli(['resolve', FIXTURE('basic'), 'No such task']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Task not found/);
  });

  it('fails when arguments are missing', () => {
    const r = runCli(['resolve', FIXTURE('basic')]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/missing/);
  });
});

describe('CLI: dispatch tmux', () => {
  const HOST_ARGS = [
    '--target-window',
    'devcontainers:developing',
    '--workspace-folder-host',
    '/host/forwood-one_developing',
    '--workspace-folder',
    '/workspaces/website',
  ];

  it('emits a bash dispatch script for a dedicated-panel task', () => {
    const r = runCli([
      'dispatch',
      'tmux',
      FIXTURE('basic'),
      'API',
      ...HOST_ARGS,
    ]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/^# task: API$/m);
    expect(r.stdout).toContain('tmux list-panes -t');
    expect(r.stdout).toContain('tmux split-window');
    // basic fixture's API has no gate edge → host context (ADR 0006): the
    // split pane runs a plain host shell, no devcontainer exec wrapper, and
    // ${workspaceFolder} resolves against the HOST path (PLAN-15).
    expect(r.stdout).not.toContain('devcontainer exec');
    expect(r.stdout).toContain(
      'bash /host/forwood-one_developing/.vscode/scripts/tasks/dev-api.sh',
    );
    // Status footer present.
    expect(r.stdout).toContain('✓ task succeeded');
    expect(r.stdout).toContain('✗ task failed');
  });

  it('emits multiple steps in declaration order for a composite task', () => {
    const r = runCli([
      'dispatch',
      'tmux',
      FIXTURE('composite'),
      'Spin up dev servers',
      ...HOST_ARGS,
    ]);
    expect(r.status).toBe(0);
    const idxReq = r.stdout.indexOf('# task: Require devcontainer');
    const idxApi = r.stdout.indexOf('# task: API');
    const idxWeb = r.stdout.indexOf('# task: WEB');
    expect(idxReq).toBeGreaterThanOrEqual(0);
    expect(idxApi).toBeGreaterThan(idxReq);
    expect(idxWeb).toBeGreaterThan(idxApi);
    // Aggregator parent emits no comment line of its own (no command).
    expect(r.stdout).not.toContain('# task: Spin up dev servers');
  });

  it('fails when --target-window is missing', () => {
    const r = runCli([
      'dispatch',
      'tmux',
      FIXTURE('basic'),
      'API',
      '--workspace-folder-host',
      '/host',
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--target-window required/);
  });

  it('fails when --workspace-folder-host is missing', () => {
    const r = runCli([
      'dispatch',
      'tmux',
      FIXTURE('basic'),
      'API',
      '--target-window',
      'devcontainers:developing',
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--workspace-folder-host required/);
  });

  it('fails on unknown surface', () => {
    const r = runCli(['dispatch', 'gnome-terminal', FIXTURE('basic'), 'API']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown surface/);
  });
});

describe('CLI: dispatch tmux — snapshot stability', () => {
  // Snapshot covers the FULL emitted script for a dedicated-panel task —
  // pane-finder awk script, Ctrl-C / re-run path, devcontainer-exec wrapper,
  // status footer, pane title. Regenerate after intentional changes with
  // `vitest run -u`.
  it('matches the snapshot for a dedicated-panel task', () => {
    const r = runCli([
      'dispatch',
      'tmux',
      FIXTURE('basic'),
      'API',
      '--target-window',
      'devcontainers:developing',
      '--workspace-folder-host',
      '/host/forwood-one_developing',
      '--workspace-folder',
      '/workspaces/website',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatchInlineSnapshot(`
      "# task: API
      pane_id=$(tmux list-panes -t 'devcontainers:developing' -F "#{pane_id} #{pane_title}" | awk -v t='API' '$2==t {print $1; exit}')
      if [[ -n "$pane_id" ]]; then
        tmux select-pane -t "$pane_id"
        tmux send-keys -t "$pane_id" C-c 2>/dev/null || true
        tmux send-keys -t "$pane_id" 'bash /host/forwood-one_developing/.vscode/scripts/tasks/dev-api.sh' Enter
      else
        pane_id=$(tmux split-window -t 'devcontainers:developing' -h -P -F "#{pane_id}" 'bash -lc '\\''__t0=$SECONDS; bash /host/forwood-one_developing/.vscode/scripts/tasks/dev-api.sh; __rc=$?; __dur=$((SECONDS-__t0)); echo; if [ $__rc -eq 0 ]; then printf "\\033[32m✓ task succeeded\\033[0m (%ss)\\n" "$__dur"; else printf "\\033[31m✗ task failed (exit %d)\\033[0m (%ss)\\n" "$__rc" "$__dur"; fi; read -rsn 1 -p "press any key to close…"; echo; exit $__rc'\\''')
        tmux select-pane -t "$pane_id" -T 'API'
      fi
      "
    `);
  });
});

describe('CLI: dispatch maiterm', () => {
  it('fails gracefully when no maiTerm is running', () => {
    // Force the lockfile dir to an empty location to simulate no live
    // maiTerm. We do this by pointing HOME at /var/empty and letting the
    // lockfile lookup fall through to "no candidates".
    const r = spawnSync(
      process.execPath,
      [
        CLI,
        'dispatch',
        'maiterm',
        FIXTURE('basic'),
        'API',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: '/var/empty',
          NODE_NO_WARNINGS: '1',
        },
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/No live maiTerm lockfile/);
  });

  it('fails when the clone path / label are missing', () => {
    const r = runCli(['dispatch', 'maiterm']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/missing/);
  });
});
