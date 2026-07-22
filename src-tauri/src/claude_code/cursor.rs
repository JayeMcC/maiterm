//! Cursor CLI (`cursor-agent`) on-disk registration. Cursor discovers MCP
//! servers from `~/.cursor/mcp.json` — a JSON `mcpServers` object, same shape as
//! Claude's `~/.claude.json`. We merge our HTTP entry in (Bearer auth, which the
//! server's `extract_auth` already accepts) without clobbering the user's other
//! servers.
//!
//! Phase 1 (tools + presence): MCP config only. Status hooks (`~/.cursor/hooks.json`)
//! are Phase 2 — see docs/cursor-parity-design.md.

use std::fs;
use std::path::{Path, PathBuf};

use crate::state::{AgentRuntime, Preferences};
use super::lockfile::AGENT_HOOK_SHIM;
use super::registrar::Registrar;

/// Cursor CLI lifecycle events we register a forwarding command hook for. The CLI
/// reliably fires only the shell/MCP execution hooks today (its lifecycle hooks are
/// flaky — see docs/cursor-parity-design.md); the shell/MCP ones drive the "working"
/// state and the dormancy reaper handles idle. The rest are best-effort.
const CURSOR_HOOK_EVENTS: &[&str] = &[
    "sessionStart",
    "sessionEnd",
    "stop",
    "beforeShellExecution",
    "afterShellExecution",
    "beforeMCPExecution",
    "afterMCPExecution",
    "beforeSubmitPrompt",
];

/// Marker identifying *our* hook entry inside a (possibly user-populated) event array.
const SHIM_MARKER: &str = "agent-hook.sh";

pub struct CursorRegistrar;

impl Registrar for CursorRegistrar {
    fn runtime(&self) -> AgentRuntime {
        AgentRuntime::Cursor
    }

    fn enabled(&self, prefs: &Preferences) -> bool {
        prefs.cursor_ide
    }

    fn install(&self, port: u16, auth: &str, _workspace_folders: &[String], _prefs: &Preferences) {
        let Some(dir) = cursor_dir() else {
            log::warn!("Cursor install: could not determine home directory");
            return;
        };
        if let Err(e) = fs::create_dir_all(&dir) {
            log::warn!("Cursor install: failed to create {:?}: {}", dir, e);
            return;
        }

        // 1. MCP server entry → ~/.cursor/mcp.json (Phase 1 — tools).
        let mcp_path = dir.join("mcp.json");
        if let Ok(existing) = read_json(&mcp_path) {
            let merged = put_mcp_entry(existing, mcp_name(), port, auth);
            if let Ok(json) = serde_json::to_string_pretty(&merged) {
                if let Err(e) = atomic_write(&mcp_path, &json) {
                    log::warn!("Cursor install: failed to write {:?}: {}", mcp_path, e);
                }
            }
        }

        // 2. Hook shim (executable) → ~/.cursor/hooks/agent-hook.sh (Phase 2 — status).
        let shim_path = dir.join("hooks").join("agent-hook.sh");
        if let Some(parent) = shim_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(e) = write_executable(&shim_path, AGENT_HOOK_SHIM) {
            log::warn!("Cursor install: failed to write shim {:?}: {}", shim_path, e);
        }

        // 3. Command hooks → ~/.cursor/hooks.json (merge; never clobber user hooks).
        let hooks_path = dir.join("hooks.json");
        let shim_str = shim_path.to_string_lossy().to_string();
        if let Ok(existing) = read_json(&hooks_path) {
            let merged = build_cursor_hooks(existing, &shim_str, auth);
            if let Ok(json) = serde_json::to_string_pretty(&merged) {
                if let Err(e) = atomic_write(&hooks_path, &json) {
                    log::warn!("Cursor install: failed to write {:?}: {}", hooks_path, e);
                }
            }
        }

        log::info!("Cursor install (port {}): mcp.json + hooks.json + shim", port);
    }

    /// Cursor does not rewrite maiTerm's entry, so there is nothing to re-assert.
    fn reassert_if_drifted(&self, _port: u16, _auth: &str, _prefs: &Preferences) {}

    fn unregister(&self, _port: u16, _auth: &str) {
        let Some(dir) = cursor_dir() else { return };

        // 1. Remove our mcp.json entry (preserve the rest).
        let mcp_path = dir.join("mcp.json");
        if mcp_path.exists() {
            if let Ok(Some(existing)) = read_json(&mcp_path) {
                let cleaned = remove_mcp_entry(existing.clone(), mcp_name());
                if cleaned != existing {
                    if let Ok(json) = serde_json::to_string_pretty(&cleaned) {
                        let _ = atomic_write(&mcp_path, &json);
                    }
                }
            }
        }

        // 2. Strip ONLY our hook entries from hooks.json (command contains agent-hook.sh).
        let hooks_path = dir.join("hooks.json");
        if hooks_path.exists() {
            if let Ok(Some(existing)) = read_json(&hooks_path) {
                let cleaned = strip_our_hooks(existing.clone());
                if cleaned != existing {
                    if let Ok(json) = serde_json::to_string_pretty(&cleaned) {
                        let _ = atomic_write(&hooks_path, &json);
                    }
                }
            }
        }

        // 3. Best-effort shim removal.
        let shim_path = dir.join("hooks").join("agent-hook.sh");
        if shim_path.exists() {
            let _ = fs::remove_file(&shim_path);
        }
    }
}

// ── pure, testable helpers ───────────────────────────────────────────────────

fn mcp_name() -> &'static str {
    crate::state::agent_runtime::mcp_server_name(AgentRuntime::Cursor)
}

fn cursor_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cursor"))
}

/// Merge maiTerm's command hooks into an existing (or absent) ~/.cursor/hooks.json.
/// Cursor's schema is `{ "version": 1, "hooks": { "<event>": [ { "command", "timeout" } ] } }`
/// (flatter than Codex's). Per event: replace our entry (command contains agent-hook.sh)
/// in place, else append; leave user entries untouched; preserve other top-level keys.
fn build_cursor_hooks(existing: Option<serde_json::Value>, shim_path: &str, auth: &str) -> serde_json::Value {
    let mut root = match existing {
        Some(v @ serde_json::Value::Object(_)) => v,
        _ => serde_json::json!({}),
    };
    let obj = root.as_object_mut().expect("root object");
    obj.entry("version").or_insert_with(|| serde_json::json!(1));
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks = hooks.as_object_mut().expect("hooks object");

    // $3="cursor" tags the runtime for /hooks normalization; $2="" (no baked port — local).
    let command = format!("bash \"{}\" \"{}\" \"\" \"cursor\"", shim_path, auth);
    let our_entry = serde_json::json!({ "command": command, "timeout": 5 });

    for &event in CURSOR_HOOK_EVENTS {
        let arr = hooks.entry(event).or_insert_with(|| serde_json::json!([]));
        if !arr.is_array() {
            *arr = serde_json::json!([]);
        }
        let arr = arr.as_array_mut().expect("event array");
        match arr.iter().position(is_our_entry) {
            Some(idx) => arr[idx] = our_entry.clone(),
            None => arr.push(our_entry.clone()),
        }
    }
    root
}

/// Is this hook entry one of ours? (Its `command` references the shim.)
fn is_our_entry(e: &serde_json::Value) -> bool {
    e.get("command")
        .and_then(|c| c.as_str())
        .map(|c| c.contains(SHIM_MARKER))
        .unwrap_or(false)
}

/// Remove ONLY our entries from every event array; drop now-empty events. Preserves
/// other top-level keys (incl. `version`).
fn strip_our_hooks(mut root: serde_json::Value) -> serde_json::Value {
    if let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for (_event, arr) in hooks.iter_mut() {
            if let Some(a) = arr.as_array_mut() {
                a.retain(|e| !is_our_entry(e));
            }
        }
        hooks.retain(|_event, arr| arr.as_array().map(|a| !a.is_empty()).unwrap_or(true));
    }
    root
}

/// Write a file and mark it executable (no-op chmod on non-unix).
fn write_executable(path: &Path, contents: &str) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| format!("write {:?}: {}", path, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod {:?}: {}", path, e))?;
    }
    Ok(())
}

/// Merge our HTTP MCP entry into a (possibly user-populated) mcp.json value,
/// preserving other servers + top-level keys. Replaces our own entry if present
/// so the port/token update.
fn put_mcp_entry(existing: Option<serde_json::Value>, name: &str, port: u16, auth: &str) -> serde_json::Value {
    let mut root = match existing {
        Some(v @ serde_json::Value::Object(_)) => v,
        _ => serde_json::json!({}),
    };
    let obj = root.as_object_mut().expect("root is object");
    let servers = obj.entry("mcpServers").or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    let servers = servers.as_object_mut().expect("mcpServers is object");
    servers.insert(
        name.to_string(),
        serde_json::json!({
            "url": format!("http://127.0.0.1:{}/mcp", port),
            "headers": { "Authorization": format!("Bearer {}", auth) }
        }),
    );
    root
}

/// Remove our named entry from mcp.json, preserving everything else.
fn remove_mcp_entry(mut root: serde_json::Value, name: &str) -> serde_json::Value {
    if let Some(servers) = root.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
        servers.remove(name);
    }
    root
}

fn read_json(path: &Path) -> Result<Option<serde_json::Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read {:?}: {}", path, e))?;
    Ok(serde_json::from_str(&raw).ok())
}

fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("maiterm-tmp");
    fs::write(&tmp, contents).map_err(|e| format!("write tmp {:?}: {}", tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {:?} -> {:?}: {}", tmp, path, e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_mcp_entry_into_empty_creates_http_server() {
        let v = put_mcp_entry(None, "maiterm2", 51234, "TOK");
        assert_eq!(v["mcpServers"]["maiterm2"]["url"].as_str(), Some("http://127.0.0.1:51234/mcp"));
        assert_eq!(
            v["mcpServers"]["maiterm2"]["headers"]["Authorization"].as_str(),
            Some("Bearer TOK")
        );
    }

    #[test]
    fn put_mcp_entry_preserves_user_servers_and_updates_token() {
        let existing = serde_json::json!({
            "mcpServers": { "other": { "url": "http://localhost:9999/mcp" } },
            "someOtherKey": true
        });
        let v = put_mcp_entry(Some(existing), "maiterm2", 7000, "NEW");
        // user's server + top-level key survive
        assert_eq!(v["mcpServers"]["other"]["url"].as_str(), Some("http://localhost:9999/mcp"));
        assert_eq!(v["someOtherKey"].as_bool(), Some(true));
        // ours added with the new token
        assert_eq!(v["mcpServers"]["maiterm2"]["headers"]["Authorization"].as_str(), Some("Bearer NEW"));

        // re-run replaces ours in place (idempotent)
        let v2 = put_mcp_entry(Some(v), "maiterm2", 7001, "NEWER");
        assert_eq!(v2["mcpServers"]["maiterm2"]["url"].as_str(), Some("http://127.0.0.1:7001/mcp"));
        assert_eq!(v2["mcpServers"]["other"]["url"].as_str(), Some("http://localhost:9999/mcp"));
    }

    #[test]
    fn build_cursor_hooks_uses_cursor_schema_and_tags_runtime() {
        let v = build_cursor_hooks(None, "/h/.cursor/hooks/agent-hook.sh", "TOK");
        assert_eq!(v["version"].as_i64(), Some(1));
        // Flat Cursor schema: hooks.<event> = [ { command, timeout } ].
        for &event in CURSOR_HOOK_EVENTS {
            let arr = v["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{event} has one entry");
            let cmd = arr[0]["command"].as_str().unwrap();
            assert!(cmd.contains("agent-hook.sh") && cmd.contains("TOK") && cmd.contains("\"cursor\""),
                "{event} command runs the shim with token + cursor runtime: {cmd}");
        }
    }

    #[test]
    fn build_cursor_hooks_preserves_user_and_strip_removes_ours() {
        let existing = serde_json::json!({
            "version": 1,
            "hooks": { "stop": [ { "command": "echo user-stop" } ] }
        });
        let v = build_cursor_hooks(Some(existing), "/h/.cursor/hooks/agent-hook.sh", "T");
        let stop = v["hooks"]["stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "user stop hook preserved alongside ours");

        let cleaned = strip_our_hooks(v);
        // Only stop survives (had a user entry); all our-only events dropped.
        assert!(cleaned["hooks"]["beforeShellExecution"].as_array().is_none());
        assert_eq!(cleaned["hooks"]["stop"].as_array().unwrap().len(), 1);
        assert_eq!(cleaned["hooks"]["stop"][0]["command"].as_str(), Some("echo user-stop"));
    }

    #[test]
    fn remove_mcp_entry_drops_only_ours() {
        let existing = put_mcp_entry(
            Some(serde_json::json!({ "mcpServers": { "other": { "url": "u" } } })),
            "maiterm2", 7000, "TOK",
        );
        let cleaned = remove_mcp_entry(existing, "maiterm2");
        assert!(cleaned["mcpServers"].get("maiterm2").is_none(), "ours removed");
        assert_eq!(cleaned["mcpServers"]["other"]["url"].as_str(), Some("u"), "other survives");
    }
}
