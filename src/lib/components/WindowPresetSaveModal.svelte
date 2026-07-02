<script lang="ts">
  import { tick } from 'svelte';
  import * as commands from '$lib/tauri/commands';
  import { workspacesStore } from '$lib/stores/workspaces.svelte';
  import { dispatch } from '$lib/stores/notificationDispatch';
  import { error as logError } from '@tauri-apps/plugin-log';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();

  let name = $state('');
  let existingNames = $state<string[]>([]);
  let saving = $state(false);
  let conflictNeedsOverwrite = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);

  // Default the name to something the user can immediately overwrite: the
  // active workspace name (usually more meaningful than the internal window
  // label like "window-<uuid>") plus today's date. Refreshed each time the
  // modal opens so a stale name doesn't linger.
  $effect(() => {
    if (open) {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const label = workspacesStore.activeWorkspace?.name ?? 'Window';
      name = `${label} — ${stamp}`;
      conflictNeedsOverwrite = false;
      saving = false;
      commands
        .listWindowPresets()
        .then((list) => {
          existingNames = list.map((p) => p.name);
        })
        .catch(() => {
          existingNames = [];
        });
      tick().then(() => inputEl?.select());
    }
  });

  const trimmed = $derived(name.trim());
  const clashes = $derived(existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase()));

  async function submit() {
    if (!trimmed || saving) return;
    saving = true;
    try {
      // First attempt without overwrite so the backend can flag a name clash.
      // Only pass overwrite=true once the user has explicitly confirmed via
      // the "Overwrite" button, so we never silently clobber a preset the
      // user forgot they had.
      const overwrite = clashes && conflictNeedsOverwrite;
      await workspacesStore.saveCurrentWindowAsPreset(trimmed, overwrite);
      dispatch('Preset saved', `Window preset "${trimmed}" saved`, 'info');
      onclose();
    } catch (e) {
      const msg = String(e);
      if (msg.toLowerCase().includes('already exists')) {
        conflictNeedsOverwrite = true;
      } else {
        logError(`Save window preset failed: ${msg}`);
        dispatch('Save failed', msg, 'error');
      }
      saving = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onclose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }
</script>

{#if open}
  <div class="backdrop" onclick={handleBackdropClick} onkeydown={handleKeydown} role="dialog" aria-modal="true" tabindex="-1">
    <div class="modal">
      <div class="header">
        <h2>Save Window Preset</h2>
        <IconButton tooltip="Close" style="font-size: 1.538rem;padding:4px 8px;width:auto;height:auto" onclick={onclose}>&times;</IconButton>
      </div>

      <div class="content">
        <p class="hint">
          Captures this window's workspaces, panes, tab names, cwd, and notes as a reusable template. Terminal scrollback and live processes are not saved — restoring spawns fresh shells at the same
          paths.
        </p>

        <label class="field">
          <span class="label-text">Preset name</span>
          <input
            type="text"
            bind:value={name}
            bind:this={inputEl}
            oninput={() => {
              conflictNeedsOverwrite = false;
            }}
            placeholder="e.g. Dev stack"
          />
        </label>

        {#if clashes && !conflictNeedsOverwrite}
          <div class="warning">A preset named "{trimmed}" already exists.</div>
        {:else if conflictNeedsOverwrite}
          <div class="warning strong">Overwrite the existing "{trimmed}"?</div>
        {/if}
      </div>

      <div class="footer">
        <Button variant="secondary" onclick={onclose} disabled={saving}>Cancel</Button>
        {#if conflictNeedsOverwrite}
          <Button onclick={submit} disabled={!trimmed || saving}>
            {saving ? 'Saving…' : 'Overwrite'}
          </Button>
        {:else}
          <Button onclick={submit} disabled={!trimmed || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
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
    border-radius: 10px;
    width: 440px;
    max-width: 90vw;
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
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .hint {
    margin: 0;
    color: var(--fg-dim);
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .label-text {
    font-size: 0.85rem;
    color: var(--fg-dim);
  }

  .field input {
    background: var(--bg-dark);
    border: 1px solid var(--bg-light);
    color: var(--fg);
    padding: 8px 10px;
    border-radius: 4px;
    font-size: 0.95rem;
  }

  .field input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .warning {
    color: var(--yellow, #e0af68);
    font-size: 0.85rem;
  }

  .warning.strong {
    color: var(--red, #f7768e);
    font-weight: 600;
  }

  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--bg-light);
  }
</style>
