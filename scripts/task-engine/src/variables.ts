import type { TaskInput } from './types.ts';

/**
 * Context the engine uses to resolve `${…}` variables found in task fields.
 *
 * `inputs` carries pre-resolved values for `${input:id}` references — the
 * engine itself doesn't prompt; the caller (CLI / launcher) is responsible
 * for collecting input values and passing them in. This keeps the engine
 * pure and easy to test.
 */
export interface VariableContext {
  /** Absolute path to the workspace root (= the clone root for our tasks). */
  workspaceFolder: string;
  /** Environment variables visible to the engine (typically `process.env`). */
  env: Record<string, string | undefined>;
  /** Pre-resolved input values, keyed by input `id`. Optional. */
  inputs?: Record<string, string>;
}

const VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Resolve `${variable}` references in a single string. Returns the input
 * unchanged when no variables match.
 *
 * Supported:
 *   - `${workspaceFolder}`         → ctx.workspaceFolder
 *   - `${workspaceFolderBasename}` → basename of ctx.workspaceFolder
 *   - `${userHome}`                → process.env.HOME / USERPROFILE
 *   - `${env:NAME}`                → ctx.env.NAME (empty string if missing)
 *   - `${input:ID}`                → ctx.inputs[ID] (or `unresolvedInput` callback)
 *
 * Anything else is left untouched (`${file}`, `${selectedText}`, …): those
 * variables require editor context the engine doesn't have.
 */
export function resolveString(
  value: string,
  ctx: VariableContext,
  options?: { unresolvedInput?: (id: string) => string },
): string {
  return value.replace(VAR_PATTERN, (match, expr: string) => {
    if (expr === 'workspaceFolder') return ctx.workspaceFolder;
    if (expr === 'workspaceFolderBasename') {
      const segs = ctx.workspaceFolder.replace(/\/+$/, '').split('/');
      return segs[segs.length - 1] ?? ctx.workspaceFolder;
    }
    if (expr === 'userHome') {
      return process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
    }
    if (expr.startsWith('env:')) {
      const name = expr.slice(4);
      return ctx.env[name] ?? '';
    }
    if (expr.startsWith('input:')) {
      const id = expr.slice(6);
      const resolved = ctx.inputs?.[id];
      if (resolved !== undefined) return resolved;
      if (options?.unresolvedInput) return options.unresolvedInput(id);
      return match;
    }
    return match;
  });
}

/**
 * Walk an arbitrary JSON-shaped value and resolve `${…}` in every string leaf.
 * Returns a structurally equivalent value with substituted strings.
 */
export function resolveDeep<T>(
  value: T,
  ctx: VariableContext,
  options?: { unresolvedInput?: (id: string) => string },
): T {
  if (typeof value === 'string') {
    return resolveString(value, ctx, options) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(v => resolveDeep(v, ctx, options)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveDeep(v, ctx, options);
    }
    return out as T;
  }
  return value;
}

/**
 * List every `${input:ID}` reference appearing anywhere in `value` (recursively).
 * The CLI / launcher uses this to know which inputs to prompt for before
 * resolving a task.
 */
export function listRequiredInputs(value: unknown): string[] {
  const ids = new Set<string>();
  function visit(v: unknown): void {
    if (typeof v === 'string') {
      let m: RegExpExecArray | null;
      VAR_PATTERN.lastIndex = 0;
      while ((m = VAR_PATTERN.exec(v)) !== null) {
        const expr = m[1] ?? '';
        if (expr.startsWith('input:')) ids.add(expr.slice(6));
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const child of Object.values(v as Record<string, unknown>)) visit(child);
    }
  }
  visit(value);
  return [...ids];
}

/**
 * Resolve an input declaration's `default` against the context. Used to
 * surface a sensible pre-filled value when prompting the user. Returns
 * undefined if the input has no default or the type is `command` (which the
 * engine doesn't execute — caller would need its own resolver).
 */
export function resolveInputDefault(
  input: TaskInput,
  ctx: VariableContext,
): string | undefined {
  if (input.type === 'command') return undefined;
  if (input.default === undefined) return undefined;
  return resolveString(input.default, ctx);
}
