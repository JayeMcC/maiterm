<script lang="ts">
  // Follows the ChangelogModal.svelte backdrop/escape/close pattern.
  // Dumb modal: collects a free-text bug description; the parent captures the
  // diagnostics snapshot (at open) and files the report on submit.
  import IconButton from '$lib/components/ui/IconButton.svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
    onsubmit: (description: string) => void;
    /** True while the parent is filing — disables the form + shows progress. */
    submitting?: boolean;
    /** Short note about the captured snapshot, shown under the textarea. */
    snapshotNote?: string;
  }

  let { open, onclose, onsubmit, submitting = false, snapshotNote }: Props = $props();

  let description = $state('');
  let textarea = $state<HTMLTextAreaElement | null>(null);

  // Reset + focus each time the modal opens.
  $effect(() => {
    if (open) {
      description = '';
      // Focus after the element mounts.
      queueMicrotask(() => textarea?.focus());
    }
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onclose();
      return;
    }
    // Cmd/Ctrl+Enter submits from within the textarea.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget && !submitting) {
      onclose();
    }
  }

  function submit() {
    if (submitting) return;
    onsubmit(description);
  }
</script>

{#if open}
  <div class="backdrop" onclick={handleBackdropClick} onkeydown={handleKeydown} role="dialog" aria-modal="true" aria-label="Report a bug" tabindex="-1">
    <div class="modal">
      <div class="header">
        <h2>Report a bug</h2>
        <IconButton tooltip="Close" style="font-size: 1.538rem;padding:4px 8px;width:auto;height:auto" onclick={onclose}>&times;</IconButton>
      </div>

      <div class="content">
        <label class="field-label" for="bug-desc">What's going wrong?</label>
        <textarea
          id="bug-desc"
          bind:this={textarea}
          bind:value={description}
          onkeydown={handleKeydown}
          placeholder="Describe what happened, what you expected, and any steps to reproduce…"
          rows="6"
          disabled={submitting}></textarea>
        <p class="hint">
          A snapshot of the app's current state is attached automatically.
          {#if snapshotNote}<span class="snap">{snapshotNote}</span>{/if}
        </p>
      </div>

      <div class="footer">
        <button class="btn secondary" onclick={onclose} disabled={submitting}>Cancel</button>
        <button class="btn" onclick={submit} disabled={submitting}>
          {submitting ? 'Filing…' : 'File bug report'}
        </button>
        <span class="hint kbd-hint">⌘↵ to file</span>
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
    width: 480px;
    max-width: 90vw;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--bg-light);
  }

  h2 {
    margin: 0;
    font-size: 1.231rem;
    font-weight: 600;
    color: var(--fg);
  }

  .content {
    padding: 16px 20px;
  }

  .field-label {
    display: block;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--fg-dim);
    margin-bottom: 8px;
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    background: var(--bg-dark);
    color: var(--fg);
    border: 1px solid var(--bg-light);
    border-radius: 4px;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 0.95rem;
    line-height: 1.5;
  }

  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  textarea:disabled {
    opacity: 0.6;
  }

  .hint {
    margin: 8px 0 0 0;
    font-size: 0.769rem;
    color: var(--fg-dim);
  }

  .snap {
    display: block;
    margin-top: 4px;
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--fg-dim);
    opacity: 0.8;
    word-break: break-all;
  }

  .footer {
    padding: 12px 20px;
    border-top: 1px solid var(--bg-light);
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .btn {
    font-size: 0.923rem;
    font-weight: 600;
    padding: 6px 16px;
    border: none;
    border-radius: 4px;
    background: var(--accent);
    color: var(--bg-dark);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .btn:hover:not(:disabled) {
    filter: brightness(1.15);
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .btn.secondary {
    background: var(--bg-light);
    color: var(--fg);
  }

  .btn.secondary:hover:not(:disabled) {
    filter: brightness(1.3);
  }

  .kbd-hint {
    margin: 0;
    margin-left: auto;
  }
</style>
