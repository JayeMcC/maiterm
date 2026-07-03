//! Named window presets. Save the current window's shape as a template that
//! can be restored later into a fresh window. See docs/CLAUDE.md and the
//! workspace note titled "Window presets" for the design rationale — the point
//! is memory: the webview holding a window is ~15–25 MB, so a template that
//! reconstitutes the same workspaces + cwds without keeping the webview alive
//! is what actually lets a user hibernate windows.
//!
//! Presets live at `AppData.window_presets` (sibling of `windows`), NOT inside
//! `Preferences`, so the preferences roundtrip in `preferences.svelte.ts` can't
//! clobber them.

use std::sync::Arc;
use tauri::State;

use crate::commands::window::{build_window_sync, clone_workspace_with_id_mapping, TabContext};
use crate::commands::workspace::iso_now;
use crate::state::{save_state, AppState, WindowData};
use crate::state::workspace::WindowPreset;

/// Build a preset body from a live window: clone each workspace with fresh IDs
/// (this already drops pty_id, scrollback, mesh topics, agent bridges,
/// archived tabs, and the `suspended` flag), then also clear the transient
/// `trigger_variables` map on each tab so restored windows start clean.
///
/// `tab_contexts` carries per-tab cwd/ssh info from the frontend so the preset
/// captures where each tab was pointed at — same source of truth as the
/// duplicate-window path.
fn capture_window_body(source: &WindowData, tab_contexts: &[TabContext]) -> WindowData {
    // Label is unused in a preset body (each restore mints a new one) but
    // WindowData::new requires a value; pass an empty string.
    let mut body = WindowData::new(String::new());
    body.sidebar_width = source.sidebar_width;
    body.sidebar_collapsed = source.sidebar_collapsed;

    let mut active_workspace_id = None;
    for ws in &source.workspaces {
        let (mut cloned, _tab_map) = clone_workspace_with_id_mapping(ws, tab_contexts);
        for pane in &mut cloned.panes {
            for tab in &mut pane.tabs {
                tab.trigger_variables.clear();
            }
        }
        if source.active_workspace_id.as_deref() == Some(&ws.id) {
            active_workspace_id = Some(cloned.id.clone());
        }
        body.workspaces.push(cloned);
    }
    body.active_workspace_id = active_workspace_id;
    body
}

#[tauri::command]
pub fn list_window_presets(state: State<'_, Arc<AppState>>) -> Vec<WindowPreset> {
    state.app_data.read().window_presets.clone()
}

#[tauri::command]
pub fn save_window_preset(
    window: tauri::Window,
    state: State<'_, Arc<AppState>>,
    name: String,
    tab_contexts: Vec<TabContext>,
    overwrite: bool,
) -> Result<WindowPreset, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Preset name is required".into());
    }
    let label = window.label().to_string();

    let (preset, data_clone) = {
        let mut app_data = state.app_data.write();
        let source = app_data.window(&label)
            .ok_or_else(|| format!("Window '{}' not found", label))?
            .clone();
        let body = capture_window_body(&source, &tab_contexts);

        let existing = app_data.window_presets
            .iter()
            .position(|p| p.name.eq_ignore_ascii_case(&name));

        let preset = if let Some(idx) = existing {
            if !overwrite {
                return Err(format!("Preset '{}' already exists", name));
            }
            let existing_preset = &app_data.window_presets[idx];
            let updated = WindowPreset {
                id: existing_preset.id.clone(),
                name,
                created_at: existing_preset.created_at.clone(),
                updated_at: iso_now(),
                window: body,
            };
            app_data.window_presets[idx] = updated.clone();
            updated
        } else {
            let now = iso_now();
            let new_preset = WindowPreset {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                created_at: now.clone(),
                updated_at: now,
                window: body,
            };
            app_data.window_presets.push(new_preset.clone());
            new_preset
        };
        (preset, app_data.clone())
    };
    save_state(&data_clone)?;
    Ok(preset)
}

#[tauri::command]
pub fn open_window_preset(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    preset_id: String,
) -> Result<String, String> {
    // Snapshot the preset body + derive tab_contexts from each tab's stored
    // restore_cwd/ssh_command/remote_cwd so the restored tabs spawn where the
    // original session was pointed.
    let (preset_body, tab_contexts) = {
        let app_data = state.app_data.read();
        let preset = app_data.window_presets.iter()
            .find(|p| p.id == preset_id)
            .ok_or_else(|| format!("Preset '{}' not found", preset_id))?;
        let mut contexts = Vec::new();
        for ws in &preset.window.workspaces {
            for pane in &ws.panes {
                for tab in &pane.tabs {
                    contexts.push(TabContext {
                        tab_id: tab.id.clone(),
                        scrollback: None,
                        cwd: tab.restore_cwd.clone(),
                        ssh_command: tab.restore_ssh_command.clone(),
                        remote_cwd: tab.restore_remote_cwd.clone(),
                    });
                }
            }
        }
        (preset.window.clone(), contexts)
    };

    let new_label = format!("window-{}", uuid::Uuid::new_v4());

    let data_clone = {
        let mut app_data = state.app_data.write();
        let mut new_win = WindowData::new(new_label.clone());
        new_win.sidebar_width = preset_body.sidebar_width;
        new_win.sidebar_collapsed = preset_body.sidebar_collapsed;

        // Preserve source-order → cloned-order mapping so we can carry
        // active_workspace_id across the fresh UUID mint.
        for ws in &preset_body.workspaces {
            let (cloned, _) = clone_workspace_with_id_mapping(ws, &tab_contexts);
            new_win.workspaces.push(cloned);
        }
        if let Some(ref active_id) = preset_body.active_workspace_id {
            if let Some(idx) = preset_body.workspaces.iter().position(|w| w.id == *active_id) {
                if let Some(cloned_ws) = new_win.workspaces.get(idx) {
                    new_win.active_workspace_id = Some(cloned_ws.id.clone());
                }
            }
        }
        app_data.windows.push(new_win);
        app_data.clone()
    };
    save_state(&data_clone)?;

    // Spawn webview on a background thread — same rationale as create_window.
    let app_clone = app.clone();
    let label_clone = new_label.clone();
    std::thread::spawn(move || {
        if let Err(e) = build_window_sync(&app_clone, &label_clone) {
            log::error!("Failed to create window from preset '{}': {}", label_clone, e);
        }
    });

    Ok(new_label)
}

#[tauri::command]
pub fn delete_window_preset(
    state: State<'_, Arc<AppState>>,
    preset_id: String,
) -> Result<(), String> {
    let data_clone = {
        let mut app_data = state.app_data.write();
        app_data.window_presets.retain(|p| p.id != preset_id);
        app_data.clone()
    };
    save_state(&data_clone)?;
    Ok(())
}

#[tauri::command]
pub fn rename_window_preset(
    state: State<'_, Arc<AppState>>,
    preset_id: String,
    new_name: String,
) -> Result<(), String> {
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() {
        return Err("Preset name is required".into());
    }
    let data_clone = {
        let mut app_data = state.app_data.write();
        if app_data.window_presets.iter()
            .any(|p| p.id != preset_id && p.name.eq_ignore_ascii_case(&new_name))
        {
            return Err(format!("Preset '{}' already exists", new_name));
        }
        let preset = app_data.window_presets.iter_mut()
            .find(|p| p.id == preset_id)
            .ok_or_else(|| format!("Preset '{}' not found", preset_id))?;
        preset.name = new_name;
        preset.updated_at = iso_now();
        app_data.clone()
    };
    save_state(&data_clone)?;
    Ok(())
}

// ── Portable export / import (share a window setup as JSON) ──────────────────

const SETUP_VERSION: u32 = 1;

/// Portable window-setup envelope. Wraps a captured (machine-state-stripped)
/// window body + metadata. Local cwds are relativized to `~` on export and
/// expanded on import so a setup shared between users with the same relative
/// layout re-creates cleanly.
#[derive(serde::Serialize, serde::Deserialize)]
struct SetupEnvelope {
    #[serde(rename = "maitermSetup")]
    version: u32,
    name: String,
    #[serde(rename = "exportedAt", default)]
    exported_at: String,
    window: WindowData,
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|h| !h.is_empty())
}

/// Apply `f` to every tab's LOCAL `restore_cwd`. Remote cwds and ssh commands
/// are left untouched — host/account-specific, not meaningfully portable.
fn map_local_cwds(body: &mut WindowData, f: &dyn Fn(&str) -> String) {
    for ws in &mut body.workspaces {
        for pane in &mut ws.panes {
            for tab in &mut pane.tabs {
                if let Some(cwd) = tab.restore_cwd.as_deref() {
                    tab.restore_cwd = Some(f(cwd));
                }
            }
        }
    }
}

fn relativize_cwds(body: &mut WindowData) {
    let Some(home) = home_dir() else { return };
    let prefix = format!("{home}/");
    map_local_cwds(body, &|p| {
        if p == home {
            "~".to_string()
        } else if let Some(rest) = p.strip_prefix(&prefix) {
            format!("~/{rest}")
        } else {
            p.to_string()
        }
    });
}

fn expand_cwds(body: &mut WindowData) {
    let Some(home) = home_dir() else { return };
    map_local_cwds(body, &|p| {
        if p == "~" {
            home.clone()
        } else if let Some(rest) = p.strip_prefix("~/") {
            format!("{home}/{rest}")
        } else {
            p.to_string()
        }
    });
}

/// De-duplicate an imported preset name against the existing list.
fn unique_preset_name(existing: &[WindowPreset], base: &str) -> String {
    let base = if base.trim().is_empty() { "Imported setup" } else { base.trim() };
    let taken = |n: &str| existing.iter().any(|p| p.name.eq_ignore_ascii_case(n));
    if !taken(base) {
        return base.to_string();
    }
    for i in 2.. {
        let candidate = format!("{base} ({i})");
        if !taken(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

/// Export the current window's arrangement as a portable JSON string. Reuses the
/// preset-capture path (drops pty_id, scrollback, bridges, …), relativizes local
/// cwds, and wraps in a versioned envelope for sharing.
#[tauri::command]
pub fn export_window_setup(
    window: tauri::Window,
    state: State<'_, Arc<AppState>>,
    tab_contexts: Vec<TabContext>,
    name: Option<String>,
    path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let source = state
        .app_data
        .read()
        .window(&label)
        .ok_or_else(|| format!("Window '{label}' not found"))?
        .clone();
    let mut body = capture_window_body(&source, &tab_contexts);
    relativize_cwds(&mut body);
    let envelope = SetupEnvelope {
        version: SETUP_VERSION,
        name: name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "maiTerm setup".into()),
        exported_at: iso_now(),
        window: body,
    };
    let json = serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Import a setup JSON string as a new window preset. Expands cwds to the local
/// home and de-dupes the name; the caller then `open_window_preset`s it to spawn
/// the arrangement (which mints fresh workspace/pane/tab IDs).
#[tauri::command]
pub fn import_window_setup(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<WindowPreset, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let mut envelope: SetupEnvelope =
        serde_json::from_str(&json).map_err(|e| format!("Invalid setup JSON: {e}"))?;
    if envelope.version != SETUP_VERSION {
        return Err(format!(
            "Unsupported setup version {} (this build expects {})",
            envelope.version, SETUP_VERSION
        ));
    }
    expand_cwds(&mut envelope.window);

    let (preset, data_clone) = {
        let mut app_data = state.app_data.write();
        let name = unique_preset_name(&app_data.window_presets, &envelope.name);
        let now = iso_now();
        let preset = WindowPreset {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            created_at: now.clone(),
            updated_at: now,
            window: envelope.window,
        };
        app_data.window_presets.push(preset.clone());
        (preset, app_data.clone())
    };
    save_state(&data_clone)?;
    Ok(preset)
}
