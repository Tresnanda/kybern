//! The `kybern_preview_open` agent tool (spec 6.5): resolve a target the way
//! `previews.open` does, never grant a folder, and tell clients to show it.

use anyhow::{Result, anyhow, ensure};
use kybern_protocol::methods::{PreviewOpenRequestedNotification, PreviewTargetInfo};
use kybern_protocol::{Settings, ThreadId};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{GrantPolicy, ThreadRoots, resolve};

pub const TOOL: &str = "kybern_preview_open";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    target: String,
    #[serde(default)]
    title: Option<String>,
}

pub struct Outcome {
    pub result: Value,
    /// Sent to clients when the panel should react (shown, needs_permission,
    /// opens_in_browser).
    pub notify: Option<PreviewOpenRequestedNotification>,
}

/// `clients` is the number of connected clients that can hear the
/// notification. Zero means nobody can show the page: `no_client`.
pub fn open(
    thread_id: ThreadId,
    roots: &ThreadRoots,
    settings: &Settings,
    policy: &GrantPolicy,
    arguments: Value,
    clients: usize,
) -> Result<Outcome> {
    let object = arguments.as_object().ok_or_else(|| anyhow!("Tool arguments must be a JSON object."))?;
    ensure!(!object.contains_key("thread_id"), "The preview tool is bound to the current thread.");
    let args: Args = serde_json::from_value(arguments).map_err(|error| anyhow!("Invalid arguments: {error}"))?;
    let target = args.target.trim();
    ensure!(!target.is_empty() && args.target.chars().count() <= 2048, "Give a target of 1-2048 characters.");
    let title = args.title.map(|title| title.trim().to_owned()).filter(|title| !title.is_empty());
    ensure!(title.as_ref().is_none_or(|title| title.chars().count() <= 120), "Keep the title to 120 characters or fewer.");

    // Never allow_folder from an agent: only the user can grant a folder.
    let resolved = resolve(target, roots, &settings.preview_allowed_folders, false, policy).map_err(|error| anyhow!("{}", error.message))?;
    let (status, normalized, message) = match (&resolved.info, &resolved.needs_permission) {
        (PreviewTargetInfo::File { path, .. }, Some(request)) => (
            "needs_permission",
            path.clone(),
            format!("The user was asked to allow previewing files in {}. Wait for them to decide; do not retry.", request.folder),
        ),
        (PreviewTargetInfo::File { path, .. }, None) => ("shown", path.clone(), "The page is open in the Preview panel.".to_owned()),
        (PreviewTargetInfo::Server { url, .. }, _) => ("shown", url.clone(), "The page is open in the Preview panel.".to_owned()),
        (PreviewTargetInfo::External { url }, _) => {
            ("opens_in_browser", url.clone(), "This address is outside localhost, so it opens in the user's browser instead.".to_owned())
        }
    };
    if clients == 0 {
        let message = "No Kybern window is connected, so nothing was shown. Mention the address in your reply instead.";
        return Ok(Outcome { result: json!({"status": "no_client", "target": normalized, "message": message}), notify: None });
    }
    let notify = PreviewOpenRequestedNotification { thread_id, target: normalized.clone(), title, requested_by_agent: true };
    Ok(Outcome { result: json!({"status": status, "target": normalized, "message": message}), notify: Some(notify) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn setup() -> (PathBuf, ThreadRoots, GrantPolicy) {
        let dir = std::env::temp_dir().join(format!("kybern-preview-agent-{}", uuid::Uuid::new_v4())).join("w");
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        std::fs::write(dir.join("mock.html"), "<p>x</p>").unwrap();
        let policy = GrantPolicy { home: Some(dir.clone()), data_dir: dir.join(".kybern"), system: Vec::new() };
        (dir.clone(), ThreadRoots { cwd: dir, project: None }, policy)
    }

    fn call(roots: &ThreadRoots, settings: &Settings, policy: &GrantPolicy, args: Value, clients: usize) -> Result<Outcome> {
        open(uuid::Uuid::new_v4(), roots, settings, policy, args, clients)
    }

    #[test]
    fn statuses() {
        let (dir, roots, policy) = setup();
        let settings = Settings::default();
        let status = |args: Value, clients: usize| {
            let outcome = call(&roots, &settings, &policy, args, clients).unwrap();
            (outcome.result["status"].as_str().unwrap().to_owned(), outcome.notify.is_some())
        };
        assert_eq!(status(json!({"target": "mock.html"}), 1), ("shown".into(), true));
        assert_eq!(status(json!({"target": "http://localhost:5173"}), 1), ("shown".into(), true));
        assert_eq!(status(json!({"target": "https://example.com"}), 1), ("opens_in_browser".into(), true));
        assert_eq!(status(json!({"target": "mock.html"}), 0), ("no_client".into(), false));
        let elsewhere = std::env::temp_dir().join(format!("kybern-preview-agent-out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&elsewhere).unwrap();
        let page = elsewhere.canonicalize().unwrap().join("out.html");
        std::fs::write(&page, "<p>x</p>").unwrap();
        let outcome = call(&roots, &settings, &policy, json!({"target": page.to_str().unwrap(), "title": "Outside"}), 1).unwrap();
        assert_eq!(outcome.result["status"], "needs_permission");
        assert!(outcome.result["message"].as_str().unwrap().contains("The user was asked to allow previewing files in"));
        assert_eq!(outcome.notify.unwrap().title.as_deref(), Some("Outside"));
        // Never grants: the same call without a stored grant keeps asking.
        assert_eq!(status(json!({"target": page.to_str().unwrap()}), 1).0, "needs_permission");
        // Once the user granted the folder, the agent can show it.
        let mut granted = Settings::default();
        granted.preview_allowed_folders = vec![page.parent().unwrap().to_string_lossy().into_owned()];
        let outcome = call(&roots, &granted, &policy, json!({"target": page.to_str().unwrap()}), 1).unwrap();
        assert_eq!(outcome.result["status"], "shown");
        let _ = std::fs::remove_dir_all(&elsewhere);
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn rejects_bad_input() {
        let (dir, roots, policy) = setup();
        let settings = Settings::default();
        for args in [
            json!({"target": "mock.html", "thread_id": uuid::Uuid::new_v4()}),
            json!({}),
            json!({"target": ""}),
            json!({"target": "mock.html", "allow_folder": true}),
            json!({"target": "mock.html", "title": "x".repeat(121)}),
            json!({"target": "javascript:alert(1)"}),
            json!({"target": "missing.html"}),
            json!({"target": "mock.html", "title": 4}),
        ] {
            assert!(call(&roots, &settings, &policy, args.clone(), 1).is_err(), "{args}");
        }
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }
}
