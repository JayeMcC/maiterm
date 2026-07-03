import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readTasksFile } from '../reader.ts';
import { buildTaskTree, flattenSequential } from '../graph.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (name: string) => join(HERE, 'fixtures', name);

describe('buildTaskTree', () => {
  it('returns a leaf node for a task with no dependsOn', () => {
    const { tasks } = readTasksFile(FIXTURE('composite'));
    const node = buildTaskTree('API', tasks);
    expect(node.task.label).toBe('API');
    expect(node.dependsOn).toHaveLength(0);
  });

  it('builds the dependency tree honouring dependsOrder', () => {
    const { tasks } = readTasksFile(FIXTURE('composite'));
    const node = buildTaskTree('Spin up dev servers', tasks);
    expect(node.task.label).toBe('Spin up dev servers');
    expect(node.dependsOrder).toBe('parallel');
    expect(node.dependsOn.map(c => c.task.label)).toEqual([
      'Require devcontainer',
      'API',
      'WEB',
    ]);
    // Each child is itself a leaf.
    expect(node.dependsOn.every(c => c.dependsOn.length === 0)).toBe(true);
  });

  it('builds nested chains (sequence-of-parallel)', () => {
    const { tasks } = readTasksFile(FIXTURE('composite'));
    const node = buildTaskTree('Kill all, branch setup, spin up dev', tasks);
    expect(node.dependsOrder).toBe('sequence');
    expect(node.dependsOn.map(c => c.task.label)).toEqual([
      'Kill all',
      'Branch change setup',
      'Spin up dev servers',
    ]);
    // The third child is itself an aggregator with three parallel children.
    const aggregator = node.dependsOn[2];
    expect(aggregator?.task.label).toBe('Spin up dev servers');
    expect(aggregator?.dependsOn).toHaveLength(3);
    expect(aggregator?.dependsOrder).toBe('parallel');
  });

  it('defaults dependsOrder to parallel when unspecified', () => {
    const tasks = [
      { label: 'root', dependsOn: ['a', 'b'] },
      { label: 'a', command: 'echo a' },
      { label: 'b', command: 'echo b' },
    ];
    expect(buildTaskTree('root', tasks).dependsOrder).toBe('parallel');
  });

  it('throws on missing root task', () => {
    const { tasks } = readTasksFile(FIXTURE('composite'));
    expect(() => buildTaskTree('Nonexistent', tasks)).toThrow(/Task not found/);
  });

  it('throws on missing dependency', () => {
    const tasks = [{ label: 'root', dependsOn: ['ghost'] }];
    expect(() => buildTaskTree('root', tasks)).toThrow(/Missing dependency: ghost/);
  });

  it('throws on dependency cycle', () => {
    const { tasks } = readTasksFile(FIXTURE('composite'));
    expect(() => buildTaskTree('Cycle root', tasks)).toThrow(/Dependency cycle/);
  });

  it('accepts a string (non-array) dependsOn', () => {
    const tasks = [
      { label: 'root', dependsOn: 'leaf' },
      { label: 'leaf', command: 'echo leaf' },
    ];
    const node = buildTaskTree('root', tasks);
    expect(node.dependsOn).toHaveLength(1);
    expect(node.dependsOn[0]?.task.label).toBe('leaf');
  });
});

describe('flattenSequential', () => {
  it('emits deepest-first, then siblings in declaration order', () => {
    const { tasks } = readTasksFile(FIXTURE('composite'));
    const node = buildTaskTree('Kill all, branch setup, spin up dev', tasks);
    expect(flattenSequential(node).map(t => t.label)).toEqual([
      'Kill all',
      'Branch change setup',
      'Require devcontainer',
      'API',
      'WEB',
      'Spin up dev servers',
      'Kill all, branch setup, spin up dev',
    ]);
  });

  it('deduplicates tasks that appear multiple times', () => {
    const tasks = [
      { label: 'root', dependsOn: ['a', 'b'] },
      { label: 'a', dependsOn: ['shared'] },
      { label: 'b', dependsOn: ['shared'] },
      { label: 'shared', command: 'echo once' },
    ];
    const node = buildTaskTree('root', tasks);
    const labels = flattenSequential(node).map(t => t.label);
    expect(labels.filter(l => l === 'shared')).toHaveLength(1);
  });
});
