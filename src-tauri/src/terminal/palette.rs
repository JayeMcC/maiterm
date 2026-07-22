use alacritty_terminal::vte::ansi::Rgb;

/// The app's terminal color scheme, pushed from the frontend theme system so
/// the backend can answer OSC 4/10/11/12 color queries with real values.
/// Indices follow alacritty's color table: 0-255 palette, then NamedColor
/// (256 = foreground, 257 = background, 258 = cursor, 259-266 dim, ...).
#[derive(Debug, Clone)]
pub struct ThemePalette {
    pub fg: Rgb,
    pub bg: Rgb,
    pub cursor: Rgb,
    pub ansi: [Rgb; 16],
}

impl Default for ThemePalette {
    fn default() -> Self {
        // Tokyo Night — matches the app's default theme so queries answered
        // before the frontend pushes a palette are still plausible.
        Self {
            fg: rgb(0xc0, 0xca, 0xf5),
            bg: rgb(0x1a, 0x1b, 0x26),
            cursor: rgb(0xc0, 0xca, 0xf5),
            ansi: [
                rgb(0x15, 0x16, 0x1e),
                rgb(0xf7, 0x76, 0x8e),
                rgb(0x9e, 0xce, 0x6a),
                rgb(0xe0, 0xaf, 0x68),
                rgb(0x7a, 0xa2, 0xf7),
                rgb(0xbb, 0x9a, 0xf7),
                rgb(0x7d, 0xcf, 0xff),
                rgb(0xa9, 0xb1, 0xd6),
                rgb(0x41, 0x48, 0x68),
                rgb(0xf7, 0x76, 0x8e),
                rgb(0x9e, 0xce, 0x6a),
                rgb(0xe0, 0xaf, 0x68),
                rgb(0x7a, 0xa2, 0xf7),
                rgb(0xbb, 0x9a, 0xf7),
                rgb(0x7d, 0xcf, 0xff),
                rgb(0xc0, 0xca, 0xf5),
            ],
        }
    }
}

impl ThemePalette {
    /// Resolve any alacritty color-table index to a concrete color.
    pub fn resolve(&self, index: usize) -> Rgb {
        match index {
            0..=15 => self.ansi[index],
            16..=231 => {
                // 6x6x6 color cube (xterm values: 0, 95, 135, 175, 215, 255)
                let i = index - 16;
                let comp = |v: usize| -> u8 {
                    if v == 0 { 0 } else { (55 + 40 * v) as u8 }
                };
                rgb(comp(i / 36), comp((i / 6) % 6), comp(i % 6))
            }
            232..=255 => {
                let gray = (8 + 10 * (index - 232)) as u8;
                rgb(gray, gray, gray)
            }
            256 => self.fg,     // NamedColor::Foreground
            257 => self.bg,     // NamedColor::Background
            258 => self.cursor, // NamedColor::Cursor
            259..=266 => dim(self.ansi[index - 259]), // DimBlack..DimWhite
            267 => self.fg,     // BrightForeground
            268 => dim(self.fg), // DimForeground
            _ => self.fg,
        }
    }
}

fn rgb(r: u8, g: u8, b: u8) -> Rgb {
    Rgb { r, g, b }
}

fn dim(c: Rgb) -> Rgb {
    rgb(
        (c.r as u16 * 2 / 3) as u8,
        (c.g as u16 * 2 / 3) as u8,
        (c.b as u16 * 2 / 3) as u8,
    )
}

/// Parse `#rrggbb` / `#rgb` / bare `rrggbb` hex.
pub fn parse_hex(s: &str) -> Option<Rgb> {
    let s = s.strip_prefix('#').unwrap_or(s);
    match s.len() {
        6 => {
            let v = u32::from_str_radix(s, 16).ok()?;
            Some(rgb((v >> 16) as u8, (v >> 8) as u8, v as u8))
        }
        3 => {
            let v = u32::from_str_radix(s, 16).ok()?;
            let (r, g, b) = ((v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf);
            Some(rgb((r * 17) as u8, (g * 17) as u8, (b * 17) as u8))
        }
        _ => None,
    }
}

/// Parse an XParseColor-style spec as used by OSC 4/10/11/12 setters:
/// `rgb:RR/GG/BB` (1-4 hex digits per component, scaled) or hex forms.
pub fn parse_color_spec(s: &str) -> Option<Rgb> {
    if let Some(rest) = s.strip_prefix("rgb:") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() != 3 {
            return None;
        }
        let comp = |p: &str| -> Option<u8> {
            if p.is_empty() || p.len() > 4 {
                return None;
            }
            let v = u16::from_str_radix(p, 16).ok()? as u32;
            let max = (1u32 << (4 * p.len() as u32)) - 1;
            Some((v * 255 / max) as u8)
        };
        return Some(rgb(comp(parts[0])?, comp(parts[1])?, comp(parts[2])?));
    }
    parse_hex(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_cube_and_grayscale() {
        let p = ThemePalette::default();
        // 16 = cube origin (black)
        assert_eq!(p.resolve(16), rgb(0, 0, 0));
        // 231 = cube max (white)
        assert_eq!(p.resolve(231), rgb(255, 255, 255));
        // 232 = darkest gray
        assert_eq!(p.resolve(232), rgb(8, 8, 8));
        assert_eq!(p.resolve(256), p.fg);
        assert_eq!(p.resolve(257), p.bg);
    }

    #[test]
    fn parses_color_specs() {
        assert_eq!(parse_color_spec("#ff8000"), Some(rgb(255, 128, 0)));
        assert_eq!(parse_color_spec("rgb:ff/80/00"), Some(rgb(255, 128, 0)));
        // 4-digit components scale down
        assert_eq!(parse_color_spec("rgb:ffff/8080/0000"), Some(rgb(255, 128, 0)));
        // 1-digit components scale up
        assert_eq!(parse_color_spec("rgb:f/8/0"), Some(rgb(255, 136, 0)));
        assert_eq!(parse_color_spec("nonsense"), None);
    }
}
