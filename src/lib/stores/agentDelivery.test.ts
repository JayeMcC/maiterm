import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDeliveryController } from './agentDelivery';

/**
 * Regression contract for the recipient-keyed FIFO mailbox extracted from agentBridge.
 * These tests are the guarantee referenced by the eng review (T1): the 1:1 bridge — and the
 * mesh built on the same core — delivers strictly in order, and the e3d4eb8 fix (a newer
 * message must never jump a non-empty queue) holds.
 */

function makeHarness(opts: { cooldownMs?: number; drainTickMs?: number } = {}) {
  const attempts: { tabId: string; text: string }[] = [];
  const live = new Set<string>();
  const awaiting = new Set<string>();
  let injectResult = true;

  const ctl = createDeliveryController(
    {
      inject: async (tabId, text) => {
        attempts.push({ tabId, text }); // recorded on every attempt (success OR failure)
        return injectResult;
      },
      liveState: (tabId) => live.has(tabId),
      awaitingHuman: (tabId) => awaiting.has(tabId),
    },
    { cooldownMs: opts.cooldownMs ?? 1000, drainTickMs: opts.drainTickMs ?? 1500 },
  );

  return {
    ctl,
    attempts,
    live,
    awaiting,
    setInjectResult: (v: boolean) => { injectResult = v; },
    textsFor: (tabId: string) => attempts.filter((a) => a.tabId === tabId).map((a) => a.text),
  };
}

describe('agentDelivery — FIFO mailbox', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('delivers immediately when ready and the queue is empty', async () => {
    const h = makeHarness();
    h.live.add('A');
    h.ctl.ensure('A', true);

    const r = await h.ctl.deliver('A', 'm1');

    expect(r).toBe('delivered');
    expect(h.textsFor('A')).toEqual(['m1']);
  });

  it('queues when the session is not live, then drains in order on markReady', async () => {
    const h = makeHarness();
    h.ctl.ensure('A', true); // ready flag set, but liveState false → not deliverable

    expect(await h.ctl.deliver('A', 'm1')).toBe('queued');
    expect(await h.ctl.deliver('A', 'm2')).toBe('queued');
    expect(h.textsFor('A')).toEqual([]);

    h.live.add('A');
    h.ctl.markReady('A'); // flushes the head; cooldown drains the rest
    await vi.runAllTimersAsync();

    expect(h.textsFor('A')).toEqual(['m1', 'm2']);
  });

  it('REGRESSION e3d4eb8: a new message never jumps a non-empty queue', async () => {
    const h = makeHarness();
    h.live.add('A');
    h.ctl.ensure('A', true);
    h.awaiting.add('A'); // at a human prompt → held → messages queue

    expect(await h.ctl.deliver('A', 'A1')).toBe('queued');
    expect(await h.ctl.deliver('A', 'A2')).toBe('queued');
    expect(h.textsFor('A')).toEqual([]);

    // Human answers; the tab is deliverable again, but the queue hasn't drained yet.
    h.awaiting.delete('A');
    // A fresh message arrives in that window. Pre-fix it would inject AHEAD of A1/A2.
    expect(await h.ctl.deliver('A', 'A3')).toBe('queued');

    await vi.runAllTimersAsync();

    // Strict FIFO: oldest-first, the newcomer last.
    expect(h.textsFor('A')).toEqual(['A1', 'A2', 'A3']);
  });

  it('serializes back-to-back sends through the cooldown, preserving order', async () => {
    const h = makeHarness({ cooldownMs: 1000 });
    h.live.add('A');
    h.ctl.ensure('A', true);

    expect(await h.ctl.deliver('A', 'm1')).toBe('delivered'); // immediate, arms cooldown
    expect(await h.ctl.deliver('A', 'm2')).toBe('queued');    // held by cooldown
    expect(h.textsFor('A')).toEqual(['m1']);

    await vi.runAllTimersAsync();
    expect(h.textsFor('A')).toEqual(['m1', 'm2']);
  });

  it('re-queues a failed inject at the FRONT (order preserved on retry)', async () => {
    const h = makeHarness();
    h.live.add('A');
    h.ctl.ensure('A', true);
    h.setInjectResult(false);

    // Deliverable, so it attempts the inject, fails, and re-queues at the front.
    expect(await h.ctl.deliver('A', 'A1')).toBe('queued');
    expect(h.textsFor('A')).toEqual(['A1']); // one failed attempt

    h.setInjectResult(true);
    await vi.runAllTimersAsync(); // drain poller retries the same head message

    expect(h.textsFor('A')).toEqual(['A1', 'A1']); // retried (front-of-queue), then delivered
  });

  it('does not deliver into a tab with no delivery entry', async () => {
    const h = makeHarness();
    h.live.add('ghost');
    // No ensure() → no entry.
    expect(await h.ctl.deliver('ghost', 'x')).toBe('failed');
    expect(h.textsFor('ghost')).toEqual([]);
    h.ctl.markReady('ghost'); // no-op, must not create an entry
    expect(h.ctl.has('ghost')).toBe(false);
  });
});
