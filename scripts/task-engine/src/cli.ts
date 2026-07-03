#!/usr/bin/env node
/**
 * task-engine CLI — thin wrapper over the public API.
 *
 *   task-engine list <clone-path> [--include-hidden]
 *       List every task in `<clone-path>/.vscode/tasks.json`. JSON output:
 *       one object per task (full VS Code-shaped record).
 *
 *   task-engine resolve <clone-path> <task-label> [--input id=value ...]
 *       Variable-substitute the named task and emit its full dependency
 *       tree as JSON. `--input id=value` provides pre-resolved values for
 *       `${input:id}` references; the engine itself doesn't prompt.
 *
 *   task-engine dispatch tmux <clone-path> <task-label>
 *       --target-window <session:window>
 *       --workspace-folder-host <host-path>
 *       [--workspace-folder <container-path>]   (default: <clone-path>)
 *       [--input id=value ...]
 *
 *       Emit a bash dispatch script for the task tree, ready to pipe to
 *       `bash`. Replaces the legacy Python `task-emit` for the tmux
 *       picker — same output shape (tmux send-keys + devcontainer exec
 *       wrapper for dedicated panels).
 *
 * Output is JSON for `list` / `resolve`, bash for `dispatch`. Errors go
 * to stderr with a non-zero exit code.
 */

import process from 'node:process';
import { listTasks, resolveTask, type VariableContext } from './index.ts';
import { emitTmuxDispatch, type TmuxDispatchContext } from './dispatchers/tmux.ts';
import { dispatchMaiterm } from './dispatchers/maiterm.ts';
import { connectMaiterm } from './dispatchers/maiterm-connect.ts';

function die(msg: string, code = 1): never {
  process.stderr.write(`task-engine: ${msg}\n`);
  process.exit(code);
}

function parseInputs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--input') continue;
    const kv = args[i + 1];
    if (!kv) die(`--input requires id=value`);
    const eq = kv.indexOf('=');
    if (eq < 0) die(`--input expected id=value, got: ${kv}`);
    out[kv.slice(0, eq)] = kv.slice(eq + 1);
    i++;
  }
  return out;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Pull `--name value` out of an arg list; returns undefined if absent. */
function getOpt(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (value === undefined) die(`${name} requires a value`);
  return value;
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(
      `Usage:\n` +
        `  task-engine list <clone-path> [--include-hidden]\n` +
        `  task-engine resolve <clone-path> <task-label> [--input id=value ...]\n` +
        `  task-engine dispatch tmux <clone-path> <task-label> \\\n` +
        `      --target-window <session:window> \\\n` +
        `      --workspace-folder-host <host-path> \\\n` +
        `      [--workspace-folder <container-path>] \\\n` +
        `      [--input id=value ...]\n` +
        `  task-engine dispatch maiterm <clone-path> <task-label> \\\n` +
        `      [--workspace-name <name>] \\\n` +
        `      [--workspace-folder-host <host-path>] \\\n` +
        `      [--workspace-folder <container-path>] \\\n` +
        `      [--input id=value ...]\n`,
    );
    return;
  }

  if (cmd === 'list') {
    const clonePath = rest[0];
    if (!clonePath) die(`list: missing <clone-path>`);
    const tasks = listTasks(clonePath, {
      includeHidden: hasFlag(rest, '--include-hidden'),
    });
    process.stdout.write(JSON.stringify(tasks) + '\n');
    return;
  }

  if (cmd === 'resolve') {
    const clonePath = rest[0];
    const taskLabel = rest[1];
    if (!clonePath || !taskLabel) {
      die(`resolve: missing <clone-path> or <task-label>`);
    }
    const inputs = parseInputs(rest);
    const ctx: VariableContext = {
      workspaceFolder: clonePath,
      env: process.env,
      inputs,
    };
    const tree = resolveTask(clonePath, taskLabel, ctx);
    process.stdout.write(JSON.stringify(tree, null, 2) + '\n');
    return;
  }

  if (cmd === 'dispatch') {
    const surface = rest[0];
    if (surface === 'tmux') return void dispatchTmuxFromCli(rest.slice(1));
    if (surface === 'maiterm') return void dispatchMaitermFromCli(rest.slice(1));
    die(`dispatch: unknown surface '${surface ?? ''}' (expected 'tmux' or 'maiterm')`);
  }

  die(`unknown command: ${cmd}`);
}

function dispatchTmuxFromCli(rest: string[]): void {
  const clonePath = rest[0];
  const taskLabel = rest[1];
  if (!clonePath || !taskLabel) {
    die(`dispatch tmux: missing <clone-path> or <task-label>`);
  }
  const targetWindow = getOpt(rest, '--target-window');
  const workspaceFolderHost = getOpt(rest, '--workspace-folder-host');
  if (!targetWindow) die(`dispatch tmux: --target-window required`);
  if (!workspaceFolderHost) die(`dispatch tmux: --workspace-folder-host required`);

  // ${workspaceFolder} substitution uses the container-side path the task
  // commands will see when run via `devcontainer exec`. Defaults to the
  // clone path if --workspace-folder isn't passed (matches how a non-
  // devcontainer task would resolve).
  const workspaceFolder = getOpt(rest, '--workspace-folder') ?? clonePath;
  const inputs = parseInputs(rest);

  const ctx: VariableContext = {
    workspaceFolder,
    env: process.env,
    inputs,
  };
  const tree = resolveTask(clonePath, taskLabel, ctx, { workspaceFolderHost });

  const tmuxCtx: TmuxDispatchContext = { targetWindow, workspaceFolderHost };
  process.stdout.write(emitTmuxDispatch(tree, tmuxCtx));
}

async function dispatchMaitermFromCli(rest: string[]): Promise<void> {
  const clonePath = rest[0];
  const taskLabel = rest[1];
  if (!clonePath || !taskLabel) {
    die(`dispatch maiterm: missing <clone-path> or <task-label>`);
  }
  const workspaceName = getOpt(rest, '--workspace-name');
  const workspaceFolderHost = getOpt(rest, '--workspace-folder-host');
  const workspaceFolder = getOpt(rest, '--workspace-folder') ?? clonePath;
  const containerPrelude = getOpt(rest, '--container-prelude');
  const inputs = parseInputs(rest);

  const ctx: VariableContext = { workspaceFolder, env: process.env, inputs };
  const tree = resolveTask(clonePath, taskLabel, ctx, { workspaceFolderHost });

  const conn = await connectMaiterm();
  try {
    const steps = await dispatchMaiterm(tree, {
      client: conn.client,
      workspaceName,
      workspaceFolderHost,
      containerPrelude,
    });
    process.stdout.write(JSON.stringify(steps, null, 2) + '\n');
  } finally {
    await conn.close();
  }
}

main(process.argv.slice(2));
