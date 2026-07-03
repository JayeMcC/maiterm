import { describe, expect, it } from 'vitest';
import {
  buildTaskTree,
  deriveExecutionContext,
  REQUIRE_DEVCONTAINER_LABEL,
} from '../index.ts';
import type { Task } from '../types.ts';

// In-memory task set mirroring the forwood-one overlay shape (post-PLAN-15
// classification: leaves carry explicit gate edges, composites inherit).
const gate: Task = { label: 'Require devcontainer', type: 'shell', command: 'bash gate.sh' };
const api: Task = { label: 'API', type: 'shell', command: 'bash dev-api.sh', dependsOn: ['Require devcontainer'] };
// String (non-array) dependsOn form — VS Code accepts both.
const web: Task = { label: 'WEB', type: 'shell', command: 'bash dev-web.sh', dependsOn: 'Require devcontainer' };
const browser: Task = { label: 'Open browser to root dev', type: 'shell', command: 'open http://localhost:3000' };
const spinUp: Task = {
  label: 'Spin up dev servers',
  dependsOn: ['Require devcontainer', 'API', 'WEB', 'Open browser to root dev'],
  dependsOrder: 'parallel',
};
const killAllSetup: Task = {
  label: 'Kill all, branch setup, spin up dev',
  dependsOn: ['Spin up dev servers'],
  dependsOrder: 'sequence',
};
const TASKS: Task[] = [gate, api, web, browser, spinUp, killAllSetup];

describe('deriveExecutionContext', () => {
  it('exports the forwood gate label as the default', () => {
    expect(REQUIRE_DEVCONTAINER_LABEL).toBe('Require devcontainer');
  });

  it('direct gate edge → container', () => {
    expect(deriveExecutionContext('API', TASKS)).toBe('container');
  });

  it('string-form dependsOn gate edge → container', () => {
    expect(deriveExecutionContext('WEB', TASKS)).toBe('container');
  });

  it('transitive gate through nested composites → container', () => {
    expect(deriveExecutionContext('Kill all, branch setup, spin up dev', TASKS)).toBe('container');
  });

  it('no gate anywhere in the chain → host', () => {
    expect(deriveExecutionContext('Open browser to root dev', TASKS)).toBe('host');
  });

  it('the gate task itself → host', () => {
    expect(deriveExecutionContext('Require devcontainer', TASKS)).toBe('host');
  });

  it('honours a gate-label override (default label ignored when overridden)', () => {
    const sandboxGate: Task = { label: 'Require sandbox', type: 'shell', command: 'bash sandbox.sh' };
    const task: Task = { label: 'X', type: 'shell', command: 'x', dependsOn: ['Require sandbox'] };
    const tasks = [sandboxGate, task];
    expect(deriveExecutionContext('X', tasks, { gateLabel: 'Require sandbox' })).toBe('container');
    expect(deriveExecutionContext('X', tasks)).toBe('host');
  });

  it('throws on a missing dependency, matching buildTaskTree', () => {
    const broken: Task = { label: 'Broken', dependsOn: ['Nope'] };
    expect(() => deriveExecutionContext('Broken', [broken])).toThrow(/Missing dependency: Nope/);
  });

  it('throws on a dependency cycle, matching buildTaskTree', () => {
    const a: Task = { label: 'A', dependsOn: ['B'] };
    const b: Task = { label: 'B', dependsOn: ['A'] };
    expect(() => deriveExecutionContext('A', [a, b])).toThrow(/Dependency cycle/);
  });

  it('throws on an unknown root label', () => {
    expect(() => deriveExecutionContext('Nope', TASKS)).toThrow(/Task not found: Nope/);
  });
});

describe('buildTaskTree executionContext annotation', () => {
  it('annotates every node with its own derived context', () => {
    const tree = buildTaskTree('Spin up dev servers', TASKS);
    expect(tree.executionContext).toBe('container');
    const byLabel = new Map(tree.dependsOn.map(c => [c.task.label, c]));
    expect(byLabel.get('Require devcontainer')?.executionContext).toBe('host');
    expect(byLabel.get('API')?.executionContext).toBe('container');
    expect(byLabel.get('Open browser to root dev')?.executionContext).toBe('host');
  });

  it('existing cycle / missing-dependency errors are unchanged', () => {
    const a: Task = { label: 'A', dependsOn: ['B'] };
    expect(() => buildTaskTree('A', [a])).toThrow(/Missing dependency: B/);
  });
});
