import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLiveMaitermLock } from '../dispatchers/lockfile.ts';

function makeLockDir(): string {
  return mkdtempSync(join(tmpdir(), 'tengine-lock-'));
}

function writeLock(
  dir: string,
  port: number,
  fields: Partial<{ pid: number; ideName: string; authToken: string }>,
): void {
  const lock = {
    authToken: fields.authToken ?? 'tok-' + port,
    ideName: fields.ideName ?? 'maiTerm',
    ideVersion: '1.18.0',
    pid: fields.pid ?? process.pid,
    serverPort: port,
    transport: 'ws',
    workspaceFolders: ['/home/x'],
  };
  writeFileSync(join(dir, `${port}.lock`), JSON.stringify(lock));
}

describe('findLiveMaitermLock', () => {
  it('returns null when the lock dir is missing', () => {
    expect(findLiveMaitermLock('/nope/does/not/exist')).toBeNull();
  });

  it('returns null when no .lock files are present', () => {
    const dir = makeLockDir();
    try {
      expect(findLiveMaitermLock(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no lock has a live pid', () => {
    const dir = makeLockDir();
    try {
      writeLock(dir, 12345, { pid: 999999999 }); // unlikely-to-exist pid
      expect(findLiveMaitermLock(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips locks whose ideName is not maiTerm-prefixed', () => {
    const dir = makeLockDir();
    try {
      writeLock(dir, 11111, { ideName: 'OtherIDE' });
      expect(findLiveMaitermLock(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts maiTermDev (debug build ideName)', () => {
    const dir = makeLockDir();
    try {
      writeLock(dir, 22222, { ideName: 'maiTermDev' });
      const lock = findLiveMaitermLock(dir);
      expect(lock).not.toBeNull();
      expect(lock!.ideName).toBe('maiTermDev');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the live lock when one is present', () => {
    const dir = makeLockDir();
    try {
      writeLock(dir, 43925, {}); // pid defaults to process.pid → alive
      const lock = findLiveMaitermLock(dir);
      expect(lock).not.toBeNull();
      expect(lock!.serverPort).toBe(43925);
      expect(lock!.ideName).toBe('maiTerm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the most recently written lock when multiple live entries exist', async () => {
    const dir = makeLockDir();
    try {
      writeLock(dir, 11111, {});
      // Force a deterministic mtime gap.
      await new Promise(r => setTimeout(r, 20));
      writeLock(dir, 22222, {});
      const lock = findLiveMaitermLock(dir);
      expect(lock!.serverPort).toBe(22222);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-.lock files in the directory', () => {
    const dir = makeLockDir();
    try {
      writeFileSync(join(dir, 'README.txt'), 'not a lockfile');
      mkdirSync(join(dir, 'sub'));
      writeLock(dir, 99999, {});
      const lock = findLiveMaitermLock(dir);
      expect(lock!.serverPort).toBe(99999);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
