/**
 * `--forward <port>` / `--unforward <port>` — ad-hoc sidecar forwards
 * (ADR 0006 / R9). A labelled alpine/socat container joins the dev
 * container's network namespace and publishes one port; Docker owns its
 * lifetime, so forwards survive the caller and terminal restarts.
 */
import {
  buildStatusReport,
  cloneBasename,
  devcontainerRoot,
  findDevContainerId,
  hostPortBusy,
  listForwards,
  realRunner,
  type ExecRunner,
} from './container-status.ts';
import { messageOf, type ModeResult } from './list-mode.ts';

export interface ForwardDeps {
  runner?: ExecRunner;
}

export async function runForwardMode(
  dir: string,
  port: number,
  deps: ForwardDeps = {},
): Promise<ModeResult> {
  const runner = deps.runner ?? realRunner;

  const status = await buildStatusReport(dir, { runner, probeTcp: async () => false });
  if (!status.report) {
    return { exitCode: status.exitCode, stdout: '', stderr: (status.error ?? '') + '\n' };
  }
  const report = status.report;
  if (report.state !== 'up') {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Container is ${report.state === 'down' ? 'not running (down)' : report.state} — bring it up first (Spin up dev servers / Require devcontainer).\n`,
    };
  }

  const published = report.ports.find(p => p.hostPort === port || p.containerPort === port);
  if (published) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Port ${port} is already published by compose service '${published.service}' — no forward needed.\n`,
    };
  }
  if (await hostPortBusy(runner, port)) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Port ${port} is already bound by an unrelated host process.\n`,
    };
  }

  const root = report.repoRoot!;
  const { id: devId } = await findDevContainerId(runner, root);
  if (!devId) {
    return { exitCode: 1, stdout: '', stderr: 'Dev container disappeared mid-operation.\n' };
  }
  // Docker refuses -p together with --network container:<id>, so the sidecar
  // joins the compose NETWORK (own netns → publishing is legal) and relays
  // to the dev container's IP on that network (Correction 3).
  const target = await devNetworkTarget(runner, devId);
  if (!target) {
    return { exitCode: 1, stdout: '', stderr: 'Could not resolve the dev container network/IP.\n' };
  }
  const name = `f1-fwd-${cloneBasename(root)}-${port}`;
  const run = await runner.run('docker', [
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '--label',
    `forwood.sidecar-forward=${port}`,
    '--label',
    `forwood.sidecar-clone=${root}`,
    '--network',
    target.network,
    '-p',
    `${port}:${port}`,
    'alpine/socat',
    `TCP-LISTEN:${port},fork,reuseaddr`,
    `TCP:${target.ip}:${port}`,
  ]);
  if (run.exitCode !== 0) {
    return { exitCode: 1, stdout: '', stderr: `docker run failed (exit ${run.exitCode}).\n` };
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({ forwarded: port, containerName: name }) + '\n',
    stderr: '',
  };
}

async function devNetworkTarget(
  runner: ExecRunner,
  devId: string,
): Promise<{ network: string; ip: string } | null> {
  const r = await runner.run('docker', [
    'inspect',
    devId,
    '--format',
    '{{json .NetworkSettings.Networks}}',
  ]);
  if (r.exitCode !== 0) return null;
  try {
    const nets = JSON.parse(r.stdout.trim()) as Record<string, { IPAddress?: string }>;
    for (const [network, v] of Object.entries(nets)) {
      if (v?.IPAddress) return { network, ip: v.IPAddress };
    }
  } catch {
    // fall through
  }
  return null;
}

export async function runUnforwardMode(
  dir: string,
  port: number,
  deps: ForwardDeps = {},
): Promise<ModeResult> {
  const runner = deps.runner ?? realRunner;
  let root: string | null;
  try {
    root = devcontainerRoot(dir);
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: messageOf(err) + '\n' };
  }
  if (!root) {
    return { exitCode: 3, stdout: '', stderr: `No .devcontainer/devcontainer.json found walking up from ${dir}\n` };
  }
  const forwards = await listForwards(runner, root);
  const hit = forwards.find(f => f.port === port);
  if (!hit) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: `No forward for port ${port} on ${root} — nothing to do.\n`,
    };
  }
  const rm = await runner.run('docker', ['rm', '-f', hit.containerName]);
  if (rm.exitCode !== 0) {
    return { exitCode: 1, stdout: '', stderr: `docker rm failed (exit ${rm.exitCode}).\n` };
  }
  return { exitCode: 0, stdout: JSON.stringify({ unforwarded: port }) + '\n', stderr: '' };
}
