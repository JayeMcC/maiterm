/**
 * `--fire <label> --dir <d>` — the provider contract's fire half (ADR 0006).
 * Resolves the owning repo by marker walk-up, then dispatches through the
 * same maiTerm dispatcher as the interactive menu: find-or-spawn per
 * presentation semantics, invoking context never the target.
 *
 * Context assembly (all dir-derived, no $FORWOOD_CLONE):
 *   - workspaceFolderHost  = repo root (host path)
 *   - workspaceFolder      = devcontainer.json `workspaceFolder` when the
 *     container config exists (container-side substitution), else repo root
 *   - containerPrelude     = the repo's own container-gate script when
 *     present, making container tabs cold-start self-sufficient
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveDir,
  listTasks,
  resolveTask,
  dispatchMaiterm,
  shQuote,
  type McpClientLike,
} from '@forwood/task-engine';
import { messageOf, type ModeResult } from './list-mode.ts';

export interface FireDeps {
  /** Injected MCP client (tests); when absent, connect via the lockfile. */
  client?: McpClientLike;
}

export async function runFireMode(
  dir: string,
  label: string,
  deps: FireDeps = {},
): Promise<ModeResult> {
  let resolution;
  try {
    resolution = resolveDir(dir);
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: messageOf(err) + '\n' };
  }
  if (!resolution.repoRoot) {
    return { exitCode: 3, stdout: '', stderr: `No .vscode/tasks.json found walking up from ${dir}\n` };
  }
  const repoRoot = resolution.repoRoot;

  let tasks;
  try {
    tasks = listTasks(repoRoot, { includeHidden: true });
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: messageOf(err) + '\n' };
  }
  if (!tasks.some(t => t.label === label)) {
    const labels = tasks.map(t => t.label);
    const close = labels.filter(
      l =>
        l.toLowerCase().includes(label.toLowerCase()) ||
        label.toLowerCase().includes(l.toLowerCase()),
    );
    const hint = close.length
      ? `Close matches: ${close.join(', ')}`
      : `Available: ${labels.join(', ')}`;
    return { exitCode: 1, stdout: '', stderr: `Task not found: ${label}. ${hint}\n` };
  }

  const workspaceFolder =
    containerWorkspaceFolder(resolution.devcontainerConfigPath) ?? repoRoot;
  const gateScript = join(repoRoot, '.vscode/scripts/tasks/require-devcontainer.sh');
  const containerPrelude = existsSync(gateScript) ? `bash ${shQuote(gateScript)}` : undefined;

  const tree = resolveTask(
    repoRoot,
    label,
    { workspaceFolder, env: process.env },
    { workspaceFolderHost: repoRoot },
  );

  let client = deps.client;
  let close: (() => Promise<void>) | undefined;
  if (!client) {
    const { connectMaiterm } = await import('@forwood/task-engine');
    const conn = await connectMaiterm();
    client = conn.client;
    close = conn.close;
  }
  try {
    const steps = await dispatchMaiterm(tree, {
      client,
      workspaceFolderHost: repoRoot,
      containerPrelude,
    });
    return { exitCode: 0, stdout: JSON.stringify(steps, null, 2) + '\n', stderr: '' };
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: messageOf(err) + '\n' };
  } finally {
    await close?.();
  }
}

/** Read `workspaceFolder` from a devcontainer.json (tolerating comments). */
function containerWorkspaceFolder(configPath: string | null): string | null {
  if (!configPath) return null;
  try {
    const raw = readFileSync(configPath, 'utf8').replace(/(^|\s)\/\/[^\n]*/g, '');
    const parsed = JSON.parse(raw) as { workspaceFolder?: string };
    return typeof parsed.workspaceFolder === 'string' ? parsed.workspaceFolder : null;
  } catch {
    return null;
  }
}
