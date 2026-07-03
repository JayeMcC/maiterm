import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Shape of `~/.claude/ide/<port>.lock` — written by maiTerm at startup and
 * re-written when the MCP server re-binds. Stale locks (for prior maiTerm
 * processes) can linger if the app crashed; consumers must verify the `pid`
 * is alive before trusting the entry.
 */
export interface MaitermLock {
  authToken: string;
  ideName: string;
  ideVersion: string;
  pid: number;
  serverPort: number;
  transport: 'ws' | 'http';
  workspaceFolders: string[];
}

const DEFAULT_LOCK_DIR = () => join(homedir(), '.claude', 'ide');

/** Whether `pid` corresponds to a live process. POSIX-only (uses `kill 0`). */
function pidAlive(pid: number): boolean {
  try {
    // signal 0 = no-op, just checks reachability + permission.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = process exists but not ours
    // (still "alive" from our perspective).
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

/**
 * Find the live maiTerm IDE lockfile. Strategy:
 *   1. List `*.lock` in `~/.claude/ide/`.
 *   2. Parse each, keep entries whose `ideName === 'maiTerm'`.
 *   3. Filter to entries whose `pid` is alive.
 *   4. Return the most recently written one.
 *
 * Returns `null` if no live maiTerm lock is found.
 *
 * @param lockDir Override the discovery directory (testing).
 */
export function findLiveMaitermLock(lockDir?: string): MaitermLock | null {
  const dir = lockDir ?? DEFAULT_LOCK_DIR();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates: { lock: MaitermLock; mtimeMs: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith('.lock')) continue;
    const path = join(dir, name);
    let lock: MaitermLock;
    try {
      lock = JSON.parse(readFileSync(path, 'utf8')) as MaitermLock;
    } catch {
      continue;
    }
    // Debug builds set ideName to "maiTermDev"; release builds use "maiTerm".
    // Accept both prefixes so devs running a fork build for testing aren't
    // forced to a release rebuild.
    if (!lock.ideName.startsWith('maiTerm')) continue;
    if (!pidAlive(lock.pid)) continue;
    try {
      candidates.push({ lock, mtimeMs: statSync(path).mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.lock ?? null;
}
