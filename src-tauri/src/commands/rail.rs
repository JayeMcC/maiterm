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

/// POSIX single-quote a token (wrap in '…', escape embedded ' as '\'' ).
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Run a one-shot provider command and capture its output. NOT a PTY — this is
/// for machine-readable provider calls (list/status) and fire-and-report
/// buttons, bounded by a timeout so a hung provider can't wedge the rail.
///
/// `login_shell`: a GUI-launched app inherits a minimal PATH (no homebrew, no
/// node, no user bins), so a bare provider name won't resolve. With
/// `login_shell = true` the command runs via `$SHELL -lc '<quoted>'`, which
/// sources the user's login profile and gets their real dev environment.
#[command]
pub async fn run_rail_provider(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    login_shell: Option<bool>,
) -> Result<ProviderResult, String> {
    let mut cmd = if login_shell.unwrap_or(false) {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut line = sh_quote(&program);
        for a in &args {
            line.push(' ');
            line.push_str(&sh_quote(a));
        }
        let mut c = tokio::process::Command::new(shell);
        c.arg("-lc").arg(line);
        c
    } else {
        let mut c = tokio::process::Command::new(&program);
        c.args(&args);
        c
    };
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
