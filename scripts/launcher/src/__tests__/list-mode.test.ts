import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runListMode } from '../list-mode.ts';

// JSONC on purpose (comment + trailing comma) — the engine reader owns
// parsing; list mode must survive real-world overlay files.
const TASKS_JSONC = `{
  // gate-edged leaf, host leaf
  "version": "2.0.0",
  "tasks": [
    { "label": "Require devcontainer", "type": "shell", "command": "bash gate.sh", "presentation": { "panel": "shared", "reveal": "silent" } },
    { "label": "API", "type": "shell", "command": "bash api.sh", "dependsOn": ["Require devcontainer"], "presentation": { "panel": "dedicated", "group": "API" }, },
    { "label": "Open browser", "type": "shell", "command": "open http://x" },
  ]
}`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'list-mode-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function repoWithTasks(content = TASKS_JSONC): string {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.vscode'), { recursive: true });
  writeFileSync(join(repo, '.vscode/tasks.json'), content);
  mkdirSync(join(repo, 'web/app'), { recursive: true });
  return repo;
}

describe('runListMode', () => {
  it('emits a ListReport with per-task executionContext for a deep subdir', () => {
    const repo = repoWithTasks();
    const r = runListMode(join(repo, 'web/app'));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    const report = JSON.parse(r.stdout);
    expect(report.repoRoot).toBe(repo);
    expect(report.tasksJson).toBe(join(repo, '.vscode/tasks.json'));
    const byLabel = Object.fromEntries(
      report.tasks.map((t: { label: string }) => [t.label, t]),
    );
    expect(byLabel['API'].executionContext).toBe('container');
    expect(byLabel['Open browser'].executionContext).toBe('host');
    expect(byLabel['Require devcontainer'].executionContext).toBe('host');
    expect(byLabel['API'].presentation.group).toBe('API');
    expect(byLabel['API'].dependsOn).toEqual(['Require devcontainer']);
  });

  it('exit 3 + null report when no tasks.json exists up-tree', () => {
    const bare = join(root, 'bare');
    mkdirSync(bare, { recursive: true });
    const r = runListMode(bare);
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stdout)).toEqual({ repoRoot: null, tasksJson: null, tasks: [] });
  });

  it('exit 2 on a non-existent dir', () => {
    const r = runListMode(join(root, 'missing'));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/no such directory/);
  });

  it('exit 1 with a parse message on malformed tasks.json', () => {
    const repo = repoWithTasks('{ not json ');
    const r = runListMode(repo);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it('is a pure function of its inputs — no TTY involved (FR-012)', () => {
    const repo = repoWithTasks();
    const r = runListMode(repo);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});
