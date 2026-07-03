import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { TaskMenu } from '../task-menu.tsx';
import type { Task } from '@forwood/task-engine';

const SAMPLE_TASKS: Task[] = [
  {
    label: 'API',
    type: 'shell',
    command: 'pnpm dev:api',
    presentation: { panel: 'dedicated', group: 'API' },
  },
  {
    label: 'WEB',
    type: 'shell',
    command: 'pnpm dev:web',
    presentation: { panel: 'dedicated', group: 'WEB' },
  },
  {
    label: 'Lint branch diff',
    type: 'shell',
    command: 'lint',
  },
];

describe('<TaskMenu>', () => {
  it('renders header with clone name + task count', () => {
    const { lastFrame } = render(
      <TaskMenu cloneName="developing" tasks={SAMPLE_TASKS} onSelect={() => undefined} onQuit={() => undefined} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('developing');
    expect(frame).toContain('3 tasks');
  });

  it('lists every task label and highlights the first by default', () => {
    const { lastFrame } = render(
      <TaskMenu cloneName="developing" tasks={SAMPLE_TASKS} onSelect={() => undefined} onQuit={() => undefined} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('API');
    expect(frame).toContain('WEB');
    expect(frame).toContain('Lint branch diff');
    // Cursor marker on the first row.
    expect(frame).toMatch(/▸\s+API/);
  });

  it('shows the presentation.group as a tag', () => {
    const { lastFrame } = render(
      <TaskMenu cloneName="developing" tasks={SAMPLE_TASKS} onSelect={() => undefined} onQuit={() => undefined} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[API]');
    expect(frame).toContain('[WEB]');
  });

  it('arrow-down moves the cursor and Enter calls onSelect with the focused task', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(
      <TaskMenu cloneName="developing" tasks={SAMPLE_TASKS} onSelect={onSelect} onQuit={() => undefined} />,
    );
    stdin.write('\x1B[B'); // ↓
    await new Promise(r => setTimeout(r, 10));
    expect(lastFrame()).toMatch(/▸\s+WEB/);
    stdin.write('\r'); // Enter
    await new Promise(r => setTimeout(r, 10));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]?.label).toBe('WEB');
  });

  it('wraps from last back to first on arrow-down', async () => {
    const { stdin, lastFrame } = render(
      <TaskMenu cloneName="developing" tasks={SAMPLE_TASKS} onSelect={() => undefined} onQuit={() => undefined} />,
    );
    stdin.write('\x1B[B'); stdin.write('\x1B[B'); stdin.write('\x1B[B');
    await new Promise(r => setTimeout(r, 10));
    expect(lastFrame()).toMatch(/▸\s+API/);
  });

  it('q triggers onQuit', async () => {
    const onQuit = vi.fn();
    const { stdin } = render(
      <TaskMenu cloneName="developing" tasks={SAMPLE_TASKS} onSelect={() => undefined} onQuit={onQuit} />,
    );
    stdin.write('q');
    await new Promise(r => setTimeout(r, 10));
    expect(onQuit).toHaveBeenCalledTimes(1);
  });
});
