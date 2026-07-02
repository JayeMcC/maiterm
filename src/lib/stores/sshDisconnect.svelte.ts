/**
 * Tracks SSH sessions that dropped *unexpectedly* (network outage), as opposed
 * to a clean user-initiated logout. Drives the per-tab "disconnected" badge in
 * TerminalTabs, which the user can click to reconnect.
 *
 * Detection lives in TerminalPane.svelte (exit-code 255 via OSC 133, with an
 * ssh stderr-phrase fallback). This store only holds the resulting state +
 * the context needed to reconnect.
 */
import { SvelteMap } from 'svelte/reactivity';

export interface DisconnectInfo {
  /** Hostname for display (parsed from the ssh command), if known. */
  host: string | null;
  /** Cleaned ssh command (bare "user@host [flags]") to replay on reconnect. */
  sshCommand: string | null;
  /** Remote cwd to cd into on reconnect, if known. */
  remoteCwd: string | null;
  /** Remote (Claude-set) title at the moment of the drop, preserved on the tab. */
  title: string | null;
  /** Timestamp of the drop (ms). */
  at: number;
}

function createSshDisconnectStore() {
  // Reactive: read via `.has()`/`.get()` in tab-list templates through isDisconnected/getInfo.
  const disconnected = new SvelteMap<string, DisconnectInfo>();

  return {
    /** Reactive accessor — reading this in a template/`$derived` tracks changes. */
    get map() {
      return disconnected;
    },

    isDisconnected(tabId: string): boolean {
      return disconnected.has(tabId);
    },

    getInfo(tabId: string): DisconnectInfo | undefined {
      return disconnected.get(tabId);
    },

    mark(tabId: string, info: DisconnectInfo) {
      disconnected.set(tabId, info);
    },

    clear(tabId: string) {
      disconnected.delete(tabId);
    },
  };
}

export const sshDisconnectStore = createSshDisconnectStore();
