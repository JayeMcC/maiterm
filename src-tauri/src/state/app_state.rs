use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::mpsc::Sender;
use std::time::Instant;

use super::persistence::app_data_slug;
use super::scrollback_db::ScrollbackDb;
use super::workspace::AppData;
use crate::terminal::handle::TerminalHandle;

pub enum PtyCommand {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Kill,
}

pub struct PtyHandle {
    pub sender: Sender<PtyCommand>,
    pub child_pid: Option<u32>,
}

pub struct FileWatcherHandle {
    pub _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
}

/// Per-PTY byte counter
pub struct PtyStats {
    pub bytes_written: AtomicU64,
    pub bytes_read: AtomicU64,
    /// Millis since UNIX_EPOCH of the last PTY read. Used to detect an
    /// actively-drawing TUI so resizes can be coalesced (see resize_pty).
    pub last_read_ms: AtomicU64,
}

/// A resize waiting for the trailing debounce while the PTY is streaming.
/// Coalescing rapid resize requests into one SIGWINCH matters because TUIs
/// (Claude Code) re-render retained content on every width change — each one
/// mid-stream leaves a permanent duplicate in scrollback.
pub struct PendingResize {
    pub cols: u16,
    pub rows: u16,
    pub last_request: Instant,
}

/// Ring buffer cap for memory_samples. 720 samples × 60s cadence = 12h of history.
/// At ~40 bytes per sample serialized, the on-disk JSON stays under ~30KB.
pub const MEMORY_SAMPLE_CAP: usize = 720;

/// Memory sample emitted by the periodic memory_sampler task.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct MemorySample {
    pub timestamp_secs: u64,
    pub rss_bytes: u64,
}

/// Remote file watch entry for SSH-based polling.
pub struct RemoteFileWatch {
    pub user_host: String,
    pub remote_path: String,
    pub last_mtime: Option<u64>,
}

/// Active SSH MCP tunnel info (reverse port forward to expose local MCP on remote).
pub struct SshTunnel {
    pub pid: u32,
    pub remote_port: u16,
    pub host_key: String,
    pub tab_ids: std::collections::HashSet<String>,
    /// The ssh destination args the tunnel was started with (e.g. "-p 2222 user@host").
    /// Reused verbatim by the SSH transcript mirror so its fetch commands hit the same
    /// destination (and can mux over the tunnel's ControlMaster socket).
    pub ssh_args: String,
}

/// Per-session coalescing state for the SSH transcript mirror (mailink/mirror.rs).
/// One fetch in flight per session; events landing mid-fetch set `dirty` so the worker
/// loops once more instead of overlapping ssh processes.
#[derive(Default)]
pub struct RemoteMirrorEntry {
    pub in_flight: bool,
    pub dirty: bool,
    /// Unix-ms until which new fetches are skipped after a failure (backoff).
    pub backoff_until_ms: u64,
}

/// Per-model error-class counters — the live counterpart of one row of Slice 1's offline batch
/// pass (`scripts/claude-model-error-rates.mjs`) `summary.models[model]`. Field names/semantics
/// mirror that script exactly (classification lives in `claude_code::model_errors`, ported
/// 1:1 from the script's `classify*` functions) so a fixture run through both produces the
/// same numbers.
#[derive(Clone, Default, serde::Serialize)]
pub struct ModelErrorCounts {
    pub turns: u64,
    pub tool_calls: u64,
    pub tool_errors: u64,
    pub errors_by_class: HashMap<String, u64>,
    pub retry_events: u64,
}

/// Per-session live-transcript-tailer bookkeeping for `claude_code::model_errors`: how far the
/// session's transcript JSONL has been read (byte offset, like `RemoteMirrorEntry` above but for
/// a direct local read instead of an ssh round trip) plus the classifier's own running state
/// (current model, in-flight `tool_use_id` → model correlation). Unlike the offline script's
/// `Map` — fine for a one-shot batch pass — `tool_use_model` is pruned the moment a `tool_use` is
/// matched to its `tool_result`, so a long-running live session doesn't accumulate unbounded
/// state for calls that already resolved.
#[derive(Default)]
pub struct ErrorTailState {
    pub offset: u64,
    pub current_model: Option<String>,
    pub tool_use_model: HashMap<String, String>,
}

/// Tracked Claude Code session (registered via hooks).
pub struct AgentSessionInfo {
    /// Which agent runtime owns this session; detected at initSession (Stage 3 sets Claude everywhere as a placeholder).
    #[allow(dead_code)]
    pub runtime: crate::state::AgentRuntime,
    pub tab_id: String,
    pub cwd: Option<String>,
    pub state: AgentSessionState,
    /// Current tool being executed (set by PreToolUse, cleared by PostToolUse/Stop)
    pub tool_name: Option<String>,
    /// Compact primary-argument label for the current tool (e.g. `rm -rf ./dist` for Bash),
    /// extracted from the PreToolUse `tool_input` (or a Codex PermissionRequest, which carries
    /// tool_name/tool_input directly). Lets the maiLink permission card show WHAT is being
    /// approved, not just which tool. Cleared with tool_name.
    pub tool_detail: Option<String>,
    /// Structured content of an open AskUserQuestion: the raw `tool_input` captured from the
    /// PreToolUse hook (its `questions[]` drive the maiLink structured PendingPrompt). Set when
    /// AskUserQuestion starts, cleared when it completes (PostToolUse) or the turn stops.
    pub pending_question: Option<serde_json::Value>,
    /// Unix-ms when `pending_question` was captured. Claude Code auto-resolves an unanswered
    /// AskUserQuestion after ~60s ("user may be away"), so the phone needs the ask's age to
    /// show/expire its answer card. Set/cleared with pending_question.
    pub pending_question_at: Option<i64>,
    /// Model used in this session (set by SessionStart)
    pub model: Option<String>,
    /// Absolute path of the session's transcript JSONL *on the host where the agent runs* — a
    /// REMOTE path for SSH tabs. Every Claude hook payload carries it verbatim (even through the
    /// SSH reverse tunnel); captured/refreshed by hooks_handler so the SSH transcript mirror
    /// (mailink/mirror.rs) knows exactly what file to fetch. Claude-only today.
    pub transcript_path: Option<String>,
    /// MCP connection ID that called initSession for this session.
    /// Used to recover affinity after SSE reconnects: if a session's
    /// connection_id is no longer in connection_tabs, it's orphaned.
    pub connection_id: Option<String>,
    /// Subagents (Task-tool fan-out) spawned by this session, keyed by Claude's
    /// `agent_id` — the correlation id present on SubagentStart/SubagentStop and on
    /// PreToolUse/PostToolUse payloads fired *inside* a subagent (see
    /// `src-tauri/src/claude_code/CLAUDE.md` § Claude Code Hooks Integration). Lets
    /// the maiTerm UI show live fan-out progress the parent session's own
    /// `tool_name`/`tool_detail` can't represent (those track only ONE in-flight
    /// tool at a time — a subagent's tool calls would otherwise clobber them).
    pub subagents: HashMap<String, SubagentInfo>,
    /// Live per-model error-class counts for this session (API errors, refusal fallbacks,
    /// `max_tokens` truncation, tool-call failures — see `claude_code::model_errors`),
    /// incrementally tailed from this session's own transcript JSONL on every hook event.
    /// Scoped to the CURRENT session only, same precedent as `subagents` above: cleared when the
    /// session ends, not carried over to a resumed session (see that module's doc comment for
    /// the cross-resume follow-up).
    pub error_counts: HashMap<String, ModelErrorCounts>,
}

impl AgentSessionInfo {
    /// Insert a fresh subagent (SubagentStart), evicting the oldest non-`Running`
    /// entry first if already at `MAX_TRACKED_SUBAGENTS` — bounds a long session's
    /// map without ever dropping a still-live subagent.
    pub fn insert_subagent(&mut self, agent_id: String, info: SubagentInfo) {
        if self.subagents.len() >= MAX_TRACKED_SUBAGENTS && !self.subagents.contains_key(&agent_id) {
            let oldest_finished = self
                .subagents
                .iter()
                .filter(|(_, s)| s.state != SubagentState::Running)
                .min_by_key(|(_, s)| s.started_at_ms)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest_finished {
                self.subagents.remove(&id);
            }
        }
        self.subagents.insert(agent_id, info);
    }
}

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionState {
    Active,
    WaitingInput,
    WaitingPermission,
    Stopped,
}

/// One completed (or in-flight-when-logged) tool call inside a subagent — the
/// "small log of commands / tool calls" the subagent panel expands to show.
/// Logged at PreToolUse time (invocation), not PostToolUse, so a subagent that
/// never returns still leaves a visible trail of what it was doing.
#[derive(Clone, serde::Serialize)]
pub struct SubagentLogEntry {
    pub tool_name: String,
    pub detail: Option<String>,
    pub at_ms: i64,
}

/// Lifecycle of a tracked subagent. Claude Code's hooks give no explicit failure
/// signal (SubagentStop fires the same way whether the subagent succeeded or
/// errored) — `Failed` means "the parent session ended while this subagent was
/// still `Running`" (interrupted, never got its Stop). Part of the shared schema
/// with the frontend's independent `subagents.svelte.ts` map, which is what
/// actually infers `Failed` on `agent-hook-session-end` — this server-side map
/// entry is discarded along with the whole session at that point (see
/// `HookPhase::SessionEnd`), so there is nothing to gain mutating it here first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentState {
    Running,
    Done,
    #[allow(dead_code)] // never constructed server-side; see doc comment above
    Failed,
}

/// A subagent (Task-tool spawn) tracked within a parent agent session. See
/// `AgentSessionInfo::subagents` for why this exists as a separate per-agent_id
/// map rather than reusing the session's own tool_name/tool_detail fields.
#[derive(Clone, serde::Serialize)]
pub struct SubagentInfo {
    /// Claude's agent type/name, e.g. "general-purpose", "Explore", or a custom
    /// subagent's frontmatter `name` (plugin-scoped subagents use `plugin:name`).
    pub agent_type: String,
    pub state: SubagentState,
    /// Tool currently in flight inside the subagent (PreToolUse sets, PostToolUse clears).
    pub tool_name: Option<String>,
    pub tool_detail: Option<String>,
    /// Bounded trail of tool invocations, oldest first, capped at SUBAGENT_LOG_CAP.
    pub log: Vec<SubagentLogEntry>,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Per-subagent tool-call log cap. Bounds memory for a long-running subagent that
/// churns through many tool calls (e.g. a recon agent grepping repeatedly).
pub const SUBAGENT_LOG_CAP: usize = 50;

/// Cap on how many subagents (across all states) one session tracks at once.
/// A very long conversation can fan out dozens of subagents over its lifetime;
/// once over the cap, the oldest non-`Running` entry is evicted on next insert
/// so the live/most-recent picture never gets crowded out. `Running` entries are
/// never evicted.
pub const MAX_TRACKED_SUBAGENTS: usize = 40;

pub struct AppState {
    pub scrollback_db: ScrollbackDb,
    pub pty_registry: RwLock<HashMap<String, PtyHandle>>,
    /// alacritty_terminal instances keyed by pty_id
    pub terminal_registry: RwLock<HashMap<String, TerminalHandle>>,
    /// Maps tab_id → pty_id so we can auto-kill a previous PTY when a new one
    /// is spawned for the same tab (e.g. HMR remount, frontend crash recovery).
    pub tab_pty_map: RwLock<HashMap<String, String>>,
    pub app_data: RwLock<AppData>,
    // File watchers keyed by tab ID
    pub file_watchers: RwLock<HashMap<String, FileWatcherHandle>>,
    // In-flight SCP uploads: upload_id → cooperative cancel flag
    pub scp_uploads: RwLock<HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    // Embedded MCP / IDE server (shared across agent runtimes; one server, one port/auth)
    pub mcp_port: RwLock<Option<u16>>,
    pub mcp_auth: RwLock<Option<String>>,
    pub ide_pending: RwLock<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>,
    pub ide_connected: RwLock<bool>,
    pub ide_notify_tx: parking_lot::Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>,
    pub mcp_shutdown: parking_lot::Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    // SSH MCP tunnels: keyed by host_key (user@host)
    pub ssh_tunnels: RwLock<HashMap<String, SshTunnel>>,
    // Per-host single-flight locks for tunnel establishment: an app restart re-bridges
    // many tabs at once, often to the same server — serialize same-host starts so the
    // first caller spawns the tunnel and the rest reuse it. Keyed by host_key.
    pub ssh_tunnel_start_locks:
        parking_lot::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
    // Remote file watchers (SSH stat polling): keyed by tab_id
    pub remote_file_watchers: RwLock<HashMap<String, RemoteFileWatch>>,
    // SSH transcript mirror fetch coalescing: keyed by session_id
    pub remote_mirrors: RwLock<HashMap<String, RemoteMirrorEntry>>,
    pub remote_watcher_running: std::sync::atomic::AtomicBool,
    // Live per-model error-class tailer bookkeeping (claude_code::model_errors), keyed by
    // session_id — parallel to remote_mirrors above, but for the local classification tailer
    // (offset + classifier running state) rather than an ssh mirror fetch.
    pub error_tail_state: RwLock<HashMap<String, ErrorTailState>>,
    // Resizes deferred while the PTY is actively streaming (keyed by pty_id)
    pub pending_resizes: RwLock<HashMap<String, PendingResize>>,
    // Diagnostics
    pub pty_stats: RwLock<HashMap<String, PtyStats>>,
    pub memory_samples: RwLock<Vec<MemorySample>>,
    // Agent hook sessions (Claude/Codex/…): session_id → session info
    pub agent_sessions: RwLock<HashMap<String, AgentSessionInfo>>,
    // Pending session IDs from SessionStart HTTP hooks awaiting initSession to assign a tab
    pub pending_agent_sessions: RwLock<Vec<(String, Option<String>, Instant)>>, // (session_id, cwd, timestamp)
    /// Set once the frontend's `agent-ide-tool` listener has been registered
    /// (the Svelte layout calls `mark_frontend_ready` after `appWindow.listen`
    /// resolves). Until this is true, frontend-emitted MCP tool requests go
    /// into `pending_frontend_emits` instead of firing into the void —
    /// Tauri's event system drops emits with no registered listener and
    /// won't queue them itself.
    pub frontend_ready: std::sync::atomic::AtomicBool,
    /// Buffered `agent-ide-tool` payloads waiting for the frontend listener.
    /// Each entry is `(target_window_label_or_None, payload_value)`. Flushed
    /// in FIFO order from `mark_frontend_ready`.
    pub pending_frontend_emits: parking_lot::Mutex<Vec<(Option<String>, serde_json::Value)>>,
    // maiLink: outstanding one-time pairing codes → expiry instant (docs/mailink-protocol.md §3.2)
    pub mailink_pairing_codes: RwLock<HashMap<String, Instant>>,
    // maiLink: the live listener's (fingerprint, port), set when the bridge starts so the
    // pairing-code command can build the QR payload without re-reading the cert. None ⇒ the
    // listener is not running (boot-with-bridge-off, or toggled off at runtime).
    pub mailink_info: RwLock<Option<(String, u16)>>,
    // maiLink: graceful-shutdown handle for the running axum listener, so a runtime disable can
    // stop it (the bridge can be toggled on/off without an app restart).
    pub mailink_shutdown: RwLock<Option<axum_server::Handle>>,
    // maiLink doorbell coverage: count of live WS connections. >0 ⇒ a phone is connected and
    // receiving events directly, so the push doorbell is suppressed.
    pub mailink_ws_count: std::sync::atomic::AtomicUsize,
    // maiLink doorbell coverage: millis-since-epoch of the last WS disconnect. A foregrounded
    // phone's WS can blip (drop+reconnect) in well under a second; without a grace window that
    // momentary count==0 lets an attention transition ring the doorbell spuriously. The doorbell
    // treats a tab as covered for a short grace after this instant even at count==0. 0 ⇒ never dropped.
    pub mailink_ws_last_drop_ms: AtomicU64,
    /// Terminal color scheme pushed from the frontend theme system; shared into
    /// each PTY's event proxy so OSC 4/10/11/12 color queries answer truthfully.
    pub terminal_palette: std::sync::Arc<RwLock<crate::terminal::palette::ThemePalette>>,
}

impl AppState {
    pub fn new() -> Self {
        let db_path = dirs::data_dir()
            .expect("No data directory found")
            .join(app_data_slug())
            .join("aiterm-scrollback.db");
        let scrollback_db = ScrollbackDb::open(db_path)
            .expect("Failed to open scrollback database");

        Self {
            scrollback_db,
            pty_registry: RwLock::new(HashMap::new()),
            terminal_registry: RwLock::new(HashMap::new()),
            tab_pty_map: RwLock::new(HashMap::new()),
            app_data: RwLock::new(AppData::default()),
            file_watchers: RwLock::new(HashMap::new()),
            scp_uploads: RwLock::new(HashMap::new()),
            mcp_port: RwLock::new(None),
            mcp_auth: RwLock::new(None),
            ide_pending: RwLock::new(HashMap::new()),
            ide_connected: RwLock::new(false),
            ide_notify_tx: parking_lot::Mutex::new(None),
            mcp_shutdown: parking_lot::Mutex::new(None),
            ssh_tunnels: RwLock::new(HashMap::new()),
            ssh_tunnel_start_locks: parking_lot::Mutex::new(HashMap::new()),
            remote_file_watchers: RwLock::new(HashMap::new()),
            remote_mirrors: RwLock::new(HashMap::new()),
            remote_watcher_running: std::sync::atomic::AtomicBool::new(false),
            error_tail_state: RwLock::new(HashMap::new()),
            pending_resizes: RwLock::new(HashMap::new()),
            pty_stats: RwLock::new(HashMap::new()),
            memory_samples: RwLock::new(Vec::new()),
            agent_sessions: RwLock::new(HashMap::new()),
            pending_agent_sessions: RwLock::new(Vec::new()),
            frontend_ready: std::sync::atomic::AtomicBool::new(false),
            pending_frontend_emits: parking_lot::Mutex::new(Vec::new()),
            mailink_pairing_codes: RwLock::new(HashMap::new()),
            mailink_info: RwLock::new(None),
            mailink_shutdown: RwLock::new(None),
            mailink_ws_count: std::sync::atomic::AtomicUsize::new(0),
            mailink_ws_last_drop_ms: AtomicU64::new(0),
            terminal_palette: std::sync::Arc::new(RwLock::new(
                crate::terminal::palette::ThemePalette::default(),
            )),
        }
    }

    /// Current alacritty grid size for a live PTY, if one exists.
    pub fn live_grid_size(&self, pty_id: &str) -> Option<(u16, u16)> {
        use alacritty_terminal::grid::Dimensions;
        let registry = self.terminal_registry.read();
        let handle = registry.get(pty_id)?;
        Some((handle.term.columns() as u16, handle.term.screen_lines() as u16))
    }
}

#[cfg(test)]
mod subagent_tests {
    use super::*;

    fn mk_session() -> AgentSessionInfo {
        AgentSessionInfo {
            runtime: crate::state::AgentRuntime::Claude,
            tab_id: "tab-1".to_string(),
            cwd: None,
            state: AgentSessionState::Active,
            tool_name: None,
            tool_detail: None,
            pending_question: None,
            pending_question_at: None,
            model: None,
            transcript_path: None,
            connection_id: None,
            subagents: HashMap::new(),
            error_counts: HashMap::new(),
        }
    }

    fn mk_subagent(state: SubagentState, started_at_ms: i64) -> SubagentInfo {
        SubagentInfo {
            agent_type: "general-purpose".to_string(),
            state,
            tool_name: None,
            tool_detail: None,
            log: Vec::new(),
            started_at_ms,
            updated_at_ms: started_at_ms,
        }
    }

    #[test]
    fn insert_subagent_never_evicts_a_running_entry() {
        let mut session = mk_session();
        for i in 0..MAX_TRACKED_SUBAGENTS {
            session.insert_subagent(format!("running-{i}"), mk_subagent(SubagentState::Running, i as i64));
        }
        assert_eq!(session.subagents.len(), MAX_TRACKED_SUBAGENTS);
        // One more Running insert has nothing evictable — the map grows past the cap
        // rather than dropping a live subagent.
        session.insert_subagent("running-extra".to_string(), mk_subagent(SubagentState::Running, 999));
        assert_eq!(session.subagents.len(), MAX_TRACKED_SUBAGENTS + 1);
        assert!(session.subagents.values().all(|s| s.state == SubagentState::Running));
    }

    #[test]
    fn insert_subagent_evicts_the_oldest_finished_entry_at_capacity() {
        let mut session = mk_session();
        // One Done subagent, started earliest — the eviction candidate.
        session.insert_subagent("oldest-done".to_string(), mk_subagent(SubagentState::Done, 0));
        // Fill the rest with newer Running subagents up to the cap.
        for i in 1..MAX_TRACKED_SUBAGENTS {
            session.insert_subagent(format!("running-{i}"), mk_subagent(SubagentState::Running, i as i64));
        }
        assert_eq!(session.subagents.len(), MAX_TRACKED_SUBAGENTS);
        assert!(session.subagents.contains_key("oldest-done"));

        // Inserting one more at capacity evicts the oldest non-Running entry, never a
        // Running one.
        session.insert_subagent("new-arrival".to_string(), mk_subagent(SubagentState::Running, 1000));
        assert_eq!(session.subagents.len(), MAX_TRACKED_SUBAGENTS);
        assert!(!session.subagents.contains_key("oldest-done"), "the oldest finished entry should have been evicted");
        assert!(session.subagents.contains_key("new-arrival"));
    }

    #[test]
    fn insert_subagent_replacing_an_existing_id_never_triggers_eviction() {
        let mut session = mk_session();
        for i in 0..MAX_TRACKED_SUBAGENTS {
            session.insert_subagent(format!("id-{i}"), mk_subagent(SubagentState::Done, i as i64));
        }
        assert_eq!(session.subagents.len(), MAX_TRACKED_SUBAGENTS);
        // Re-inserting an ALREADY-TRACKED id (e.g. a fresh SubagentStart reusing a
        // stale key) is a replace, not a net-new entry — must not evict anything else.
        session.insert_subagent("id-0".to_string(), mk_subagent(SubagentState::Running, 5000));
        assert_eq!(session.subagents.len(), MAX_TRACKED_SUBAGENTS);
        assert_eq!(session.subagents.get("id-0").unwrap().state, SubagentState::Running);
    }
}
