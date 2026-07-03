import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listTasks, resolveTask } from '../index.ts';
import type { VariableContext } from '../variables.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (name: string) => join(HERE, 'fixtures', name);

describe('listTasks', () => {
  it('omits hidden tasks by default', () => {
    const tasks = listTasks(FIXTURE('basic'));
    expect(tasks.map(t => t.label)).toEqual(['API', 'WEB']);
  });

  it('includes hidden tasks when requested', () => {
    const tasks = listTasks(FIXTURE('basic'), { includeHidden: true });
    expect(tasks.map(t => t.label)).toContain('Hidden helper');
  });
});

describe('resolveTask', () => {
  it('returns a tree with all string fields variable-substituted', () => {
    const ctx: VariableContext = {
      workspaceFolder: '/workspace/forwood-one_developing',
      env: { API_PORT: '4000' },
    };
    const tree = resolveTask(FIXTURE('basic'), 'API', ctx);
    expect(tree.task.label).toBe('API');
    expect(tree.task.command).toBe(
      'bash /workspace/forwood-one_developing/.vscode/scripts/tasks/dev-api.sh',
    );
    expect(tree.task.options?.cwd).toBe('/workspace/forwood-one_developing');
    expect(tree.task.options?.env?.['API_PORT']).toBe('4000');
  });

  it('resolves nested dependency trees', () => {
    const ctx: VariableContext = {
      workspaceFolder: '/workspace/forwood-one_developing',
      env: {},
    };
    const tree = resolveTask(FIXTURE('composite'), 'Spin up dev servers', ctx);
    expect(tree.dependsOn.map(c => c.task.label)).toEqual([
      'Require devcontainer',
      'API',
      'WEB',
    ]);
  });

  it('substitutes input values when provided', () => {
    const ctx: VariableContext = {
      workspaceFolder: '/workspace/forwood-one_developing',
      env: {},
      inputs: { lintBranchTarget: 'release/1.8.0' },
    };
    const tree = resolveTask(FIXTURE('inputs'), 'Lint branch diff', ctx);
    expect(tree.task.command).toBe('lint --base release/1.8.0');
  });
});
