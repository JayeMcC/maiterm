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
import { open as shellOpen } from '@tauri-apps/plugin-shell';
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

/**
 * The container section (ADR 0006): detected by `.devcontainer/devcontainer.json`,
 * populated by the `--container-status` provider mode. Live ports, unpublished
 * in-container listeners you can forward, and active sidecar forwards.
 */
const CONTAINER_PROVIDER = {
  marker: '.devcontainer/devcontainer.json',
  program: 'forwood-launcher',
  statusArgs: ['--container-status', '--dir', '{dir}'],
  forwardArgs: ['--forward', '{port}', '--dir', '{dir}'],
  unforwardArgs: ['--unforward', '{port}', '--dir', '{dir}'],
};

const MARKERS = [...PROVIDERS.map((p) => p.marker), CONTAINER_PROVIDER.marker];

export interface RailItem {
  label: string;
  group: string | null;
  executionContext: 'host' | 'container' | null;
}

export interface PublishedPort {
  service: string;
  containerPort: number;
  hostPort: number;
  listening: boolean;
}
export interface ContainerListener {
  containerPort: number;
  process: string | null;
  forwardable: boolean;
}
export interface SidecarForward {
  port: number;
  containerName: string;
  running: boolean;
}
export interface ContainerStatus {
  state: 'up' | 'down' | 'runtime-unavailable';
  repoRoot: string | null;
  ports: PublishedPort[];
  listeners: ContainerListener[];
  forwards: SidecarForward[];
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

  // Container section state.
  let containerDir = $state<string | null>(null);
  let containerStatus = $state<ContainerStatus | null>(null);
  let containerError = $state<string | null>(null);
  let containerBusy = $state<number | null>(null); // port currently forwarding/stopping

  async function refresh(cwd: string | null | undefined): Promise<void> {
    const dir = cwd ?? null;
    if (dir === lastDir) return; // active tab's cwd unchanged
    lastDir = dir;

    if (!dir) {
      sections = [];
      containerDir = null;
      containerStatus = null;
      return;
    }

    loading = true;
    try {
      const found = await findMarkersUpward(dir, MARKERS);

      // Container section: detect .devcontainer, then pull live status.
      const containerHit = found.find((m) => m.marker === CONTAINER_PROVIDER.marker);
      if (containerHit) {
        containerDir = containerHit.root;
        await refreshContainerStatus();
      } else {
        containerDir = null;
        containerStatus = null;
        containerError = null;
      }

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
            15,
            true, // login shell — GUI app needs the user's PATH to find the launcher
          );
          if (res.exitCode !== 0) {
            section.error = res.stderr.trim() || `provider exited ${res.exitCode}`;
          } else {
            const report = JSON.parse(res.stdout) as {
              tasks?: Array<{ label: string; presentation?: { group?: string }; executionContext?: 'host' | 'container' }>;
            };
            // Show ALL tasks — the task's declared context decides where it
            // RUNS when fired (the launcher wraps container tasks in
            // devcontainer exec, runs host tasks on the host), not whether it
            // appears. So everything is triggerable from anywhere with a task
            // list; the badge just tells you where it'll land.
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
        true, // login shell
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

  /** Pull live container status for the detected devcontainer dir. Cheap
   *  enough to poll while the rail is open (the component drives the cadence). */
  async function refreshContainerStatus(): Promise<void> {
    if (!containerDir) return;
    try {
      const res = await runRailProvider(
        CONTAINER_PROVIDER.program,
        substitute(CONTAINER_PROVIDER.statusArgs, { dir: containerDir }),
        containerDir,
        15,
        true,
      );
      if (res.exitCode !== 0) {
        containerError = res.stderr.trim() || `container-status exited ${res.exitCode}`;
      } else {
        containerStatus = JSON.parse(res.stdout) as ContainerStatus;
        containerError = null;
      }
    } catch (e) {
      containerError = e instanceof Error ? e.message : String(e);
    }
  }

  async function forwardPort(port: number): Promise<void> {
    await runForwardCmd(CONTAINER_PROVIDER.forwardArgs, port);
  }
  async function unforwardPort(port: number): Promise<void> {
    await runForwardCmd(CONTAINER_PROVIDER.unforwardArgs, port);
  }
  async function runForwardCmd(args: string[], port: number): Promise<void> {
    if (!containerDir) return;
    containerBusy = port;
    try {
      const res = await runRailProvider(
        CONTAINER_PROVIDER.program,
        substitute(args, { dir: containerDir, port: String(port) }),
        containerDir,
        30,
        true,
      );
      if (res.exitCode !== 0) {
        containerError = res.stderr.trim() || `forward exited ${res.exitCode}`;
      } else {
        containerError = null;
      }
    } catch (e) {
      containerError = e instanceof Error ? e.message : String(e);
    } finally {
      containerBusy = null;
      await refreshContainerStatus();
    }
  }

  /** Open a published port in the default browser (host localhost). */
  async function openPort(hostPort: number): Promise<void> {
    try {
      await shellOpen(`http://localhost:${hostPort}`);
    } catch {
      /* opener unavailable — ignore */
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
      return sections.length > 0 || containerStatus != null;
    },
    get containerStatus() {
      return containerStatus;
    },
    get containerError() {
      return containerError;
    },
    get containerBusy() {
      return containerBusy;
    },
    get hasContainer() {
      return containerDir != null;
    },
    toggleCollapsed() {
      collapsed = !collapsed;
    },
    refresh,
    refreshContainerStatus,
    fire,
    forwardPort,
    unforwardPort,
    openPort,
  };
}

export const hotbarStore = createHotbarStore();
