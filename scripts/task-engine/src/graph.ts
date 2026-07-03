import type { Task, TaskTreeNode, ResolvedTask, ExecutionContext } from './types.ts';

/**
 * The well-known container gate task (ADR 0006): its presence anywhere in a
 * task's `dependsOn` chain marks that task as container execution context.
 * Overridable per call for non-forwood task lists.
 */
export const REQUIRE_DEVCONTAINER_LABEL = 'Require devcontainer';

export interface ExecutionContextOptions {
  /** Gate label to look for; defaults to {@link REQUIRE_DEVCONTAINER_LABEL}. */
  gateLabel?: string;
}

/**
 * Build the dependency tree for `rootLabel`. VS Code's `dependsOn` semantics:
 * a task lists zero-or-more pre-requisite tasks to run *before* its own
 * command; `dependsOrder` (`sequence` | `parallel`, default `parallel`)
 * controls whether those pre-requisites run one-at-a-time or together.
 *
 * The engine emits the tree — dispatchers decide *how* to execute it. Each
 * node carries a derived `executionContext`: `'container'` iff the gate task
 * appears in its subtree, `'host'` otherwise (and for the gate itself).
 *
 * Throws on missing dependency or dependency cycle. A cycle is any path
 * where a task transitively depends on itself.
 */
export function buildTaskTree(
  rootLabel: string,
  allTasks: readonly Task[],
  options: ExecutionContextOptions = {},
): TaskTreeNode {
  const gateLabel = options.gateLabel ?? REQUIRE_DEVCONTAINER_LABEL;
  const byLabel = new Map(allTasks.map(t => [t.label, t]));
  const root = byLabel.get(rootLabel);
  if (!root) throw new Error(`Task not found: ${rootLabel}`);

  const path: string[] = [];

  function buildNode(task: Task): { node: TaskTreeNode; gateInSubtree: boolean } {
    if (path.includes(task.label)) {
      throw new Error(
        `Dependency cycle: ${[...path, task.label].join(' -> ')}`,
      );
    }
    path.push(task.label);

    const depLabels = task.dependsOn === undefined
      ? []
      : Array.isArray(task.dependsOn)
        ? task.dependsOn
        : [task.dependsOn];

    let gateInSubtree = false;
    const dependsOn = depLabels.map(label => {
      const dep = byLabel.get(label);
      if (!dep) {
        throw new Error(`Missing dependency: ${label} (referenced by ${task.label})`);
      }
      const child = buildNode(dep);
      if (label === gateLabel || child.gateInSubtree) gateInSubtree = true;
      return child.node;
    });

    path.pop();

    const executionContext: ExecutionContext =
      task.label !== gateLabel && gateInSubtree ? 'container' : 'host';

    return {
      node: {
        task: task as ResolvedTask,
        dependsOn,
        dependsOrder: task.dependsOrder ?? 'parallel',
        executionContext,
      },
      gateInSubtree,
    };
  }

  return buildNode(root).node;
}

/**
 * Derive a single task's execution context without keeping the tree around.
 * Same validation as `buildTaskTree` (missing dependency / cycle / unknown
 * label all throw identically).
 */
export function deriveExecutionContext(
  rootLabel: string,
  allTasks: readonly Task[],
  options: ExecutionContextOptions = {},
): ExecutionContext {
  return buildTaskTree(rootLabel, allTasks, options).executionContext;
}

/**
 * Flatten a task tree into a linear execution plan, honouring `dependsOrder`.
 * Useful for dispatchers that run tasks one-at-a-time (e.g. the tmux picker
 * which fires `send-keys` into a single pane).
 *
 * Output order: deepest-first, then siblings in declaration order. Parallel
 * groups are still emitted serially here — call sites that genuinely run
 * in parallel should walk the tree directly via `buildTaskTree`.
 */
export function flattenSequential(node: TaskTreeNode): ResolvedTask[] {
  const out: ResolvedTask[] = [];
  const seen = new Set<string>();
  function visit(n: TaskTreeNode): void {
    for (const child of n.dependsOn) visit(child);
    if (!seen.has(n.task.label)) {
      seen.add(n.task.label);
      out.push(n.task);
    }
  }
  visit(node);
  return out;
}
