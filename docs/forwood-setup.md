# Setting up maiTerm with the forwood task runner

End-to-end setup so a new employee gets maiTerm running as their local
dev-container terminal — with the **task runner rail** (fire dev servers, view
container ports) that replaces VS Code's tasks panel. Follow top to bottom.

The rail is two parts working together, **both in this repo**:

- **maiTerm** (this fork, `JayeMcC/maiterm`) — the terminal app + the rail UI.
- **`forwood-launcher` + `@forwood/task-engine`** (`scripts/launcher/`,
  `scripts/task-engine/`) — the provider the rail runs to list/fire tasks and
  read container status. The app is forwood-agnostic; all the forwood
  knowledge lives in the launcher.

## 0. One-command setup

Clone this repo (branch **`main`** — stable, what releases cut from; `dev` is
active development) **anywhere you like** and run the setup script — it
resolves every path from its own checkout location, and the rail finds your
forwood clones from each tab's cwd, so no particular directory layout is
required:

```sh
git clone -b main git@github.com:JayeMcC/maiterm.git maiterm
bash maiterm/scripts/forwood-setup.sh
```

Forwood-internal alternative (same tree, mirrored to Bitbucket):

```sh
git clone -b Jaye-term git@bitbucket.org:forwood/forwood-one-tools.git maiterm
bash maiterm/scripts/forwood-setup.sh
```

Docs below use `~/proj/...` in examples — that's a convention, not a
requirement. The one place a root directory matters is *name-based* clone
lookup (`forwood-launcher --clone developing` or `$FORWOOD_CLONE`), which
resolves against `$PROJ_ROOT` (default `~/proj`) — set `PROJ_ROOT` if your
clones live elsewhere, or just rely on the rail's cwd detection, which needs
no configuration.

The script is idempotent — re-run it any time; completed steps are skipped. It
installs Node (≥ 22.6) and `@devcontainers/cli` if missing, warns if Docker
isn't running, installs the latest maiTerm3 release DMG (or `--build` to build
from the checkout), installs + links `forwood-launcher` onto PATH, verifies,
and launches the app (`--no-launch` to skip). Sections 1–3 below describe what
it does, for manual setup or troubleshooting.

## 1. Prerequisites

| Need | Why | Install |
|---|---|---|
| **Homebrew + Node** | The rail runs `forwood-launcher` via your login shell, which needs node ≥ 22.6 on PATH. | `brew install node` (setup script does this) |
| **Docker Desktop** | Container tasks (API/WEB/DBs) run via `devcontainer exec`; the container section reads live status via `docker`. | Docker Desktop for Mac |
| **`@devcontainers/cli`** | Host-side container bring-up + `devcontainer exec`. | `npm i -g @devcontainers/cli` (setup script does this) |
| **forwood clones** | The repos whose `.vscode/tasks.json` the rail detects — anywhere on disk; detection walks up from the tab's cwd. | your usual clone setup |
| **Xcode CLT + Rust** | Only for building the app from source (`--build`). | `xcode-select --install`, `rustup` |

## 2. Install maiTerm

Two ways. Most people want the **download**; build from source only if you're
developing the app itself. Either way it installs as **maiTerm3**
(`com.aiterm.app3`), side by side with any upstream maiTerm.

### A. Download the DMG (recommended)

Grab the latest `.dmg` from the fork's releases:
**<https://github.com/JayeMcC/maiterm/releases/latest>** → open it → drag
**maiTerm3** into Applications.

**First launch needs a one-time Gatekeeper bypass.** The app is signed but not
Apple-notarized, so macOS quarantines the download. Clear it once:

```sh
xattr -dr com.apple.quarantine /Applications/maiTerm3.app
```

(or right-click the app → **Open** → **Open** the first time). After that it
launches normally and updates itself in-app (§6).

### B. Build from source (developers)

```sh
git clone git@github.com:JayeMcC/maiterm.git ~/proj/maiterm
cd ~/proj/maiterm
npm ci
bash scripts/install-local.sh --release
```

`install-local.sh` builds the bundle, copies it to `/Applications/maiTerm3.app`,
**and re-signs it** — mandatory (a plain copy breaks the ad-hoc signature and the
app launches to a white screen; the script handles it and verifies with
`codesign -v`). When it prints `✓ maiTerm3 installed and signature verified`,
launch it from `/Applications`.

## 3. Link `forwood-launcher` onto your PATH

The rail invokes `forwood-launcher` by name through your login shell, so it must
resolve on PATH:

```sh
cd ~/proj/maiterm/scripts/launcher
npm ci && npm link
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
- **Optional global hotkey** — to fire the standalone launcher TUI from outside
  maiTerm, bind `scripts/launcher/bin/forwood-launcher` to a key combo — see
  `scripts/launcher/docs/keybind-hammerspoon.lua` for a Hammerspoon example.

## 6. Updates

maiTerm updates itself. On launch it checks the fork's release feed and, when a
newer version exists, shows an **"Update Available"** toast — click it, review,
and install; the app downloads the signed update, swaps itself, and restarts.
(After an update the swapped binary may need the one-time `xattr` bypass from §2A
on its next launch — Apple notarization would remove even that, a future step.)

If you built from source instead, update by pulling and rebuilding:

```sh
cd ~/proj/maiterm && git pull && bash scripts/install-local.sh --release
```

## Releasing (maintainer only)

Cut a release so everyone's in-app updater picks it up:

```sh
bash scripts/release.sh 1.18.1     # any version higher than the last
```

That bumps the version, tags `v1.18.1`, and pushes — the **Release** workflow
builds + signs the maiTerm3 bundle and publishes a GitHub Release with the `.dmg`
and the `latest.json` updater feed. One-time setup: the repo secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must be set
(Settings → Secrets → Actions). The signing key's public half is embedded in the
app; keep the private half (`~/.tauri/maiterm-updater.key`) backed up — losing it
means existing installs can't verify future updates.

## Customizing the rail (advanced)

The rail ships with the forwood providers built in, so there's nothing to
configure for normal use. To point it at a different toolchain (or a second
launcher), drop a `~/.config/maiterm/rail.json` — it's merged over the defaults:

```json
{
  "taskProviders": [
    {
      "marker": ".vscode/tasks.json",
      "label": "Tasks",
      "program": "forwood-launcher",
      "listArgs": ["--list", "--json", "--dir", "{dir}"],
      "fireArgs": ["--fire", "{label}", "--dir", "{dir}"]
    }
  ],
  "containerProvider": {
    "marker": ".devcontainer/devcontainer.json",
    "program": "forwood-launcher",
    "statusArgs": ["--container-status", "--dir", "{dir}"],
    "forwardArgs": ["--forward", "{port}", "--dir", "{dir}"],
    "unforwardArgs": ["--unforward", "{port}", "--dir", "{dir}"]
  }
}
```

`{dir}` expands to the detected repo root, `{label}` to the fired task, `{port}`
to the port. A missing or malformed file falls back to the defaults silently.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Rail doesn't appear | Tab's cwd isn't inside a repo with `.vscode/tasks.json`. `cd` into a clone. |
| "Provider exited …" in the rail | `forwood-launcher` not on PATH (redo step 3) or Docker not running. |
| Container section says "Docker not running" | Start Docker Desktop. |
| White screen after a manual copy | Don't copy the `.app` by hand — use `install-local.sh` (it re-signs). |
| Tasks show but firing does nothing | Confirm maiTerm is the one with the lockfile the launcher targets (only run one maiTerm3). |
