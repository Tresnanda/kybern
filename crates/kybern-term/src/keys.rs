//! Keystroke to byte-sequence mapping (xterm conventions).

use gpui::Keystroke;

/// Modifier bitmask as used by xterm's `CSI 1 ; m X` encoding, or `None` when
/// no modifier is held.
fn xterm_modifier(ks: &Keystroke) -> Option<u8> {
    let m = &ks.modifiers;
    let code = (m.shift as u8) | ((m.alt as u8) << 1) | ((m.control as u8) << 2);
    if code == 0 { None } else { Some(code + 1) }
}

/// Bytes to send to the process for a keystroke, or `None` when the key is
/// not something a terminal consumes (the caller should let it propagate).
///
/// `app_cursor` selects the DECCKM encoding for arrows/home/end.
pub fn keystroke_to_bytes(ks: &Keystroke, app_cursor: bool) -> Option<Vec<u8>> {
    let m = &ks.modifiers;
    // Cmd-combinations belong to the app.
    if m.platform {
        return None;
    }
    let key = ks.key.as_str();
    let plain = !m.control && !m.alt && !m.shift;
    let modifier = xterm_modifier(ks);

    // Keys with a fixed encoding regardless of modifiers (or with a few
    // well-known modified forms).
    let fixed: Option<&'static [u8]> = match (key, m.control, m.alt, m.shift) {
        ("enter", false, false, false) => Some(b"\r"),
        ("enter", false, false, true) => Some(b"\n"),
        ("enter", false, true, false) => Some(b"\x1b\r"),
        ("tab", false, false, false) => Some(b"\t"),
        ("tab", false, false, true) => Some(b"\x1b[Z"),
        ("escape", _, _, _) => Some(b"\x1b"),
        ("backspace", false, false, _) => Some(b"\x7f"),
        ("backspace", true, false, _) => Some(b"\x08"),
        ("backspace", false, true, _) => Some(b"\x1b\x7f"),
        ("space", true, false, _) => Some(b"\x00"),
        ("space", false, true, _) => Some(b"\x1b "),
        _ => None,
    };
    if let Some(bytes) = fixed {
        return Some(bytes.to_vec());
    }

    // Cursor and editing keys.
    let cursor = |normal: &str, app: &str| -> String {
        let seq = if app_cursor { app } else { normal };
        match modifier {
            None => format!("\x1b{seq}"),
            Some(mc) => format!("\x1b[1;{mc}{}", &seq[1..]),
        }
    };
    let tilde = |n: u8| -> String {
        match modifier {
            None => format!("\x1b[{n}~"),
            Some(mc) => format!("\x1b[{n};{mc}~"),
        }
    };
    let special = match key {
        "up" => Some(cursor("[A", "OA")),
        "down" => Some(cursor("[B", "OB")),
        "right" => Some(cursor("[C", "OC")),
        "left" => Some(cursor("[D", "OD")),
        "home" => Some(cursor("[H", "OH")),
        "end" => Some(cursor("[F", "OF")),
        "insert" => Some(tilde(2)),
        "delete" => Some(tilde(3)),
        "pageup" => Some(tilde(5)),
        "pagedown" => Some(tilde(6)),
        "f1" => Some(match modifier {
            None => "\x1bOP".into(),
            Some(mc) => format!("\x1b[1;{mc}P"),
        }),
        "f2" => Some(match modifier {
            None => "\x1bOQ".into(),
            Some(mc) => format!("\x1b[1;{mc}Q"),
        }),
        "f3" => Some(match modifier {
            None => "\x1bOR".into(),
            Some(mc) => format!("\x1b[1;{mc}R"),
        }),
        "f4" => Some(match modifier {
            None => "\x1bOS".into(),
            Some(mc) => format!("\x1b[1;{mc}S"),
        }),
        "f5" => Some(tilde(15)),
        "f6" => Some(tilde(17)),
        "f7" => Some(tilde(18)),
        "f8" => Some(tilde(19)),
        "f9" => Some(tilde(20)),
        "f10" => Some(tilde(21)),
        "f11" => Some(tilde(23)),
        "f12" => Some(tilde(24)),
        _ => None,
    };
    if let Some(s) = special {
        return Some(s.into_bytes());
    }

    // Control characters: ctrl-a..ctrl-z and the punctuation column.
    if m.control && !m.alt {
        let mut chars = key.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            let byte = match c.to_ascii_lowercase() {
                c @ 'a'..='z' => Some(c as u8 - b'a' + 1),
                '@' | '2' => Some(0x00),
                '[' | '3' => Some(0x1b),
                '\\' | '4' => Some(0x1c),
                ']' | '5' => Some(0x1d),
                '^' | '6' => Some(0x1e),
                '_' | '7' | '-' => Some(0x1f),
                '?' | '8' => Some(0x7f),
                _ => None,
            };
            if let Some(b) = byte {
                return Some(vec![b]);
            }
        }
        return None;
    }

    // Alt/option as meta: ESC + the key (or the composed character).
    if m.alt && !m.control {
        let text = ks.key_char.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| {
            if m.shift { key.to_uppercase() } else { key.to_string() }
        });
        if text.chars().count() == 1 {
            let mut out = vec![0x1b];
            out.extend_from_slice(text.as_bytes());
            return Some(out);
        }
        return None;
    }

    // Printable text as the platform composed it.
    if let Some(text) = ks.key_char.as_deref().filter(|s| !s.is_empty()) {
        if text.chars().all(|c| !c.is_control()) {
            return Some(text.as_bytes().to_vec());
        }
    }
    if key == "space" {
        return Some(b" ".to_vec());
    }
    // Fall back to the key name when it is a single printable character.
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if !c.is_control() && (plain || m.shift) {
            let c = if m.shift { c.to_uppercase().next().unwrap_or(c) } else { c };
            return Some(c.to_string().into_bytes());
        }
    }
    None
}

/// Wrap pasted text in bracketed-paste markers when the program asked for
/// them, and normalise line endings so multi-line pastes do not execute
/// line by line in shells that treat `\n` as Enter.
pub fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8> {
    let text = text.replace("\r\n", "\r").replace('\n', "\r");
    if bracketed {
        let mut out = b"\x1b[200~".to_vec();
        out.extend_from_slice(text.as_bytes());
        out.extend_from_slice(b"\x1b[201~");
        out
    } else {
        text.into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ks(s: &str) -> Keystroke {
        Keystroke::parse(s).unwrap()
    }

    #[test]
    fn basics() {
        assert_eq!(keystroke_to_bytes(&ks("enter"), false), Some(b"\r".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("backspace"), false), Some(b"\x7f".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("tab"), false), Some(b"\t".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("shift-tab"), false), Some(b"\x1b[Z".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("escape"), false), Some(b"\x1b".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("a"), false), Some(b"a".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("space"), false), Some(b" ".to_vec()));
    }

    #[test]
    fn arrows_follow_app_cursor_mode() {
        assert_eq!(keystroke_to_bytes(&ks("up"), false), Some(b"\x1b[A".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("up"), true), Some(b"\x1bOA".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("shift-left"), false), Some(b"\x1b[1;2D".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("ctrl-right"), true), Some(b"\x1b[1;5C".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("delete"), false), Some(b"\x1b[3~".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("f5"), false), Some(b"\x1b[15~".to_vec()));
    }

    #[test]
    fn control_and_meta() {
        assert_eq!(keystroke_to_bytes(&ks("ctrl-c"), false), Some(vec![3]));
        assert_eq!(keystroke_to_bytes(&ks("ctrl-z"), false), Some(vec![26]));
        assert_eq!(keystroke_to_bytes(&ks("ctrl-["), false), Some(vec![0x1b]));
        assert_eq!(keystroke_to_bytes(&ks("alt-b"), false), Some(b"\x1bb".to_vec()));
        assert_eq!(keystroke_to_bytes(&ks("cmd-c"), false), None);
    }

    #[test]
    fn paste_wrapping() {
        assert_eq!(paste_bytes("a\nb", false), b"a\rb".to_vec());
        assert_eq!(paste_bytes("x", true), b"\x1b[200~x\x1b[201~".to_vec());
    }
}
