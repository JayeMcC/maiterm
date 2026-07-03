import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runForwardMode, runUnforwardMode } from '../forwards.ts';
import type { ExecRunner } from '../container-status.ts';

let root: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fwd-'));
  repo = join(root, 'repo');
  mkdirSync(join(repo, '.devcontainer'), { recursive: true });
  writeFileSync(join(repo, '.devcontainer/devcontainer.json'), '{}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function recordingRunner(
  map: Array<[RegExp, { stdout?: string; exitCode?: number }]>,
): { runner: ExecRunner; commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    runner: {
      async run(cmd, args) {
        const s = [cmd, ...args].join(' ');
        commands.push(s);
        for (const [re, r] of map) if (re.test(s)) return { stdout: r.stdout ?? '', exitCode: r.exitCode ?? 0 };
        throw new Error(`unexpected command: ${s}`);
      },
    },
  };
}

const INSPECT = JSON.stringify([
  {
    Id: 'dev111',
    Config: { Labels: { 'com.docker.compose.service': 'api' } },
    NetworkSettings: { Ports: { '4000/tcp': [{ HostPort: '4000' }] } },
  },
]);

function upMap(): Array<[RegExp, { stdout?: string; exitCode?: number }]> {
  return [
    [/docker ps -q --filter label=devcontainer\.local_folder=/, { stdout: 'dev111\n' }],
    [/docker inspect dev111 --format .*compose\.project/, { stdout: 'proj_x\n' }],
    [/docker inspect dev111 --format .*Networks/, { stdout: '{"proj_x_default":{"IPAddress":"172.20.0.5"}}\n' }],
    [/docker ps -q --filter label=com\.docker\.compose\.project=proj_x/, { stdout: 'dev111\n' }],
    [/docker inspect dev111$/, { stdout: INSPECT }],
    [/docker exec dev111 ss -tlnH/, { stdout: 'LISTEN 0 5 *:8123 *:*\n' }],
    [/docker ps --format .* --filter label=forwood\.sidecar-clone=/, { stdout: '' }],
    [/lsof /, { exitCode: 1 }],
    [/docker run /, { stdout: 'sidecarid\n' }],
    [/docker rm -f /, { stdout: '' }],
  ];
}

describe('runForwardMode', () => {
  it('refuses a port the compose project already publishes, naming the service', async () => {
    const { runner } = recordingRunner(upMap());
    const r = await runForwardMode(repo, 4000, { runner });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/already published/);
    expect(r.stderr).toContain('api');
  });

  it('refuses when an unrelated host process binds the port', async () => {
    const map = upMap();
    map.unshift([/lsof .*8123/, { exitCode: 0 }]);
    const { runner } = recordingRunner(map);
    const r = await runForwardMode(repo, 8123, { runner });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/host/i);
  });

  it('refuses when the container is down', async () => {
    const { runner } = recordingRunner([
      [/docker ps -q --filter label=devcontainer\.local_folder=/, { stdout: '' }],
      // down still enumerates forwards (they may linger) — stub it empty
      [/docker ps --format .* --filter label=forwood\.sidecar-clone=/, { stdout: '' }],
    ]);
    const r = await runForwardMode(repo, 8123, { runner });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/not running|down/i);
  });

  it('creates a labelled socat sidecar on the compose network relaying to the dev container IP', async () => {
    // Docker refuses -p together with --network container:<id> (netns join),
    // so the sidecar joins the compose NETWORK and relays to the dev
    // container's IP on it (Correction 3).
    const { runner, commands } = recordingRunner(upMap());
    const r = await runForwardMode(repo, 8123, { runner });
    expect(r.exitCode).toBe(0);
    const run = commands.find(c => c.startsWith('docker run'));
    expect(run).toBeDefined();
    expect(run).toContain('--name f1-fwd-repo-8123');
    expect(run).toContain('--label forwood.sidecar-forward=8123');
    expect(run).toContain(`--label forwood.sidecar-clone=${repo}`);
    expect(run).toContain('--network proj_x_default');
    expect(run).not.toContain('--network container:');
    expect(run).toContain('-p 8123:8123');
    expect(run).toContain('alpine/socat');
    expect(run).toContain('TCP:172.20.0.5:8123');
  });
});

describe('runUnforwardMode', () => {
  it('removes an existing sidecar by name', async () => {
    const map = upMap();
    map.unshift([
      /docker ps --format .* --filter label=forwood\.sidecar-clone=/,
      { stdout: JSON.stringify({ Names: 'f1-fwd-repo-8123', Labels: 'forwood.sidecar-forward=8123', State: 'running' }) + '\n' },
    ]);
    const { runner, commands } = recordingRunner(map);
    const r = await runUnforwardMode(repo, 8123, { runner });
    expect(r.exitCode).toBe(0);
    expect(commands.some(c => c.startsWith('docker rm -f f1-fwd-repo-8123'))).toBe(true);
  });

  it('unknown forward → clean no-op: exit 0 with a stderr notice', async () => {
    const { runner, commands } = recordingRunner(upMap());
    const r = await runUnforwardMode(repo, 7777, { runner });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/no forward/i);
    expect(commands.some(c => c.startsWith('docker rm'))).toBe(false);
  });
});
