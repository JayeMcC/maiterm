import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type { TaskFile } from './types.ts';

/**
 * Read and parse `<clonePath>/.vscode/tasks.json`. Tolerates comments and
 * trailing commas (VS Code's tasks.json is JSONC, not strict JSON).
 *
 * Throws if the file is missing, malformed, or lacks a `tasks` array.
 */
export function readTasksFile(clonePath: string): TaskFile {
  const path = join(clonePath, '.vscode', 'tasks.json');
  if (!existsSync(path)) {
    throw new Error(`tasks.json not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const summary = errors
      .map(e => `[offset ${e.offset}, length ${e.length}] error code ${e.error}`)
      .join('; ');
    throw new Error(`Failed to parse ${path}: ${summary}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path}: expected a JSON object, got ${typeof parsed}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj['tasks'])) {
    throw new Error(`${path}: missing or non-array \`tasks\` field`);
  }
  return obj as unknown as TaskFile;
}
