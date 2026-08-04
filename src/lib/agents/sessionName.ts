// Session naming convention + auto-namer.
//
// Convention:  <stack>·<location>·<ticket>·<work-part>
// Example:     s4·review·EAP-3007·get-it-green
//
// A structured, resumable session name that the app fills automatically from a
// tab's context — stack + location from the tab's cwd, ticket (and a starter
// work-part) from the current git branch — leaving the work-part for the user
// to tweak. A convention nobody auto-applies drifts; this is the auto-applier.
//
// PURE by design: no `$lib`, no Tauri, no Svelte imports, so it runs under plain
// Node in vitest (see sessionName.test.ts). The async glue that reads the live
// cwd/branch lives at the wire-in site (TerminalTabs.startEditing), which passes
// the resolved { cwd, branch } in here.

/** The four fields of a session name, in canonical order. */
export type SessionNameField = 'stack' | 'location' | 'ticket' | 'workPart';

/** Canonical field order — the builder always emits fields in exactly this order. */
export const FIELD_ORDER: readonly SessionNameField[] = ['stack', 'location', 'ticket', 'workPart'];

/** The separator between fields (U+00B7 MIDDLE DOT). */
export const SEPARATOR = '·'; // ·

/** Default placeholder used for a field whose value is unknown. */
export const DEFAULT_FALLBACKS: Record<SessionNameField, string> = {
  stack: 'local',
  location: 'session',
  ticket: 'no-ticket',
  workPart: 'wip',
};

/** Max characters kept per field before truncation (keeps tab titles readable). */
const DEFAULT_MAX_FIELD_LENGTH = 32;

/** Raw (possibly unknown) values for the four fields. */
export interface SessionNameParts {
  stack?: string | null;
  location?: string | null;
  ticket?: string | null;
  workPart?: string | null;
}

export interface BuildSessionNameOptions {
  /** Override the field separator (default `·`). */
  separator?: string;
  /** Override per-field fallbacks used when a value is empty/unknown. */
  fallbacks?: Partial<Record<SessionNameField, string>>;
  /** Truncate each field to this many characters (default 32). 0 disables. */
  maxFieldLength?: number;
}

/**
 * Normalise one field value: trim, drop any embedded separator (so a value can
 * never fake extra fields), turn whitespace/slashes into single hyphens, and
 * cap length. Returns '' for null/undefined/blank.
 */
export function sanitizeField(value: string | null | undefined, maxLength = DEFAULT_MAX_FIELD_LENGTH): string {
  if (!value) return '';
  let out = String(value)
    .trim()
    .split(SEPARATOR)
    .join('') // never let the separator leak into a field
    .replace(/[\s/\\]+/g, '-') // whitespace + path separators → hyphen
    .replace(/-+/g, '-') // collapse runs
    .replace(/^-+|-+$/g, ''); // trim stray hyphens
  if (maxLength > 0 && out.length > maxLength) {
    out = out.slice(0, maxLength).replace(/-+$/g, '');
  }
  return out;
}

/**
 * Build the `·`-joined session name from parts, substituting a fallback for any
 * field that is empty/unknown. Fields are always emitted in {@link FIELD_ORDER}
 * so the name stays structurally stable (and therefore resumable) even when
 * some context couldn't be resolved.
 */
export function buildSessionName(parts: SessionNameParts, opts: BuildSessionNameOptions = {}): string {
  const separator = opts.separator ?? SEPARATOR;
  const maxLen = opts.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH;
  const fallbacks = { ...DEFAULT_FALLBACKS, ...(opts.fallbacks ?? {}) };

  return FIELD_ORDER.map((field) => {
    const clean = sanitizeField(parts[field], maxLen);
    if (clean) return clean;
    // Fallback is itself sanitised so a custom fallback can't break structure.
    return sanitizeField(fallbacks[field], maxLen) || DEFAULT_FALLBACKS[field];
  }).join(separator);
}

// --- context resolvers (pure) ---------------------------------------------

/** Jira-style ticket key, e.g. EAP-3007. Letters upper-cased on return. */
const TICKET_RE = /([A-Za-z]{2,10})-(\d+)/;

/**
 * Extract a Jira-style ticket key from a git branch name.
 * `feature/EAP-3007-get-it-green` → `EAP-3007`; `eap-3007-fix` → `EAP-3007`.
 * Returns null when no key is present.
 */
export function resolveTicketFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  const m = branch.match(TICKET_RE);
  if (!m) return null;
  const [, key, num] = m;
  if (!key || !num) return null;
  return `${key.toUpperCase()}-${num}`;
}

/**
 * Derive a Forwood stack tag (e.g. `s4`) from a cwd path. Matches a path segment
 * like `s4`, `s-4`, `stack4`, or `stack-4` on a component boundary. Returns
 * `s<n>` or null when no stack marker is found.
 */
export function resolveStackFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const m = cwd.match(/(?:^|[/_\- ])s(?:tack)?[-_]?(\d+)(?=$|[/_\- ])/i);
  return m ? `s${m[1]}` : null;
}

/**
 * Derive a "location" from a cwd — the basename of the directory (the worktree /
 * repo / folder the tab sits in), sanitised. Returns null for empty/root paths.
 */
export function resolveLocationFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const segments = cwd.split(/[/\\]/).filter(Boolean);
  const base = segments[segments.length - 1];
  if (!base) return null;
  const clean = sanitizeField(base);
  return clean || null;
}

/** Branch prefixes that are workflow noise, stripped when deriving a work-part. */
const BRANCH_PREFIX_RE = /^(feature|feat|bugfix|fix|hotfix|chore|release|task|dev)\//i;

/**
 * Derive a starter work-part from a git branch: the branch slug with a leading
 * workflow prefix and the ticket key removed. `feature/EAP-3007-get-it-green`
 * → `get-it-green`. Returns null when nothing meaningful remains (the builder
 * then falls back to `wip`).
 */
export function resolveWorkPartFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  let rest = branch.replace(BRANCH_PREFIX_RE, '');
  const ticket = resolveTicketFromBranch(branch);
  if (ticket) rest = rest.replace(new RegExp(ticket, 'i'), '');
  const clean = sanitizeField(rest);
  return clean || null;
}

export interface ResolveContext {
  /** Tab's current working directory (from OSC 7 / PtyInfo), if known. */
  cwd?: string | null;
  /** Current git branch for that cwd, if known. */
  branch?: string | null;
  /** Explicit work-part override; when absent it's derived from the branch. */
  workPart?: string | null;
}

/**
 * Resolve the four session-name fields from a tab's context. Each field is
 * best-effort: unresolved fields come back null and the builder supplies a
 * fallback. The work-part defaults to the branch-derived slug so the auto-name
 * is useful immediately, while staying the field the user is expected to tweak.
 */
export function resolveSessionNameParts(ctx: ResolveContext): SessionNameParts {
  return {
    stack: resolveStackFromCwd(ctx.cwd),
    location: resolveLocationFromCwd(ctx.cwd),
    ticket: resolveTicketFromBranch(ctx.branch),
    workPart: ctx.workPart ?? resolveWorkPartFromBranch(ctx.branch),
  };
}

/**
 * One-call auto-namer: resolve context → build the `·`-joined name. This is the
 * function the wire-in calls once it has the tab's cwd and git branch.
 */
export function autoSessionName(ctx: ResolveContext, opts?: BuildSessionNameOptions): string {
  return buildSessionName(resolveSessionNameParts(ctx), opts);
}
