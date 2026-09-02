//! Keybindings: built-in defaults merged with `<data_dir>/keybindings.json`.
//!
//! File format mirrors Zed/T3: a list of `{ "context": "Workspace", "bindings": { "cmd-n": "kybern::NewThread" } }`.
//! Unknown action names are reported, not fatal.

use std::path::Path;

use gpui::*;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Section {
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    bindings: std::collections::BTreeMap<String, String>,
}

pub const DEFAULTS: &[(&str, &str, Option<&str>)] = &[
    ("cmd-n", "kybern::NewThread", None),
    ("cmd-.", "kybern::Interrupt", None),
    ("cmd-shift-e", "kybern::ToggleRightPanel", None),
    ("cmd-b", "kybern::ToggleSidebar", None),
    ("cmd-l", "kybern::FocusComposer", None),
    ("cmd-k", "kybern::OpenPalette", None),
    ("cmd-shift-p", "kybern::OpenPalette", None),
    ("cmd-shift-t", "kybern::OpenTerminal", None),
    ("cmd-shift-d", "kybern::OpenChanges", None),
    ("cmd-,", "kybern::OpenSettings", None),
    ("cmd-shift-a", "kybern::ArchiveThread", None),
    ("cmd-1", "kybern::SelectPreviousThread", None),
    ("cmd-2", "kybern::SelectNextThread", None),
    #[cfg(target_os = "macos")]
    ("cmd-q", "kybern::Quit", None),
];

pub fn install(cx: &mut App, data_dir: Option<&Path>) {
    let mut bindings: Vec<KeyBinding> = Vec::new();
    for (keys, action, context) in DEFAULTS {
        if let Some(b) = make_binding(cx, keys, action, *context) {
            bindings.push(b);
        }
    }
    if let Some(path) = data_dir.map(|d| d.join("keybindings.json")) {
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Vec<Section>>(&text) {
                Ok(sections) => {
                    for s in sections {
                        for (keys, action) in s.bindings {
                            match make_binding(cx, &keys, &action, s.context.as_deref()) {
                                Some(b) => bindings.push(b),
                                None => tracing::warn!(keys, action, "unknown action in keybindings.json"),
                            }
                        }
                    }
                }
                Err(e) => tracing::warn!(%e, path = %path.display(), "keybindings.json is not valid; using defaults"),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let example = serde_json::json!([{ "context": "Workspace", "bindings": { "cmd-n": "kybern::NewThread" } }]);
                let _ = std::fs::write(&path, serde_json::to_string_pretty(&example).unwrap());
            }
            Err(e) => tracing::warn!(%e, "could not read keybindings.json"),
        }
    }
    // Later bindings win, so user bindings override defaults.
    cx.bind_keys(bindings);
}

fn make_binding(cx: &App, keys: &str, action: &str, context: Option<&str>) -> Option<KeyBinding> {
    let action = cx.build_action(action, None).ok()?;
    let predicate = match context {
        Some(c) => Some(std::rc::Rc::new(KeyBindingContextPredicate::parse(c).ok()?)),
        None => None,
    };
    KeyBinding::load(keys, action, predicate, false, None, cx.keyboard_mapper().as_ref()).ok()
}
