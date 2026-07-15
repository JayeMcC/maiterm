import { terminalsStore } from '$lib/stores/terminals.svelte';
import { workspacesStore, navigateToTab } from '$lib/stores/workspaces.svelte';
import { preferencesStore } from '$lib/stores/preferences.svelte';
import { toastStore } from '$lib/stores/toasts.svelte';
import { getPtyInfo, writeTerminal } from '$lib/tauri/commands';
import { error as logError } from '@tauri-apps/plugin-log';

/** Dedicated tab name — repeated runs reuse this tab instead of piling up new ones. */
export const REPORT_CHANGES_TAB_NAME = 'report-changes';

function encodeForPty(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Run the configured cursor-agent report+apply command against the source
 * terminal's cwd, in a dedicated `report-changes` tab in the same pane.
 *
 * The command is prefixed with `cd <cwd> &&` so a reused tab (whose shell may
 * be sitting in an older directory) always targets the clicked tab's repo.
 * cursor-agent runs locally, so tabs with a live SSH session are rejected.
 */
export async function runReportAndApply(workspaceId: string, paneId: string, tabId: string) {
  try {
    const instance = terminalsStore.get(tabId);
    if (!instance) {
      toastStore.addToast('Report + Apply', 'No running terminal on this tab', 'error');
      return;
    }

    const ptyInfo = await getPtyInfo(instance.ptyId);
    if (ptyInfo.foreground_command) {
      toastStore.addToast('Report + Apply', 'This tab is in an SSH session — cursor-agent runs locally', 'error');
      return;
    }
    if (!ptyInfo.cwd) {
      toastStore.addToast('Report + Apply', 'Could not determine the terminal cwd', 'error');
      return;
    }

    const command = `cd ${shellQuote(ptyInfo.cwd)} && ${preferencesStore.cursorReportApplyCommand}`;

    const ws = workspacesStore.workspaces.find((w) => w.id === workspaceId);
    const pane = ws?.panes.find((p) => p.id === paneId);
    const existing = pane?.tabs.find((t) => t.tab_type === 'terminal' && t.name === REPORT_CHANGES_TAB_NAME);

    if (existing) {
      await navigateToTab(existing.id);
      const live = terminalsStore.get(existing.id);
      if (live) {
        // Ctrl-C first so a still-running agent is interrupted before the new
        // command lands (same semantics as the MCP openTab reuse path).
        await writeTerminal(live.ptyId, encodeForPty('\x03'));
        await new Promise((r) => setTimeout(r, 50));
        await writeTerminal(live.ptyId, encodeForPty(command + '\n'));
      } else {
        // Suspended: queue take-once; the mount hook delivers it when the
        // navigation above resumes the tab.
        terminalsStore.setPendingCommand(existing.id, command);
      }
      return;
    }

    const tab = await workspacesStore.createTab(workspaceId, paneId, REPORT_CHANGES_TAB_NAME);
    // Override the inherited split context: spawn locally at the source tab's
    // cwd, never replaying a persisted SSH command over the queued cursor run.
    terminalsStore.setSplitContext(tab.id, { cwd: ptyInfo.cwd, sshCommand: null, remoteCwd: null });
    terminalsStore.setPendingCommand(tab.id, command);
  } catch (e) {
    logError(`Report + apply failed: ${e}`);
    toastStore.addToast('Report + Apply', String(e), 'error');
  }
}
