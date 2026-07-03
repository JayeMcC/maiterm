<script lang="ts">
  import { workspacesStore } from '$lib/stores/workspaces.svelte';
  import { hotbarStore } from '$lib/stores/hotbar.svelte';

  // Detection is driven by the ACTIVE tab's working directory. last_cwd is the
  // reactive field the workspaces store keeps in sync from OSC 7 (falling back
  // to the tab's restore cwd). The store dedupes unchanged dirs.
  // Re-target on every active-tab change (switching tabs OR workspaces). Reads
  // the tab identity + pty so the store can resolve the REAL process cwd
  // (OSC-independent) rather than trusting last_cwd, which goes stale on idle
  // tabs whose prompt doesn't emit OSC 7.
  $effect(() => {
    const tab = workspacesStore.activeTab;
    const tabId = tab?.id ?? null;
    const ptyId = tab?.pty_id ?? null;
    const fallback = tab?.last_cwd ?? tab?.restore_cwd ?? null;
    void hotbarStore.refreshForTab(tabId, ptyId, fallback);
  });

  // Poll container status only while the rail is open and a devcontainer is
  // detected — live truth (ports come/go, forwards start/stop) without cost
  // when the rail is folded or there's no container.
  $effect(() => {
    if (hotbarStore.collapsed || !hotbarStore.hasContainer) return;
    const id = setInterval(() => void hotbarStore.refreshContainerStatus(), 4000);
    return () => clearInterval(id);
  });

  const open = $derived(hotbarStore.visible && !hotbarStore.collapsed);

  /** Clone/repo the section targets — the last path segment (e.g.
   *  `forwood-one_developing`), so you can see which stack the tasks fire at. */
  function targetName(dir: string): string {
    return dir.split('/').filter(Boolean).pop() ?? dir;
  }

  let forwardInput = $state('');
  function submitForward() {
    const port = Number(forwardInput.trim());
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      void hotbarStore.forwardPort(port);
      forwardInput = '';
    }
  }
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
          {@const key = section.provider.marker}
          {@const sectionCollapsed = hotbarStore.isSectionCollapsed(key)}
          <section class="rail-section">
            <button class="section-head toggle" onclick={() => hotbarStore.toggleSection(key)}>
              <span class="chevron" class:collapsed={sectionCollapsed}>▾</span>
              {section.provider.label}
            </button>
            <div class="section-target" title={section.dir}>{targetName(section.dir)}</div>

            {#if !sectionCollapsed}
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
            {/if}
          </section>
        {/each}

        {#if hotbarStore.hasContainer}
          {@const cs = hotbarStore.containerStatus}
          {@const containerCollapsed = hotbarStore.isSectionCollapsed('container')}
          <section class="rail-section">
            <button class="section-head toggle" onclick={() => hotbarStore.toggleSection('container')}>
              <span class="chevron" class:collapsed={containerCollapsed}>▾</span>
              Container
              {#if cs}
                <span class="state state-{cs.state}">{cs.state}</span>
              {/if}
            </button>

            {#if !containerCollapsed}
            {#if hotbarStore.containerError}
              <p class="section-error" title={hotbarStore.containerError}>{hotbarStore.containerError}</p>
            {/if}

            {#if cs && cs.state === 'up'}
              {#if cs.ports.length > 0}
                <div class="port-list">
                  {#each cs.ports as p (p.hostPort)}
                    <button class="port-row" title="Open {p.scheme ?? 'http'}://localhost:{p.hostPort}" onclick={() => hotbarStore.openPort(p.hostPort, p.scheme)}>
                      <span class="dot" class:live={p.listening}></span>
                      <span class="port-label">{p.service}</span>
                      <span class="port-num">:{p.hostPort}</span>
                    </button>
                  {/each}
                </div>
              {/if}

              {#each cs.listeners.filter((l) => l.forwardable) as l (l.containerPort)}
                <div class="fwd-row">
                  <span class="port-num">:{l.containerPort}</span>
                  <span class="fwd-note">in-container</span>
                  <button class="fwd-btn" disabled={hotbarStore.containerBusy === l.containerPort} onclick={() => hotbarStore.forwardPort(l.containerPort)}>Forward</button>
                </div>
              {/each}

              {#each cs.forwards as f (f.port)}
                <div class="fwd-row">
                  <span class="dot" class:live={f.running}></span>
                  <span class="port-num">:{f.port}</span>
                  <span class="fwd-note">forwarded</span>
                  <button class="fwd-btn stop" disabled={hotbarStore.containerBusy === f.port} onclick={() => hotbarStore.unforwardPort(f.port)}>Stop</button>
                </div>
              {/each}

              <div class="fwd-row manual">
                <input class="fwd-input" type="text" inputmode="numeric" placeholder="port…" bind:value={forwardInput} onkeydown={(e) => e.key === 'Enter' && submitForward()} />
                <button class="fwd-btn" onclick={submitForward}>Forward</button>
              </div>
            {:else if cs && cs.state === 'down'}
              <p class="section-empty">Container down — spin up dev servers</p>
            {:else if cs && cs.state === 'runtime-unavailable'}
              <p class="section-empty">Docker not running</p>
            {/if}
            {/if}
          </section>
        {/if}
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
  .section-head.toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    background: none;
    border: none;
    padding: 2px 0;
    cursor: pointer;
    text-align: left;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .section-head.toggle:hover {
    color: var(--text-color, #ddd);
  }
  .chevron {
    font-size: 12px;
    line-height: 1;
    transition: transform 0.12s ease;
  }
  .section-target {
    font-size: 11px;
    color: var(--accent, #4a9eff);
    margin: 0 0 5px 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .chevron.collapsed {
    transform: rotate(-90deg);
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

  .state {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 3px;
    text-transform: uppercase;
  }
  .state-up {
    background: var(--success-bg, #1f3a24);
    color: var(--success, #6bd08a);
  }
  .state-down {
    background: var(--warn-bg, #3a2f1f);
    color: var(--warn, #d0a86b);
  }
  .state-runtime-unavailable {
    background: var(--error-bg, #3a1f1f);
    color: var(--error-color, #e06c75);
  }
  .port-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .port-row,
  .fwd-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .port-row {
    text-align: left;
    padding: 3px 6px;
    border: none;
    background: none;
    color: var(--text-color, #ddd);
    cursor: pointer;
    border-radius: 4px;
  }
  .port-row:hover {
    background: var(--button-hover-bg, #303030);
  }
  .fwd-row {
    padding: 3px 6px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-muted, #555);
    flex: 0 0 auto;
  }
  .dot.live {
    background: var(--success, #6bd08a);
  }
  .port-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .port-num {
    color: var(--text-muted, #9a9a9a);
    font-variant-numeric: tabular-nums;
  }
  .fwd-note {
    flex: 1;
    font-size: 10px;
    color: var(--text-muted, #777);
  }
  .fwd-btn {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid var(--border-color, #333);
    background: var(--button-bg, #242424);
    color: var(--text-color, #ddd);
    cursor: pointer;
  }
  .fwd-btn:hover:not(:disabled) {
    background: var(--button-hover-bg, #303030);
  }
  .fwd-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .fwd-btn.stop {
    border-color: var(--error-color, #6b3333);
  }
  .fwd-input {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid var(--border-color, #333);
    background: var(--input-bg, #1e1e1e);
    color: var(--text-color, #ddd);
  }
</style>
