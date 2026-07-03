-- forwood-launcher Hammerspoon binding.
--
-- Drop this snippet into ~/.hammerspoon/init.lua (or require it from there).
-- Reload Hammerspoon (Cmd+Ctrl+R in the console) and the binding is live.
--
-- Default: Ctrl+Option+Cmd+T fires the launcher in the current terminal
-- workspace. Picks the launcher binary up from the canonical fork-clone
-- location; adjust LAUNCHER_PATH if your tree lives elsewhere.
--
-- The shell runs in a non-interactive context, so we set PATH explicitly
-- to include the standard Homebrew / Node-via-nvm locations. Tweak as
-- needed for your install.

local LAUNCHER_PATH = os.getenv("HOME") .. "/proj/maiterm/scripts/launcher/bin/forwood-launcher"

-- Map a maiTerm workspace name → which clone the launcher should target.
-- Reads the active maiTerm tab's parent workspace name (best-effort) and
-- maps it to a FORWOOD_CLONE value. Falls back to nil → launcher will
-- prompt or error per its own resolution logic.
local function activeClone()
  -- Hammerspoon can't read maiTerm's internal workspace name directly.
  -- Simplest: read it from an env var the user sets per workspace via
  -- maiTerm's per-workspace shell init, OR hard-code per binding.
  -- For a single-clone setup, just return your usual clone:
  return os.getenv("FORWOOD_CLONE") or "developing"
end

local function fireLauncher()
  local clone = activeClone()
  local cmd = string.format(
    [[/usr/bin/env -S /bin/bash -lc "FORWOOD_CLONE=%s '%s'"]],
    clone,
    LAUNCHER_PATH
  )
  -- Open in a new maiTerm tab so the alt-buffer UI has somewhere to render.
  -- (Skipping the new-tab dance and using `os.execute` directly would run
  -- the launcher headless — alt-buffer with nowhere to draw — and it'd
  -- exit immediately.)
  hs.osascript.applescript(string.format([[
    tell application "maiTerm" to activate
    delay 0.1
    tell application "System Events" to keystroke "t" using {command down}
    delay 0.2
    tell application "System Events" to keystroke "%s" & return
  ]], cmd:gsub('"', '\\"')))
end

-- Bind Ctrl+Option+Cmd+T to fire the launcher.
hs.hotkey.bind({"ctrl", "alt", "cmd"}, "T", fireLauncher)

-- Optional alert so you know the binding loaded.
hs.alert.show("forwood-launcher bound to ⌃⌥⌘T")
