use std::collections::HashMap;
use std::sync::Arc;

use alacritty_terminal::vte::ansi::Rgb;
use base64::Engine;
use parking_lot::RwLock;

use super::palette::parse_color_spec;

/// Events extracted from OSC sequences in raw PTY output.
/// These are maiTerm-specific features that alacritty_terminal doesn't handle natively.
#[derive(Debug, Clone)]
pub enum OscEvent {
    /// OSC 7: CWD report — file://host/path
    Cwd { cwd: String, host: Option<String> },
    /// OSC 133/633: Shell integration (FinalTerm/VS Code)
    ShellIntegration { cmd: char, exit_code: Option<i32> },
    /// OSC 9/777/99: Notification request (non-protocol text only)
    Notification { message: String },
    /// OSC 1337: iTerm2 CurrentDir
    CurrentDir { cwd: String },
    /// OSC 1: Icon name (shown as tab tooltip / secondary label)
    IconName { name: String },
    /// OSC 1337 SetUserVar: key + decoded value (feeds the trigger-variable store)
    UserVar { key: String, value: String },
}

/// Lightweight state machine that scans raw PTY bytes for OSC sequences.
/// Bytes pass through unchanged — alacritty_terminal still sees everything.
pub struct OscInterceptor {
    /// Accumulates bytes when inside an OSC sequence
    osc_buffer: Vec<u8>,
    /// True when we're between ESC] and ST/BEL
    in_osc: bool,
    /// True when we just saw ESC (waiting for ] or \)
    saw_esc: bool,
    /// Mirror of program-set palette overrides (OSC 4/10/11/12, cleared by
    /// 104/110/111/112). alacritty tracks the same state internally for
    /// rendering; this copy exists so the event proxy can answer color
    /// queries (Event::ColorRequest) without access to the Term.
    color_overrides: Arc<RwLock<HashMap<usize, Rgb>>>,
}

impl OscInterceptor {
    pub fn new(color_overrides: Arc<RwLock<HashMap<usize, Rgb>>>) -> Self {
        Self {
            osc_buffer: Vec::with_capacity(256),
            in_osc: false,
            saw_esc: false,
            color_overrides,
        }
    }

    /// Scan raw bytes, extract OSC events. Returns structured events.
    pub fn process(&mut self, data: &[u8]) -> Vec<OscEvent> {
        let mut events = Vec::new();

        for &byte in data {
            if self.saw_esc {
                self.saw_esc = false;
                if byte == b']' {
                    // ESC ] — start of OSC sequence
                    self.in_osc = true;
                    self.osc_buffer.clear();
                    continue;
                } else if byte == b'\\' && self.in_osc {
                    // ESC \ — String Terminator (ST), end of OSC
                    self.in_osc = false;
                    if let Some(event) = self.parse_osc() {
                        events.push(event);
                    }
                    continue;
                }
                // Not an OSC-related ESC sequence
                continue;
            }

            if byte == 0x1b {
                // ESC
                self.saw_esc = true;
                continue;
            }

            if self.in_osc {
                if byte == 0x07 {
                    // BEL — also terminates OSC
                    self.in_osc = false;
                    if let Some(event) = self.parse_osc() {
                        events.push(event);
                    }
                } else {
                    self.osc_buffer.push(byte);
                    // Safety: don't accumulate forever on malformed input
                    if self.osc_buffer.len() > 4096 {
                        self.in_osc = false;
                        self.osc_buffer.clear();
                    }
                }
            }
        }

        events
    }

    /// Parse the accumulated OSC buffer into an event.
    fn parse_osc(&mut self) -> Option<OscEvent> {
        let payload = String::from_utf8_lossy(&self.osc_buffer).to_string();

        // Split on first ';' to get OSC code
        let (code_str, data) = match payload.find(';') {
            Some(pos) => (&payload[..pos], &payload[pos + 1..]),
            None => (payload.as_str(), ""),
        };

        let code: u32 = code_str.parse().ok()?;

        match code {
            1 => {
                // OSC 1: Icon name (title's sibling; alacritty only surfaces 0/2)
                if data.is_empty() {
                    return None;
                }
                Some(OscEvent::IconName {
                    name: data.to_string(),
                })
            }
            7 => {
                // OSC 7: file://host/path
                self.parse_osc7(data)
            }
            133 | 633 => {
                // OSC 133/633: Shell integration
                self.parse_osc133(data)
            }
            9 => {
                // OSC 9: Notification
                // Skip payloads that are only digits/semicolons (Claude Code protocol data)
                if data.bytes().all(|b| b.is_ascii_digit() || b == b';') {
                    return None;
                }
                if data.is_empty() {
                    return None;
                }
                Some(OscEvent::Notification {
                    message: data.to_string(),
                })
            }
            4 => {
                // OSC 4: palette set — mirror `idx;spec` pairs ("?" queries are
                // answered by alacritty via Event::ColorRequest, nothing to do here)
                let mut parts = data.split(';');
                while let (Some(idx_str), Some(spec)) = (parts.next(), parts.next()) {
                    if spec == "?" {
                        continue;
                    }
                    if let (Ok(idx), Some(rgb)) = (idx_str.parse::<usize>(), parse_color_spec(spec)) {
                        if idx < 256 {
                            self.color_overrides.write().insert(idx, rgb);
                        }
                    }
                }
                None
            }
            10 | 11 | 12 => {
                // OSC 10/11/12: set foreground/background/cursor color.
                // Table indices per NamedColor: 256/257/258.
                if data != "?" {
                    if let Some(rgb) = parse_color_spec(data) {
                        self.color_overrides.write().insert(246 + code as usize, rgb);
                    }
                }
                None
            }
            104 => {
                // OSC 104: reset palette entries (all when no args)
                let mut overrides = self.color_overrides.write();
                if data.is_empty() {
                    overrides.retain(|&idx, _| idx >= 256);
                } else {
                    for idx_str in data.split(';') {
                        if let Ok(idx) = idx_str.parse::<usize>() {
                            overrides.remove(&idx);
                        }
                    }
                }
                None
            }
            110 | 111 | 112 => {
                // OSC 110/111/112: reset foreground/background/cursor
                self.color_overrides.write().remove(&(146 + code as usize));
                None
            }
            777 => {
                // OSC 777 (rxvt-unicode): notify;title;body
                let mut parts = data.splitn(3, ';');
                if parts.next() != Some("notify") {
                    return None;
                }
                let title = parts.next().unwrap_or("");
                let body = parts.next().unwrap_or("");
                let message = match (title.is_empty(), body.is_empty()) {
                    (false, false) => format!("{title}: {body}"),
                    (false, true) => title.to_string(),
                    (true, false) => body.to_string(),
                    (true, true) => return None,
                };
                Some(OscEvent::Notification { message })
            }
            99 => {
                // OSC 99 (kitty): metadata;payload — minimal support: surface the
                // payload of plain body/title parts, ignore structured extras.
                let (meta, payload) = match data.find(';') {
                    Some(pos) => (&data[..pos], &data[pos + 1..]),
                    None => ("", data),
                };
                if payload.is_empty() {
                    return None;
                }
                // p= selects the part kind; only body (default) and title are text
                let part_ok = meta
                    .split(':')
                    .filter_map(|kv| kv.strip_prefix("p="))
                    .all(|p| p == "body" || p == "title");
                if !part_ok {
                    return None;
                }
                Some(OscEvent::Notification {
                    message: payload.to_string(),
                })
            }
            1337 => {
                // OSC 1337: iTerm2 extensions — CurrentDir + SetUserVar
                if let Some(cwd) = data.strip_prefix("CurrentDir=") {
                    if !cwd.is_empty() {
                        return Some(OscEvent::CurrentDir {
                            cwd: cwd.to_string(),
                        });
                    }
                }
                if let Some(kv) = data.strip_prefix("SetUserVar=") {
                    if let Some((key, b64)) = kv.split_once('=') {
                        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                            if !key.is_empty() {
                                return Some(OscEvent::UserVar {
                                    key: key.to_string(),
                                    value: String::from_utf8_lossy(&decoded).to_string(),
                                });
                            }
                        }
                    }
                }
                None
            }
            _ => None,
        }
    }

    fn parse_osc7(&self, data: &str) -> Option<OscEvent> {
        // Parse file://host/path format
        if let Some(rest) = data.strip_prefix("file://") {
            let (host, path) = if let Some(slash_pos) = rest.find('/') {
                let h = &rest[..slash_pos];
                let p = &rest[slash_pos..];
                (
                    if h.is_empty() { None } else { Some(h.to_string()) },
                    percent_decode(p),
                )
            } else {
                (None, String::new())
            };
            if !path.is_empty() {
                return Some(OscEvent::Cwd { cwd: path, host });
            }
        }
        None
    }

    fn parse_osc133(&self, data: &str) -> Option<OscEvent> {
        let parts: Vec<&str> = data.split(';').collect();
        let cmd_str = parts.first()?;
        let cmd = cmd_str.chars().next()?;

        match cmd {
            'A' | 'B' | 'C' => Some(OscEvent::ShellIntegration {
                cmd,
                exit_code: None,
            }),
            'D' => {
                let exit_code = parts.get(1).and_then(|s| s.parse().ok());
                Some(OscEvent::ShellIntegration { cmd, exit_code })
            }
            _ => None,
        }
    }
}

/// Simple percent-decoding for file:// URLs
fn percent_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next();
            let lo = chars.next();
            if let (Some(h), Some(l)) = (hi, lo) {
                let hex = [h, l];
                if let Ok(s) = std::str::from_utf8(&hex) {
                    if let Ok(val) = u8::from_str_radix(s, 16) {
                        result.push(val as char);
                        continue;
                    }
                }
            }
            // Malformed percent encoding — pass through
            result.push('%');
        } else {
            result.push(b as char);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interceptor() -> (OscInterceptor, Arc<RwLock<HashMap<usize, Rgb>>>) {
        let overrides: Arc<RwLock<HashMap<usize, Rgb>>> = Arc::new(RwLock::new(HashMap::new()));
        (OscInterceptor::new(Arc::clone(&overrides)), overrides)
    }

    fn rgb(r: u8, g: u8, b: u8) -> Rgb {
        Rgb { r, g, b }
    }

    #[test]
    fn parses_icon_name_bel_and_st_terminated() {
        let (mut i, _) = interceptor();
        let events = i.process(b"\x1b]1;my-icon\x07");
        assert!(matches!(&events[..], [OscEvent::IconName { name }] if name == "my-icon"));
        let events = i.process(b"\x1b]1;other\x1b\\");
        assert!(matches!(&events[..], [OscEvent::IconName { name }] if name == "other"));
        // Empty icon name is dropped
        assert!(i.process(b"\x1b]1;\x07").is_empty());
    }

    #[test]
    fn parses_osc777_notify() {
        let (mut i, _) = interceptor();
        let events = i.process(b"\x1b]777;notify;Build;done\x1b\\");
        assert!(matches!(&events[..], [OscEvent::Notification { message }] if message == "Build: done"));
        // Title only
        let events = i.process(b"\x1b]777;notify;Build\x07");
        assert!(matches!(&events[..], [OscEvent::Notification { message }] if message == "Build"));
        // Non-notify subcommand ignored
        assert!(i.process(b"\x1b]777;other;x;y\x07").is_empty());
    }

    #[test]
    fn parses_osc99_kitty_notifications() {
        let (mut i, _) = interceptor();
        let events = i.process(b"\x1b]99;i=1:d=0;Hello\x07");
        assert!(matches!(&events[..], [OscEvent::Notification { message }] if message == "Hello"));
        // Bare payload, no metadata
        let events = i.process(b"\x1b]99;Just text\x07");
        assert!(matches!(&events[..], [OscEvent::Notification { message }] if message == "Just text"));
        // Non-text part kinds are ignored
        assert!(i.process(b"\x1b]99;p=icon;abc\x07").is_empty());
        assert!(i.process(b"\x1b]99;\x07").is_empty());
    }

    #[test]
    fn parses_set_user_var_and_current_dir() {
        let (mut i, _) = interceptor();
        // "hello" base64
        let events = i.process(b"\x1b]1337;SetUserVar=foo=aGVsbG8=\x07");
        assert!(matches!(&events[..], [OscEvent::UserVar { key, value }] if key == "foo" && value == "hello"));
        // Invalid base64 dropped
        assert!(i.process(b"\x1b]1337;SetUserVar=foo=!!!\x07").is_empty());
        // CurrentDir still works
        let events = i.process(b"\x1b]1337;CurrentDir=/tmp\x07");
        assert!(matches!(&events[..], [OscEvent::CurrentDir { cwd }] if cwd == "/tmp"));
    }

    #[test]
    fn mirrors_color_sets_and_resets() {
        let (mut i, overrides) = interceptor();

        // OSC 4 set (two pairs, one a query which must not insert)
        i.process(b"\x1b]4;1;rgb:ff/00/00;2;?\x07");
        assert_eq!(overrides.read().get(&1), Some(&rgb(255, 0, 0)));
        assert!(overrides.read().get(&2).is_none());

        // OSC 10/11/12 map to NamedColor indices 256/257/258
        i.process(b"\x1b]10;#00ff00\x07");
        i.process(b"\x1b]11;rgb:00/00/ff\x07");
        i.process(b"\x1b]12;#123456\x07");
        assert_eq!(overrides.read().get(&256), Some(&rgb(0, 255, 0)));
        assert_eq!(overrides.read().get(&257), Some(&rgb(0, 0, 255)));
        assert_eq!(overrides.read().get(&258), Some(&rgb(0x12, 0x34, 0x56)));
        // Queries don't insert
        i.process(b"\x1b]10;?\x07");
        assert_eq!(overrides.read().get(&256), Some(&rgb(0, 255, 0)));

        // OSC 110/111/112 reset the named slots
        i.process(b"\x1b]110\x07");
        assert!(overrides.read().get(&256).is_none());

        // OSC 104 with args resets only those palette entries
        i.process(b"\x1b]4;3;#aabbcc\x07");
        i.process(b"\x1b]104;1\x07");
        assert!(overrides.read().get(&1).is_none());
        assert_eq!(overrides.read().get(&3), Some(&rgb(0xaa, 0xbb, 0xcc)));

        // OSC 104 bare resets the whole palette but not the named slots
        i.process(b"\x1b]104\x07");
        assert!(overrides.read().get(&3).is_none());
        assert_eq!(overrides.read().get(&257), Some(&rgb(0, 0, 255)));
    }

    #[test]
    fn existing_codes_still_parse() {
        let (mut i, _) = interceptor();
        let events = i.process(b"\x1b]7;file://host/Users/x\x07");
        assert!(matches!(&events[..], [OscEvent::Cwd { cwd, host: Some(h) }] if cwd == "/Users/x" && h == "host"));
        let events = i.process(b"\x1b]133;D;1\x07");
        assert!(matches!(&events[..], [OscEvent::ShellIntegration { cmd: 'D', exit_code: Some(1) }]));
        let events = i.process(b"\x1b]9;hi there\x07");
        assert!(matches!(&events[..], [OscEvent::Notification { message }] if message == "hi there"));
        // Claude Code protocol payloads (digits/semicolons) stay filtered
        assert!(i.process(b"\x1b]9;4;2\x07").is_empty());
    }
}
