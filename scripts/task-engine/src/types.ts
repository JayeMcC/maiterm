/**
 * VS Code tasks.json schema, restricted to the subset the engine actually
 * cares about. Pass-through philosophy (ADR 0005): field names match VS Code
 * exactly so the engine never invents its own model. Dispatchers translate
 * `presentation.panel` / `presentation.group` / etc. into their native idioms.
 *
 * Reference: https://code.visualstudio.com/docs/editor/tasks-appendix
 */

export interface TaskFile {
  version?: string;
  inputs?: TaskInput[];
  tasks: Task[];
}

export type TaskInput = PromptStringInput | PickStringInput | CommandInput;

export interface PromptStringInput {
  id: string;
  type: 'promptString';
  description?: string;
  default?: string;
  password?: boolean;
}

export interface PickStringInput {
  id: string;
  type: 'pickString';
  description?: string;
  default?: string;
  options: (string | { label: string; value: string })[];
}

export interface CommandInput {
  id: string;
  type: 'command';
  command: string;
  args?: Record<string, unknown>;
}

export interface Task {
  label: string;
  type?: 'shell' | 'process';
  command?: string;
  args?: (string | { value: string; quoting?: 'escape' | 'strong' | 'weak' })[];
  options?: TaskOptions;
  dependsOn?: string | string[];
  dependsOrder?: 'sequence' | 'parallel';
  presentation?: TaskPresentation;
  isBackground?: boolean;
  problemMatcher?: unknown;
  group?: string | { kind: string; isDefault?: boolean };
  runOptions?: { runOn?: 'default' | 'folderOpen'; instanceLimit?: number };
  hide?: boolean;
}

export interface TaskOptions {
  cwd?: string;
  env?: Record<string, string>;
  shell?: { executable?: string; args?: string[] };
}

export interface TaskPresentation {
  reveal?: 'always' | 'silent' | 'never';
  echo?: boolean;
  focus?: boolean;
  panel?: 'shared' | 'dedicated' | 'new';
  group?: string;
  close?: boolean;
  clear?: boolean;
  showReuseMessage?: boolean;
}

/**
 * The engine's resolution of a single task. Identical shape to `Task` (we don't
 * invent fields), but every `${…}` variable has been substituted using a
 * `VariableContext`.
 */
export type ResolvedTask = Task;

/**
 * Where a task's command executes (ADR 0006): on the host (default) or inside
 * the clone's devcontainer. Derived at emission from the dependency graph —
 * never a tasks.json field; the source schema stays pass-through.
 */
export type ExecutionContext = 'host' | 'container';

/**
 * A node in a task's dependency tree.
 *
 * VS Code's `dependsOn` semantics: each task may list zero-or-more tasks to
 * run *before* itself, with `dependsOrder` controlling whether those
 * pre-requisites run in `sequence` or `parallel`. A composite task may carry
 * just a `dependsOn` and no `command` of its own (an aggregator); a leaf task
 * has no `dependsOn` and just a command.
 */
export interface TaskTreeNode {
  task: ResolvedTask;
  /** Pre-requisite tasks to run before `task.command` (if any). */
  dependsOn: TaskTreeNode[];
  /** How the entries in `dependsOn` run relative to each other. */
  dependsOrder: 'sequence' | 'parallel';
  /**
   * Derived per node: `'container'` iff the container gate task appears in
   * this node's `dependsOn` subtree; the gate task itself is `'host'`
   * (in-container it's a no-op guard, on the host it performs the bring-up).
   */
  executionContext: ExecutionContext;
}
