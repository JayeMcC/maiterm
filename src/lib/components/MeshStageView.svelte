<script lang="ts">
  import { tick } from 'svelte';
  import { agentMeshStore } from '$lib/stores/agentMesh.svelte';
  import { claudeStateStore } from '$lib/stores/agentState.svelte';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';

  interface Props { workspaceId: string; }
  let { workspaceId }: Props = $props();

  // Members of this mesh workspace (reactive on mesh + agent-state changes).
  const members = $derived.by(() => { void agentMeshStore.version; return agentMeshStore.rosterForWorkspace(workspaceId); });
  const slots = $derived.by(() => { void agentMeshStore.version; return agentMeshStore.stageSlots(workspaceId); });
  const filmstrip = $derived(members.filter((m) => m.tabId !== slots.left && m.tabId !== slots.right));

  const roleOf = $derived((tabId: string | null) => members.find((m) => m.tabId === tabId)?.role ?? '');

  // After the slot divs render (or recompose), tell the flat TerminalPanes to (re)attach.
  // The portal matches data-terminal-slot={tabId}; firing terminal-slot-ready re-homes a
  // terminal whenever its slot appears or moves (stage ⇄ filmstrip).
  $effect(() => {
    const ids = [slots.left, slots.right, ...filmstrip.map((m) => m.tabId)].filter(Boolean) as string[];
    tick().then(() => {
      for (const id of ids) window.dispatchEvent(new CustomEvent('terminal-slot-ready', { detail: { tabId: id } }));
    });
  });

  function promote(tabId: string, e: MouseEvent) {
    agentMeshStore.promoteToStage(workspaceId, tabId, e.shiftKey ? 'right' : 'left');
  }
  function exit() {
    agentMeshStore.toggleStageView(workspaceId);
  }
  function dotColor(tabId: string | null): 'accent' | 'green' | 'dim' {
    if (!tabId) return 'dim';
    const cs = claudeStateStore.getState(tabId);
    return cs?.state === 'active' ? 'accent' : cs ? 'green' : 'dim';
  }
</script>

<div class="stage-view">
  <div class="stage-row">
    {#each (['left', 'right'] as const) as side}
      {@const tabId = slots[side]}
      <div class="stage-panel">
        <div class="panel-label">
          <StatusDot color={dotColor(tabId)} pulse={dotColor(tabId) === 'accent'} />
          <span>{tabId ? roleOf(tabId) : `${side} — click a tile below`}</span>
          <span class="side-tag">{side}</span>
        </div>
        <div class="stage-slot" data-terminal-slot={tabId ?? `__mesh_empty_${side}`}>
          {#if !tabId}<div class="slot-empty">Click a filmstrip tile to stage it{side === 'right' ? ' (Shift+click for the right panel)' : ''}.</div>{/if}
        </div>
      </div>
    {/each}
  </div>

  <div class="filmstrip">
    <button class="exit-btn" onclick={exit} title="Exit stage view — back to normal splits">⤢ Exit</button>
    {#if filmstrip.length === 0}
      <div class="strip-empty">{members.length === 0 ? 'No named agents in this mesh yet — name an agent tab to add it.' : 'All agents are on stage.'}</div>
    {/if}
    {#each filmstrip as m (m.tabId)}
      <button
        class="tile"
        onclick={(e) => promote(m.tabId, e)}
        title="Click → left panel · Shift+click → right panel"
      >
        <div class="tile-term" data-terminal-slot={m.tabId}></div>
        <div class="tile-overlay">
          <StatusDot color={dotColor(m.tabId)} pulse={dotColor(m.tabId) === 'accent'} />
          <span class="tile-role">{m.role}</span>
        </div>
      </button>
    {/each}
  </div>
</div>

<style>
  .stage-view { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-dark); }
  .stage-row { flex: 1; display: flex; min-height: 0; gap: 1px; }
  .stage-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: var(--bg-dark); }
  .panel-label {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 10px; font-size: 11px; color: var(--fg);
    background: var(--bg-medium); border-bottom: 1px solid var(--bg-light);
  }
  .panel-label .side-tag { margin-left: auto; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-dim); }
  .stage-slot { flex: 1; min-height: 0; position: relative; }
  .slot-empty {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--fg-dim); font-size: 12px; text-align: center; padding: 0 24px;
  }

  .filmstrip {
    display: flex; align-items: center; gap: 8px;
    height: 150px; padding: 8px 10px; overflow-x: auto; overflow-y: hidden;
    background: var(--bg-medium); border-top: 1px solid var(--bg-light);
  }
  .exit-btn {
    flex-shrink: 0; align-self: flex-start;
    background: none; border: 1px solid var(--bg-light); border-radius: 4px;
    color: var(--fg-dim); font-size: 11px; padding: 4px 8px; cursor: pointer;
  }
  .exit-btn:hover { color: var(--fg); border-color: var(--fg-dim); }
  .strip-empty { color: var(--fg-dim); font-size: 12px; padding-left: 8px; }

  .tile {
    flex-shrink: 0; position: relative;
    width: 200px; height: 130px; padding: 0;
    border: 1px solid var(--bg-light); border-radius: 5px; overflow: hidden;
    background: var(--bg-dark); cursor: pointer;
  }
  .tile:hover { border-color: var(--accent); }
  /* The portaled terminal renders at its own size top-left, scaled down to a thumbnail. Its
     job is "what's it doing / what color is the dot," not legibility (design §7.4). */
  .tile-term {
    position: absolute; top: 0; left: 0;
    width: 400%; height: 400%;
    transform: scale(0.25); transform-origin: top left;
    pointer-events: none;
  }
  .tile-overlay {
    position: absolute; left: 0; right: 0; bottom: 0;
    display: flex; align-items: center; gap: 5px;
    padding: 3px 6px; font-size: 10px; color: var(--fg);
    background: linear-gradient(transparent, rgba(0,0,0,0.75));
  }
  .tile-role { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
