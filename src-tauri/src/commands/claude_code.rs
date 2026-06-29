use std::sync::Arc;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

/// Called by the frontend to send a tool response back to Claude CLI.
#[tauri::command]
pub fn claude_code_respond(
    state: State<'_, Arc<AppState>>,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    let mut pending = state.ide_pending.write();
    if let Some(tx) = pending.remove(&request_id) {
        let _ = tx.send(result);
        Ok(())
    } else {
        Err(format!("No pending request with id: {}", request_id))
    }
}

/// Called once from the Svelte layout's `onMount` after the
/// `agent-ide-tool` listener has been registered. Flips `frontend_ready`
/// to true and immediately drains any payloads the server queued during
/// the boot race (Tauri drops emits that have no registered listener,
/// so a tool call landing in the first ~5s of app boot needs to wait
/// for the listener to come up before the emit goes through).
///
/// Idempotent — repeat invocations no-op because the queue is already
/// empty and the flag stays true.
#[tauri::command]
pub fn mark_frontend_ready(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state
        .frontend_ready
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let drained: Vec<(Option<String>, Value)> = {
        let mut pending = state.pending_frontend_emits.lock();
        std::mem::take(&mut *pending)
    };
    for (target_label, payload) in drained {
        if let Some(label) = target_label {
            let _ = app.emit_to(&label, "agent-ide-tool", payload.clone());
            let _ = app.emit_to(&label, "claude-code-tool", payload);
        } else {
            let _ = app.emit("agent-ide-tool", payload.clone());
            let _ = app.emit("claude-code-tool", payload);
        }
    }
    Ok(())
}

/// Called by the frontend to forward a notification (e.g. selection change) to Claude CLI.
#[tauri::command]
pub fn claude_code_notify_selection(
    state: State<'_, Arc<AppState>>,
    payload: Value,
) -> Result<(), String> {
    let guard = state.ide_notify_tx.lock();
    if let Some(tx) = guard.as_ref() {
        let json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        tx.send(json).map_err(|e| e.to_string())
    } else {
        // No client connected, silently ignore
        Ok(())
    }
}

/// Re-apply on-disk integration for non-Claude runtimes after a preference toggle.
/// Claude is managed at startup + by the re-assert timer, so it's skipped here. Each
/// enabled runtime is (idempotently) installed and each disabled one unregistered, using
/// the live MCP port/auth. No-op when the MCP server isn't up yet. Lets a user enable
/// Codex from Preferences and have ~/.codex configured immediately, without a restart.
#[tauri::command]
pub fn refresh_agent_integrations(state: State<'_, Arc<AppState>>) {
    let port = match *state.mcp_port.read() {
        Some(p) => p,
        None => return,
    };
    let auth = state.mcp_auth.read().clone().unwrap_or_default();
    if auth.is_empty() {
        return;
    }
    let prefs = state.app_data.read().preferences.clone();
    for r in crate::claude_code::registrar::all_registrars() {
        if r.runtime() == crate::state::AgentRuntime::Claude {
            continue;
        }
        if r.enabled(&prefs) {
            r.install(port, &auth, &[], &prefs);
        } else {
            r.unregister(port, &auth);
        }
    }
}
