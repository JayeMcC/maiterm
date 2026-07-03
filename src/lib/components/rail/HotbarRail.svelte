<script lang="ts">
  import { workspacesStore } from '$lib/stores/workspaces.svelte';
  import { hotbarStore } from '$lib/stores/hotbar.svelte';

  // Detection is driven by the ACTIVE tab's working directory. last_cwd is the
  // reactive field the workspaces store keeps in sync from OSC 7 (falling back
  // to the tab's restore cwd). The store dedupes unchanged dirs.
  $effect(() => {
    const tab = workspacesStore.activeTab;
    const cwd = tab?.last_cwd ?? tab?.restore_cwd ?? null;
    void hotbarStore.refresh(cwd);
  });

  const open = $derived(hotbarStore.visible && !hotbarStore.collapsed);
</script>

<!-- Folds away entirely (width 0) when no section is detected; a thin strip
     with a re-open chevron remains when collapsed but detections exist. -->
{#if hotbarStore.visible}
  <div class="rail" class:collapsed={hotbarStore.collapsed} class:open>
    {#if hotbarStore.collapsed}
      <button class="rail-reopen" title="Show hotbar" onclick={() => hotbarStore.toggleCollapsed()}>‹</button>
    {:else}
      <div class="rail-inner">
        <div class="rail-head">
          <span class="rail-title">Hotbar</span>
          <button class="rail-collapse" title="Collapse" onclick={() => hotbarStore.toggleCollapsed()}>›</button>
        </div>

        {#each hotbarStore.sections as section (section.provider.marker)}
          <section class="rail-section">
            <header class="section-head">{section.provider.label}</header>

            {#if section.error}
              <p class="section-error" title={section.error}>{section.error}</p>
            {:else if section.items.length === 0}
              <p class="section-empty">No items</p>
            {:else}
              <div class="section-items">
                {#each section.items as item (item.label)}
                  <button
                    class="rail-item"
                    class:container={item.executionContext === 'container'}
                    class:firing={section.firing === item.label}
                    disabled={section.firing !== null}
                    title={item.executionContext ? `${item.label} (${item.executionContext})` : item.label}
                    onclick={() => hotbarStore.fire(section, item)}
                  >
                    {item.label}
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .rail {
    flex: 0 0 auto;
    height: 100%;
    border-left: 1px solid var(--border-color, #2a2a2a);
    background: var(--panel-bg, #1a1a1a);
    overflow: hidden;
    transition: width 0.15s ease;
    width: 220px;
  }
  .rail.collapsed {
    width: 20px;
  }
  .rail-inner {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 220px;
    overflow-y: auto;
  }
  .rail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-color, #2a2a2a);
  }
  .rail-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted, #888);
  }
  .rail-collapse,
  .rail-reopen {
    background: none;
    border: none;
    color: var(--text-muted, #888);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 2px 4px;
  }
  .rail-reopen {
    width: 20px;
    height: 100%;
  }
  .rail-collapse:hover,
  .rail-reopen:hover {
    color: var(--text-color, #ddd);
  }
  .rail-section {
    padding: 6px 8px;
  }
  .section-head {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted, #999);
    margin-bottom: 4px;
  }
  .section-items {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .rail-item {
    text-align: left;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border-color, #333);
    background: var(--button-bg, #242424);
    color: var(--text-color, #ddd);
    font-size: 12px;
    cursor: pointer;
  }
  .rail-item:hover:not(:disabled) {
    background: var(--button-hover-bg, #303030);
  }
  .rail-item:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .rail-item.container {
    border-left: 2px solid var(--accent, #4a9eff);
  }
  .rail-item.firing {
    opacity: 0.6;
  }
  .section-error {
    font-size: 11px;
    color: var(--error-color, #e06c75);
    margin: 2px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .section-empty {
    font-size: 11px;
    color: var(--text-muted, #777);
    margin: 2px 0;
  }
</style>
