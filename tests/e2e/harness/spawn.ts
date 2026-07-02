/**
 * Spawn a built maiTerm binary, wait for its lockfile to land, kill it
 * cleanly after the test. Tightly coupled to the CI runner — we expect
 * the binary to live at `src-tauri/target/<profile>/aiterm` and the
 * lockfile at `~/.claude/ide/<port>.lock`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface MaitermLock {
  authToken: string;
  ideName: string;
  ideVersion: string;
  pid: number;
  serverPort: number;
  transport: 'ws' | 'http';
  workspaceFolders: string[];
}

export interface MaitermHandle {
  proc: ChildProcess;
  lock: MaitermLock;
  /** The instance's hermetic HOME (pass back to spawnMaiterm for restarts). */
  home: string;
  kill: () => Promise<void>;
}

/** Snapshot the set of `.lock` filenames present right now. */
function snapshotLocks(lockDir: string): Set<string> {
  try {
    return new Set(readdirSync(lockDir).filter((n) => n.endsWith('.lock')));
  } catch {
    return new Set();
  }
}

/**
 * Launch the maiTerm binary and resolve once it writes a fresh lockfile
 * pointing at *its own* pid. We diff lockfile lists before/after spawn so
 * we don't latch onto a stale lock from a previous run on the same machine.
 *
 * Times out after `timeoutMs` (default 60s — CI is sometimes slow).
 */
export async function spawnMaiterm(
  opts: {
    binary: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    /**
     * Reuse an existing hermetic HOME (restart tests: kill + respawn with the
     * same state). Caller owns cleanup when provided; otherwise a fresh
     * mkdtemp HOME is created and removed on kill().
     */
    home?: string;
  } = { binary: '' },
): Promise<MaitermHandle> {
  if (!opts.binary) throw new Error('spawnMaiterm: binary path is required');
  if (!existsSync(opts.binary)) {
    throw new Error(`spawnMaiterm: binary not found at ${opts.binary}`);
  }

  // Hermetic per-instance HOME: without it every spawn reads/writes the real
  // user profile — tabs from one run restore into the next (reuse-by-name
  // tests then match stale tabs), and parallel test files thrash the shared
  // state file (issue #1). The app derives its data dir, log dir, AND the
  // ~/.claude/ide lockfile dir from $HOME, so one override isolates all three.
  const ownsHome = !opts.home;
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'maiterm-e2e-home-'));
  const lockDir = join(home, '.claude', 'ide');

  const beforeLocks = snapshotLocks(lockDir);
  const proc = spawn(opts.binary, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      // macOS Accessory activation: the spawned instance renders in the
      // background without stealing focus from whoever is at the keyboard.
      MAITERM_E2E_BACKGROUND: '1',
      ...(opts.env ?? {}),
    },
    detached: false,
  });

  // Capture stdout/stderr to a buffer — surfaced in test failures so we
  // can see why startup didn't reach lockfile-write.
  const tail: string[] = [];
  const captureLine = (chunk: Buffer) => {
    const lines = chunk.toString('utf8').split('\n');
    for (const line of lines) {
      if (line) tail.push(line);
      if (tail.length > 200) tail.shift();
    }
  };
  proc.stdout?.on('data', captureLine);
  proc.stderr?.on('data', captureLine);

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
  // Ref-cell so TS can see the async assignment from the `exit` listener.
  const exitState: { value: ExitInfo | null } = { value: null };
  proc.once('exit', (code, signal) => {
    exitState.value = { code, signal };
  });

  while (Date.now() - start < timeoutMs) {
    if (exitState.value) {
      throw new Error(`maiTerm exited before lockfile was written (code=${exitState.value.code}, signal=${exitState.value.signal}). ` + `Last output:\n${tail.join('\n')}`);
    }
    const after = snapshotLocks(lockDir);
    for (const name of after) {
      if (beforeLocks.has(name)) continue;
      const path = join(lockDir, name);
      let lock: MaitermLock;
      try {
        lock = JSON.parse(readFileSync(path, 'utf8')) as MaitermLock;
      } catch {
        continue;
      }
      // Debug builds set ideName to "maiTermDev"; release builds use "maiTerm".
      // startsWith catches both, plus any future variants.
      if (!lock.ideName.startsWith('maiTerm')) continue;
      if (lock.pid !== proc.pid) continue;
      // Sanity-check the lockfile is fresh enough.
      const mtime = statSync(path).mtimeMs;
      if (mtime < start) continue;
      return makeHandle(proc, lock, home, ownsHome);
    }
    await sleep(200);
  }

  proc.kill('SIGTERM');
  if (ownsHome) rmSync(home, { recursive: true, force: true });
  throw new Error(`Timed out after ${timeoutMs}ms waiting for maiTerm lockfile (pid=${proc.pid}). Last output:\n${tail.join('\n')}`);
}

function makeHandle(proc: ChildProcess, lock: MaitermLock, home: string, ownsHome: boolean): MaitermHandle {
  return {
    proc,
    lock,
    home,
    async kill() {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            proc.kill('SIGKILL');
            resolve();
          }, 3_000);
          proc.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      if (ownsHome) rmSync(home, { recursive: true, force: true });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
