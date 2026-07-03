import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Directory-based resolution (PLAN-15 / ADR 0006): mirror of the hotbar's
 * detector semantics. From a starting directory, ascend parents looking for
 * the two marker files independently:
 *
 *   - `.vscode/tasks.json`            → `repoRoot` + `tasksJsonPath`
 *   - `.devcontainer/devcontainer.json` → `devcontainerConfigPath`
 *
 * First match wins per probe (nested checkouts resolve to the innermost
 * owner). The two probes may land on different ancestors; callers use
 * whichever their mode needs.
 */
export interface DirResolution {
  repoRoot: string | null;
  tasksJsonPath: string | null;
  devcontainerConfigPath: string | null;
}

export function resolveDir(dir: string): DirResolution {
  const start = resolve(dir);
  if (!existsSync(start)) {
    throw new Error(`resolve-dir: no such directory: ${dir}`);
  }

  let repoRoot: string | null = null;
  let tasksJsonPath: string | null = null;
  let devcontainerConfigPath: string | null = null;

  let cur = start;
  for (;;) {
    if (!tasksJsonPath) {
      const p = join(cur, '.vscode', 'tasks.json');
      if (existsSync(p)) {
        repoRoot = cur;
        tasksJsonPath = p;
      }
    }
    if (!devcontainerConfigPath) {
      const p = join(cur, '.devcontainer', 'devcontainer.json');
      if (existsSync(p)) devcontainerConfigPath = p;
    }
    if (tasksJsonPath && devcontainerConfigPath) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return { repoRoot, tasksJsonPath, devcontainerConfigPath };
}
