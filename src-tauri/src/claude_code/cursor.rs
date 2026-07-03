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
use super::registrar::Registrar;

pub struct CursorRegistrar;

impl Registrar for CursorRegistrar {
    fn runtime(&self) -> AgentRuntime {
        AgentRuntime::Cursor
    }

    fn enabled(&self, prefs: &Preferences) -> bool {
        prefs.cursor_ide
    }

    fn install(&self, port: u16, auth: &str, _workspace_folders: &[String], _prefs: &Preferences) {
        let Some(path) = mcp_json_path() else {
            log::warn!("Cursor install: could not determine home directory");
            return;
        };
        if let Some(parent) = path.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                log::warn!("Cursor install: failed to create {:?}: {}", parent, e);
                return;
            }
        }
        match read_json(&path) {
            Ok(existing) => {
                let merged = put_mcp_entry(existing, mcp_name(), port, auth);
                match serde_json::to_string_pretty(&merged) {
                    Ok(json) => {
                        if let Err(e) = atomic_write(&path, &json) {
                            log::warn!("Cursor install: failed to write {:?}: {}", path, e);
                        } else {
                            log::info!(
                                "Cursor install (port {}): mcpServers.{} in {:?}",
                                port, mcp_name(), path
                            );
                        }
                    }
                    Err(e) => log::warn!("Cursor install: serialize mcp.json failed: {}", e),
                }
            }
            Err(e) => log::warn!("Cursor install: failed to read {:?}: {}", path, e),
        }
    }

    /// Cursor does not rewrite maiTerm's entry, so there is nothing to re-assert.
    fn reassert_if_drifted(&self, _port: u16, _auth: &str) {}

    fn unregister(&self, _port: u16, _auth: &str) {
        let Some(path) = mcp_json_path() else { return };
        if !path.exists() {
            return;
        }
        match read_json(&path) {
            Ok(Some(existing)) => {
                let cleaned = remove_mcp_entry(existing.clone(), mcp_name());
                // Only rewrite if we actually removed our entry — never reformat a
                // user's mcp.json that never held ours.
                if cleaned != existing {
                    match serde_json::to_string_pretty(&cleaned) {
                        Ok(json) => {
                            if let Err(e) = atomic_write(&path, &json) {
                                log::warn!("Cursor unregister: failed to write {:?}: {}", path, e);
                            }
                        }
                        Err(e) => log::warn!("Cursor unregister: serialize mcp.json failed: {}", e),
                    }
                }
            }
            Ok(None) => {}
            Err(e) => log::warn!("Cursor unregister: failed to read {:?}: {}", path, e),
        }
    }
}

// ── pure, testable helpers ───────────────────────────────────────────────────

fn mcp_name() -> &'static str {
    crate::state::agent_runtime::mcp_server_name(AgentRuntime::Cursor)
}

fn mcp_json_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cursor").join("mcp.json"))
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
