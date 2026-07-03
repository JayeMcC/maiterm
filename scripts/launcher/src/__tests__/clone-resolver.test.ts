import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveClone,
  resolveCloneFromCwd,
  validateClone,
  clonePathFor,
  KNOWN_CLONE_NAMES,
} from '../clone-resolver.ts';

describe('clonePathFor', () => {
  it('maps `main` to forwood-one (no suffix)', () => {
    expect(clonePathFor('main', { projRoot: '/p' })).toBe('/p/forwood-one');
  });

  it('maps any other name to forwood-one_<name>', () => {
    expect(clonePathFor('developing', { projRoot: '/p' })).toBe('/p/forwood-one_developing');
    expect(clonePathFor('quick-fixes', { projRoot: '/p' })).toBe('/p/forwood-one_quick-fixes');
  });
});

describe('resolveClone', () => {
  it('prefers --clone over FORWOOD_CLONE', () => {
    const info = resolveClone({ arg: 'developing', env: 'reviewing', projRoot: '/p' });
    expect(info).toEqual({
      name: 'developing',
      path: '/p/forwood-one_developing',
      source: 'arg',
    });
  });

  it('falls back to FORWOOD_CLONE when no arg', () => {
    const info = resolveClone({ env: 'reviewing', projRoot: '/p' });
    expect(info).toEqual({
      name: 'reviewing',
      path: '/p/forwood-one_reviewing',
      source: 'env',
    });
  });

  it('returns null when nothing is set and cwd has no clone ancestor', () => {
    // Pass cwd outside any clone and env='' so neither resolution path fires.
    expect(resolveClone({ env: '', projRoot: '/p', cwd: '/tmp' })).toBeNull();
  });

  it('falls back to cwd-walk when env and arg are absent', () => {
    const info = resolveClone({
      env: '',
      projRoot: '/p',
      cwd: '/elsewhere/forwood-one_developing/api',
    });
    expect(info).toEqual({
      name: 'developing',
      path: '/elsewhere/forwood-one_developing',
      source: 'cwd',
    });
  });

  it('--clone arg wins over cwd', () => {
    const info = resolveClone({
      arg: 'reviewing',
      env: '',
      projRoot: '/p',
      cwd: '/p/forwood-one_developing',
    });
    expect(info?.name).toBe('reviewing');
    expect(info?.source).toBe('arg');
  });

  it('FORWOOD_CLONE wins over cwd', () => {
    const info = resolveClone({
      env: 'reviewing',
      projRoot: '/p',
      cwd: '/p/forwood-one_developing',
    });
    expect(info?.name).toBe('reviewing');
    expect(info?.source).toBe('env');
  });
});

describe('resolveCloneFromCwd', () => {
  it('matches when cwd IS the clone directory', () => {
    expect(resolveCloneFromCwd('/p/forwood-one_developing')).toEqual({
      name: 'developing',
      path: '/p/forwood-one_developing',
      source: 'cwd',
    });
  });

  it('walks up from a nested subdirectory', () => {
    expect(resolveCloneFromCwd('/p/forwood-one_reviewing/web/src/components')).toEqual({
      name: 'reviewing',
      path: '/p/forwood-one_reviewing',
      source: 'cwd',
    });
  });

  it('maps `forwood-one` (no suffix) to clone name `main`', () => {
    expect(resolveCloneFromCwd('/p/forwood-one/api')).toEqual({
      name: 'main',
      path: '/p/forwood-one',
      source: 'cwd',
    });
  });

  it('does NOT match forwood-one-tests directories', () => {
    expect(resolveCloneFromCwd('/p/forwood-one-tests_developing/foo')).toBeNull();
  });

  it('does NOT match forwood-one-tools', () => {
    expect(resolveCloneFromCwd('/p/forwood-one-tools/scripts')).toBeNull();
  });

  it('returns null when no ancestor matches', () => {
    expect(resolveCloneFromCwd('/tmp/random/place')).toBeNull();
  });

  it('exposes the known-clones list for help text', () => {
    expect(KNOWN_CLONE_NAMES).toContain('developing');
    expect(KNOWN_CLONE_NAMES).toContain('reviewing');
    expect(KNOWN_CLONE_NAMES).toContain('main');
  });
});

describe('validateClone', () => {
  it('returns the info when .vscode/tasks.json exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'forwood-launcher-'));
    try {
      const clonePath = join(root, 'forwood-one_developing');
      mkdirSync(join(clonePath, '.vscode'), { recursive: true });
      writeFileSync(join(clonePath, '.vscode', 'tasks.json'), '{}');
      const info = { name: 'developing', path: clonePath, source: 'arg' as const };
      expect(validateClone(info)).toBe(info);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws an actionable error when tasks.json is missing', () => {
    expect(() =>
      validateClone({ name: 'nope', path: '/var/empty/missing', source: 'arg' }),
    ).toThrow(/tasks\.json not found/);
  });
});
