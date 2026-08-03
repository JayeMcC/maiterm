import { describe, it, expect } from 'vitest';
import {
  buildSessionName,
  sanitizeField,
  resolveTicketFromBranch,
  resolveStackFromCwd,
  resolveLocationFromCwd,
  resolveWorkPartFromBranch,
  resolveSessionNameParts,
  autoSessionName,
  SEPARATOR,
  DEFAULT_FALLBACKS,
} from './sessionName';

describe('buildSessionName', () => {
  it('joins the four fields in canonical order with the middle-dot separator', () => {
    const name = buildSessionName({ stack: 's4', location: 'review', ticket: 'EAP-3007', workPart: 'get-it-green' });
    expect(name).toBe('s4·review·EAP-3007·get-it-green');
    expect(name.split(SEPARATOR)).toEqual(['s4', 'review', 'EAP-3007', 'get-it-green']);
  });

  it('preserves field ORDER even when caller passes keys out of order', () => {
    const name = buildSessionName({ workPart: 'w', ticket: 'EAP-1', location: 'loc', stack: 's1' });
    expect(name).toBe('s1·loc·EAP-1·w');
  });

  it('fills each unknown field with its fallback, keeping all four positions', () => {
    expect(buildSessionName({})).toBe(
      [DEFAULT_FALLBACKS.stack, DEFAULT_FALLBACKS.location, DEFAULT_FALLBACKS.ticket, DEFAULT_FALLBACKS.workPart].join(SEPARATOR),
    );
    expect(buildSessionName({})).toBe('local·session·no-ticket·wip');
  });

  it('applies fallbacks per-field when only some are known', () => {
    expect(buildSessionName({ stack: 's4', ticket: 'EAP-9' })).toBe('s4·session·EAP-9·wip');
  });

  it('treats null / undefined / blank / whitespace as unknown', () => {
    expect(buildSessionName({ stack: null, location: undefined, ticket: '', workPart: '   ' })).toBe(
      'local·session·no-ticket·wip',
    );
  });

  it('never lets an embedded separator forge extra fields', () => {
    const name = buildSessionName({ stack: 's4', location: 'a·b·c', ticket: 'EAP-1', workPart: 'w' });
    // location collapses to a single field — still exactly four segments
    expect(name.split(SEPARATOR)).toHaveLength(4);
    expect(name).toBe('s4·abc·EAP-1·w');
  });

  it('honours a custom separator and custom fallbacks', () => {
    const name = buildSessionName({ stack: 's4' }, { separator: '/', fallbacks: { workPart: 'TODO' } });
    expect(name).toBe('s4/session/no-ticket/TODO');
  });

  it('truncates over-long fields', () => {
    const name = buildSessionName({ stack: 's4', workPart: 'x'.repeat(80) }, { maxFieldLength: 8 });
    expect(name.split(SEPARATOR)[3]).toBe('xxxxxxxx');
  });
});

describe('sanitizeField', () => {
  it('turns whitespace and path separators into single hyphens and trims', () => {
    expect(sanitizeField('  get   it green ')).toBe('get-it-green');
    expect(sanitizeField('a/b\\c')).toBe('a-b-c');
    expect(sanitizeField('--x--')).toBe('x');
  });
  it('returns empty string for nullish/blank input', () => {
    expect(sanitizeField(null)).toBe('');
    expect(sanitizeField(undefined)).toBe('');
    expect(sanitizeField('   ')).toBe('');
  });
});

describe('resolveTicketFromBranch', () => {
  it('extracts an upper-cased Jira key from common branch shapes', () => {
    expect(resolveTicketFromBranch('feature/EAP-3007-get-it-green')).toBe('EAP-3007');
    expect(resolveTicketFromBranch('eap-3007-fix')).toBe('EAP-3007');
    expect(resolveTicketFromBranch('FPM-527')).toBe('FPM-527');
  });
  it('returns null when there is no ticket', () => {
    expect(resolveTicketFromBranch('dev')).toBeNull();
    expect(resolveTicketFromBranch('main')).toBeNull();
    expect(resolveTicketFromBranch(null)).toBeNull();
  });
});

describe('resolveStackFromCwd', () => {
  it('finds a stack marker on a path-segment boundary', () => {
    expect(resolveStackFromCwd('/Users/j/proj/s4/forwood-one')).toBe('s4');
    expect(resolveStackFromCwd('/Users/j/stacks/stack4/app')).toBe('s4');
    expect(resolveStackFromCwd('/Users/j/proj/s-12/x')).toBe('s12');
  });
  it('returns null when no stack marker is present', () => {
    expect(resolveStackFromCwd('/Users/j/proj/forwood-one')).toBeNull();
    expect(resolveStackFromCwd(null)).toBeNull();
  });
  it('does not match a stack marker mid-word (e.g. css5)', () => {
    expect(resolveStackFromCwd('/Users/j/proj/css5-tokens')).toBeNull();
  });
});

describe('resolveLocationFromCwd', () => {
  it('uses the basename of the directory', () => {
    expect(resolveLocationFromCwd('/Users/j/proj/forwood-one-review')).toBe('forwood-one-review');
    expect(resolveLocationFromCwd('/Users/j/proj/review/')).toBe('review');
  });
  it('returns null for empty/root paths', () => {
    expect(resolveLocationFromCwd('/')).toBeNull();
    expect(resolveLocationFromCwd('')).toBeNull();
    expect(resolveLocationFromCwd(null)).toBeNull();
  });
});

describe('resolveWorkPartFromBranch', () => {
  it('strips the workflow prefix and ticket key, leaving the slug', () => {
    expect(resolveWorkPartFromBranch('feature/EAP-3007-get-it-green')).toBe('get-it-green');
    expect(resolveWorkPartFromBranch('bugfix/FPM-1-crash-on-load')).toBe('crash-on-load');
  });
  it('returns null when nothing meaningful remains', () => {
    expect(resolveWorkPartFromBranch('EAP-3007')).toBeNull();
    expect(resolveWorkPartFromBranch('feature/EAP-3007')).toBeNull();
    expect(resolveWorkPartFromBranch(null)).toBeNull();
  });
});

describe('resolveSessionNameParts + autoSessionName', () => {
  it('resolves all four fields from cwd + branch, deriving work-part from the branch', () => {
    const parts = resolveSessionNameParts({ cwd: '/Users/j/proj/s4/review', branch: 'feature/EAP-3007-get-it-green' });
    expect(parts).toEqual({ stack: 's4', location: 'review', ticket: 'EAP-3007', workPart: 'get-it-green' });
  });

  it('honours an explicit work-part over the branch-derived one', () => {
    const parts = resolveSessionNameParts({ cwd: '/Users/j/proj/s4/review', branch: 'feature/EAP-3007-x', workPart: 'phase-2' });
    expect(parts.workPart).toBe('phase-2');
  });

  it('autoSessionName produces the full convention string end-to-end', () => {
    expect(autoSessionName({ cwd: '/Users/j/proj/s4/review', branch: 'feature/EAP-3007-get-it-green' })).toBe(
      's4·review·EAP-3007·get-it-green',
    );
  });

  it('degrades gracefully when branch is unknown (cwd-only)', () => {
    // No branch → ticket + work-part fall back, stack + location still resolve.
    expect(autoSessionName({ cwd: '/Users/j/proj/s4/review', branch: null })).toBe('s4·review·no-ticket·wip');
  });

  it('degrades gracefully when cwd is unknown (branch-only)', () => {
    expect(autoSessionName({ cwd: null, branch: 'feature/EAP-3007-get-it-green' })).toBe(
      'local·session·EAP-3007·get-it-green',
    );
  });
});
