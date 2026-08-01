import * as commands from '$lib/tauri/commands';
import { agentStateStore } from './agentState.svelte';
import { preferencesStore } from './preferences.svelte';
import { SvelteMap } from 'svelte/reactivity';

/** How often to ask the backend which sessions are currently being narrated.
 *  Short enough that the "speaking" badge feels live, long enough that a
 *  handful of open Claude tabs is a non-issue on IPC traffic. */
const POLL_INTERVAL_MS = 1000;

/**
 * Tracks which tabs currently have a live `say` narration in flight — the
 * "voice live" half of voice mode (see scripts/voice-status/speak-status.sh
 * and barge-in.sh, and the `voice_status` preference that gates both).
 *
 * This is a poll, not a push, on purpose: the pid file's lifetime is owned
 * entirely by a `say` subprocess outside maiTerm's control — speak-status.sh
 * backgrounds it and removes the file when it exits naturally, barge-in.sh
 * may kill it (and remove the file) mid-utterance the moment the user submits
 * a new prompt. Neither hook talks back to maiTerm directly, so there's no
 * event to listen for; a short poll against the same pid-file directory both
 * scripts already use is the simplest honest way to reflect that external
 * state without inventing a new IPC channel those standalone, hand-testable
 * shell scripts would also need to speak.
 *
 * Only polls while `voice_status` is on and at least one tab has a tracked
 * agent session — idle otherwise.
 */
function createVoiceStatusStore() {
  // tabId → speaking. SvelteMap so isSpeaking() reads stay reactive.
  const speaking = new SvelteMap<string, boolean>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  async function tick() {
    if (inFlight) return; // don't pile up requests if a poll is slow
    if (!preferencesStore.voiceStatus) {
      if (speaking.size) speaking.clear();
      return;
    }
    const active = agentStateStore.getActiveSessions();
    if (!active.length) {
      if (speaking.size) speaking.clear();
      return;
    }

    inFlight = true;
    let live: string[];
    try {
      live = await commands.getVoiceSpeakingSessions(active.map((a) => a.sessionId));
    } catch {
      // Transient IPC hiccup — leave prior state as-is, next tick corrects it.
      inFlight = false;
      return;
    }
    inFlight = false;

    const liveSessionIds = new Set(live);
    const activeTabIds = new Set(active.map((a) => a.tabId));

    for (const { tabId, sessionId } of active) {
      if (liveSessionIds.has(sessionId)) speaking.set(tabId, true);
      else if (speaking.has(tabId)) speaking.delete(tabId);
    }
    // Drop entries for tabs whose session ended since the last tick.
    for (const tabId of [...speaking.keys()]) {
      if (!activeTabIds.has(tabId)) speaking.delete(tabId);
    }
  }

  return {
    /** Is this tab's Claude session currently being narrated aloud? */
    isSpeaking(tabId: string): boolean {
      return speaking.get(tabId) ?? false;
    },

    init() {
      if (timer) return;
      timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
      void tick();
    },

    destroy() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      speaking.clear();
    },
  };
}

export const voiceStatusStore = createVoiceStatusStore();
