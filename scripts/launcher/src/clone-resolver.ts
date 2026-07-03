import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Resolve the active forwood-one clone for this launcher invocation.
 *
 * Priority (per ADR-0005, refined with cwd-walk fallback):
 *   1. `--clone <name>` CLI override (always wins).
 *   2. `FORWOOD_CLONE` environment variable (set per maiTerm workspace).
 *   3. Current working directory — walk up from cwd looking for a
 *      `forwood-one` or `forwood-one_<suffix>` ancestor.
 *   4. Otherwise → null; the caller surfaces a picker or errors.
 *
 * Maps clone name → host-side path using the same convention the tmux
 * picker uses (`scripts/terminal/tmux-workspaces/bin/task-picker.sh`):
 *   - `main`    → `$PROJ_ROOT/forwood-one`
 *   - anything  → `$PROJ_ROOT/forwood-one_<name>`
 *
 * Cwd-walk returns the *real* directory path it found (which may diverge
 * from `clonePathFor` if your clones live outside `$PROJ_ROOT`).
 */

export interface CloneInfo {
  /** The clone name (e.g. `developing`, `reviewing`, `main`). */
  name: string;
  /** Absolute host-side path to the clone's checkout. */
  path: string;
  /** Where this resolution came from — useful for error messages. */
  source: 'arg' | 'env' | 'cwd' | 'fallback';
}

export interface CloneResolverOptions {
  /** CLI `--clone <name>` value, if provided. */
  arg?: string;
  /** `FORWOOD_CLONE` env value, if set. Defaults to `process.env.FORWOOD_CLONE`. */
  env?: string;
  /** Current working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Parent directory of `forwood-one*` checkouts.
   * Defaults to `$PROJ_ROOT` env or `~/proj`.
   */
  projRoot?: string;
}

const KNOWN_CLONES = ['main', 'developing', 'reviewing', 'experimenting', 'quick-fixes'];

export function projRoot(opts: CloneResolverOptions = {}): string {
  return opts.projRoot ?? process.env['PROJ_ROOT'] ?? join(homedir(), 'proj');
}

export function clonePathFor(name: string, opts: CloneResolverOptions = {}): string {
  const root = projRoot(opts);
  if (name === 'main') return join(root, 'forwood-one');
  return join(root, `forwood-one_${name}`);
}

/**
 * Walk up from `cwd` looking for an ancestor whose basename matches
 *   - `forwood-one`       → clone name `main`
 *   - `forwood-one_<x>`   → clone name `<x>` (e.g. `developing`)
 *
 * Returns the first match. Does NOT match `forwood-one-tests*` or
 * `forwood-one-tools*` — only the product clone naming convention
 * (`forwood-one_<suffix>` with an underscore).
 *
 * Returns null when no ancestor matches.
 */
export function resolveCloneFromCwd(cwd: string): CloneInfo | null {
  let current = cwd;
  // Cap the walk in case `cwd` is something pathological — fs root will
  // make `dirname` return itself, but a defensive max-depth keeps the
  // loop from spinning if we ever change to a logical pwd that doesn't
  // shorten.
  for (let depth = 0; depth < 64; depth++) {
    const name = basename(current);
    if (name === 'forwood-one') {
      return { name: 'main', path: current, source: 'cwd' };
    }
    const match = /^forwood-one_(.+)$/.exec(name);
    if (match && match[1] !== undefined) {
      return { name: match[1], path: current, source: 'cwd' };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Resolve the active clone. Returns the [[CloneInfo]] when the source is
 * unambiguous, or null when nothing is set (the launcher should then
 * fall back to a picker or error).
 *
 * Does NOT validate that the clone directory exists — that's
 * `validateClone`'s job.
 */
export function resolveClone(opts: CloneResolverOptions = {}): CloneInfo | null {
  const envValue = opts.env ?? process.env['FORWOOD_CLONE'];
  if (opts.arg) {
    return { name: opts.arg, path: clonePathFor(opts.arg, opts), source: 'arg' };
  }
  if (envValue) {
    return { name: envValue, path: clonePathFor(envValue, opts), source: 'env' };
  }
  const cwd = opts.cwd ?? process.cwd();
  return resolveCloneFromCwd(cwd);
}

/**
 * Check that a clone's `.vscode/tasks.json` exists at the resolved path.
 * Returns the same `CloneInfo` on success; throws with an actionable
 * message on failure.
 */
export function validateClone(info: CloneInfo): CloneInfo {
  const tasksFile = join(info.path, '.vscode', 'tasks.json');
  if (!existsSync(tasksFile)) {
    const known = KNOWN_CLONES.join(' / ');
    throw new Error(
      `Clone '${info.name}' (source: ${info.source}) → ${info.path}\n` +
        `tasks.json not found at ${tasksFile}.\n` +
        `Known clone names: ${known}. Override with --clone <name> or set FORWOOD_CLONE.`,
    );
  }
  return info;
}

export const KNOWN_CLONE_NAMES = KNOWN_CLONES;
