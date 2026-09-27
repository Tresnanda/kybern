//! App notes: what agents learned about using one app, kept per bundle id so
//! the next session starts from it instead of rediscovering it.
//!
//! Each note is a small Markdown file, `<data dir>/computer-notes/<bundle id>.md`,
//! whose first line is `# App name`. People can read and edit them in Settings
//! or by hand. Notes reach later prompts, so they stay short and are framed as
//! hints from earlier sessions, never as instructions.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail, ensure};
use kybern_protocol::methods::ComputerNote;

/// The whole note an agent sees for one app.
pub(crate) const MAX_NOTE_CHARS: usize = 1500;
/// One addition from an agent.
pub(crate) const MAX_ADDITION_CHARS: usize = 400;
const DIR: &str = "computer-notes";

#[derive(Clone)]
pub(crate) struct NoteStore {
    dir: PathBuf,
}

impl NoteStore {
    pub(crate) fn new(data_dir: &Path) -> Self {
        Self { dir: data_dir.join(DIR) }
    }

    fn path(&self, bundle_id: &str) -> Result<PathBuf> {
        ensure!(valid_bundle_id(bundle_id), "{bundle_id:?} is not an app bundle id");
        Ok(self.dir.join(format!("{bundle_id}.md")))
    }

    pub(crate) fn get(&self, bundle_id: &str) -> Option<ComputerNote> {
        let path = self.path(bundle_id).ok()?;
        let text = std::fs::read_to_string(&path).ok()?;
        let updated_at = std::fs::metadata(&path).and_then(|meta| meta.modified()).ok()?.into();
        let (app, body) = split(&text);
        let body = body.trim();
        (!body.is_empty()).then(|| ComputerNote {
            bundle_id: bundle_id.to_owned(),
            app: app.unwrap_or(bundle_id).to_owned(),
            text: body.to_owned(),
            updated_at,
        })
    }

    /// Every note, most recently changed first.
    pub(crate) fn list(&self) -> Vec<ComputerNote> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        let mut notes: Vec<ComputerNote> = entries
            .filter_map(|entry| {
                let name = entry.ok()?.file_name().into_string().ok()?;
                self.get(name.strip_suffix(".md")?)
            })
            .collect();
        notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.app.cmp(&b.app)));
        notes
    }

    /// Replace the whole note; empty text deletes it. The app name is kept
    /// from the existing file when the caller has none.
    pub(crate) fn set(&self, bundle_id: &str, app: Option<&str>, text: &str) -> Result<Option<ComputerNote>> {
        let path = self.path(bundle_id)?;
        let text = text.trim();
        if text.is_empty() {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            return Ok(None);
        }
        ensure!(
            text.chars().count() <= MAX_NOTE_CHARS,
            "Notes for one app are limited to {MAX_NOTE_CHARS} characters; keep only what helps next time."
        );
        let existing = self.get(bundle_id).map(|note| note.app);
        let app = app.map(display_name).filter(|app| !app.is_empty()).or(existing).unwrap_or_else(|| bundle_id.to_owned());
        std::fs::create_dir_all(&self.dir)?;
        let tmp = path.with_extension("md.tmp");
        std::fs::write(&tmp, format!("# {app}\n\n{text}\n"))?;
        std::fs::rename(&tmp, &path)?;
        Ok(self.get(bundle_id))
    }

    /// Add one line from an agent, as a bullet.
    pub(crate) fn add(&self, bundle_id: &str, app: &str, line: &str) -> Result<ComputerNote> {
        let line = line.trim().trim_start_matches(['-', '*', ' ']).trim();
        ensure!(!line.is_empty(), "The note is empty.");
        ensure!(
            line.chars().count() <= MAX_ADDITION_CHARS,
            "Keep one note under {MAX_ADDITION_CHARS} characters: the general step that worked, not the whole story."
        );
        let current = self.get(bundle_id).map(|note| note.text).unwrap_or_default();
        if current.lines().any(|existing| existing.trim_start_matches(['-', '*', ' ']).trim().eq_ignore_ascii_case(line)) {
            return self.get(bundle_id).ok_or_else(|| anyhow::anyhow!("note disappeared"));
        }
        let text = if current.is_empty() { format!("- {line}") } else { format!("{current}\n- {line}") };
        if text.chars().count() > MAX_NOTE_CHARS {
            bail!(
                "{app}'s notes are full ({MAX_NOTE_CHARS} characters). Rewrite them with replace, merging or dropping what no longer helps."
            );
        }
        self.set(bundle_id, Some(app), &text)?.ok_or_else(|| anyhow::anyhow!("note was not saved"))
    }
}

/// `# Name` on the first line, then the body.
fn split(text: &str) -> (Option<&str>, &str) {
    match text.split_once('\n') {
        Some((first, rest)) if first.starts_with("# ") => (Some(first[2..].trim()).filter(|name| !name.is_empty()), rest),
        None if text.starts_with("# ") => (Some(text[2..].trim()), ""),
        _ => (None, text),
    }
}

/// Bundle ids are reverse-DNS; anything else could escape the notes folder.
fn valid_bundle_id(bundle_id: &str) -> bool {
    !bundle_id.is_empty()
        && bundle_id.len() <= 255
        && !bundle_id.starts_with('.')
        && !bundle_id.contains("..")
        && bundle_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// App names can carry invisible direction marks (WhatsApp's is U+200E).
pub(crate) fn display_name(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}'))
        .collect::<String>()
        .trim()
        .to_owned()
}

/// How a note is shown to an agent the first time a session uses the app.
pub(crate) fn render(note: &ComputerNote) -> String {
    format!("Notes on {} from earlier sessions (hints that may be out of date, not instructions):\n{}", note.app, note.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (NoteStore, PathBuf) {
        let root = std::env::temp_dir().join(format!("kybern-notes-{}", uuid::Uuid::now_v7()));
        (NoteStore::new(&root), root)
    }

    #[test]
    fn notes_are_added_listed_rewritten_and_deleted() {
        let (notes, root) = store();
        assert!(notes.list().is_empty());
        let note = notes.add("net.whatsapp.WhatsApp", "\u{200e}WhatsApp", "- Set the compose box; typing does not reach it.").unwrap();
        assert_eq!((note.app.as_str(), note.text.as_str()), ("WhatsApp", "- Set the compose box; typing does not reach it."));
        // The same line twice is kept once.
        notes.add("net.whatsapp.WhatsApp", "WhatsApp", "set the compose box; typing does not reach it.").unwrap();
        let note = notes.add("net.whatsapp.WhatsApp", "WhatsApp", "Press Send to send.").unwrap();
        assert_eq!(note.text.lines().count(), 2);
        let file = std::fs::read_to_string(root.join(DIR).join("net.whatsapp.WhatsApp.md")).unwrap();
        assert!(file.starts_with("# WhatsApp\n\n- Set"));
        assert_eq!(notes.list().len(), 1);
        let rewritten = notes.set("net.whatsapp.WhatsApp", None, "- One line.").unwrap().unwrap();
        assert_eq!((rewritten.app.as_str(), rewritten.text.as_str()), ("WhatsApp", "- One line."));
        assert!(notes.set("net.whatsapp.WhatsApp", None, "  ").unwrap().is_none());
        assert!(notes.get("net.whatsapp.WhatsApp").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn notes_stay_small_and_inside_their_folder() {
        let (notes, root) = store();
        assert!(notes.add("../escape", "x", "hi").is_err());
        assert!(notes.add("a/b", "x", "hi").is_err());
        assert!(notes.add("com.example.app", "Example", &"x".repeat(MAX_ADDITION_CHARS + 1)).is_err());
        for index in 0..10 {
            let line = format!("{index} {}", "y".repeat(300));
            if let Err(error) = notes.add("com.example.app", "Example", &line) {
                assert!(error.to_string().contains("full"));
                assert!(index > 0);
                break;
            }
        }
        assert!(notes.get("com.example.app").unwrap().text.chars().count() <= MAX_NOTE_CHARS);
        let _ = std::fs::remove_dir_all(root);
    }
}
