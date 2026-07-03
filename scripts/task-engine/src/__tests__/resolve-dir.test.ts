import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDir } from '../index.ts';

// Temp-dir fixtures (NOT repo-relative — walking up from inside a real
// checkout could hit that repo's own .vscode/tasks.json).
let root: string;

const TASKS = '{ "version": "2.0.0", "tasks": [] }\n';
const DEVC = '{ "workspaceFolder": "/workspaces/x" }\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'resolve-dir-'));
  // <root>/repo            — has .vscode/tasks.json + .devcontainer
  // <root>/repo/web/app    — deep subdir
  // <root>/repo/nested     — inner checkout with its own tasks.json
  // <root>/bare            — no markers at all
  // <root>/devonly         — .devcontainer but no tasks.json
  mkdirSync(join(root, 'repo/.vscode'), { recursive: true });
  writeFileSync(join(root, 'repo/.vscode/tasks.json'), TASKS);
  mkdirSync(join(root, 'repo/.devcontainer'), { recursive: true });
  writeFileSync(join(root, 'repo/.devcontainer/devcontainer.json'), DEVC);
  mkdirSync(join(root, 'repo/web/app'), { recursive: true });
  mkdirSync(join(root, 'repo/nested/.vscode'), { recursive: true });
  writeFileSync(join(root, 'repo/nested/.vscode/tasks.json'), TASKS);
  mkdirSync(join(root, 'bare/sub'), { recursive: true });
  mkdirSync(join(root, 'devonly/.devcontainer'), { recursive: true });
  writeFileSync(join(root, 'devonly/.devcontainer/devcontainer.json'), DEVC);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveDir', () => {
  it('matches the directory itself when it carries the marker', () => {
    const r = resolveDir(join(root, 'repo'));
    expect(r.repoRoot).toBe(join(root, 'repo'));
    expect(r.tasksJsonPath).toBe(join(root, 'repo/.vscode/tasks.json'));
  });

  it('walks up from a deep subdirectory to the owning repo root', () => {
    const r = resolveDir(join(root, 'repo/web/app'));
    expect(r.repoRoot).toBe(join(root, 'repo'));
  });

  it('first match wins for nested checkouts', () => {
    const r = resolveDir(join(root, 'repo/nested'));
    expect(r.repoRoot).toBe(join(root, 'repo/nested'));
  });

  it('returns null fields when no marker exists up-tree', () => {
    const r = resolveDir(join(root, 'bare/sub'));
    expect(r.repoRoot).toBeNull();
    expect(r.tasksJsonPath).toBeNull();
    expect(r.devcontainerConfigPath).toBeNull();
  });

  it('probes .devcontainer/devcontainer.json independently of tasks.json', () => {
    const withBoth = resolveDir(join(root, 'repo/web/app'));
    expect(withBoth.devcontainerConfigPath).toBe(
      join(root, 'repo/.devcontainer/devcontainer.json'),
    );
    const devOnly = resolveDir(join(root, 'devonly'));
    expect(devOnly.repoRoot).toBeNull();
    expect(devOnly.devcontainerConfigPath).toBe(
      join(root, 'devonly/.devcontainer/devcontainer.json'),
    );
  });

  it('throws on a non-existent directory', () => {
    expect(() => resolveDir(join(root, 'nope/nope'))).toThrow(/no such directory/);
  });
});
