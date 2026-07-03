/**
 * `--list --json --dir <d>` — the provider contract's list half (ADR 0006).
 * Emits a ListReport (data-model.md) for the repo owning `dir`, resolved by
 * marker walk-up. Pure function of its inputs: no TTY, no process state —
 * the CLI shell in modes.ts does the printing and exiting.
 *
 * Exit-code contract: 0 report / 3 no-task-list-here (distinct from error) /
 * 2 bad dir / 1 malformed tasks.json.
 */
import { resolveDir, listTasks, deriveExecutionContext } from '@forwood/task-engine';

export interface ModeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runListMode(dir: string): ModeResult {
  let resolution;
  try {
    resolution = resolveDir(dir);
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: messageOf(err) + '\n' };
  }

  if (!resolution.repoRoot || !resolution.tasksJsonPath) {
    return {
      exitCode: 3,
      stdout: JSON.stringify({ repoRoot: null, tasksJson: null, tasks: [] }) + '\n',
      stderr: '',
    };
  }

  try {
    const tasks = listTasks(resolution.repoRoot);
    const annotated = tasks.map(t => ({
      ...t,
      executionContext: deriveExecutionContext(t.label, tasks),
    }));
    const report = {
      repoRoot: resolution.repoRoot,
      tasksJson: resolution.tasksJsonPath,
      tasks: annotated,
    };
    return { exitCode: 0, stdout: JSON.stringify(report, null, 2) + '\n', stderr: '' };
  } catch (err) {
    return {
      exitCode: 1,
      stderr: `${resolution.tasksJsonPath}: ${messageOf(err)}\n`,
      stdout: '',
    };
  }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
