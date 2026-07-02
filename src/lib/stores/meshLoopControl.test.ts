import { describe, it, expect } from 'vitest';
import { createLoopController, type LoopLimits } from './meshLoopControl';

function ctl(limits: LoopLimits) {
  let cur = limits;
  const c = createLoopController({ limits: () => cur });
  return {
    c,
    set: (l: LoopLimits) => {
      cur = l;
    },
  };
}

describe('soft cap', () => {
  it('allows up to N turns, then pauses', () => {
    const { c } = ctl({ softCap: 3, hardCap: 0, ttlMs: 0 });
    expect(c.evaluate('t', 1, 0, 0).ok).toBe(true);
    expect(c.evaluate('t', 3, 0, 0).ok).toBe(true);
    const v = c.evaluate('t', 4, 0, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe('soft');
      expect(v.cap).toBe(3);
    }
  });

  it('a human resume lifts the ceiling by another N', () => {
    const { c } = ctl({ softCap: 3, hardCap: 0, ttlMs: 0 });
    expect(c.evaluate('t', 4, 0, 0).ok).toBe(false); // paused at 3
    c.resume('t', 0);
    expect(c.evaluate('t', 4, 0, 0).ok).toBe(true); // now allowed
    expect(c.evaluate('t', 6, 0, 0).ok).toBe(true);
    expect(c.evaluate('t', 7, 0, 0).ok).toBe(false); // paused again at 6
    expect(c.lifts('t')).toBe(1);
  });

  it('never pauses when the soft cap is disabled (0)', () => {
    const { c } = ctl({ softCap: 0, hardCap: 0, ttlMs: 0 });
    expect(c.evaluate('t', 9999, 0, 0).ok).toBe(true);
  });
});

describe('hard cap', () => {
  it('blocks past M and a resume cannot clear it', () => {
    const { c } = ctl({ softCap: 3, hardCap: 5, ttlMs: 0 });
    c.resume('t', 0); // soft → 6
    c.resume('t', 0); // soft → 9
    expect(c.evaluate('t', 5, 0, 0).ok).toBe(true);
    const v = c.evaluate('t', 6, 0, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe('hard');
      expect(v.cap).toBe(5);
    }
  });

  it('is checked before the soft cap', () => {
    const { c } = ctl({ softCap: 3, hardCap: 5, ttlMs: 0 });
    // nextTurn 6 is over BOTH soft(3) and hard(5) — must report hard
    const v = c.evaluate('t', 6, 0, 0);
    if (!v.ok) expect(v.reason).toBe('hard');
  });
});

describe('ttl', () => {
  it('force-pauses a topic older than the TTL, and resume re-bases the clock', () => {
    const { c } = ctl({ softCap: 100, hardCap: 0, ttlMs: 1000 });
    expect(c.evaluate('t', 1, 0, 500).ok).toBe(true); // within ttl
    const v = c.evaluate('t', 2, 0, 1500); // 1500ms old > 1000
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('ttl');
    c.resume('t', 1500); // re-base ttl to 1500
    expect(c.evaluate('t', 3, 0, 2000).ok).toBe(true); // 500ms since resume
    expect(c.evaluate('t', 4, 0, 2600).ok).toBe(false); // 1100ms since resume
  });

  it('is checked before the soft cap but after the hard cap', () => {
    const { c } = ctl({ softCap: 3, hardCap: 5, ttlMs: 1000 });
    // over soft(3) and past ttl, but under hard(5) → ttl wins
    const v1 = c.evaluate('t', 4, 0, 2000);
    if (!v1.ok) expect(v1.reason).toBe('ttl');
    // over hard(5) and past ttl → hard wins
    const v2 = c.evaluate('t', 6, 0, 2000);
    if (!v2.ok) expect(v2.reason).toBe('hard');
  });
});
