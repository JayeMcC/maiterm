<script lang="ts">
  import { workspacesStore } from '$lib/stores/workspaces.svelte';
  import { commsListBotChannels } from '$lib/tauri/commands';
  import type { BotChannel, CommsMonitorChannel } from '$lib/tauri/types';
  import { error as logError } from '@tauri-apps/plugin-log';

  interface Props {
    open: boolean;
    workspaceId: string | null;
    paneId: string | null;
    tabId: string | null;
    onclose: () => void;
  }

  let { open, workspaceId, paneId, tabId, onclose }: Props = $props();

  let channels = $state<BotChannel[]>([]);
  let selected = $state<Set<string>>(new Set());
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);
  let busy = $state(false);

  const tab = $derived.by(() => {
    if (!workspaceId || !paneId || !tabId) return null;
    return workspacesStore.workspaces
      .find(w => w.id === workspaceId)?.panes
      .find(p => p.id === paneId)?.tabs
      .find(t => t.id === tabId) ?? null;
  });
  const wasEnabled = $derived(!!tab?.comms_monitor);

  // (Re)load the channel list each time the modal opens; pre-check current config.
  $effect(() => {
    if (!open) return;
    loading = true;
    errorMsg = null;
    channels = [];
    selected = new Set(tab?.comms_monitor?.channels.map(c => c.id) ?? []);
    (async () => {
      try {
        channels = await commsListBotChannels();
        if (channels.length === 0) {
          errorMsg = 'The bot is not a member of any channel — add it to the channels it should watch in Mattermost.';
        }
      } catch (e) {
        errorMsg = String(e);
        logError(`[comms] channel list failed: ${e}`);
      } finally {
        loading = false;
      }
    })();
  });

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  async function save() {
    if (!workspaceId || !paneId || !tabId) return;
    busy = true;
    try {
      const picked: CommsMonitorChannel[] = channels
        .filter(c => selected.has(c.id))
        .map(c => ({ id: c.id, name: c.display_name, team_name: c.team_name, last_seen_create_at: 0 }));
      await workspacesStore.setTabCommsMonitor(workspaceId, paneId, tabId, picked.length > 0 ? picked : null);
      onclose();
    } catch (e) {
      errorMsg = String(e);
    } finally {
      busy = false;
    }
  }

  async function disable() {
    if (!workspaceId || !paneId || !tabId) return;
    busy = true;
    try {
      await workspacesStore.setTabCommsMonitor(workspaceId, paneId, tabId, null);
      onclose();
    } catch (e) {
      errorMsg = String(e);
    } finally {
      busy = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onclose();
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="backdrop"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="palette">
      <div class="header">
        <div class="title">Chat Monitoring</div>
        <div class="subtitle">
          Pick the channels this tab listens to. When a pickup-authorized user
          @mentions the bot in one of them, the thread is assigned to
          {#if tab}<strong>{tab.name}</strong>{:else}this tab{/if} and injected into its
          agent session. Only channels the bot is a member of appear here.
        </div>
      </div>
      <div class="body">
        {#if loading}
          <p class="status">Loading channels…</p>
        {:else if errorMsg}
          <p class="status error">{errorMsg}</p>
        {:else}
          {#each channels as ch (ch.id)}
            <label class="channel-row">
              <input
                type="checkbox"
                checked={selected.has(ch.id)}
                onchange={() => toggle(ch.id)}
              />
              <span class="channel-name">{ch.display_name}</span>
              <span class="channel-team">{ch.team_display_name}</span>
            </label>
          {/each}
        {/if}
      </div>
      <div class="footer">
        {#if wasEnabled}
          <button class="btn btn-danger" onclick={disable} disabled={busy}>Disable monitoring</button>
        {/if}
        <div class="spacer"></div>
        <button class="btn" onclick={onclose} disabled={busy}>Cancel</button>
        <button
          class="btn btn-primary"
          onclick={save}
          disabled={busy || loading || (selected.size === 0 && !wasEnabled)}
        >{selected.size === 0 && wasEnabled ? 'Disable' : 'Save'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    padding-top: 15vh;
    z-index: 1000;
  }

  .palette {
    background: var(--bg-medium);
    border: 1px solid var(--bg-light);
    border-radius: 8px;
    width: 460px;
    max-height: 480px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    align-self: flex-start;
  }

  .header {
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--bg-light);
  }

  .title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--fg);
  }

  .subtitle {
    margin-top: 3px;
    font-size: 0.8rem;
    color: var(--fg-dim);
    line-height: 1.4;
  }

  .subtitle strong {
    color: var(--accent);
    font-weight: 600;
  }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 6px;
  }

  .status {
    padding: 12px;
    font-size: 0.85rem;
    color: var(--fg-dim);
  }

  .status.error {
    color: var(--error, #f7768e);
  }

  .channel-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.88rem;
    color: var(--fg);
  }

  .channel-row:hover {
    background: var(--bg-light);
  }

  .channel-row input {
    accent-color: var(--accent);
  }

  .channel-name {
    flex: 1;
  }

  .channel-team {
    font-size: 0.75rem;
    color: var(--fg-dim);
  }

  .footer {
    display: flex;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--bg-light);
  }

  .spacer {
    flex: 1;
  }

  .btn {
    padding: 5px 14px;
    border-radius: 6px;
    border: 1px solid var(--bg-light);
    background: var(--bg-dark);
    color: var(--fg);
    font-size: 0.85rem;
    cursor: pointer;
  }

  .btn:hover:not(:disabled) {
    background: var(--bg-light);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-dark);
  }

  .btn-danger {
    color: var(--error, #f7768e);
    border-color: var(--error, #f7768e);
  }
</style>
