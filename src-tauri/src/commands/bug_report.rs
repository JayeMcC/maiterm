//! In-app bug reporting.
//!
//! Backs the hover pull-tab "BUG" button + BugReportModal in the frontend.
//! One call captures a diagnostics snapshot to a sidecar JSON file and files a
//! `- [ ]` item under the `## maiterm` section of the shared cross-repo todo,
//! so a bug the operator hits mid-session lands directly on the work queue with
//! full program state attached.
//!
//! The todo destination is `$MAITERM_BUG_TODO_PATH` when set, else the operator's
//! shared `~/proj/Jaye-memory/todo.md`. A future slice promotes this to a real
//! preference + settings-UI control (see the todo item's Slice 3).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::state::persistence::log_dir_slug;

/// Path (relative to `$HOME`) of the shared cross-repo todo used when
/// `$MAITERM_BUG_TODO_PATH` is unset.
const DEFAULT_TODO_REL: &str = "proj/Jaye-memory/todo.md";
/// The section new in-app bug items are filed under.
const TODO_SECTION: &str = "## maiterm";

/// Expand a leading `~` / `~/` against the home directory; otherwise verbatim.
fn expand_tilde(p: &str) -> PathBuf {
    if p == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(p));
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

/// Directory the snapshot sidecar files live in — mirrors `read_app_logs`'
/// log-dir resolution (`~/Library/Logs/<identifier>/` on macOS) plus
/// `bug-reports/`, so snapshots sit alongside the logs they reference.
fn bug_reports_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir()
        .or_else(dirs::config_dir)
        .map(|d| {
            if cfg!(target_os = "macos") {
                dirs::home_dir()
                    .unwrap_or(d.clone())
                    .join("Library/Logs")
                    .join(log_dir_slug())
            } else {
                d.join("aiterm/logs")
            }
        })
        .ok_or("Could not determine log directory")?;
    Ok(base.join("bug-reports"))
}

/// Render the markdown todo item. First description line rides on the `- [ ]`
/// header; any further lines become 2-space continuation lines (so the todo
/// cleanup script keeps them with the item), and the snapshot path is a nested
/// bullet.
fn render_todo_item(desc: &str, created_at: &str, version: &str, sidecar: &str) -> String {
    let desc = desc.trim();
    let mut lines = desc.lines();
    let head = lines
        .next()
        .filter(|l| !l.trim().is_empty())
        .unwrap_or("(no description provided)");

    let mut out =
        format!("- [ ] **Bug (in-app report, {created_at})** — maiTerm v{version}. {head}");
    for extra in lines {
        out.push('\n');
        out.push_str("  ");
        out.push_str(extra);
    }
    out.push('\n');
    out.push_str(&format!("  - State snapshot: `{sidecar}`"));
    out
}

/// Atomically replace `path`'s contents with `contents` (temp file + rename),
/// so a concurrent reader never sees a half-written todo file.
fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension(format!(
        "tmp-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&tmp, contents).map_err(|e| format!("write temp todo: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename temp todo: {e}"))
}

/// Insert `item` at the end of the `## maiterm` section of the todo at `path`
/// (before the next top-level `## ` heading). Returns `(path, section_found)`.
/// If the file is missing/empty or has no `## maiterm` heading, the section is
/// created at EOF and `section_found` is false.
fn append_to_todo(path: &Path, item: &str) -> Result<(String, bool), String> {
    let path_str = path.to_string_lossy().to_string();
    let existing = std::fs::read_to_string(path).unwrap_or_default();

    // No file / empty, or no maiterm section → create the section at the end.
    let section_start = existing.lines().position(|l| l.trim() == TODO_SECTION);

    if existing.trim().is_empty() || section_start.is_none() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create todo dir: {e}"))?;
        }
        let mut out = existing;
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(TODO_SECTION);
        out.push_str("\n\n");
        out.push_str(item);
        out.push('\n');
        atomic_write(path, &out)?;
        return Ok((path_str, false));
    }

    let start = section_start.unwrap();
    let mut lines: Vec<String> = existing.lines().map(String::from).collect();
    // End of the maiterm section = the next top-level heading, or EOF.
    let mut insert_at = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, l)| l.starts_with("## "))
        .map(|(i, _)| i)
        .unwrap_or(lines.len());
    // Sit the new item just after the last non-blank line of the section (skip
    // back over the blank lines that pad the section boundary).
    while insert_at > start + 1 && lines[insert_at - 1].trim().is_empty() {
        insert_at -= 1;
    }

    let mut idx = insert_at;
    for il in item.lines() {
        lines.insert(idx, il.to_string());
        idx += 1;
    }

    let mut out = lines.join("\n");
    if existing.ends_with('\n') {
        out.push('\n');
    }
    atomic_write(path, &out)?;
    Ok((path_str, true))
}

/// File an in-app bug report: write the diagnostics snapshot to a sidecar JSON
/// file and append a todo item under `## maiterm`.
///
/// * `description` — free-text from the modal (may be multi-line / empty).
/// * `diagnostics` — the `get_app_diagnostics` snapshot captured at report time.
/// * `created_at` — an ISO timestamp string from the frontend (JS `Date`).
#[tauri::command]
pub fn file_bug_report(
    description: String,
    diagnostics: serde_json::Value,
    created_at: String,
) -> Result<serde_json::Value, String> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let version = diagnostics
        .get("version")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    // 1. Sidecar snapshot.
    let dir = bug_reports_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create bug-reports dir: {e}"))?;
    let sidecar = dir.join(format!("bug-{secs}.json"));
    let payload = serde_json::json!({
        "description": description.trim(),
        "created_at": created_at,
        "app_version": version,
        "diagnostics": diagnostics,
    });
    let pretty =
        serde_json::to_string_pretty(&payload).map_err(|e| format!("serialize snapshot: {e}"))?;
    std::fs::write(&sidecar, pretty).map_err(|e| format!("write snapshot: {e}"))?;
    let sidecar_str = sidecar.to_string_lossy().to_string();

    // 2. Todo item.
    let item = render_todo_item(&description, &created_at, &version, &sidecar_str);

    // 3. Resolve + append the todo destination.
    let todo_path = match std::env::var("MAITERM_BUG_TODO_PATH") {
        Ok(v) if !v.trim().is_empty() => expand_tilde(v.trim()),
        _ => dirs::home_dir()
            .ok_or("Could not determine home directory")?
            .join(DEFAULT_TODO_REL),
    };
    let (todo_file, section_found) = append_to_todo(&todo_path, &item)?;

    log::info!(
        "Bug report filed → {} (section_found={}, snapshot {})",
        todo_file,
        section_found,
        sidecar_str
    );

    Ok(serde_json::json!({
        "todo_file": todo_file,
        "sidecar_path": sidecar_str,
        "section_found": section_found,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_single_line_item() {
        let out = render_todo_item(
            "app froze on split",
            "2026-08-16T10:00:00Z",
            "1.25.2",
            "/tmp/bug-1.json",
        );
        assert!(out.starts_with("- [ ] **Bug (in-app report, 2026-08-16T10:00:00Z)** — maiTerm v1.25.2. app froze on split"));
        assert!(out.contains("  - State snapshot: `/tmp/bug-1.json`"));
    }

    #[test]
    fn multiline_description_indents_continuation() {
        let out = render_todo_item("line one\nline two\nline three", "t", "v", "/s.json");
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(
            lines[0],
            "- [ ] **Bug (in-app report, t)** — maiTerm vv. line one"
        );
        assert_eq!(lines[1], "  line two");
        assert_eq!(lines[2], "  line three");
        assert_eq!(lines[3], "  - State snapshot: `/s.json`");
    }

    #[test]
    fn empty_description_uses_placeholder() {
        let out = render_todo_item("   ", "t", "v", "/s.json");
        assert!(out.contains("(no description provided)"));
    }

    #[test]
    fn appends_into_existing_section() {
        let dir = std::env::temp_dir().join(format!(
            "maiterm-bugtest-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("todo.md");
        std::fs::write(
            &path,
            "# TODO\n\n## alpha\n\n- [ ] a1\n\n## maiterm\n\n- [ ] existing\n\n## zeta\n\n- [ ] z1\n",
        )
        .unwrap();

        let (_, found) = append_to_todo(&path, "- [ ] NEW\n  - State snapshot: `/s.json`").unwrap();
        assert!(found);
        let out = std::fs::read_to_string(&path).unwrap();
        // Landed inside maiterm, after `existing`, before the zeta heading.
        let mai = out.find("## maiterm").unwrap();
        let zeta = out.find("## zeta").unwrap();
        let new = out.find("- [ ] NEW").unwrap();
        let existing = out.find("- [ ] existing").unwrap();
        assert!(existing < new && new < zeta && mai < new);
        // Other sections untouched.
        assert!(out.contains("- [ ] a1"));
        assert!(out.contains("- [ ] z1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_section_when_missing() {
        let dir = std::env::temp_dir().join(format!(
            "maiterm-bugtest2-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("todo.md");
        std::fs::write(&path, "# TODO\n\n## alpha\n\n- [ ] a1\n").unwrap();

        let (_, found) = append_to_todo(&path, "- [ ] NEW").unwrap();
        assert!(!found);
        let out = std::fs::read_to_string(&path).unwrap();
        assert!(out.contains("## maiterm"));
        assert!(out.contains("- [ ] NEW"));
        assert!(out.contains("- [ ] a1"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
