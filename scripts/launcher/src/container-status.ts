/**
 * `--container-status --dir <d>` — the provider contract's status half
 * (ADR 0006). Live truth from the container runtime: published ports off the
 * running compose project (no .env parsing), unpublished dev-container
 * listeners, active sidecar forwards.
 *
 * Listening semantics (T011 finding): docker-proxy answers TCP on every
 * published port whether or not anything listens inside, so dev-container
 * ports take their truth from `ss` INSIDE the container; only sibling
 * services (their own containers — postgres, redis) use a host TCP probe.
 *
 * All docker access goes through an injectable ExecRunner so tests run on
 * fixtures; `runtime-unavailable` is a state, not an error.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { basename } from 'node:path';
import { resolveDir } from '@forwood/task-engine';
import { messageOf, type ModeResult } from './list-mode.ts';

export interface ExecRunner {
  run(cmd: string, args: string[]): Promise<{ stdout: string; exitCode: number }>;
}

export interface StatusDeps {
  runner?: ExecRunner;
  /** Host TCP probe for sibling-service ports; injectable for tests. */
  probeTcp?: (port: number) => Promise<boolean>;
}

export interface PublishedPort {
  service: string;
  containerPort: number;
  hostPort: number;
  listening: boolean;
  /** URL scheme for click-to-open. Most dev servers are http; the Vite WEB
   *  server (container port 5173) serves https. Keyed on the CONTAINER port so
   *  it's stable across clones' host-port offsets. */
  scheme: 'http' | 'https';
}

/** Container ports whose dev server speaks HTTPS (forwood: Vite WEB on 5173). */
const HTTPS_CONTAINER_PORTS = new Set([5173]);
function schemeFor(containerPort: number): 'http' | 'https' {
  return HTTPS_CONTAINER_PORTS.has(containerPort) ? 'https' : 'http';
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
export interface ContainerStatusReport {
  state: 'up' | 'down' | 'runtime-unavailable';
  repoRoot: string | null;
  ports: PublishedPort[];
  listeners: ContainerListener[];
  forwards: SidecarForward[];
}

export const realRunner: ExecRunner = {
  run(cmd, args) {
    return new Promise(resolvePromise => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', d => (stdout += String(d)));
      child.on('error', () => resolvePromise({ stdout: '', exitCode: 127 }));
      child.on('close', code => resolvePromise({ stdout, exitCode: code ?? 1 }));
    });
  },
};

export function realProbeTcp(port: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const sock = connect({ host: '127.0.0.1', port, timeout: 1500 });
    sock.once('connect', () => {
      sock.destroy();
      resolvePromise(true);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolvePromise(false);
    });
    sock.once('error', () => resolvePromise(false));
  });
}

/** Resolve the devcontainer root (the folder carrying `.devcontainer/`). */
export function devcontainerRoot(dir: string): string | null {
  const res = resolveDir(dir);
  return res.devcontainerConfigPath ? dirname(dirname(res.devcontainerConfigPath)) : null;
}

export async function findDevContainerId(
  runner: ExecRunner,
  root: string,
): Promise<{ id: string | null; dockerOk: boolean }> {
  const r = await runner.run('docker', [
    'ps',
    '-q',
    '--filter',
    `label=devcontainer.local_folder=${root}`,
  ]);
  if (r.exitCode !== 0) return { id: null, dockerOk: false };
  const id = r.stdout.trim().split('\n')[0] || null;
  return { id, dockerOk: true };
}

export async function listForwards(
  runner: ExecRunner,
  root: string,
): Promise<SidecarForward[]> {
  const r = await runner.run('docker', [
    'ps',
    '--format',
    '{{json .}}',
    '--filter',
    `label=forwood.sidecar-clone=${root}`,
  ]);
  if (r.exitCode !== 0) return [];
  const out: SidecarForward[] = [];
  for (const line of r.stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { Names: string; Labels: string; State: string };
      const labels = Object.fromEntries(
        row.Labels.split(',').map(kv => kv.split('=') as [string, string]),
      );
      const port = Number(labels['forwood.sidecar-forward']);
      if (!Number.isFinite(port)) continue;
      out.push({ port, containerName: row.Names, running: row.State === 'running' });
    } catch {
      // skip unparseable rows
    }
  }
  return out;
}

/** Ports the host already listens on (unrelated processes) — via lsof. */
export async function hostPortBusy(runner: ExecRunner, port: number): Promise<boolean> {
  const r = await runner.run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return r.exitCode === 0;
}

/** Parse `ss -tlnH` (fallback `/proc/net/tcp`) into a set of listening ports. */
function parseSsPorts(stdout: string): Set<number> {
  const ports = new Set<number>();
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3] ?? '';
    const m = local.match(/:(\d+)$/);
    if (m) ports.add(Number(m[1]));
  }
  return ports;
}

function parseProcNetTcp(stdout: string): Set<number> {
  const ports = new Set<number>();
  for (const line of stdout.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    // local_address = col 1 ("0100007F:1F90"), st = col 3 ("0A" = LISTEN)
    if (cols.length < 4 || cols[3] !== '0A') continue;
    const hex = cols[1]?.split(':')[1];
    if (hex) ports.add(parseInt(hex, 16));
  }
  return ports;
}

export async function devContainerListeningPorts(
  runner: ExecRunner,
  devId: string,
): Promise<Set<number>> {
  const ss = await runner.run('docker', ['exec', devId, 'ss', '-tlnH']);
  if (ss.exitCode === 0) return parseSsPorts(ss.stdout);
  const proc = await runner.run('docker', ['exec', devId, 'cat', '/proc/net/tcp']);
  return proc.exitCode === 0 ? parseProcNetTcp(proc.stdout) : new Set();
}

interface InspectRow {
  Id: string;
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: { Ports?: Record<string, Array<{ HostPort?: string }> | null> };
}

export async function buildStatusReport(
  dir: string,
  deps: StatusDeps = {},
): Promise<{ report: ContainerStatusReport | null; exitCode: number; error?: string }> {
  const runner = deps.runner ?? realRunner;
  const probeTcp = deps.probeTcp ?? realProbeTcp;

  let root: string | null;
  try {
    root = devcontainerRoot(dir);
  } catch (err) {
    return { report: null, exitCode: 2, error: messageOf(err) };
  }
  if (!root) return { report: null, exitCode: 3, error: `No .devcontainer/devcontainer.json found walking up from ${dir}` };

  const empty = { repoRoot: root, ports: [], listeners: [], forwards: [] as SidecarForward[] };
  const { id: devId, dockerOk } = await findDevContainerId(runner, root);
  if (!dockerOk) {
    return { report: { state: 'runtime-unavailable', ...empty }, exitCode: 0 };
  }
  const forwards = await listForwards(runner, root);
  if (!devId) {
    return { report: { state: 'down', ...empty, forwards }, exitCode: 0 };
  }

  const proj = (
    await runner.run('docker', [
      'inspect',
      devId,
      '--format',
      '{{ index .Config.Labels "com.docker.compose.project" }}',
    ])
  ).stdout.trim();
  const idsOut = await runner.run('docker', [
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${proj}`,
  ]);
  const ids = idsOut.stdout.trim().split('\n').filter(Boolean);
  const inspect = await runner.run('docker', ['inspect', ...ids]);
  const rows = JSON.parse(inspect.stdout || '[]') as InspectRow[];

  const ssPorts = await devContainerListeningPorts(runner, devId);

  const ports: PublishedPort[] = [];
  const devPublished = new Set<number>();
  for (const row of rows) {
    const service = row.Config?.Labels?.['com.docker.compose.service'] ?? 'unknown';
    const isDev = row.Id.startsWith(devId) || devId.startsWith(row.Id);
    for (const [key, bindings] of Object.entries(row.NetworkSettings?.Ports ?? {})) {
      if (!bindings) continue;
      const containerPort = Number(key.split('/')[0]);
      for (const b of bindings) {
        const hostPort = Number(b.HostPort);
        if (!Number.isFinite(hostPort)) continue;
        if (isDev) devPublished.add(containerPort);
        const listening = isDev ? ssPorts.has(containerPort) : await probeTcp(hostPort);
        ports.push({ service, containerPort, hostPort, listening, scheme: schemeFor(containerPort) });
        break; // one binding per container port is enough for the report
      }
    }
  }

  const listeners: ContainerListener[] = [];
  for (const p of [...ssPorts].sort((a, b) => a - b)) {
    if (devPublished.has(p)) continue;
    listeners.push({
      containerPort: p,
      process: null,
      forwardable: !(await hostPortBusy(runner, p)),
    });
  }

  return { report: { state: 'up', repoRoot: root, ports, listeners, forwards }, exitCode: 0 };
}

export async function runStatusMode(dir: string, deps: StatusDeps = {}): Promise<ModeResult> {
  const { report, exitCode, error } = await buildStatusReport(dir, deps);
  if (!report) return { exitCode, stdout: '', stderr: (error ?? 'status failed') + '\n' };
  return { exitCode, stdout: JSON.stringify(report, null, 2) + '\n', stderr: '' };
}

/** Basename used in sidecar names — exported for forwards.ts. */
export function cloneBasename(root: string): string {
  return basename(root);
}
