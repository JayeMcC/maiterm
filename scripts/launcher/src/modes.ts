/**
 * Non-interactive mode router (PLAN-15 provider contract). Invoked from
 * index.tsx before any Ink rendering or clone resolution — these modes are
 * dir-derived and TTY-free by contract (FR-012).
 */
import { runListMode } from './list-mode.ts';
import { runFireMode } from './fire-mode.ts';
import { runStatusMode } from './container-status.ts';
import { runForwardMode, runUnforwardMode } from './forwards.ts';

const MODE_FLAGS = ['--list', '--fire', '--container-status', '--forward', '--unforward'];

export function isNonInteractive(argv: string[]): boolean {
  return MODE_FLAGS.some(f => argv.includes(f));
}

export async function runNonInteractive(argv: string[]): Promise<number> {
  const dir = optValue(argv, '--dir');
  if (!dir) {
    process.stderr.write(
      `forwood-launcher: --dir <path> is required for ${MODE_FLAGS.join('/')}\n`,
    );
    return 2;
  }

  if (argv.includes('--list')) {
    return emit(runListMode(dir));
  }
  if (argv.includes('--container-status')) {
    return emit(await runStatusMode(dir));
  }

  const fireLabel = optValue(argv, '--fire');
  if (argv.includes('--fire')) {
    if (!fireLabel) {
      process.stderr.write('forwood-launcher: --fire requires a task label\n');
      return 2;
    }
    return emit(await runFireMode(dir, fireLabel));
  }

  for (const [flag, fn] of [
    ['--forward', runForwardMode],
    ['--unforward', runUnforwardMode],
  ] as const) {
    if (!argv.includes(flag)) continue;
    const port = Number(optValue(argv, flag));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      process.stderr.write(`forwood-launcher: ${flag} requires a port number\n`);
      return 2;
    }
    return emit(await fn(dir, port));
  }

  return 2;
}

function emit(r: { exitCode: number; stdout: string; stderr: string }): number {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.exitCode;
}

function optValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
}
