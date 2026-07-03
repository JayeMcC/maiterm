import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Task } from '@forwood/task-engine';

/**
 * Arrow-key navigable menu over a list of [[Task]]s.
 *
 * Visual contract (full-screen alt-buffer):
 *   - Header row: clone name + count.
 *   - One row per task: highlighted when the cursor lands on it, with
 *     `presentation.group` shown as a tag on the right (so the user can
 *     see at a glance which tab a task targets).
 *   - Footer: keybinding hint.
 *
 * Selection fires `onSelect(task)`. `q` / `Esc` / `Ctrl-C` fire `onQuit`.
 * The component does not own dispatch — it surfaces user intent and
 * leaves the side-effect to the parent.
 */
export function TaskMenu(props: {
  cloneName: string;
  tasks: Task[];
  onSelect: (task: Task) => void;
  onQuit: () => void;
}): React.JSX.Element {
  const { cloneName, tasks, onSelect, onQuit } = props;
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onQuit();
      return;
    }
    if (key.upArrow || input === 'k') {
      setCursor(c => (c <= 0 ? tasks.length - 1 : c - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor(c => (c >= tasks.length - 1 ? 0 : c + 1));
      return;
    }
    if (key.return) {
      const picked = tasks[cursor];
      if (picked) onSelect(picked);
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          {cloneName}
        </Text>
        <Text dimColor> — {tasks.length} task{tasks.length === 1 ? '' : 's'}</Text>
      </Box>
      <Box flexDirection="column">
        {tasks.map((task, i) => {
          const focused = i === cursor;
          const group = task.presentation?.group;
          return (
            <Box key={task.label}>
              <Text color={focused ? 'cyan' : undefined}>
                {focused ? '▸ ' : '  '}
                {task.label}
              </Text>
              {group ? (
                <Text dimColor>  [{group}]</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ or j/k · Enter to fire · q/Esc to quit
        </Text>
      </Box>
    </Box>
  );
}
