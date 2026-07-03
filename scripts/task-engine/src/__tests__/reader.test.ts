import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readTasksFile } from '../reader.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (name: string) => join(HERE, 'fixtures', name);

describe('readTasksFile', () => {
  it('parses JSONC with comments and trailing commas', () => {
    const file = readTasksFile(FIXTURE('basic'));
    expect(file.version).toBe('2.0.0');
    expect(file.tasks).toHaveLength(3);
    expect(file.tasks[0]?.label).toBe('API');
  });

  it('reads inputs section', () => {
    const file = readTasksFile(FIXTURE('inputs'));
    expect(file.inputs).toHaveLength(2);
    expect(file.inputs?.[0]?.id).toBe('lintBranchTarget');
    expect(file.inputs?.[0]?.type).toBe('promptString');
  });

  it('throws on missing file', () => {
    expect(() => readTasksFile(join(HERE, 'nonexistent'))).toThrow(/not found/);
  });
});
