import type { TaskTreeNode } from '../types.ts';

/**
 * Context the tmux dispatcher needs to emit a bash dispatch script.
 *
 * The engine's variable resolver already substitutes `${workspaceFolder}` in
 * task commands using the *container-side* path (e.g. `/workspaces/website`).
 * The dispatcher then wraps those container commands with `devcontainer exec
 * --workspace-folder <hostPath>` so tmux fires them from the host shell.
 */
export interface TmuxDispatchContext {
  /** tmux target window, e.g. `devcontainers:developing`. */
  targetWindow: string;
  /** Host-side path passed to `devcontainer exec --workspace-folder`. */
  workspaceFolderHost: string;
}

/** POSIX shell single-quote escape — bash-safe quoting of an arbitrary string. */
export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Sanitize an arbitrary string to a valid tmux pane title token: replace
 * anything that isn't alphanumeric / `.` / `_` / `-` with `_`. Matches the
 * legacy Python emitter so existing pane titles continue to match by lookup.
 */
export function paneTitle(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Status-footer wrapper applied to dedicated-panel tasks. Prints a ✓/✗
 * banner with exit code + elapsed seconds, waits for any keypress, then
 * exits with the task's return code so the pane closes carrying the rc.
 *
 * Byte-for-byte equivalent of the legacy bash emitter so existing muscle
 * memory (banner colour, prompt text) stays unchanged.
 */
const DEDICATED_FOOTER =
  '; __rc=$?; __dur=$((SECONDS-__t0)); echo; ' +
  'if [ $__rc -eq 0 ]; then ' +
  'printf "\\033[32m✓ task succeeded\\033[0m (%ss)\\n" "$__dur"; ' +
  'else ' +
  'printf "\\033[31m✗ task failed (exit %d)\\033[0m (%ss)\\n" "$__rc" "$__dur"; ' +
  'fi; ' +
  'read -rsn 1 -p "press any key to close…"; ' +
  'echo; exit $__rc';

/**
 * Emit a bash dispatch script for the given task tree. The script:
 *   - For `presentation.panel: "shared"` tasks, sends the command into the
 *     window's pane 0 with `tmux send-keys`.
 *   - For `presentation.panel: "dedicated"` (and `"new"`, treated the same)
 *     tasks, finds a pane whose title matches `presentation.group` (or the
 *     task label) and re-runs the command there (Ctrl-C first); if no such
 *     pane exists, splits a new one running `devcontainer exec ...` wrapped
 *     with the timing footer.
 *   - Walks `dependsOn` depth-first in declaration order, emitting each
 *     dependency before the parent. Aggregator tasks (no `command`, just
 *     `dependsOn`) emit only their children's dispatch.
 *
 * Tasks already dispatched in this walk are skipped on repeat references —
 * matching the legacy emitter's `emitted` set so a shared dependency only
 * fires once.
 *
 * Note on `dependsOrder`: the dispatcher emits serially in declaration order
 * regardless of `dependsOrder`. tmux `send-keys` is itself asynchronous (it
 * just queues keystrokes into target panes), so the resulting panes run
 * concurrently in practice. Honouring `dependsOrder: "sequence"` strictly
 * (blocking until each prereq finishes) would require execution-side
 * coordination the engine deliberately doesn't model — see ADR 0005.
 */
export function emitTmuxDispatch(
  node: TaskTreeNode,
  ctx: TmuxDispatchContext,
): string {
  const lines: string[] = [];
  const emitted = new Set<string>();

  function visit(n: TaskTreeNode): void {
    for (const child of n.dependsOn) visit(child);

    if (emitted.has(n.task.label)) return;
    emitted.add(n.task.label);

    const task = n.task;
    const command = task.command;
    if (!command || command.trim() === '') {
      // Aggregator task: nothing more to dispatch after the children.
      return;
    }

    const presentation = task.presentation ?? {};
    const panel = presentation.panel ?? 'shared';
    const group = presentation.group ?? task.label;

    lines.push(`# task: ${task.label}`);

    if (panel === 'shared') {
      const sendTarget = `${ctx.targetWindow}.0`;
      lines.push(
        `tmux send-keys -t ${shQuote(sendTarget)} ${shQuote(command)} Enter`,
      );
      return;
    }

    // Dedicated / new: find-or-create a pane whose title matches the group.
    // Per-node execution context (ADR 0006): only container-context tasks
    // get the devcontainer exec wrapper; host-context tasks run in a plain
    // host shell in their new pane.
    const title = paneTitle(group);
    const wrapper = '__t0=$SECONDS; ' + command + DEDICATED_FOOTER;
    const inner =
      n.executionContext === 'container'
        ? `devcontainer exec --workspace-folder ${shQuote(ctx.workspaceFolderHost)} ` +
          `bash -lc ${shQuote(wrapper)}`
        : `bash -lc ${shQuote(wrapper)}`;
    const win = shQuote(ctx.targetWindow);

    lines.push(
      `pane_id=$(tmux list-panes -t ${win} -F "#{pane_id} #{pane_title}" ` +
        `| awk -v t=${shQuote(title)} '$2==t {print $1; exit}')`,
    );
    lines.push('if [[ -n "$pane_id" ]]; then');
    lines.push('  tmux select-pane -t "$pane_id"');
    lines.push('  tmux send-keys -t "$pane_id" C-c 2>/dev/null || true');
    lines.push(`  tmux send-keys -t "$pane_id" ${shQuote(command)} Enter`);
    lines.push('else');
    lines.push(
      `  pane_id=$(tmux split-window -t ${win} -h -P -F "#{pane_id}" ${shQuote(inner)})`,
    );
    lines.push(`  tmux select-pane -t "$pane_id" -T ${shQuote(title)}`);
    lines.push('fi');
  }

  visit(node);
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}
