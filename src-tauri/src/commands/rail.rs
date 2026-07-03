//! Hotbar rail backend (PLAN-15 stream 3 / ADR 0006).
//!
//! The rail is a right-edge fold-out whose sections derive from the active
//! tab's working directory. Two host-side primitives back it:
//!   - `find_markers_upward`: cheap detector — walk up from a cwd looking for
//!     marker files (`.vscode/tasks.json`, `.devcontainer/devcontainer.json`).
//!   - `run_rail_provider`: run an external provider command (e.g.
//!     `forwood-launcher --list --json --dir <cwd>`) and return its stdout.
//!
//! The app stays forwood-agnostic: markers and provider commands are supplied
//! by the caller (from preferences), so this is a generic "contextual action
//! rail", upstreamable as such.

use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedMarker {
    /// The marker relative path that matched, e.g. `.vscode/tasks.json`.
    pub marker: String,
    /// The ancestor directory that owns the marker (the repo root for it).
    pub root: String,
    /// The full path to the matched marker file.
    pub path: String,
}

/// Walk up from `start_dir` (inclusive) to the filesystem root; for each
/// marker return the FIRST ancestor that contains it (innermost owner wins).
/// A marker with no match up-tree is simply absent from the result.
#[command]
pub async fn find_markers_upward(
    start_dir: String,
    markers: Vec<String>,
) -> Result<Vec<DetectedMarker>, String> {
    let start = std::path::Path::new(&start_dir);
    if !start.exists() {
        return Err(format!("no such directory: {start_dir}"));
    }

    let mut found: Vec<DetectedMarker> = Vec::new();
    let mut remaining: Vec<String> = markers;

    for ancestor in start.ancestors() {
        if remaining.is_empty() {
            break;
        }
        remaining.retain(|marker| {
            let candidate = ancestor.join(marker);
            if candidate.exists() {
                found.push(DetectedMarker {
                    marker: marker.clone(),
                    root: ancestor.to_string_lossy().to_string(),
                    path: candidate.to_string_lossy().to_string(),
                });
                false // resolved — stop looking for this marker
            } else {
                true
            }
        });
    }

    Ok(found)
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Run a one-shot provider command and capture its output. NOT a PTY — this is
/// for machine-readable provider calls (list/status) and fire-and-report
/// buttons, bounded by a timeout so a hung provider can't wedge the rail.
#[command]
pub async fn run_rail_provider(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<ProviderResult, String> {
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args);
    if let Some(dir) = cwd.as_ref() {
        cmd.current_dir(dir);
    }

    let secs = timeout_secs.unwrap_or(15);
    let output = tokio::time::timeout(std::time::Duration::from_secs(secs), cmd.output())
        .await
        .map_err(|_| format!("provider '{program}' timed out after {secs}s"))?
        .map_err(|e| format!("provider '{program}' failed to run: {e}"))?;

    Ok(ProviderResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}
