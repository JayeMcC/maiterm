import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import { toastStore } from './toasts.svelte';
import { terminalsStore } from './terminals.svelte';
import * as commands from '$lib/tauri/commands';
import { info as logInfo, error as logError } from '@tauri-apps/plugin-log';
import type { Update } from '@tauri-apps/plugin-updater';
import type { ChangelogEntry } from '$lib/components/ChangelogModal.svelte';

/**
 * Update checker for the personal fork's SOURCE distribution.
 *
 * The fork is distributed as source: GitHub is the source of truth, and the
 * stable line is mirrored to the shared tools Bitbucket repo as the `Jaye-term`
 * branch (see reference-maiterm-git-remotes). It has NO signed updater feed
 * (`createUpdaterArtifacts: false`, no private key), so the Tauri auto-installer
 * can't apply updates — and the upstream endpoints would offer the ORIGINAL's
 * releases, which is exactly what we must NOT link to. So instead of the Tauri
 * `check()`, we compare the running build's embedded git SHA (`__GIT_SHA__`)
 * against the tip of the distribution branch and, when they differ, prompt the
 * user to pull & rebuild — opening the Bitbucket branch. No upstream, no
 * auto-install, no binary download.
 *
 * The Tauri-installer surface below (currentUpdate / downloadAndInstall /
 * restart / release-notes) is retired to inert stubs so the existing banner /
 * What's-New UI still compiles; the live path is checkForUpdates →
 * openDistribution. The banner is kept dormant (showBanner === false) so the
 * only prompt is the toast, whose action opens Bitbucket.
 */
const DIST_REMOTE = 'git@bitbucket.org:forwood/forwood-one-tools.git';
const DIST_BRANCH = 'Jaye-term';
const DIST_URL = 'https://bitbucket.org/forwood/forwood-one-tools/branch/Jaye-term';

function createUpdaterStore() {
  let checking = $state(false);
  let updateAvailable = $state(false);
  let latestSha = $state<string | null>(null);
  let dismissed = $state(false);
  let releaseNotes = $state<ChangelogEntry[]>([]);
  let showWhatsNewRequested = $state(false);
  // Inert remnants of the retired Tauri-installer surface — never change.
  const downloading = false;
  const installed = false;
  const currentUpdate: Update | null = null;
  const loadingNotes = false;

  /** Open the distribution branch so the user can pull & rebuild. */
  async function openDistribution(): Promise<void> {
    try {
      await shellOpen(DIST_URL);
    } catch {
      /* opener unavailable — ignore */
    }
  }

  async function checkForUpdates(silent = false): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      // `git ls-remote` over the login shell — a GUI-launched app's PATH has no
      // git/ssh-agent otherwise. The tip of Jaye-term is the same commit the
      // running build's SHA was stamped from.
      const res = await commands.runRailProvider(
        'git',
        ['ls-remote', DIST_REMOTE, DIST_BRANCH],
        undefined,
        15,
        true,
      );
      if (res.exitCode !== 0) {
        throw new Error(res.stderr.trim() || `git ls-remote exited ${res.exitCode}`);
      }
      const remoteSha = (res.stdout.trim().split(/\s+/)[0] ?? '').toLowerCase();
      const localSha = (__GIT_SHA__ || '').toLowerCase().replace(/-dirty$/, '');
      if (!remoteSha) throw new Error('empty ls-remote response');

      // Embedded SHA is a short prefix; a match means the remote tip == the
      // commit this build came from.
      const upToDate = !!localSha && remoteSha.startsWith(localSha);
      updateAvailable = !upToDate;
      latestSha = remoteSha.slice(0, 9);

      if (!upToDate) {
        dismissed = false;
        logInfo(`Update available on ${DIST_BRANCH}: ${latestSha} (running ${localSha || 'unknown'})`);
        if (!silent) {
          toastStore.addToast(
            'Update Available',
            `${DIST_BRANCH} has newer changes (${latestSha}) — click to pull & rebuild`,
            'info',
            undefined,
            undefined,
            () => void openDistribution(),
          );
        }
      } else if (!silent) {
        toastStore.addToast('Up to Date', `Running the latest ${DIST_BRANCH} (${latestSha}).`, 'success');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError(`Update check failed: ${msg}`);
      if (!silent) toastStore.addToast('Update Check Failed', msg, 'error');
    } finally {
      checking = false;
    }
  }

  // --- Retired Tauri auto-installer surface (no signed feed for the fork) ---
  // Inert stubs so the banner / What's-New UI still compiles. The live update
  // path is checkForUpdates → openDistribution.
  async function fetchReleaseNotes(): Promise<ChangelogEntry[]> {
    releaseNotes = [];
    return [];
  }
  async function recheckForNewer(): Promise<Update | null> {
    return null;
  }
  function switchToUpdate(_update: Update) {
    void _update;
  }
  async function downloadAndInstall() {
    await openDistribution();
  }

  function dismiss() {
    dismissed = true;
  }

  /**
   * Flush state to disk, then relaunch. relaunch() hard-kills the process
   * without firing onCloseRequested/quit-requested, so the normal shutdown
   * save path never runs — mirror it here or recently-changed state is lost.
   */
  async function restart() {
    try {
      const monitorCount = await commands.getMonitorCount().catch(() => 1);
      await commands.saveWindowGeometry(monitorCount).catch(() => {});
      await terminalsStore.saveAllScrollback();
      await invoke('sync_state');
    } catch (e) {
      logError(`Pre-relaunch state flush failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    relaunch();
  }

  return {
    get checking() {
      return checking;
    },
    get downloading() {
      return downloading;
    },
    get installed() {
      return installed;
    },
    get currentUpdate() {
      return currentUpdate;
    },
    get updateAvailable() {
      return updateAvailable;
    },
    get latestSha() {
      return latestSha;
    },
    get dismissed() {
      return dismissed;
    },
    get releaseNotes() {
      return releaseNotes;
    },
    get loadingNotes() {
      return loadingNotes;
    },
    /** Banner retired for the fork — the toast is the prompt. */
    get showBanner() {
      return false;
    },
    get showWhatsNewRequested() {
      return showWhatsNewRequested;
    },
    checkForUpdates,
    openDistribution,
    recheckForNewer,
    switchToUpdate,
    downloadAndInstall,
    fetchReleaseNotes,
    dismiss,
    restart,
    requestShowWhatsNew() {
      showWhatsNewRequested = true;
    },
    clearShowWhatsNewRequest() {
      showWhatsNewRequested = false;
    },
  };
}

export const updaterStore = createUpdaterStore();
