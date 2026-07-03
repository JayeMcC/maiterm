<script lang="ts">
  import * as commands from '$lib/tauri/commands';
  import type { WindowPreset } from '$lib/tauri/types';
  import { dispatch } from '$lib/stores/notificationDispatch';
  import { error as logError } from '@tauri-apps/plugin-log';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog';
  import { workspacesStore } from '$lib/stores/workspaces.svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();

  let presets = $state<WindowPreset[]>([]);
  let loading = $state(false);
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');
  let confirmingDeleteId = $state<string | null>(null);

  $effect(() => {
    if (open) {
      renamingId = null;
      confirmingDeleteId = null;
      renameDraft = '';
      refresh();
    }
  });

  async function refresh() {
    loading = true;
    try {
      presets = await commands.listWindowPresets();
    } catch (e) {
      logError(`listWindowPresets failed: ${e}`);
      presets = [];
    } finally {
      loading = false;
    }
  }

  function workspaceCount(p: WindowPreset): number {
    return p.window.workspaces.length;
  }

  function tabCount(p: WindowPreset): number {
    let n = 0;
    for (const ws of p.window.workspaces) {
      for (const pane of ws.panes) {
        n += pane.tabs.length;
      }
    }
    return n;
  }

  function formatDate(iso: string): string {
    // Timestamps come back as strict "YYYY-MM-DDTHH:MM:SSZ" from iso_now();
    // Date can parse this natively. Fall back to raw on parse failure to
    // avoid hiding data.
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  async function handleOpen(preset: WindowPreset) {
    try {
      await commands.openWindowPreset(preset.id);
      dispatch('Preset opened', `Opening "${preset.name}"…`, 'info');
      onclose();
    } catch (e) {
      logError(`openWindowPreset failed: ${e}`);
      dispatch('Open failed', String(e), 'error');
    }
  }

  // Export the CURRENT window's arrangement to a shareable JSON file.
  async function handleExportSetup() {
    try {
      const path = await saveDialog({
        title: 'Export window setup',
        defaultPath: 'maiterm-setup.json',
        filters: [{ name: 'maiTerm setup', extensions: ['json'] }],
      });
      if (!path) return; // cancelled
      await workspacesStore.exportCurrentWindowSetup(path);
      dispatch('Setup exported', `Saved ${path.split('/').pop()}`, 'success');
    } catch (e) {
      logError(`exportWindowSetup failed: ${e}`);
      dispatch('Export failed', String(e), 'error');
    }
  }

  // Import a setup JSON file → new preset → open it.
  async function handleImportSetup() {
    try {
      const path = await openDialog({
        title: 'Import window setup',
        multiple: false,
        filters: [{ name: 'maiTerm setup', extensions: ['json'] }],
      });
      if (!path || typeof path !== 'string') return; // cancelled
      const preset = await workspacesStore.importSetupAndOpen(path);
      dispatch('Setup imported', `Opening "${preset.name}"…`, 'success');
      onclose();
    } catch (e) {
      logError(`importWindowSetup failed: ${e}`);
      dispatch('Import failed', String(e), 'error');
    }
  }

  function startRename(preset: WindowPreset) {
    renamingId = preset.id;
    renameDraft = preset.name;
    confirmingDeleteId = null;
  }

  async function commitRename() {
    if (!renamingId) return;
    const newName = renameDraft.trim();
    const id = renamingId;
    if (!newName) {
      renamingId = null;
      return;
    }
    try {
      await commands.renameWindowPreset(id, newName);
      renamingId = null;
      await refresh();
    } catch (e) {
      logError(`renameWindowPreset failed: ${e}`);
      dispatch('Rename failed', String(e), 'error');
    }
  }

  function cancelRename() {
    renamingId = null;
    renameDraft = '';
  }

  function requestDelete(preset: WindowPreset) {
    confirmingDeleteId = preset.id;
    renamingId = null;
  }

  async function commitDelete(id: string) {
    try {
      await commands.deleteWindowPreset(id);
      confirmingDeleteId = null;
      await refresh();
    } catch (e) {
      logError(`deleteWindowPreset failed: ${e}`);
      dispatch('Delete failed', String(e), 'error');
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (renamingId) {
        cancelRename();
        return;
      }
      if (confirmingDeleteId) {
        confirmingDeleteId = null;
        return;
      }
      onclose();
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }
</script>

{#if open}
  <div class="backdrop" onclick={handleBackdropClick} onkeydown={handleKeydown} role="dialog" aria-modal="true" tabindex="-1">
    <div class="modal">
      <div class="header">
        <h2>Window Presets</h2>
        <IconButton tooltip="Close" style="font-size: 1.538rem;padding:4px 8px;width:auto;height:auto" onclick={onclose}>&times;</IconButton>
      </div>

      <div class="content">
        {#if loading}
          <div class="empty">Loading…</div>
        {:else if presets.length === 0}
          <div class="empty">
            No saved presets yet. Save one from the sidebar or via
            <em>Window → Save Current Window as Preset…</em>
          </div>
        {:else}
          <ul class="preset-list">
            {#each presets as p (p.id)}
              <li class="preset-item">
                <div class="preset-row">
                  {#if renamingId === p.id}
                    <!-- svelte-ignore a11y_autofocus -->
                    <input class="rename-input" type="text" bind:value={renameDraft} onkeydown={handleRenameKeydown} onblur={commitRename} autofocus />
                  {:else}
                    <div class="preset-name-block">
                      <span class="preset-name">{p.name}</span>
                      <span class="preset-meta">
                        {workspaceCount(p)} workspace{workspaceCount(p) === 1 ? '' : 's'},
                        {tabCount(p)} tab{tabCount(p) === 1 ? '' : 's'} · updated {formatDate(p.updated_at)}
                      </span>
                    </div>
                  {/if}

                  <div class="preset-actions">
                    {#if confirmingDeleteId === p.id}
                      <Button
                        variant="secondary"
                        onclick={() => {
                          confirmingDeleteId = null;
                        }}>Cancel</Button
                      >
                      <Button onclick={() => commitDelete(p.id)}>Delete</Button>
                    {:else if renamingId === p.id}
                      <Button variant="secondary" onclick={cancelRename}>Cancel</Button>
                      <Button onclick={commitRename}>Save</Button>
                    {:else}
                      <Button onclick={() => handleOpen(p)}>Open</Button>
                      <Button variant="secondary" onclick={() => startRename(p)}>Rename</Button>
                      <Button variant="secondary" onclick={() => requestDelete(p)}>Delete</Button>
                    {/if}
                  </div>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="footer">
        <Button variant="secondary" onclick={handleImportSetup}>Import setup…</Button>
        <Button variant="secondary" onclick={handleExportSetup}>Export current setup…</Button>
        <span style="flex:1"></span>
        <Button variant="secondary" onclick={onclose}>Close</Button>
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
    border-radius: 10px;
    width: 560px;
    max-width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--bg-light);
  }

  .header h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--fg);
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }

  .empty {
    color: var(--fg-dim);
    font-size: 0.9rem;
    line-height: 1.5;
    padding: 24px 8px;
    text-align: center;
  }

  .preset-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .preset-item {
    background: var(--bg-dark);
    border: 1px solid var(--bg-light);
    border-radius: 6px;
    padding: 10px 12px;
  }

  .preset-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .preset-name-block {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .preset-name {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preset-meta {
    font-size: 0.78rem;
    color: var(--fg-dim);
  }

  .preset-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .rename-input {
    flex: 1;
    background: var(--bg-medium);
    border: 1px solid var(--accent);
    color: var(--fg);
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 0.95rem;
    min-width: 0;
  }

  .rename-input:focus {
    outline: none;
  }

  .footer {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-end;
    padding: 12px 16px;
    border-top: 1px solid var(--bg-light);
  }
</style>
