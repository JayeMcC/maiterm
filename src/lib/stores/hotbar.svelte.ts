/**
 * Hotbar rail store (PLAN-15 stream 3 / ADR 0006).
 *
 * A right-edge fold-out whose sections derive from the active tab's working
 * directory: cheap marker walk-up decides which sections appear; each section
 * is populated by running an external provider command and rendering its JSON.
 * A picker, not an executor — firing routes through the provider (which itself
 * dispatches into maiTerm), never the invoking tab.
 *
 * The component owns the reactivity (a `$effect` on the active tab's cwd calls
 * `refresh`); this store holds state + logic so it stays testable and doesn't
 * need `$effect.root` at module scope.
 */
import { findMarkersUpward, runRailProvider } from '$lib/tauri/commands';

/**
 * Provider config. TODO(prefs): graduate to a preference so the rail is a
 * generic "contextual action rail" (ADR 0006) — for now the forwood task
 * provider ships as the default. `{dir}` → the marker's repo root, `{label}`
 * → the fired item's label.
 */
export interface RailProvider {
  marker: string;
  label: string;
  program: string;
  listArgs: string[];
  fireArgs: string[];
}

const PROVIDERS: RailProvider[] = [
  {
    marker: '.vscode/tasks.json',
    label: 'Tasks',
    program: 'forwood-launcher',
    listArgs: ['--list', '--json', '--dir', '{dir}'],
    fireArgs: ['--fire', '{label}', '--dir', '{dir}'],
  },
];

const MARKERS = PROVIDERS.map((p) => p.marker);

export interface RailItem {
  label: string;
  group: string | null;
  executionContext: 'host' | 'container' | null;
}

export interface RailSection {
  provider: RailProvider;
  /** Repo root the marker resolved to (the provider's `--dir`). */
  dir: string;
  items: RailItem[];
  error: string | null;
  firing: string | null;
}

function substitute(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`));
}

function createHotbarStore() {
  let sections = $state<RailSection[]>([]);
  let loading = $state(false);
  let collapsed = $state(false);
  let lastDir = $state<string | null>(null);

  async function refresh(cwd: string | null | undefined): Promise<void> {
    const dir = cwd ?? null;
    if (dir === lastDir) return; // active tab's cwd unchanged
    lastDir = dir;

    if (!dir) {
      sections = [];
      return;
    }

    loading = true;
    try {
      const found = await findMarkersUpward(dir, MARKERS);
      const next: RailSection[] = [];
      for (const provider of PROVIDERS) {
        const hit = found.find((m) => m.marker === provider.marker);
        if (!hit) continue;
        const section: RailSection = { provider, dir: hit.root, items: [], error: null, firing: null };
        try {
          const res = await runRailProvider(
            provider.program,
            substitute(provider.listArgs, { dir: hit.root }),
            hit.root,
          );
          if (res.exitCode !== 0) {
            section.error = res.stderr.trim() || `provider exited ${res.exitCode}`;
          } else {
            const report = JSON.parse(res.stdout) as {
              tasks?: Array<{ label: string; presentation?: { group?: string }; executionContext?: 'host' | 'container' }>;
            };
            section.items = (report.tasks ?? []).map((t) => ({
              label: t.label,
              group: t.presentation?.group ?? null,
              executionContext: t.executionContext ?? null,
            }));
          }
        } catch (e) {
          section.error = e instanceof Error ? e.message : String(e);
        }
        next.push(section);
      }
      sections = next;
    } finally {
      loading = false;
    }
  }

  /** Update the section matching `marker` (if still present) and reassign the
   *  array so reactivity fires. No-ops if the section list changed underneath. */
  function patchSection(marker: string, patch: Partial<RailSection>): void {
    sections = sections.map((s) => (s.provider.marker === marker ? { ...s, ...patch } : s));
  }

  async function fire(section: RailSection, item: RailItem): Promise<void> {
    const marker = section.provider.marker;
    patchSection(marker, { firing: item.label, error: null });
    try {
      const res = await runRailProvider(
        section.provider.program,
        substitute(section.provider.fireArgs, { dir: section.dir, label: item.label }),
        section.dir,
        30,
      );
      if (res.exitCode !== 0) {
        patchSection(marker, { error: res.stderr.trim() || `fire exited ${res.exitCode}` });
      }
    } catch (e) {
      patchSection(marker, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      patchSection(marker, { firing: null });
    }
  }

  return {
    get sections() {
      return sections;
    },
    get loading() {
      return loading;
    },
    get collapsed() {
      return collapsed;
    },
    get visible() {
      return sections.length > 0;
    },
    toggleCollapsed() {
      collapsed = !collapsed;
    },
    refresh,
    fire,
  };
}

export const hotbarStore = createHotbarStore();
