import { describe, expect, it } from 'vitest';
import {
  resolveString,
  resolveDeep,
  listRequiredInputs,
  resolveInputDefault,
  type VariableContext,
} from '../variables.ts';
import type { TaskInput } from '../types.ts';

const CTX: VariableContext = {
  workspaceFolder: '/Users/jayemccracken/proj/forwood-one_developing',
  env: { API_PORT: '4000', FORWOOD_ONE_BASE_BRANCH: 'release/1.8.0' },
  inputs: { lintBranchTarget: 'release/1.8.0', hardSnapshotTarget: 'developing' },
};

describe('resolveString', () => {
  it('substitutes ${workspaceFolder}', () => {
    expect(resolveString('${workspaceFolder}/.vscode/tasks.json', CTX))
      .toBe('/Users/jayemccracken/proj/forwood-one_developing/.vscode/tasks.json');
  });

  it('substitutes ${env:NAME}', () => {
    expect(resolveString('PORT=${env:API_PORT}', CTX)).toBe('PORT=4000');
  });

  it('substitutes ${input:id}', () => {
    expect(resolveString('lint --base ${input:lintBranchTarget}', CTX))
      .toBe('lint --base release/1.8.0');
  });

  it('returns empty string for missing env var', () => {
    expect(resolveString('${env:MISSING}', CTX)).toBe('');
  });

  it('leaves unknown ${variable} untouched', () => {
    expect(resolveString('${file}/foo', CTX)).toBe('${file}/foo');
  });

  it('uses unresolvedInput callback when input is missing', () => {
    const result = resolveString(
      '${input:nothere}',
      { ...CTX, inputs: {} },
      { unresolvedInput: id => `<missing:${id}>` },
    );
    expect(result).toBe('<missing:nothere>');
  });

  it('resolves ${workspaceFolderBasename}', () => {
    expect(resolveString('${workspaceFolderBasename}', CTX)).toBe('forwood-one_developing');
  });
});

describe('resolveDeep', () => {
  it('recurses into nested objects and arrays', () => {
    const task = {
      command: 'bash ${workspaceFolder}/run.sh',
      args: ['${env:API_PORT}', 'static'],
      options: { cwd: '${workspaceFolder}', env: { PORT: '${env:API_PORT}' } },
    };
    const out = resolveDeep(task, CTX);
    expect(out.command).toBe(
      'bash /Users/jayemccracken/proj/forwood-one_developing/run.sh',
    );
    expect(out.args).toEqual(['4000', 'static']);
    expect(out.options.env.PORT).toBe('4000');
  });

  it('preserves non-string primitives', () => {
    const out = resolveDeep({ enabled: true, count: 3, presentation: null }, CTX);
    expect(out).toEqual({ enabled: true, count: 3, presentation: null });
  });
});

describe('listRequiredInputs', () => {
  it('collects ${input:id} references', () => {
    const task = {
      command: 'lint --base ${input:lintBranchTarget} --target ${input:hardSnapshotTarget}',
      args: ['${input:hardSnapshotTarget}'],
    };
    expect(listRequiredInputs(task).sort()).toEqual([
      'hardSnapshotTarget',
      'lintBranchTarget',
    ]);
  });

  it('returns empty array for tasks with no inputs', () => {
    expect(listRequiredInputs({ command: 'pnpm dev' })).toEqual([]);
  });
});

describe('resolveInputDefault', () => {
  it('substitutes env in a promptString default', () => {
    const input: TaskInput = {
      id: 'lintBranchTarget',
      type: 'promptString',
      default: '${env:FORWOOD_ONE_BASE_BRANCH}',
    };
    expect(resolveInputDefault(input, CTX)).toBe('release/1.8.0');
  });

  it('returns undefined for command inputs', () => {
    const input: TaskInput = {
      id: 'foo',
      type: 'command',
      command: 'some.command',
    };
    expect(resolveInputDefault(input, CTX)).toBeUndefined();
  });
});
