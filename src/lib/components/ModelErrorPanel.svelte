<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { modelErrorStore } from '$lib/stores/modelErrors.svelte';
  import type { ModelErrorSummary } from '$lib/tauri/types';

  /**
   * Live view of the active tab's per-model error-class counts — API errors, refusal
   * fallbacks, `max_tokens` truncation, tool-call failures — tailed from the session's own
   * transcript by `claude_code::model_errors` (Rust; reuses Slice 1's classifier,
   * `scripts/claude-model-error-rates.mjs`). Modeled directly on `SubagentPanel.svelte`, the
   * live-observability precedent this pairs with. Backed by `modelErrorStore`.
   */

  interface Props {
    open: boolean;
    onclose: () => void;
    tabId: string | null;
    tabName?: string;
  }

  let { open, onclose, tabId, tabName }: Props = $props();

  // Fetch the tab's current snapshot the moment the panel opens (idempotent — a no-op after
  // the first successful fetch for this tab), so errors that happened before the panel was
  // ever open still show up. Live updates after that ride modelErrorStore's event listener.
  $effect(() => {
    if (open && tabId) modelErrorStore.ensureLoaded(tabId);
  });

  // Re-derive on every tick while open — modelErrorStore's SvelteMap is reactive, so this
  // recomputes automatically as hook-driven updates land.
  const summaries = $derived(tabId ? modelErrorStore.getForTab(tabId) : []);
  const expanded = new SvelteSet<string>();

  function toggleExpanded(model: string) {
    if (expanded.has(model)) expanded.delete(model);
    else expanded.add(model);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }

  function errorTotal(s: ModelErrorSummary): number {
    return Object.values(s.errors_by_class).reduce((a, n) => a + n, 0);
  }

  function errorRatePct(s: ModelErrorSummary): string {
    if (!s.turns) return '—';
    return `${((errorTotal(s) / s.turns) * 100).toFixed(1)}%`;
  }

  function severity(s: ModelErrorSummary): 'clean' | 'warn' {
    return errorTotal(s) === 0 && s.tool_errors === 0 ? 'clean' : 'warn';
  }

  /** Sorted error-class breakdown, highest count first, for the expanded row. */
  function classBreakdown(s: ModelErrorSummary): [string, number][] {
    return Object.entries(s.errors_by_class).sort((a, b) => b[1] - a[1]);
  }
</script>

{#if open}
  <div class="backdrop" onclick={handleBackdropClick} onkeydown={handleKeydown} role="dialog" aria-modal="true" tabindex="-1">
    <div class="modal">
      <div class="header">
        <h2>Model Errors{tabName ? ` — ${tabName}` : ''}</h2>
        <IconButton tooltip="Close" style="font-size: 1.538rem;padding:4px 8px;width:auto;height:auto" onclick={onclose}>&times;</IconButton>
      </div>

      <div class="content">
        {#if !tabId}
          <p class="empty">No active tab.</p>
        {:else if summaries.length === 0}
          <p class="empty">No model activity observed yet for this tab's session.</p>
        {:else}
          <ul class="list">
            {#each summaries as s (s.model)}
              <li class="row">
                <button class="row-header" onclick={() => toggleExpanded(s.model)} aria-expanded={expanded.has(s.model)}>
                  <span class="dot {severity(s)}" aria-hidden="true"></span>
                  <span class="model-family">{s.family}</span>
                  <span class="stat" title="Assistant turns">{s.turns} turns</span>
                  <span class="stat error-rate {severity(s)}" title="Errors / turns">{errorRatePct(s)}</span>
                  <span class="chevron" class:open={expanded.has(s.model)}>&#9656;</span>
                </button>
                {#if expanded.has(s.model)}
                  <div class="detail">
                    <div class="detail-stats">
                      <span>Model id: <code>{s.model}</code></span>
                      <span>Tool calls: {s.tool_calls}</span>
                      <span>Tool errors: {s.tool_errors}</span>
                      <span>Retry events: {s.retry_events}</span>
                    </div>
                    {#if classBreakdown(s).length === 0}
                      <p class="empty small">No error-class events observed.</p>
                    {:else}
                      <ul class="classes">
                        {#each classBreakdown(s) as [cls, count] (cls)}
                          <li>
                            <span class="class-name">{cls}</span>
                            <span class="class-count">{count}</span>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: var(--bg-medium);
    border: 1px solid var(--bg-light);
    border-radius: 8px;
    width: 560px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--bg-light);
    flex-shrink: 0;
  }

  h2 {
    margin: 0;
    font-size: 1.231rem;
    font-weight: 600;
    color: var(--fg);
  }

  .content {
    padding: 12px 16px;
    overflow-y: auto;
  }

  .empty {
    margin: 8px 4px;
    font-size: 0.923rem;
    color: var(--fg-dim);
    line-height: 1.5;
  }

  .empty.small {
    margin: 8px 12px;
    font-size: 0.846rem;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .row {
    border: 1px solid var(--bg-light);
    border-radius: 6px;
    overflow: hidden;
  }

  .row-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: var(--fg);
    font: inherit;
  }

  .row-header:hover {
    background: var(--bg-light);
  }

  .dot {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .dot.clean {
    background: #9ece6a;
  }

  .dot.warn {
    background: #f7768e;
  }

  .model-family {
    flex-shrink: 0;
    font-weight: 600;
    font-size: 0.846rem;
  }

  .stat {
    flex-shrink: 0;
    font-size: 0.769rem;
    color: var(--fg-dim);
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  .error-rate {
    margin-left: auto;
    font-weight: 600;
  }

  .error-rate.warn {
    color: #f7768e;
  }

  .error-rate.clean {
    color: var(--fg-dim);
  }

  .chevron {
    flex-shrink: 0;
    color: var(--fg-dim);
    font-size: 0.7rem;
    transition: transform 0.15s ease;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .detail {
    border-top: 1px solid var(--bg-light);
    background: var(--bg-dark);
    padding: 8px 10px;
  }

  .detail-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 0.769rem;
    color: var(--fg-dim);
    margin-bottom: 6px;
  }

  .detail-stats code {
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--fg);
  }

  .classes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .classes li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    font-size: 0.769rem;
    line-height: 1.4;
  }

  .class-name {
    color: var(--fg);
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  .class-count {
    flex-shrink: 0;
    color: #f7768e;
    font-weight: 600;
  }
</style>
