/**
 * @forwood/task-engine — public API.
 *
 * See ADR 0005 (docs/adr/0005-task-engine-and-dispatchers.md) for the
 * architecture: pass-through interpreter of `.vscode/tasks.json`, no
 * invented fields, dispatchers do the surface-specific translation.
 */

export type {
  Task,
  TaskFile,
  TaskInput,
  TaskOptions,
  TaskPresentation,
  TaskTreeNode,
  ResolvedTask,
  ExecutionContext,
  PromptStringInput,
  PickStringInput,
  CommandInput,
} from './types.ts';

export { readTasksFile } from './reader.ts';

export { resolveDir, type DirResolution } from './resolve-dir.ts';

export {
  resolveString,
  resolveDeep,
  resolveInputDefault,
  listRequiredInputs,
  type VariableContext,
} from './variables.ts';

export {
  buildTaskTree,
  flattenSequential,
  deriveExecutionContext,
  REQUIRE_DEVCONTAINER_LABEL,
  type ExecutionContextOptions,
} from './graph.ts';

export {
  emitTmuxDispatch,
  shQuote,
  paneTitle,
  type TmuxDispatchContext,
} from './dispatchers/tmux.ts';

export {
  dispatchMaiterm,
  buildOpenTabArgs,
  wrapForContainer,
  type McpClientLike,
  type McpToolCallResult,
  type OpenTabResult,
  type MaitermDispatchContext,
  type MaitermDispatchStep,
} from './dispatchers/maiterm.ts';

export {
  findLiveMaitermLock,
  type MaitermLock,
} from './dispatchers/lockfile.ts';

// `connectMaiterm` lives in a separate module so it (and the heavy SDK
// it imports) can be tree-shaken out of test runs. Real callers import it
// directly; tests use `dispatchMaiterm` with a fake client.
export { connectMaiterm, type MaitermConnection } from './dispatchers/maiterm-connect.ts';

import { readTasksFile } from './reader.ts';
import { resolveDeep, type VariableContext } from './variables.ts';
import { buildTaskTree, type ExecutionContextOptions } from './graph.ts';
import type { Task, TaskFile, TaskTreeNode } from './types.ts';

export interface ListTasksOptions {
  /** Include tasks with `hide: true` (false by default — matches VS Code's picker). */
  includeHidden?: boolean;
}

/**
 * One-shot helper: read `tasks.json` and return every task (variables NOT
 * resolved yet — pass the result through `resolveDeep` per task once a
 * `VariableContext` is built).
 */
export function listTasks(clonePath: string, options: ListTasksOptions = {}): Task[] {
  const file = readTasksFile(clonePath);
  const tasks = file.tasks ?? [];
  return options.includeHidden ? tasks : tasks.filter(t => !t.hide);
}

export interface ResolveTaskOptions extends ExecutionContextOptions {
  /**
   * Host-side workspace folder (PLAN-15). When set, host-context nodes —
   * including the gate itself — resolve `${workspaceFolder}` against this
   * path; container-context nodes keep `ctx.workspaceFolder` (the
   * container-side path their commands will see under `devcontainer exec`).
   * Without it, every node resolves against `ctx.workspaceFolder` (legacy).
   */
  workspaceFolderHost?: string;
}

/**
 * Resolve a single task by label: variable-substitute its fields and build
 * its dependency tree. The returned `TaskTreeNode` is what a dispatcher
 * consumes — every string is already substituted, every `dependsOn` is
 * already linked to the actual referenced task records, and every node
 * carries its derived execution context.
 */
export function resolveTask(
  clonePath: string,
  taskLabel: string,
  ctx: VariableContext,
  options: ResolveTaskOptions = {},
): TaskTreeNode {
  const file = readTasksFile(clonePath);
  const allTasks = file.tasks ?? [];
  // Build from RAW tasks (labels are never variable-bearing), so each node's
  // derived context can pick its own variable context for resolution.
  const tree = buildTaskTree(taskLabel, allTasks, options);
  const hostCtx: VariableContext = options.workspaceFolderHost
    ? { ...ctx, workspaceFolder: options.workspaceFolderHost }
    : ctx;
  const resolveNode = (n: TaskTreeNode): void => {
    n.task = resolveDeep(n.task, n.executionContext === 'host' ? hostCtx : ctx);
    n.dependsOn.forEach(resolveNode);
  };
  resolveNode(tree);
  return tree;
}

export type { TaskFile as _TaskFile };
