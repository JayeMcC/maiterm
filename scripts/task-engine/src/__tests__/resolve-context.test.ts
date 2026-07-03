import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveTask } from '../index.ts';
import type { TaskTreeNode } from '../types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (name: string) => join(HERE, 'fixtures', name);

function flatten(n: TaskTreeNode, acc: TaskTreeNode[] = []): TaskTreeNode[] {
  n.dependsOn.forEach(c => flatten(c, acc));
  acc.push(n);
  return acc;
}

describe('resolveTask — per-context ${workspaceFolder} (PLAN-15)', () => {
  const ctx = { workspaceFolder: '/workspaces/website', env: {} };

  it('host-context tasks resolve against workspaceFolderHost; container tasks against ctx.workspaceFolder', () => {
    const tree = resolveTask(FIXTURE('contexts'), 'Both', ctx, {
      workspaceFolderHost: '/hosts/clone',
    });
    const byLabel = new Map(flatten(tree).map(n => [n.task.label, n]));

    // Container-context: command paths are the ones visible INSIDE the
    // container (devcontainer exec wraps it later).
    expect(byLabel.get('Server')!.task.command).toContain(
      '/workspaces/website/run-server.sh',
    );
    // Host-context: command runs bare on the host — container paths would
    // point nowhere.
    expect(byLabel.get('Browser')!.task.command).toContain(
      '/hosts/clone/open-browser.sh',
    );
    // The gate itself is host-context (on the host it IS the bring-up).
    expect(byLabel.get('Require devcontainer')!.task.command).toContain(
      '/hosts/clone/.vscode',
    );
  });

  it('without the option, everything resolves against ctx.workspaceFolder (legacy)', () => {
    const tree = resolveTask(FIXTURE('contexts'), 'Both', ctx);
    const byLabel = new Map(flatten(tree).map(n => [n.task.label, n]));
    expect(byLabel.get('Browser')!.task.command).toContain(
      '/workspaces/website/open-browser.sh',
    );
  });
});
