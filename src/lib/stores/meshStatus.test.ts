import { describe, it, expect } from 'vitest';
import { statusMarker, buildStatusNoteTemplate, parseNeedsDecision } from './meshStatus';

describe('buildStatusNoteTemplate', () => {
  it('starts with the role marker (for dedup) and carries the purpose', () => {
    const t = buildStatusNoteTemplate('Backend API', 'owns the REST API');
    expect(t.startsWith(statusMarker('Backend API'))).toBe(true);
    expect(t).toContain('owns the REST API');
    expect(t).toContain('NEEDS DECISION');
  });
  it('falls back when no purpose is set', () => {
    expect(buildStatusNoteTemplate('X', null)).toContain('purpose not set');
  });
});

describe('parseNeedsDecision', () => {
  it('returns empty for the freshly templated placeholder', () => {
    expect(parseNeedsDecision(buildStatusNoteTemplate('Backend API', 'p'))).toBe('');
  });

  it('returns empty when there is no NEEDS DECISION heading', () => {
    expect(parseNeedsDecision('### Backend API\n**Done:**\n- shipped\n')).toBe('');
  });

  it('extracts a single decision item under the heading', () => {
    const note = [
      '<!-- mesh:status:Backend API -->',
      '### Backend API',
      '**Done:**',
      '- wired auth',
      '',
      '**NEEDS DECISION:**',
      '- pick a token TTL: 15m or 60m?',
      '',
      '**Blocked:**',
      '- ',
    ].join('\n');
    expect(parseNeedsDecision(note)).toBe('pick a token TTL: 15m or 60m?');
  });

  it('joins multiple decision items and stops at the next heading', () => {
    const note = [
      '**NEEDS DECISION:**',
      '- approve the schema migration',
      '- confirm the prod rollout window',
      '',
      '**Blocked:**',
      '- waiting on infra',
    ].join('\n');
    expect(parseNeedsDecision(note)).toBe('approve the schema migration; confirm the prod rollout window');
  });

  it('handles the heading being the last block (no trailing heading)', () => {
    expect(parseNeedsDecision('**NEEDS DECISION:**\n- ship or hold?')).toBe('ship or hold?');
  });

  it('is case-insensitive on the heading', () => {
    expect(parseNeedsDecision('**needs decision:**\n- yes or no?')).toBe('yes or no?');
  });
});
