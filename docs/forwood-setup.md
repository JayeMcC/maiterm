# Setting up maiTerm with the forwood task runner

End-to-end setup so a new employee gets maiTerm running as their local
dev-container terminal — with the **task runner rail** (fire dev servers, view
container ports) that replaces VS Code's tasks panel. Follow top to bottom.

The rail is two parts working together:

- **maiTerm** (this fork, `JayeMcC/maiterm`) — the terminal app + the rail UI.
- **`forwood-launcher`** (in `forwood-one-tools`) — the provider the rail runs
  to list/fire tasks and read container status. The app is forwood-agnostic;
  all the forwood knowledge lives in the launcher.

## 1. Prerequisites

| Need | Why | Install |
|---|---|---|
| **Homebrew + Node** | The rail runs `forwood-launcher` via your login shell, which needs node on PATH. | `brew install node` |
| **Docker Desktop** | Container tasks (API/WEB/DBs) run via `devcontainer exec`; the container section reads live status via `docker`. | Docker Desktop for Mac |
| **`@devcontainers/cli`** | Host-side container bring-up + `devcontainer exec`. | `npm i -g @devcontainers/cli` |
| **forwood clones** | The repos whose `.vscode/tasks.json` the rail detects (e.g. `~/proj/forwood-one_developing`). | your usual clone setup |
| **`forwood-one-tools`** | Home of `forwood-launcher`. | already cloned for team tooling |
| **Xcode CLT + Rust** | Building the Tauri app. | `xcode-select --install`, `rustup` |

## 2. Build & install maiTerm

The fork ships MCP tools and the rail that upstream `maiTerm` doesn't have, so
you build from source. It installs as **maiTerm3** (`com.aiterm.app3`), side by
side with any upstream maiTerm.

```sh
git clone git@github.com:JayeMcC/maiterm.git ~/proj/maiterm
cd ~/proj/maiterm
npm ci
bash scripts/install-local.sh --release
```

`install-local.sh` builds the bundle, copies it to `/Applications/maiTerm3.app`,
**and re-signs it** — that last step is mandatory (a plain copy breaks the ad-hoc
signature and the app launches to a white screen; the script handles it and
verifies with `codesign -v`). When it prints `✓ maiTerm3 installed and signature
verified`, launch it from `/Applications`.

## 3. Link `forwood-launcher` onto your PATH

The rail invokes `forwood-launcher` by name through your login shell, so it must
resolve on PATH:

```sh
cd ~/proj/forwood-one-tools/linked-tools/core/scripts/launcher
npm link
which forwood-launcher   # → /opt/homebrew/bin/forwood-launcher
```

Sanity-check it lists tasks for a clone (this is exactly what the rail runs):

```sh
forwood-launcher --list --json --dir ~/proj/forwood-one_developing | head
```

You should get JSON with a `tasks` array. If you get `command not found`, the
`npm link` didn't land on PATH; if you get an empty/errored result, check Docker
is running and the clone path is right.

## 4. Verify the rail

In maiTerm, open a terminal tab and `cd` into a forwood clone
(`~/proj/forwood-one_developing`). A fold-out **rail** appears on the right edge
with:

- **Tasks** — every task from that clone's `.vscode/tasks.json`, with the target
  clone shown under the header. Container tasks (API/WEB/DBs) carry a blue edge.
- **Container** — live state (up/down), published ports with listening dots
  (click to open), and controls to forward/stop ports.

Each section header is a collapse toggle. The rail follows your active tab, so
switching to a tab in another clone re-targets it.

## 5. Using it

- **Fire a task** — click it. The launcher routes it to the right place
  automatically: container tasks run inside the container (`devcontainer exec`),
  host tasks run on the host. You can trigger anything from a host terminal.
- **Dev-server tabs** — firing API/WEB opens a dedicated tab that runs the server
  and, when you Ctrl-C it, drops you into a live shell at the project root in the
  task's own context (container shell for container tasks).
- **Ports** — the Container section shows what's actually listening; click a port
  row to open it in your browser.

## 6. Updates

maiTerm is distributed as source — there's no auto-installer. On launch it checks
the `Jaye-term` distribution branch and, if there are newer changes, shows an
"Update Available" toast; click it to open the branch. To update:

```sh
cd ~/proj/maiterm && git pull && bash scripts/install-local.sh --release
```

(The fork's own repo is `JayeMcC/maiterm` on GitHub; `Jaye-term` in the tools
Bitbucket repo is the distribution mirror of its `main`.)

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Rail doesn't appear | Tab's cwd isn't inside a repo with `.vscode/tasks.json`. `cd` into a clone. |
| "Provider exited …" in the rail | `forwood-launcher` not on PATH (redo step 3) or Docker not running. |
| Container section says "Docker not running" | Start Docker Desktop. |
| White screen after a manual copy | Don't copy the `.app` by hand — use `install-local.sh` (it re-signs). |
| Tasks show but firing does nothing | Confirm maiTerm is the one with the lockfile the launcher targets (only run one maiTerm3). |
