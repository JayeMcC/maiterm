import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import {
  listTasks,
  resolveTask,
  dispatchMaiterm,
  connectMaiterm,
  type Task,
  type MaitermConnection,
  type MaitermDispatchStep,
  type VariableContext,
} from '@forwood/task-engine';
import { TaskMenu } from './task-menu.tsx';
import type { CloneInfo } from './clone-resolver.ts';

type Phase =
  | { kind: 'menu' }
  | { kind: 'dispatching'; task: Task }
  | { kind: 'done'; task: Task; steps: MaitermDispatchStep[] }
  | { kind: 'error'; message: string };

/**
 * Top-level launcher screen. One-shot: lists tasks for the active clone,
 * fires the user's pick through the maiTerm dispatcher, shows a status
 * row, exits.
 */
export function App(props: { clone: CloneInfo }): React.JSX.Element {
  const { clone } = props;
  const { exit } = useApp();

  // listTasks is sync so we can compute eagerly; surface errors as a phase
  // rather than a render-time throw.
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'menu' });

  useEffect(() => {
    try {
      setTasks(listTasks(clone.path));
    } catch (err) {
      setLoadError(String(err));
    }
  }, [clone.path]);

  if (loadError) {
    return (
      <Box flexDirection="column">
        <Text color="red">Failed to read tasks for clone '{clone.name}':</Text>
        <Text>{loadError}</Text>
      </Box>
    );
  }

  if (!tasks) {
    return <Text dimColor>Loading tasks for {clone.name}…</Text>;
  }

  if (phase.kind === 'menu') {
    return (
      <TaskMenu
        cloneName={clone.name}
        tasks={tasks}
        onSelect={task => fireTask(task, clone, setPhase, exit)}
        onQuit={() => exit()}
      />
    );
  }

  if (phase.kind === 'dispatching') {
    return (
      <Box flexDirection="column">
        <Text>Dispatching <Text bold>{phase.task.label}</Text>…</Text>
        <Text dimColor>(connecting to maiTerm MCP server, opening tab)</Text>
      </Box>
    );
  }

  if (phase.kind === 'done') {
    const created = phase.steps.filter(s => !s.skipped && s.result?.action === 'created').length;
    const focused = phase.steps.filter(s => !s.skipped && s.result?.action === 'focused').length;
    const skipped = phase.steps.filter(s => s.skipped).length;
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Dispatched {phase.task.label}</Text>
        <Text dimColor>
          {created} tab{created === 1 ? '' : 's'} created, {focused} focused, {skipped} aggregator{skipped === 1 ? '' : 's'} skipped
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="red">✗ Dispatch failed</Text>
      <Text>{phase.message}</Text>
    </Box>
  );
}

async function fireTask(
  task: Task,
  clone: CloneInfo,
  setPhase: (p: Phase) => void,
  exit: (err?: Error) => void,
): Promise<void> {
  setPhase({ kind: 'dispatching', task });
  let conn: MaitermConnection | null = null;
  try {
    const ctx: VariableContext = {
      workspaceFolder: clone.path,
      env: process.env,
    };
    const tree = resolveTask(clone.path, task.label, ctx);
    conn = await connectMaiterm();
    const steps = await dispatchMaiterm(tree, {
      client: conn.client,
      workspaceName: clone.name,
      workspaceFolderHost: clone.path,
    });
    setPhase({ kind: 'done', task, steps });
    // Brief settle so the user sees the success banner before the alt-buffer collapses.
    setTimeout(() => exit(), 600);
  } catch (err) {
    setPhase({ kind: 'error', message: String(err) });
    setTimeout(() => exit(new Error(String(err))), 1500);
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch {
        // Ignore — best-effort.
      }
    }
  }
}
