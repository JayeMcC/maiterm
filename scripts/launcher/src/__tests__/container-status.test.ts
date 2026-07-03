import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStatusMode, type ExecRunner } from '../container-status.ts';

let root: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'status-'));
  repo = join(root, 'repo');
  mkdirSync(join(repo, '.devcontainer'), { recursive: true });
  writeFileSync(
    join(repo, '.devcontainer/devcontainer.json'),
    '{ "workspaceFolder": "/workspaces/x" }\n',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeRunner(
  map: Array<[RegExp, { stdout?: string; exitCode?: number }]>,
): ExecRunner {
  return {
    async run(cmd, args) {
      const s = [cmd, ...args].join(' ');
      for (const [re, r] of map) if (re.test(s)) return { stdout: r.stdout ?? '', exitCode: r.exitCode ?? 0 };
      throw new Error(`fakeRunner: unexpected command: ${s}`);
    },
  };
}

const INSPECT_PROJECT = [
  {
    Id: 'dev111',
    Config: { Labels: { 'com.docker.compose.service': 'dev' } },
    NetworkSettings: { Ports: { '4000/tcp': [{ HostIp: '0.0.0.0', HostPort: '4000' }], '5173/tcp': [{ HostIp: '0.0.0.0', HostPort: '5173' }] } },
  },
  {
    Id: 'db222',
    Config: { Labels: { 'com.docker.compose.service': 'root-rw' } },
    NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] } },
  },
];

// ss -tlnH: dev container listens on 4000 (API up) and 8123 (ad-hoc), NOT 5173.
const SS_OUT = 'LISTEN 0 511 *:4000 *:*\nLISTEN 0 5 0.0.0.0:8123 0.0.0.0:*\n';

const FORWARD_PS_LINE = JSON.stringify({
  Names: 'f1-fwd-repo-9000',
  Labels: 'forwood.sidecar-forward=9000,forwood.sidecar-clone=REPO',
  State: 'running',
});

function upRunner(overrides: Array<[RegExp, { stdout?: string; exitCode?: number }]> = []): ExecRunner {
  return fakeRunner([
    ...overrides,
    [/docker ps -q --filter label=devcontainer\.local_folder=/, { stdout: 'dev111\n' }],
    [/docker inspect dev111 --format/, { stdout: 'proj_x\n' }],
    [/docker ps -q --filter label=com\.docker\.compose\.project=proj_x/, { stdout: 'dev111\ndb222\n' }],
    [/docker inspect dev111 db222$/, { stdout: JSON.stringify(INSPECT_PROJECT) }],
    [/docker exec dev111 ss -tlnH/, { stdout: SS_OUT }],
    [/docker ps --format .* --filter label=forwood\.sidecar-clone=/, { stdout: FORWARD_PS_LINE.replace('REPO', 'repo') + '\n' }],
    [/lsof .*9999/, { exitCode: 0 }], // 9999 bound on host
    [/lsof /, { exitCode: 1 }],       // everything else free
  ]);
}

describe('runStatusMode', () => {
  it('runtime-unavailable when docker itself fails — a state, not an error', async () => {
    const runner = fakeRunner([[/docker ps -q --filter label=devcontainer/, { exitCode: 1 }]]);
    const r = await runStatusMode(repo, { runner });
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.state).toBe('runtime-unavailable');
    expect(report.ports).toEqual([]);
    expect(report.listeners).toEqual([]);
  });

  it('down: empty ports/listeners but forwards still enumerated', async () => {
    const runner = fakeRunner([
      [/docker ps -q --filter label=devcontainer\.local_folder=/, { stdout: '' }],
      [/docker ps --format .* --filter label=forwood\.sidecar-clone=/, { stdout: FORWARD_PS_LINE.replace('REPO', 'repo') + '\n' }],
    ]);
    const r = await runStatusMode(repo, { runner });
    const report = JSON.parse(r.stdout);
    expect(report.state).toBe('down');
    expect(report.ports).toEqual([]);
    expect(report.forwards).toEqual([{ port: 9000, containerName: 'f1-fwd-repo-9000', running: true }]);
  });

  it('up: published ports with service labels + protocol-aware listening', async () => {
    const r = await runStatusMode(repo, { runner: upRunner(), probeTcp: async () => true });
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.state).toBe('up');
    const byPort = Object.fromEntries(report.ports.map((p: { hostPort: number }) => [p.hostPort, p]));
    // Dev-container ports use the container-side ss truth, NOT a host connect
    // (docker-proxy answers TCP even when nothing listens inside).
    expect(byPort[4000]).toMatchObject({ service: 'dev', containerPort: 4000, listening: true });
    expect(byPort[5173]).toMatchObject({ service: 'dev', listening: false });
    // Sibling services use the host probe.
    expect(byPort[5432]).toMatchObject({ service: 'root-rw', listening: true });
  });

  it('up: unpublished dev-container listeners surface with forwardable flag', async () => {
    const r = await runStatusMode(repo, { runner: upRunner(), probeTcp: async () => true });
    const report = JSON.parse(r.stdout);
    expect(report.listeners).toEqual([{ containerPort: 8123, process: null, forwardable: true }]);
  });

  it('forwardable:false when the host already binds the port', async () => {
    const ssWithCollision = SS_OUT + 'LISTEN 0 5 0.0.0.0:9999 0.0.0.0:*\n';
    const runner = upRunner([[/docker exec dev111 ss -tlnH/, { stdout: ssWithCollision }]]);
    const r = await runStatusMode(repo, { runner, probeTcp: async () => true });
    const report = JSON.parse(r.stdout);
    const l = report.listeners.find((x: { containerPort: number }) => x.containerPort === 9999);
    expect(l).toMatchObject({ forwardable: false });
  });

  it('exit 3 when no .devcontainer config exists up-tree', async () => {
    const bare = join(root, 'bare');
    mkdirSync(bare, { recursive: true });
    const r = await runStatusMode(bare, { runner: fakeRunner([]) });
    expect(r.exitCode).toBe(3);
  });
});
