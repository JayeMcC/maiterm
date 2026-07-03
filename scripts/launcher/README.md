# @forwood/launcher

One-shot Ink TUI for picking and firing tasks from a clone's `.vscode/tasks.json` against the live maiTerm via its MCP server. Implements the launcher half of [ADR 0005](../../docs/adr/0005-task-engine-and-dispatchers.md).

## Lifetime

```
key combo → cold-start → menu → fire → exit
```

~300ms cold start (Node + Ink + React), ~50MB peak RSS while the menu is open, zero background cost when not invoked. Dev-server tabs it spawns live in maiTerm and persist after the launcher exits — the launcher does not own their lifecycle.

## Usage

```sh
# Active clone comes from $FORWOOD_CLONE (set per maiTerm workspace).
forwood-launcher

# Explicit override.
forwood-launcher --clone developing

# Help.
forwood-launcher --help
```

Clone selection priority (per ADR 0005 §clone-selection): `--clone <name>` > `$FORWOOD_CLONE` > error.

Known clone names: `main`, `developing`, `reviewing`, `experimenting`, `quick-fixes`. The launcher maps them to host paths via the same convention as the tmux task-picker (`scripts/terminal/tmux-workspaces/bin/task-picker.sh`):

- `main` → `$PROJ_ROOT/forwood-one`
- otherwise → `$PROJ_ROOT/forwood-one_<name>`

`$PROJ_ROOT` defaults to `~/proj`.

## How it fires tasks

The menu reads tasks via `@forwood/task-engine`'s `listTasks`, hands the picked task to `dispatchMaiterm`, and waits for the dispatcher to walk the `dependsOn` tree (each leaf task becomes one `openTab` MCP call against maiTerm). The maiTerm IDE server is discovered via `~/.claude/ide/<port>.lock`; this requires a running maiTerm with the `openTab` / `sendKeysToTab` MCP tools (the fork at [`JayeMcC/maiterm`](https://github.com/JayeMcC/maiterm) until they're upstreamed).

## Non-interactive provider modes (PLAN-15 / ADR 0006)

The hotbar rail's provider contract — dir-derived (marker walk-up from
`--dir`, no `$FORWOOD_CLONE`), TTY-free, machine-parseable. Field names are
normative per `specs/feature/PLAN-15__maiterm-hotbar/data-model.md`.

```sh
forwood-launcher --list --json --dir <path>        # ListReport; tasks carry executionContext
forwood-launcher --fire <label> --dir <path>       # dispatch via maiTerm MCP loopback
forwood-launcher --container-status --dir <path>   # {state, ports[], listeners[], forwards[]}
forwood-launcher --forward <port> --dir <path>     # ad-hoc socat sidecar on the compose network
forwood-launcher --unforward <port> --dir <path>   # remove it (unknown port = clean no-op)
```

Exit codes: `0` ok · `3` no marker up-tree (clean "not here") · `2` bad
`--dir`/usage · `1` failure (malformed tasks.json, unknown label with
suggestions, refusals). Fire auto-derives: host folder = repo root,
container-side `${workspaceFolder}` from `devcontainer.json`, gate prelude
when the repo ships `require-devcontainer.sh`.

**SC-007 mapping — every hotbar datum has an emitting field:**

| Hotbar section datum | Source |
|---|---|
| task list entries, grouping | `ListReport.tasks[].label` / `.presentation.group` |
| per-task host/container badge | `ListReport.tasks[].executionContext` |
| fire a task | `--fire <label> --dir <cwd>` |
| container up/down/unavailable | `ContainerStatusReport.state` |
| published port rows + listening dot | `ports[].service/.hostPort/.listening` (protocol-aware — docker-proxy false-positives designed out) |
| "Forward" offers | `listeners[].containerPort/.forwardable` |
| active forwards + stop buttons | `forwards[]` · `--forward`/`--unforward` |

## Tests

```sh
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

Test scope:
- `clone-resolver` unit tests cover arg/env/fallback priority and tasks.json validation.
- `task-menu` render tests use `ink-testing-library` to drive arrow keys / Enter / `q` and assert the visible frame.

End-to-end exercise (real maiTerm + real task dispatch) lives in the [maiTerm fork's E2E suite](https://github.com/JayeMcC/maiterm/tree/feature/e2e-tests/tests/e2e), not here.
