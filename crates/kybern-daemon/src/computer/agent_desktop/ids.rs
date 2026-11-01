//! Window numbers and app ids.
//!
//! agent-desktop names a window `w-4521` on macOS and Windows and by a long
//! opaque address on Linux. Kybern's tools want one number per window that
//! stays the same for the life of the daemon.

use std::collections::{HashMap, HashSet};

use super::super::backend::Os;

#[derive(Debug, Default)]
pub(crate) struct WindowIds {
    by_native: HashMap<String, u64>,
    by_number: HashMap<u64, String>,
    taken: HashSet<u64>,
    next: u64,
}

impl WindowIds {
    /// The number for a native id, assigning one on first sight.
    pub(crate) fn number(&mut self, native: &str) -> u64 {
        if let Some(number) = self.by_native.get(native) {
            return *number;
        }
        let number = match numeric_id(native) {
            Some(number) if !self.by_number.contains_key(&number) => number,
            _ => loop {
                self.next += 1;
                if !self.by_number.contains_key(&self.next) && !self.taken.contains(&self.next) {
                    break self.next;
                }
            },
        };
        self.by_native.insert(native.to_owned(), number);
        self.by_number.insert(number, native.to_owned());
        self.taken.insert(number);
        number
    }

    /// The native id for a number. A number never listed falls back to the
    /// `w-<n>` form numeric platforms use.
    pub(crate) fn native(&self, number: u64) -> String {
        self.by_number.get(&number).cloned().unwrap_or_else(|| format!("w-{number}"))
    }
}

/// `w-4521` → 4521.
fn numeric_id(native: &str) -> Option<u64> {
    let digits = native.strip_prefix("w-").unwrap_or(native);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// The `app_id` of an app (design §3): macOS bundle id; Windows lowercase exe
/// basename; Linux desktop-entry id without `.desktop`, else the executable
/// basename.
///
/// Recorded sources: macOS `list-apps` rows carry `bundle_id` (fixture
/// `fixtures/macos/list_apps.json`). Windows rows are named by image name
/// (`notepad.exe`, windows skill) and may carry no `bundle_id`; the name, or
/// the file name of a path in `bundle_id`, is lowercased and gets `.exe`.
/// Linux rows carry the desktop id in `bundle_id` when known (linux skill,
/// "Naming an app"), otherwise `name` is the process name.
pub(crate) fn app_id(os: Os, name: &str, bundle_id: Option<&str>) -> Option<String> {
    let bundle_id = bundle_id.map(str::trim).filter(|id| !id.is_empty());
    match os {
        Os::Mac => bundle_id.map(str::to_owned),
        Os::Windows => {
            let source = bundle_id.unwrap_or(name).trim();
            let file = source.rsplit(['\\', '/']).next().unwrap_or(source).trim();
            if file.is_empty() {
                return None;
            }
            let file = file.to_ascii_lowercase();
            Some(if file.contains('.') { file } else { format!("{file}.exe") })
        }
        Os::Linux | Os::Other => {
            let source = bundle_id.unwrap_or(name).trim();
            let source = source.strip_suffix(".desktop").unwrap_or(source);
            let source = source.rsplit('/').next().unwrap_or(source);
            (!source.is_empty()).then(|| source.to_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_ids_map_to_their_number_and_back() {
        let mut ids = WindowIds::default();
        assert_eq!(ids.number("w-4521"), 4521);
        assert_eq!(ids.number("w-4521"), 4521);
        assert_eq!(ids.native(4521), "w-4521");
        // A number never listed still reaches a numeric platform's window.
        assert_eq!(ids.native(77), "w-77");
    }

    #[test]
    fn opaque_ids_get_small_stable_numbers() {
        let mut ids = WindowIds::default();
        let a = "x11:0x3a00004:5c9e2a1f8d3b4e6a9f0c7d1e2b3a4c5d";
        let b = "x11:0x3a00009:0123456789abcdef0123456789abcdef";
        assert_eq!(ids.number(a), 1);
        assert_eq!(ids.number(b), 2);
        assert_eq!(ids.number(a), 1);
        assert_eq!(ids.native(2), b);
    }

    #[test]
    fn an_assigned_number_never_collides_with_a_numeric_id() {
        let mut ids = WindowIds::default();
        assert_eq!(ids.number("opaque-a"), 1);
        // A native id that says 1 must not share the number.
        let number = ids.number("w-1");
        assert_ne!(number, 1);
        assert_eq!(ids.native(number), "w-1");
    }

    #[test]
    fn app_ids_per_os() {
        assert_eq!(app_id(Os::Mac, "Calculator", Some("com.apple.calculator")).as_deref(), Some("com.apple.calculator"));
        assert_eq!(app_id(Os::Mac, "ChromeRemoteDesktopHost", None), None);
        assert_eq!(app_id(Os::Windows, "Notepad.exe", None).as_deref(), Some("notepad.exe"));
        assert_eq!(
            app_id(Os::Windows, "Code", Some(r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe")).as_deref(),
            Some("code.exe")
        );
        assert_eq!(app_id(Os::Windows, "calc", None).as_deref(), Some("calc.exe"));
        assert_eq!(app_id(Os::Linux, "gnome-calculator", Some("org.gnome.Calculator.desktop")).as_deref(), Some("org.gnome.Calculator"));
        assert_eq!(app_id(Os::Linux, "gnome-calculator", None).as_deref(), Some("gnome-calculator"));
        assert_eq!(app_id(Os::Linux, "nautilus", Some("")).as_deref(), Some("nautilus"));
    }
}
