import { countedListen as listen } from '$lib/utils/listenCounter';
import { SvelteMap } from 'svelte/reactivity';
import { getTabModelErrors } from '$lib/tauri/commands';
import type { ModelErrorSummary } from '$lib/tauri/types';

/**
 * Live per-model error-class tracking (Slice 2 of the per-model error-rate work — pairs with
 * `scripts/claude-model-error-rates.mjs`'s offline batch pass, Slice 1). Backend classification
 * lives in `claude_code::model_errors` (Rust), which tails each session's transcript JSONL on
 * every hook event and reuses Slice 1's exact classifier — see that module's doc comment for
 * why the transcript (not the hook payload) is the source of truth.
 *
 * Powers `ModelErrorPanel.svelte` (Cmd+Shift+E) — modeled directly on `subagents.svelte.ts` /
 * `SubagentPanel.svelte`, the live-observability precedent this pairs with.
 */

function createModelErrorStore() {
  // tab_id -> model -> summary. Flat map of maps (not a single keyed map) so a per-tab read
  // only touches that tab's models, mirroring subagentStore's per-tab filtering shape.
  const byTab = new SvelteMap<string, Map<string, ModelErrorSummary>>();
  // Tabs whose initial snapshot has been fetched via getTabModelErrors — fetched at most once
  // per tab; live updates after that ride the event listener below.
  const fetchedTabs = new Set<string>();
  const unlisteners: (() => void)[] = [];

  function applySummaries(tabId: string, summaries: ModelErrorSummary[]) {
    if (!summaries.length) return;
    const next = new Map(byTab.get(tabId) ?? []);
    for (const s of summaries) next.set(s.model, s);
    byTab.set(tabId, next);
  }

  return {
    /** Diagnostic snapshot for getDiagnostics. */
    getInternalSizes() {
      return { model_error_tabs: byTab.size, unlisteners: unlisteners.length };
    },

    /** Live per-model summaries for a tab, most active (highest turn count) first. */
    getForTab(tabId: string): ModelErrorSummary[] {
      const m = byTab.get(tabId);
      return m ? [...m.values()].sort((a, b) => b.turns - a.turns) : [];
    },

    /**
     * Fetch the tab's current snapshot once, lazily — call this when a UI surface for the tab
     * is about to become visible (e.g. the panel opening). Idempotent per tab; a session that
     * accrued errors before anything was listening would otherwise show zero counts until its
     * next hook event. Live updates after the initial fetch ride the event listener, not this.
     */
    async ensureLoaded(tabId: string) {
      if (fetchedTabs.has(tabId)) return;
      fetchedTabs.add(tabId);
      try {
        const summaries = await getTabModelErrors(tabId);
        applySummaries(tabId, summaries);
      } catch {
        // No active session for this tab, or the backend command isn't reachable yet — leave
        // the tab absent from the map (same as "no errors observed"); a later hook event still
        // populates it via the live listener.
      }
    },

    async init() {
      const u = await listen<{ tab_id: string | null; summaries: ModelErrorSummary[] }>(
        'agent-model-errors-updated',
        (e) => {
          const { tab_id, summaries } = e.payload;
          if (!tab_id) return;
          applySummaries(tab_id, summaries);
        },
      );
      unlisteners.push(u);
    },

    destroy() {
      for (const u of unlisteners) u();
      unlisteners.length = 0;
    },
  };
}

export const modelErrorStore = createModelErrorStore();
