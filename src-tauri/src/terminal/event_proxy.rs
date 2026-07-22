use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::Arc;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::vte::ansi::Rgb;
use parking_lot::RwLock;
use tauri::{AppHandle, Emitter};

use crate::state::PtyCommand;
use crate::terminal::palette::ThemePalette;

/// Bridge between alacritty_terminal's internal events and our Tauri event system.
/// alacritty_terminal calls `send_event()` when the terminal state changes.
pub struct AitermEventProxy {
    pub pty_id: String,
    pub app_handle: AppHandle,
    pub pty_sender: Sender<PtyCommand>,
    /// App-level theme palette (pushed from the frontend) — answers OSC color queries.
    pub palette: Arc<RwLock<ThemePalette>>,
    /// Per-terminal program-set color overrides (mirrored by OscInterceptor).
    pub color_overrides: Arc<RwLock<HashMap<usize, Rgb>>>,
}

impl EventListener for AitermEventProxy {
    fn send_event(&self, event: Event) {
        match event {
            Event::Title(title) => {
                let _ = self.app_handle.emit(
                    &format!("term-title-{}", self.pty_id),
                    title,
                );
            }
            Event::Bell => {
                let _ = self.app_handle.emit(
                    &format!("term-bell-{}", self.pty_id),
                    (),
                );
            }
            Event::ClipboardStore(_clipboard_type, text) => {
                let _ = self.app_handle.emit(
                    &format!("term-clipboard-{}", self.pty_id),
                    text,
                );
            }
            Event::PtyWrite(text) => {
                let bytes = text.into_bytes();
                let _ = self.pty_sender.send(PtyCommand::Write(bytes));
            }
            Event::ResetTitle => {
                let _ = self.app_handle.emit(
                    &format!("term-title-{}", self.pty_id),
                    String::new(),
                );
            }
            // ColorRequest: OSC 4/10/11/12 query — answer with the program-set
            // override if one exists, else the actual theme color, so
            // theme-aware programs (vim, fzf, vivid) detect the real scheme.
            Event::ColorRequest(index, formatter) => {
                let rgb = self
                    .color_overrides
                    .read()
                    .get(&index)
                    .copied()
                    .unwrap_or_else(|| self.palette.read().resolve(index));
                let response = formatter(rgb);
                let _ = self.pty_sender.send(PtyCommand::Write(response.into_bytes()));
            }
            // TextAreaSizeRequest: terminal querying window size in pixels
            Event::TextAreaSizeRequest(formatter) => {
                // Respond with zeros — we don't have pixel info in the backend
                let response = formatter(alacritty_terminal::event::WindowSize {
                    num_lines: 0,
                    num_cols: 0,
                    cell_width: 0,
                    cell_height: 0,
                });
                let _ = self.pty_sender.send(PtyCommand::Write(response.into_bytes()));
            }
            // ClipboardLoad: terminal wants to read clipboard — denied by policy
            // (write-only OSC 52; reading the user's clipboard is a data leak).
            Event::ClipboardLoad(_clipboard_type, _formatter) => {}
            // Wakeup, CursorBlinkingChange, MouseCursorDirty, Exit, ChildExit — not needed
            _ => {}
        }
    }
}
