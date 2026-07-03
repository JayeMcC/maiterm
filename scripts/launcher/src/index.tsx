#!/usr/bin/env node
/**
 * forwood-launcher — one-shot Ink TUI that lists tasks for the active
 * clone and fires them through the maiTerm MCP dispatcher. See
 * `docs/adr/0005-task-engine-and-dispatchers.md`.
 *
 * Usage:
 *   forwood-launcher                 # uses $FORWOOD_CLONE
 *   forwood-launcher --clone <name>  # explicit override
 *
 * Process model: full-screen alt-buffer, exits on quit or after dispatch.
 * Talks to maiTerm via @forwood/task-engine's maiTerm dispatcher, which
 * discovers the IDE server from ~/.claude/ide/<port>.lock.
 */

import React from 'react';
import { render } from 'ink';
import { resolveClone, validateClone, KNOWN_CLONE_NAMES } from './clone-resolver.ts';
import { App } from './app.tsx';

function parseArgs(argv: string[]): { clone?: string; help?: boolean } {
  const out: { clone?: string; help?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clone' || a === '-c') {
      const v = argv[i + 1];
      if (!v) {
        process.stderr.write(`forwood-launcher: --clone requires a value\n`);
        process.exit(2);
      }
      out.clone = v;
      i++;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    `forwood-launcher — fire .vscode/tasks.json tasks via maiTerm MCP\n` +
      `\n` +
      `Usage:\n` +
      `  forwood-launcher                  # uses $FORWOOD_CLONE\n` +
      `  forwood-launcher --clone <name>   # explicit override\n` +
      `\n` +
      `Known clone names: ${KNOWN_CLONE_NAMES.join(', ')}\n`,
  );
}

const argv = process.argv.slice(2);

// Non-interactive provider modes (PLAN-15 / ADR 0006): --list, --fire,
// --container-status, --forward, --unforward — dir-derived, no
// $FORWOOD_CLONE, no Ink. Routed before any interactive machinery.
{
  const { isNonInteractive, runNonInteractive } = await import('./modes.ts');
  if (isNonInteractive(argv)) {
    process.exit(await runNonInteractive(argv));
  }
}

const args = parseArgs(argv);
if (args.help) {
  printHelp();
  process.exit(0);
}

const cloneInfo = resolveClone({ arg: args.clone });
if (!cloneInfo) {
  process.stderr.write(
    `forwood-launcher: no clone specified.\n` +
      `Set FORWOOD_CLONE in this workspace's environment or pass --clone <name>.\n`,
  );
  process.exit(2);
}

try {
  validateClone(cloneInfo);
} catch (err) {
  process.stderr.write(`forwood-launcher: ${String(err)}\n`);
  process.exit(2);
}

const { unmount, waitUntilExit } = render(<App clone={cloneInfo} />, {
  exitOnCtrlC: true,
});

waitUntilExit().catch(err => {
  process.stderr.write(`forwood-launcher: ${String(err)}\n`);
  process.exit(1);
});

// Defensive — ensure stdout is restored if the process is killed unexpectedly.
process.on('SIGTERM', () => unmount());
process.on('SIGINT', () => unmount());
