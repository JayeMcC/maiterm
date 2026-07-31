<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { subagentStore, type SubagentSession, type SubagentState } from '$lib/stores/subagents.svelte';

  /**
   * Live view of every subagent (Task-tool fan-out) the active tab's agent has
   * spawned — running / done / failed, its current or last tool, and an expandable
   * trail of the tool calls it made. Backed by `subagentStore` (SubagentStart/Stop +
   * agent_id-tagged PreToolUse/PostToolUse — see claude_code/CLAUDE.md § Subagent
   * tracking). Follows the ChangelogModal.svelte backdrop/escape/close pattern.
   */

  interface Props {
    open: boolean;
    onclose: () => void;
    tabId: string | null;
    tabName?: string;
  }

  let { open, onclose, tabId, tabName }: Props = $props();

  // Re-derive on every tick while open — subagentStore's SvelteMap is reactive, so
  // this recomputes automatically as hook events land.
  const subagents = $derived(tabId ? subagentStore.getForTab(tabId) : []);
  const expanded = new SvelteSet<string>();

  function toggleExpanded(agentId: string) {
    if (expanded.has(agentId)) expanded.delete(agentId);
    else expanded.add(agentId);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }

  function stateLabel(state: SubagentState): string {
    if (state === 'running') return 'Running';
    if (state === 'done') return 'Done';
    return 'Failed';
  }

  function relativeTime(ms: number): string {
    const deltaS = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (deltaS < 60) return `${deltaS}s ago`;
    const deltaM = Math.round(deltaS / 60);
    if (deltaM < 60) return `${deltaM}m ago`;
    return `${Math.round(deltaM / 60)}h ago`;
  }

  function currentLine(s: SubagentSession): string {
    if (s.toolName) return s.toolDetail ? `${s.toolName}: ${s.toolDetail}` : s.toolName;
    if (s.log.length) {
      const last = s.log[s.log.length - 1]!;
      return last.detail ? `${last.toolName}: ${last.detail}` : last.toolName;
    }
    return s.state === 'running' ? 'Starting…' : '—';
  }
</script>

{#if open}
  <div class="backdrop" onclick={handleBackdropClick} onkeydown={handleKeydown} role="dialog" aria-modal="true" tabindex="-1">
    <div class="modal">
      <div class="header">
        <h2>Subagents{tabName ? ` — ${tabName}` : ''}</h2>
        <IconButton tooltip="Close" style="font-size: 1.538rem;padding:4px 8px;width:auto;height:auto" onclick={onclose}>&times;</IconButton>
      </div>

      <div class="content">
        {#if !tabId}
          <p class="empty">No active tab.</p>
        {:else if subagents.length === 0}
          <p class="empty">No subagents spawned by this tab yet. They show up here the moment the agent uses the Task tool.</p>
        {:else}
          <ul class="list">
            {#each subagents as sub (sub.agentId)}
              <li class="row">
                <button class="row-header" onclick={() => toggleExpanded(sub.agentId)} aria-expanded={expanded.has(sub.agentId)}>
                  <span class="dot {sub.state}" aria-hidden="true"></span>
                  <span class="agent-type">{sub.agentType}</span>
                  <span class="state-label {sub.state}">{stateLabel(sub.state)}</span>
                  <span class="detail" title={currentLine(sub)}>{currentLine(sub)}</span>
                  <span class="chevron" class:open={expanded.has(sub.agentId)}>&#9656;</span>
                </button>
                {#if expanded.has(sub.agentId)}
                  <div class="log">
                    {#if sub.log.length === 0}
                      <p class="empty small">No tool calls logged yet.</p>
                    {:else}
                      <ul>
                        {#each sub.log.slice().reverse() as entry, i (sub.log.length - i)}
                          <li>
                            <span class="log-tool">{entry.toolName}</span>
                            {#if entry.detail}<span class="log-detail">{entry.detail}</span>{/if}
                            <span class="log-time">{relativeTime(entry.atMs)}</span>
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
    width: 520px;
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

  .dot.running {
    background: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
    animation: pulse 1.4s ease-in-out infinite;
  }

  .dot.done {
    background: #9ece6a;
  }

  .dot.failed {
    background: #f7768e;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  .agent-type {
    flex-shrink: 0;
    font-weight: 600;
    font-size: 0.846rem;
  }

  .state-label {
    flex-shrink: 0;
    font-size: 0.692rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--fg-dim);
  }

  .state-label.running {
    color: var(--accent);
  }

  .state-label.failed {
    color: #f7768e;
  }

  .detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.846rem;
    color: var(--fg-dim);
    font-family: var(--font-mono, ui-monospace, monospace);
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

  .log {
    border-top: 1px solid var(--bg-light);
    background: var(--bg-dark);
    max-height: 220px;
    overflow-y: auto;
  }

  .log ul {
    list-style: none;
    margin: 0;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .log li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 0.769rem;
    line-height: 1.4;
  }

  .log-tool {
    flex-shrink: 0;
    font-weight: 600;
    color: var(--fg);
  }

  .log-detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-dim);
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  .log-time {
    flex-shrink: 0;
    color: var(--fg-dim);
    font-size: 0.692rem;
  }
</style>
