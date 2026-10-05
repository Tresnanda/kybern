//! Save a text document (a note exported as Markdown) through the native save
//! dialog. Like `save_image_file`, the destination is chosen in the native
//! dialog and never crosses the JS/Rust boundary, so the webview cannot ask the
//! shell to write an arbitrary path.

use tauri::{Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// A note body is limited to 512 KiB by the daemon; leave room for the title.
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

/// A file name that is safe to offer in the dialog: no path separators or
/// control characters, never empty, and always ending in `.md`.
fn markdown_file_name(requested: &str) -> String {
    let cleaned: String = requested.replace(['/', '\\', ':'], "-").chars().filter(|character| !character.is_control()).collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    let stem = cleaned.strip_suffix(".md").unwrap_or(cleaned).trim();
    let stem: String = stem.chars().take(120).collect();
    if stem.is_empty() { "Untitled.md".into() } else { format!("{stem}.md") }
}

/// Ask where to save, then write `contents`. Returns `false` when the dialog was
/// dismissed.
#[tauri::command]
pub async fn save_text_file<R: Runtime>(window: tauri::Window<R>, file_name: String, contents: String) -> Result<bool, String> {
    if contents.len() > MAX_TEXT_BYTES {
        return Err("This note is too large to export. Copy it as Markdown instead.".into());
    }
    let mut dialog = window.app_handle().dialog().file();
    #[cfg(desktop)]
    {
        dialog = dialog.set_parent(&window);
    }
    let dialog = dialog.set_title("Export note").set_file_name(markdown_file_name(&file_name)).add_filter("Markdown", &["md", "markdown"]);
    let path = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|error| format!("The save dialog failed: {error}"))?;
    let Some(path) = path else { return Ok(false) };
    let path = path.into_path().map_err(|error| format!("invalid save path: {error}"))?;
    if path.file_name().is_none() {
        return Err("Choose a file name first".into());
    }
    std::fs::write(&path, contents).map_err(|error| format!("write file: {error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::markdown_file_name;

    #[test]
    fn export_file_names_are_safe_markdown_names() {
        assert_eq!(markdown_file_name("Meeting notes"), "Meeting notes.md");
        assert_eq!(markdown_file_name("a/b\\c: d"), "a-b-c- d.md");
        assert_eq!(markdown_file_name("already.md"), "already.md");
        assert_eq!(markdown_file_name(""), "Untitled.md");
        assert_eq!(markdown_file_name("  ..hidden"), "hidden.md");
        assert_eq!(markdown_file_name("tab\there"), "tabhere.md");
    }
}
