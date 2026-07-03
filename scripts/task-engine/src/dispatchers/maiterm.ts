import type { TaskTreeNode, ResolvedTask, ExecutionContext } from '../types.ts';
import { shQuote } from './tmux.ts';

/**
 * Minimum interface the maiTerm dispatcher needs from an MCP client.
 *
 * The dispatcher is parameterised on this interface (not the concrete SDK
 * Client) so unit tests can inject a recording fake without spinning up a
 * real maiTerm. The `connectMaiterm` helper builds an SDK-backed client
 * from a lockfile for real use.
 */
export interface McpClientLike {
  callTool(req: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<McpToolCallResult>;
  close?(): Promise<void>;
}

/**
 * Shape MCP servers return from `tools/call`: a `content` array of message
 * parts, one of which carries the tool's actual JSON-serialised response.
 * `isError: true` signals a tool-level error (distinct from a transport
 * error which would throw).
 */
export interface McpToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Response from maiTerm's `openTab` tool. Field names match the Svelte
 * handler in `feature/mcp-open-tab-and-send-keys` (now `main` on the fork).
 */
export interface OpenTabResult {
  action: 'created' | 'focused';
  tabId: string;
  ptyId: string | null;
  workspaceId: string;
  paneId: string;
  displayName: string;
  warning?: string;
}

export interface MaitermDispatchContext {
  client: McpClientLike;
  /**
   * `workspaceName` passed through to `openTab` so it routes the new tab
   * into a specific workspace instead of the currently-active one. Match
   * VS Code's per-clone workflow: launcher fires from the maiTerm
   * workspace that represents the active clone.
   */
  workspaceName?: string;
  /**
   * Host-side workspace folder. When set, dev commands are wrapped with
   * `devcontainer exec --workspace-folder <hostPath> bash -lc '<cmd>'`
   * before being sent to the tab — same idea as the tmux dispatcher. Set
   * to `null` for plain host-side execution.
   */
  workspaceFolderHost?: string;
  /**
   * Host-side command prefixed (`<prelude> && `) onto container-context
   * commands ahead of the devcontainer exec wrapper — typically the
   * container gate script, so every container tab is self-sufficient on a
   * cold stack (concurrent tabs serialise on the gate's bring-up lock).
   * Host-context commands are never prefixed.
   */
  containerPrelude?: string;
}

export interface MaitermDispatchStep {
  taskLabel: string;
  /** Skipped means "aggregator with no command of its own". */
  skipped: boolean;
  result?: OpenTabResult;
}

/**
 * Walk the dependency tree depth-first and call maiTerm's `openTab` MCP
 * tool for every task with a command. Mirrors the tmux dispatcher's
 * traversal so behaviour stays symmetric across surfaces.
 *
 * Panel → tab semantics (per ADR 0005):
 *   * `presentation.panel: 'dedicated'` + `group: 'X'` → openTab({
 *       name: 'X', reuseExisting: true, command }) — find or create the
 *       `X` tab and re-run.
 *   * `presentation.panel: 'shared'` → openTab({
 *       name: 'shared', reuseExisting: true, command }) — all shared
 *       tasks share one tab named `shared`.
 *   * `presentation.panel: 'new'` → openTab({ name: <label>,
 *       reuseExisting: false, command }) — fresh tab every run.
 *   * unspecified panel → defaults to `shared` (matches VS Code default).
 *
 * Throws on the first tool-level error so the launcher can surface it.
 */
export async function dispatchMaiterm(
  node: TaskTreeNode,
  ctx: MaitermDispatchContext,
): Promise<MaitermDispatchStep[]> {
  const out: MaitermDispatchStep[] = [];
  const emitted = new Set<string>();

  async function visit(n: TaskTreeNode): Promise<void> {
    for (const child of n.dependsOn) await visit(child);

    if (emitted.has(n.task.label)) return;
    emitted.add(n.task.label);

    const task = n.task;
    const command = task.command;
    if (!command || command.trim() === '') {
      out.push({ taskLabel: task.label, skipped: true });
      return;
    }

    const args = buildOpenTabArgs(task, ctx, n.executionContext);
    const callResult = await ctx.client.callTool({
      name: 'openTab',
      arguments: args,
    });
    if (callResult.isError) {
      const detail =
        callResult.content?.find(c => c.type === 'text')?.text ??
        '(no error message)';
      throw new Error(`openTab failed for task '${task.label}': ${detail}`);
    }
    const result = parseToolResult<OpenTabResult>(callResult, task.label);
    out.push({ taskLabel: task.label, skipped: false, result });
  }

  await visit(node);
  return out;
}

/**
 * Compose the JSON arguments for a single `openTab` call from a resolved
 * task record. Exported so tests can assert on argument shape without
 * needing a full dispatcher run.
 *
 * `executionContext` (per-node, derived by the engine — ADR 0006) decides
 * whether the command is wrapped for `devcontainer exec`: only
 * `'container'` tasks are wrapped; host tasks run bare even when
 * `workspaceFolderHost` is set. Defaults to `'container'` so direct callers
 * keep the legacy wrap-everything behaviour.
 */
export function buildOpenTabArgs(
  task: ResolvedTask,
  ctx: { workspaceName?: string; workspaceFolderHost?: string; containerPrelude?: string },
  executionContext: ExecutionContext = 'container',
): Record<string, unknown> {
  const presentation = task.presentation ?? {};
  const panel = presentation.panel ?? 'shared';
  const group = presentation.group;

  let name: string;
  let reuseExisting: boolean;
  if (panel === 'shared') {
    name = group ?? 'shared';
    reuseExisting = true;
  } else if (panel === 'new') {
    name = group ?? task.label;
    reuseExisting = false;
  } else {
    // 'dedicated' or unknown — treat as dedicated.
    name = group ?? task.label;
    reuseExisting = true;
  }

  // Persistent (dedicated/new) tabs hold long-running things — dev servers — so
  // after the task's process exits (e.g. the user Ctrl-C's the API server) the
  // tab should NOT go inert: it drops into a live login shell at the project
  // root, ready to re-fire. `options.cwd` is the resolved workspaceFolder —
  // container path (container ctx) or host clone (host ctx). Shared/quick tasks
  // keep the plain command.
  const persistent = panel !== 'shared';
  const taskRoot = task.options?.cwd;
  const hostRoot = ctx.workspaceFolderHost;

  let command: string;
  if (executionContext === 'container') {
    // The in-container script: cd to the container root, run the task, and —
    // for persistent (dev-server) tabs — drop into an interactive container
    // shell at the root afterwards.
    const cd = taskRoot ? `cd ${shQuote(taskRoot)} 2>/dev/null; ` : '';
    const keepAlive = persistent ? `; ${cd}exec "\${SHELL:-/bin/bash}" -l` : '';
    const containerInner = `${cd}${task.command ?? ''}${keepAlive}`;

    // HOST branch: bring the container up (prelude) then exec into it.
    const execWrapped = wrapForContainer(containerInner, hostRoot);
    const hostBranch = ctx.containerPrelude ? `${ctx.containerPrelude} && ${execWrapped}` : execWrapped;

    // IDEMPOTENT: `[ -e <hostClone> ]` is true ONLY on the host (that absolute
    // path doesn't exist inside the container). On the host → take the host
    // branch (gate + `devcontainer exec`). Already inside the container → run
    // the task DIRECTLY: no host gate (its path is missing) and no nested
    // `devcontainer exec` ("already in a container, going in again"). Either
    // starting context converges on the same end state — in the container with
    // the task running — so re-firing into the shell it leaves you in works.
    command = hostRoot
      ? `if [ -e ${shQuote(hostRoot)} ]; then ${hostBranch}; else ${containerInner}; fi`
      : hostBranch;
  } else {
    // Host task: keep-alive is already host-side; land at the host project root.
    command =
      persistent && taskRoot
        ? keepInteractiveShellAtRoot(task.command ?? '', taskRoot)
        : (task.command ?? '');
  }

  const args: Record<string, unknown> = {
    name,
    command,
    reuseExisting,
  };
  if (ctx.workspaceName !== undefined) args['workspaceName'] = ctx.workspaceName;
  return args;
}

/**
 * Wrap a container-side command with `devcontainer exec --workspace-folder
 * <hostPath> bash -lc '<cmd>'`. When `hostPath` is undefined, returns the
 * command unchanged (caller wants plain host-side execution).
 */
export function wrapForContainer(
  command: string,
  hostPath: string | undefined,
): string {
  if (!hostPath) return command;
  return (
    `devcontainer exec --workspace-folder ${shQuote(hostPath)} ` +
    `bash -lc ${shQuote(command)}`
  );
}

/**
 * Compose `command` so that whatever its exit, the terminal returns to `root`
 * and hands the user an interactive login shell — a killed dev server leaves a
 * live shell at the project root, in the same context the task ran in, instead
 * of a dead tab or a fallback host shell. `;` (not `&&`) so the return-to-root
 * runs even if the command fails; `2>/dev/null` on cd so a missing dir doesn't
 * spew. `${SHELL:-/bin/bash}` resolves in the target context (host or, under
 * devcontainer exec, the container).
 */
export function keepInteractiveShellAtRoot(command: string, root: string): string {
  const cd = `cd ${shQuote(root)} 2>/dev/null`;
  return `${cd}; ${command}; ${cd}; exec "\${SHELL:-/bin/bash}" -l`;
}

/**
 * Pull the JSON payload out of an MCP tool-call result. maiTerm packs the
 * handler's return value into `content[0].text` as a JSON string.
 */
function parseToolResult<T>(result: McpToolCallResult, taskLabel: string): T {
  const text = result.content?.find(c => c.type === 'text')?.text;
  if (!text) {
    throw new Error(
      `openTab for '${taskLabel}': MCP result missing text content`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `openTab for '${taskLabel}': MCP result not JSON: ${String(err)}`,
    );
  }
}
