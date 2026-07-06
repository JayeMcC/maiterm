# Handover — maiTerm task browser: "openTab failed for task 'Require devcontainer'"

**Status:** unresolved. Root-caused to the throw site + narrowed to `handleOpenTab`
error branches, but the exact failing `detail` was never captured (it only renders
in the task tab, not in any app log). Workaround exists; fix needs the real `detail`.

Date: 2026-07-06. Reported against the `forwood-one_reviewing` stack's dev tasks.

## Symptom

Running a dev task from the maiTerm **task browser** — `WEB` / `API` / `SB` / the
DB tasks, or the composites `Spin up dev servers` / `Open dev terminals` /
`Kill all, branch setup, spin up dev` — fails immediately with a truncated error:

```
open tab failed for task require dev containers
```

i.e. `openTab failed for task 'Require devcontainer': <detail>` (the `<detail>` is
truncated in the tab). Every dev task carries `"dependsOn": ["Require devcontainer"]`,
and the dispatcher walks dependencies depth-first, so the guard is the **first**
`openTab` call — its failure aborts the whole chain. The identical tasks run fine
from **VS Code / Cursor**, so this is maiTerm-task-engine-specific.

## Where it's thrown

`scripts/task-engine/src/dispatchers/maiterm.ts:121-126`:

```ts
if (callResult.isError) {
  const detail =
    callResult.content?.find(c => c.type === 'text')?.text ?? '(no error message)';
  throw new Error(`openTab failed for task '${task.label}': ${detail}`);
}
```

So maiTerm's `openTab` MCP tool returned `isError: true`; `${detail}` is the real
reason. The launcher (`@forwood/task-engine`) is an MCP **client** calling maiTerm's
`openTab`; this thrown error goes to the launcher's stderr, rendered only in the
task-browser tab — **it is NOT written to `~/Library/Logs/com.aiterm.app*/aiterm.log`.**
That's why it couldn't be recovered from the logs (see Evidence).

## The handler's failure modes

`src/lib/stores/claudeCode.svelte.ts` — `handleOpenTab` (line 804):

- `:805` → `{ error: 'name is required' }`
- `:807-810` → `{ error: 'Workspace not found: <workspaceName>' }` OR `{ error: 'No active workspace' }`
- `:868-869` → `{ error: 'Workspace has no panes: <ws.id>' }`

For "Require devcontainer" the dispatcher (`buildOpenTabArgs`) sends:

```jsonc
{ "name": "shared",            // panel:'shared' (tasks.json) → name 'shared', reuseExisting:true
  "command": "bash \"${workspaceFolder}/.vscode/scripts/tasks/require-devcontainer.sh\"",
  "reuseExisting": true,
  "workspaceName": "<launcher ctx.workspaceName>" }
```

Note: the dispatcher **ignores** `presentation.reveal` and `presentation.close` —
only `panel`/`group` are mapped. So this is **not** a `reveal:silent`/`close:true`
issue (an early wrong hypothesis). The `${workspaceFolder}` is passed through
literally — the task engine does not appear to resolve VS Code variables; worth
checking whether that matters for openTab (it shouldn't fail openTab itself, only
the command at runtime).

## Evidence gathered (attached logs)

- `aiterm-app3-today.log.txt` — instance `com.aiterm.app3`. Shows task-engine
  `openTab` calls **succeeding** (`14:32`/`14:34`, `client='@forwood/task-engine'`,
  `spawn_pty` events, `"shared" has finished (exit code 130)`). So the failure is
  **situational**, not a blanket workspace-lookup break.
- `aiterm-app-today.log.txt` — instance `com.aiterm.app` (the newest-active one at
  investigation time). No `openTab failed` / `Workspace not found` / `No active
  workspace` string anywhere — confirming the launcher error is tab-only.
- Grep across ALL instances (`com.aiterm.app`, `app2`/maiTerm2, `app3`) for
  `openTab failed for task` / `Workspace not found` / `No active workspace` /
  `Workspace has no panes` / `Require devcontainer` → **zero hits**. The `detail`
  is not persisted anywhere on disk.

## Most likely cause (hypothesis — unconfirmed)

The `workspaceName` the launcher passes (`MaitermDispatchContext.workspaceName`,
"the maiTerm workspace representing the active clone") doesn't match a live maiTerm
workspace at fire time → `Workspace not found: <name>`; OR no active workspace →
`No active workspace`. "Require devcontainer" is merely the first `openTab`, so it's
where it surfaces. Since other task-engine openTab calls succeeded (app3), this is
intermittent / context-dependent (which instance/workspace was focused when fired).

## To fix correctly — next steps

1. **Capture the real `detail`.** Reproduce and read the task-browser tab's
   scrollback (maiTerm `getTabContext` / `readLogs` MCP on that tab), or copy the
   full `openTab failed for task 'Require devcontainer': <…>` line. That names the
   exact branch.
2. **Close the observability gap (do this regardless).** The launcher error is
   invisible in logs. Either:
   - have `handleOpenTab` log its error returns at WARN in
     `claudeCode.svelte.ts` (so app logs capture the reason), and/or
   - have the task-engine launcher write its thrown error to a file
     (`scripts/task-engine` — a `--log <file>` or stderr tee).
3. **Patch the matching branch:**
   - `Workspace not found` → reconcile `ctx.workspaceName` with maiTerm's actual
     workspace names, or make `handleOpenTab` fall back to `activeWorkspace` with a
     warning instead of erroring when the named workspace is absent.
   - `No active workspace` → the task browser should target a workspace explicitly,
     or `handleOpenTab` should pick a sensible default.
4. **Add a unit test** in `scripts/task-engine/src/__tests__/dispatchers-maiterm.test.ts`
   (already covers panel mapping) for the chosen behaviour.

## Workaround (unblocks users now — container up ⇒ the guard is moot)

- Cursor/VS Code → **Tasks: Run Task** → `WEB` / `API` (handles the presentation
  fine, "Require devcontainer" just exits 0), or
- run the scripts straight into the container:
  ```bash
  devcontainer exec --workspace-folder <clone> \
    bash -lc 'bash /workspaces/website/.vscode/scripts/tasks/dev-web.sh'   # dev-api.sh for API
  ```

## Relevant source

- Throw + dispatch: `scripts/task-engine/src/dispatchers/maiterm.ts`
  (`dispatchMaiterm` :96-133, `buildOpenTabArgs` :146-217).
- Handler: `src/lib/stores/claudeCode.svelte.ts:804` (`handleOpenTab`).
- Task defs: reviewing-clone `.vscode/tasks.json` — `Require devcontainer` (label,
  `presentation: { reveal:'silent', panel:'shared', close:true }`) + every dev task
  `dependsOn` it. (That file is symlinked from
  `forwood-one-tools/linked-tools/repos/forwood-one/.vscode/scripts/tasks/` — the
  script dir — but `tasks.json` itself lives in the product clone.)
