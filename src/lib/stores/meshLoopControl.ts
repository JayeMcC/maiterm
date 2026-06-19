/**
 * Mesh loop control (docs/mesh-workspace.md §10) — bounds an A↔B ping-pong on one topic so it
 * can't burn tokens / thrash PTYs unwatched. Pure (limits + clock injected), unit-tested
 * (meshLoopControl.test.ts). Three layers, evaluated against a PROSPECTIVE next turn:
 *
 *   1. Soft cap N (primary)  — at N turns, delivery pauses; the cockpit offers resume/complete.
 *                              A human resume LIFTS the ceiling by another N (so the thread
 *                              continues for another N turns), making N a checkpoint, not a wall.
 *   2. Hard cap M (backstop) — an absolute turn ceiling (M ≫ N). Resume can NOT clear it; the
 *                              topic must be completed. The away-from-keyboard guarantee that an
 *                              unwatched runaway can't run unbounded.
 *   3. TTL (time backstop)   — a topic older than the TTL (since creation, or since the last
 *                              resume) force-pauses regardless of turn count.
 *
 * The verdict gates the send BEFORE delivery + before the turn commits, so a paused send
 * neither injects nor advances the counter — the runaway is genuinely halted until a human acts.
 */

export interface LoopLimits {
  /** Soft per-topic turn cap N (0 = disabled). */
  softCap: number;
  /** Hard per-topic turn ceiling M (0 = disabled). */
  hardCap: number;
  /** Per-topic TTL in ms (0 = disabled). */
  ttlMs: number;
}

export type LoopReason = 'soft' | 'hard' | 'ttl';

export type LoopVerdict =
  | { ok: true }
  | { ok: false; reason: LoopReason; turn: number; cap: number };

interface LoopState {
  /** How many times a human has lifted the soft cap on this topic. */
  lifts: number;
  /** TTL clock base (epoch ms) — set on resume; falls back to topic creation. */
  ttlBaseMs: number | null;
}

export function createLoopController(deps: { limits: () => LoopLimits }) {
  const states = new Map<string, LoopState>();

  function stateOf(topicId: string): LoopState {
    let s = states.get(topicId);
    if (!s) { s = { lifts: 0, ttlBaseMs: null }; states.set(topicId, s); }
    return s;
  }

  /** Would a send bringing `topicId` to `nextTurn` be allowed right now? */
  function evaluate(topicId: string, nextTurn: number, createdAtMs: number, nowMs: number): LoopVerdict {
    const lim = deps.limits();
    const s = states.get(topicId);
    const lifts = s?.lifts ?? 0;

    // Hard ceiling first — absolute, a resume can't clear it.
    if (lim.hardCap > 0 && nextTurn > lim.hardCap) {
      return { ok: false, reason: 'hard', turn: nextTurn, cap: lim.hardCap };
    }
    // Time backstop — measured from the last resume, else topic creation.
    if (lim.ttlMs > 0) {
      const base = s?.ttlBaseMs ?? createdAtMs;
      if (nowMs - base > lim.ttlMs) {
        return { ok: false, reason: 'ttl', turn: nextTurn, cap: 0 };
      }
    }
    // Soft cap — liftable. Each human resume adds another N turns of headroom.
    if (lim.softCap > 0) {
      const effective = lim.softCap * (1 + lifts);
      if (nextTurn > effective) {
        return { ok: false, reason: 'soft', turn: nextTurn, cap: effective };
      }
    }
    return { ok: true };
  }

  /** Human resume: lift the soft ceiling by another N and re-base the TTL clock. */
  function resume(topicId: string, nowMs: number) {
    const s = stateOf(topicId);
    s.lifts += 1;
    s.ttlBaseMs = nowMs;
  }

  return {
    evaluate,
    resume,
    lifts(topicId: string): number { return states.get(topicId)?.lifts ?? 0; },
    clear(topicId: string) { states.delete(topicId); },
    reset() { states.clear(); },
  };
}

export type LoopController = ReturnType<typeof createLoopController>;
