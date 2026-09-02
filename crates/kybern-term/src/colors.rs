//! ANSI palette and colour resolution.

use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use gpui::{Hsla, Rgba};

/// The 16 base colours plus default fg/bg/cursor.
#[derive(Clone, Debug, PartialEq)]
pub struct Palette {
    pub ansi: [Hsla; 16],
    pub foreground: Hsla,
    pub background: Hsla,
    pub cursor: Hsla,
    pub selection: Hsla,
}

fn hex(v: u32) -> Hsla {
    Rgba { r: ((v >> 16) & 0xff) as f32 / 255., g: ((v >> 8) & 0xff) as f32 / 255., b: (v & 0xff) as f32 / 255., a: 1. }.into()
}

impl Palette {
    /// A muted dark palette in the spirit of the macOS Terminal "Basic" theme.
    pub fn dark() -> Self {
        Self {
            ansi: [
                hex(0x3b3b3b),
                hex(0xe5484d),
                hex(0x46a758),
                hex(0xffc53d),
                hex(0x3e63dd),
                hex(0xab4aba),
                hex(0x00a2c7),
                hex(0xd0d0d0),
                hex(0x6f6f6f),
                hex(0xff6369),
                hex(0x63c174),
                hex(0xffd760),
                hex(0x6b8dff),
                hex(0xd06de0),
                hex(0x3cc9e8),
                hex(0xffffff),
            ],
            foreground: hex(0xd4d4d4),
            background: hex(0x141414),
            cursor: hex(0xd4d4d4),
            selection: Hsla { h: 0.6, s: 0.6, l: 0.6, a: 0.35 },
        }
    }

    pub fn light() -> Self {
        Self {
            ansi: [
                hex(0x000000),
                hex(0xc62a2f),
                hex(0x2a7f3f),
                hex(0x9a6700),
                hex(0x2952c4),
                hex(0x8f3f9f),
                hex(0x0b7a95),
                hex(0x777777),
                hex(0x555555),
                hex(0xe5484d),
                hex(0x3d9a52),
                hex(0xb98a00),
                hex(0x3e63dd),
                hex(0xab4aba),
                hex(0x00a2c7),
                hex(0x000000),
            ],
            foreground: hex(0x1f1f1f),
            background: hex(0xffffff),
            cursor: hex(0x1f1f1f),
            selection: Hsla { h: 0.6, s: 0.7, l: 0.5, a: 0.25 },
        }
    }

    /// The palette for the given appearance, with default fg/bg taken from
    /// the app theme so the terminal sits flush with the surrounding pane.
    pub fn for_theme(dark: bool, background: Hsla, foreground: Hsla) -> Self {
        let mut p = if dark { Self::dark() } else { Self::light() };
        p.background = background;
        p.foreground = foreground;
        p.cursor = foreground;
        p
    }

    fn named(&self, c: NamedColor, colors: &Colors) -> Hsla {
        use NamedColor::*;
        let idx = |i: usize| colors[i].map(rgb_to_hsla).unwrap_or(self.ansi[i]);
        match c {
            Black => idx(0),
            Red => idx(1),
            Green => idx(2),
            Yellow => idx(3),
            Blue => idx(4),
            Magenta => idx(5),
            Cyan => idx(6),
            White => idx(7),
            BrightBlack => idx(8),
            BrightRed => idx(9),
            BrightGreen => idx(10),
            BrightYellow => idx(11),
            BrightBlue => idx(12),
            BrightMagenta => idx(13),
            BrightCyan => idx(14),
            BrightWhite => idx(15),
            Foreground | BrightForeground => colors[Foreground].map(rgb_to_hsla).unwrap_or(self.foreground),
            Background => colors[Background].map(rgb_to_hsla).unwrap_or(self.background),
            Cursor => colors[Cursor].map(rgb_to_hsla).unwrap_or(self.cursor),
            DimForeground => dim(self.foreground),
            DimBlack => dim(idx(0)),
            DimRed => dim(idx(1)),
            DimGreen => dim(idx(2)),
            DimYellow => dim(idx(3)),
            DimBlue => dim(idx(4)),
            DimMagenta => dim(idx(5)),
            DimCyan => dim(idx(6)),
            DimWhite => dim(idx(7)),
        }
    }

    /// Resolve a cell colour. `colors` carries any OSC 4/10/11 overrides the
    /// program set at runtime.
    pub fn resolve(&self, color: &Color, colors: &Colors) -> Hsla {
        match color {
            Color::Named(n) => self.named(*n, colors),
            Color::Spec(rgb) => rgb_to_hsla(*rgb),
            Color::Indexed(i) => {
                let i = *i as usize;
                if i < 16 {
                    colors[i].map(rgb_to_hsla).unwrap_or(self.ansi[i])
                } else if let Some(rgb) = colors[i] {
                    rgb_to_hsla(rgb)
                } else {
                    rgb_to_hsla(indexed_rgb(i as u8))
                }
            }
        }
    }

    /// Foreground for a cell, applying BOLD (bright variant of the 8 base
    /// colours) and DIM.
    pub fn foreground_for(&self, color: &Color, flags: Flags, colors: &Colors) -> Hsla {
        let color = match (color, flags.contains(Flags::BOLD)) {
            (Color::Named(n), true) if (*n as usize) < 8 => Color::Indexed(*n as u8 + 8),
            (Color::Indexed(i), true) if *i < 8 => Color::Indexed(*i + 8),
            (c, _) => *c,
        };
        let hsla = self.resolve(&color, colors);
        if flags.contains(Flags::DIM) { dim(hsla) } else { hsla }
    }
}

fn dim(mut c: Hsla) -> Hsla {
    c.a *= 0.66;
    c
}

pub fn rgb_to_hsla(rgb: Rgb) -> Hsla {
    Rgba { r: rgb.r as f32 / 255., g: rgb.g as f32 / 255., b: rgb.b as f32 / 255., a: 1. }.into()
}

/// The xterm 256-colour cube and grey ramp for indices 16..=255.
pub fn indexed_rgb(i: u8) -> Rgb {
    match i {
        0..=15 => unreachable_base(i),
        16..=231 => {
            let i = i - 16;
            let comp = |c: u8| if c == 0 { 0 } else { c * 40 + 55 };
            Rgb { r: comp(i / 36), g: comp((i / 6) % 6), b: comp(i % 6) }
        }
        232..=255 => {
            let v = 8 + (i - 232) * 10;
            Rgb { r: v, g: v, b: v }
        }
    }
}

fn unreachable_base(i: u8) -> Rgb {
    // Callers resolve 0..=15 through the palette; give something sane anyway.
    let v = if i < 8 { 128 } else { 255 };
    Rgb { r: v, g: v, b: v }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cube_and_grey_ramp() {
        assert_eq!(indexed_rgb(16), Rgb { r: 0, g: 0, b: 0 });
        assert_eq!(indexed_rgb(231), Rgb { r: 255, g: 255, b: 255 });
        assert_eq!(indexed_rgb(196), Rgb { r: 255, g: 0, b: 0 });
        assert_eq!(indexed_rgb(232), Rgb { r: 8, g: 8, b: 8 });
        assert_eq!(indexed_rgb(255), Rgb { r: 238, g: 238, b: 238 });
    }

    #[test]
    fn bold_brightens_base_colors() {
        let p = Palette::dark();
        let colors = Colors::default();
        let red = p.foreground_for(&Color::Named(NamedColor::Red), Flags::empty(), &colors);
        let bold_red = p.foreground_for(&Color::Named(NamedColor::Red), Flags::BOLD, &colors);
        assert_eq!(red, p.ansi[1]);
        assert_eq!(bold_red, p.ansi[9]);
        let spec = p.foreground_for(&Color::Spec(Rgb { r: 10, g: 20, b: 30 }), Flags::BOLD, &colors);
        assert_eq!(spec, rgb_to_hsla(Rgb { r: 10, g: 20, b: 30 }));
    }
}
