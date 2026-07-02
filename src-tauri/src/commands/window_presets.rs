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
