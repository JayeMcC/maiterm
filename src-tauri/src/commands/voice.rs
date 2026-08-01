use std::path::{Path, PathBuf};

use crate::claude_code::lockfile::is_process_alive;

/// Directory the voice-status hook scripts use for barge-in pid files, keyed
/// by Claude Code `session_id` (see scripts/voice-status/speak-status.sh and
/// barge-in.sh — both scripts' headers call out that this path must stay in
/// sync between them; this is the third reader of the same contract, so it
/// stays in sync too).
///
/// `speak-status.sh` backgrounds `say`, records its pid here for the
/// duration of the utterance, and removes the file once `say` exits.
/// `barge-in.sh` kills that pid (and removes the file) the instant a new
/// prompt is submitted. So "the pid file exists and its pid is alive" is
/// exactly "narration is audible right now" — the same signal both hook
/// scripts already rely on, just read instead of acted on.
fn voice_pid_dir() -> PathBuf {
    let tmp = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(tmp).join("maiterm-voice-pids")
}

/// Pure filter so this is unit-testable without touching the real `TMPDIR`
/// (tests run concurrently and env vars are process-global). Mirrors the
/// shell scripts' sanitization: `session_id` has `/` replaced with `_`
/// before it's used as a filename.
fn speaking_sessions_in(dir: &Path, session_ids: &[String]) -> Vec<String> {
    session_ids
        .iter()
        .filter(|id| {
            let sanitized = id.replace('/', "_");
            let pid_file = dir.join(format!("{sanitized}.pid"));
            let Ok(contents) = std::fs::read_to_string(&pid_file) else {
                return false;
            };
            contents
                .trim()
                .parse::<u32>()
                .map(is_process_alive)
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

/// Given a batch of Claude Code `session_id`s (one per tab currently tracked
/// by the frontend's agent-state store), return the subset that are
/// currently being narrated aloud by `speak-status.sh` — i.e. have a live
/// pid file. Batched (rather than one call per session) so a multi-tab
/// poll is a single round trip.
///
/// Never errors: a missing/unreadable pid file, an unparsable pid, or an
/// empty `TMPDIR` all just mean "not speaking" for that session — this is a
/// best-effort UI signal, not something a turn's correctness depends on.
#[tauri::command]
pub fn get_voice_speaking_sessions(session_ids: Vec<String>) -> Vec<String> {
    speaking_sessions_in(&voice_pid_dir(), &session_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "maiterm-voice-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn no_pid_file_means_not_speaking() {
        let dir = temp_dir("no-file");
        let result = speaking_sessions_in(&dir, &["abc-123".to_string()]);
        assert!(result.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_pid_means_speaking() {
        let dir = temp_dir("live-pid");
        // Our own pid is always alive for the duration of the test.
        fs::write(dir.join("abc-123.pid"), std::process::id().to_string()).unwrap();
        let result = speaking_sessions_in(&dir, &["abc-123".to_string(), "other-session".to_string()]);
        assert_eq!(result, vec!["abc-123".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dead_pid_means_not_speaking() {
        let dir = temp_dir("dead-pid");
        // PID 999999 is vanishingly unlikely to be a live process in any test env.
        fs::write(dir.join("abc-123.pid"), "999999").unwrap();
        let result = speaking_sessions_in(&dir, &["abc-123".to_string()]);
        assert!(result.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn garbage_pid_contents_means_not_speaking() {
        let dir = temp_dir("garbage-pid");
        fs::write(dir.join("abc-123.pid"), "not-a-pid").unwrap();
        let result = speaking_sessions_in(&dir, &["abc-123".to_string()]);
        assert!(result.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_id_with_slash_is_sanitized_to_match_the_hook_scripts() {
        let dir = temp_dir("slash-session");
        // barge-in.sh / speak-status.sh both do `session_id="${session_id//\//_}"`.
        fs::write(dir.join("foo_bar.pid"), std::process::id().to_string()).unwrap();
        let result = speaking_sessions_in(&dir, &["foo/bar".to_string()]);
        assert_eq!(result, vec!["foo/bar".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }
}
