//! The Accept edits path check, shared by every ACP flavor (moved from the Grok tests).

use super::*;
use agent_client_protocol::schema::v1::ToolCallLocation;
use serde_json::json;

#[test]
fn accept_edits_answers_workspace_edits_and_asks_for_everything_else() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("repo");
    std::fs::create_dir_all(cwd.join("src")).unwrap();
    let edit = |kind: ToolKind, paths: &[PathBuf]| {
        ToolCallUpdateFields::new().kind(kind).locations(paths.iter().map(|path| ToolCallLocation::new(path.clone())).collect::<Vec<_>>())
    };
    let inside = edit(ToolKind::Edit, &[cwd.join("src/new.rs"), PathBuf::from("README.md")]);
    assert_eq!(auto_decision(PermissionMode::AcceptEdits, &inside, &cwd), Some(ApprovalDecision::AllowOnce));
    assert_eq!(auto_decision(PermissionMode::Supervised, &inside, &cwd), None);
    // Auto's requests are refusals by xAI's classifier: they reach the user.
    assert_eq!(auto_decision(PermissionMode::Auto, &inside, &cwd), None);
    assert_eq!(auto_decision(PermissionMode::FullAccess, &edit(ToolKind::Execute, &[]), &cwd), Some(ApprovalDecision::AllowOnce));

    for asks in [
        edit(ToolKind::Execute, &[cwd.join("src/new.rs")]),
        edit(ToolKind::Edit, &[]),
        edit(ToolKind::Edit, &[root.path().join("elsewhere.rs")]),
        edit(ToolKind::Delete, &[cwd.join("../repo/../outside.rs")]),
    ] {
        assert_eq!(auto_decision(PermissionMode::AcceptEdits, &asks, &cwd), None, "{asks:?}");
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.path(), cwd.join("escape")).unwrap();
        assert_eq!(auto_decision(PermissionMode::AcceptEdits, &edit(ToolKind::Edit, &[cwd.join("escape/x.rs")]), &cwd), None);
    }
}

/// An edit at `paths` with `raw_input`, as Grok sends it in `session/request_permission`.
fn edit_with(kind: ToolKind, paths: &[PathBuf], raw_input: Option<Value>) -> ToolCallUpdateFields {
    let fields =
        ToolCallUpdateFields::new().kind(kind).locations(paths.iter().map(|path| ToolCallLocation::new(path.clone())).collect::<Vec<_>>());
    match raw_input {
        Some(raw) => fields.raw_input(raw),
        None => fields,
    }
}

fn accepts(fields: &ToolCallUpdateFields, cwd: &Path) -> bool {
    auto_decision(PermissionMode::AcceptEdits, fields, cwd).is_some()
}

#[test]
fn paths_outside_the_workspace_ask_on_every_platform() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("repo");
    std::fs::create_dir_all(&cwd).unwrap();
    // A new file in folders that don't exist yet, outside; a relative climb out; and inside, to compare.
    assert!(!accepts(&edit_with(ToolKind::Edit, &[root.path().join("elsewhere/deep/new.rs")], None), &cwd));
    assert!(!accepts(&edit_with(ToolKind::Edit, &[PathBuf::from("../outside.rs")], None), &cwd));
    assert!(!accepts(&edit_with(ToolKind::Edit, &[PathBuf::from("src/../../outside.rs")], None), &cwd));
    assert!(accepts(&edit_with(ToolKind::Edit, &[PathBuf::from("src/deep/new.rs")], None), &cwd));
}

#[test]
fn every_path_in_the_raw_input_must_be_inside_and_a_move_needs_its_destination() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("repo");
    std::fs::create_dir_all(&cwd).unwrap();
    let inside = cwd.join("a.rs");
    let outside = root.path().join("cron.d/a");
    let text = |path: &Path| json!(path.to_string_lossy());

    // `mv ws/a /etc/cron.d/a`: the locations name only the source.
    let escape =
        edit_with(ToolKind::Move, std::slice::from_ref(&inside), Some(json!({ "source": text(&inside), "destination": text(&outside) })));
    assert!(!accepts(&escape, &cwd));
    // A move Kybern can't see the destination of asks.
    assert!(!accepts(&edit_with(ToolKind::Move, std::slice::from_ref(&inside), None), &cwd));
    assert!(!accepts(&edit_with(ToolKind::Move, std::slice::from_ref(&inside), Some(json!({ "path": text(&inside) }))), &cwd));
    // A move inside the workspace, whatever the keys are called.
    for raw in
        [json!({ "from": "a.rs", "to": "b.rs" }), json!({ "old_path": "a.rs", "newPath": "src/b.rs" }), json!({ "target_path": "b.rs" })]
    {
        assert!(accepts(&edit_with(ToolKind::Move, std::slice::from_ref(&inside), Some(raw.clone())), &cwd), "{raw}");
    }
    assert!(!accepts(&edit_with(ToolKind::Move, std::slice::from_ref(&inside), Some(json!({ "to": text(&outside) }))), &cwd));

    // An edit whose input names another file than its locations: both are checked.
    assert!(!accepts(&edit_with(ToolKind::Edit, std::slice::from_ref(&inside), Some(json!({ "file_path": text(&outside) }))), &cwd));
    assert!(accepts(
        &edit_with(ToolKind::Edit, std::slice::from_ref(&inside), Some(json!({ "filePath": "src/x.rs", "old_string": "let a = 1;" }))),
        &cwd
    ));
    // Nested and listed paths count too; an input path alone (no locations) is enough when it's inside.
    let nested = json!({ "edits": [{ "path": "a.rs" }, { "path": text(&outside) }] });
    assert!(!accepts(&edit_with(ToolKind::Edit, &[], Some(nested)), &cwd));
    assert!(!accepts(&edit_with(ToolKind::Delete, &[], Some(json!({ "paths": ["a.rs", text(&outside)] }))), &cwd));
    assert!(accepts(&edit_with(ToolKind::Delete, &[], Some(json!({ "paths": ["a.rs", "b.rs"] }))), &cwd));
}

#[test]
fn any_key_can_name_a_path_and_values_nested_under_one_stay_paths() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("repo");
    std::fs::create_dir_all(&cwd).unwrap();
    let inside = cwd.join("a.rs");
    let edit = |raw: Value| edit_with(ToolKind::Edit, std::slice::from_ref(&inside), Some(raw));

    // Keys no list named: a climb out through any of them asks, a path inside is fine.
    for key in [
        "absolute_path",
        "directory",
        "dir",
        "uri",
        "url",
        "location",
        "relative_path",
        "new_location",
        "targetDir",
        "outputFile",
        "moveTo",
    ] {
        assert!(!accepts(&edit(json!({ key: "../outside.rs" })), &cwd), "{key}");
        assert!(accepts(&edit(json!({ key: "src/b.rs" })), &cwd), "{key}");
    }
    // A value nested under a path key, in objects and lists, is still a path.
    for raw in [
        json!({ "file": { "value": "../outside.rs" } }),
        json!({ "file": { "name": "/etc/x" } }),
        json!({ "targets": [{ "value": "../outside.rs" }] }),
        json!({ "paths": [["src/a.rs", "../outside.rs"]] }),
    ] {
        assert!(!accepts(&edit(raw.clone()), &cwd), "{raw}");
    }
    assert!(accepts(&edit(json!({ "file": { "value": "src/b.rs" }, "targets": [{ "value": "c.rs" }] })), &cwd));

    // Under any key at all, an absolute path, a home path or a file URI counts, wherever it points.
    let outside = root.path().join("cron.d/x").to_string_lossy().into_owned();
    for raw in [
        json!({ "file_path": "src/a.rs", "backup": outside }),
        json!({ "file_path": "src/a.rs", "extra": { "note": "~/.bashrc" } }),
        json!({ "file_path": "src/a.rs", "old_string": "/etc/passwd" }),
        json!({ "file_path": "src/a.rs", "misc": [r"C:\Windows\System32\x.dll"] }),
        json!({ "file_path": "src/a.rs", "misc": "file:///etc/passwd" }),
        json!({ "file_path": "src/a.rs", "misc": r"\\server\share\x" }),
    ] {
        assert!(!accepts(&edit(raw.clone()), &cwd), "{raw}");
    }
    assert!(accepts(&edit(json!({ "file_path": "src/a.rs", "extra": inside.to_string_lossy() })), &cwd));
    // Text that is content and not a path: several lines, or a one-line code comment.
    let content = json!({
        "file_path": "src/a.rs",
        "old_string": "/etc/passwd\nroot:x:0:0",
        "new_string": "// a comment",
        "content": "/* a comment */",
        "replace_all": true,
    });
    assert!(accepts(&edit(content), &cwd));
}

#[test]
fn paths_that_need_expanding_or_interpreting_ask() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("repo");
    std::fs::create_dir_all(&cwd).unwrap();
    for path in [
        "file:///etc/passwd",
        "https://example.com/x",
        "vscode-remote://ssh/x",
        "~/.bashrc",
        "~",
        "$HOME/x",
        "src/$X/y",
        r"%USERPROFILE%\x",
        "a%APPDATA%b",
        r"\\?\C:\x",
        r"\\.\pipe\x",
        r"\\server\share\x",
        "C:foo",
        "c:",
    ] {
        assert!(!accepts(&edit_with(ToolKind::Edit, &[PathBuf::from(path)], None), &cwd), "{path}");
        assert!(!accepts(&edit_with(ToolKind::Edit, &[], Some(json!({ "file_path": path }))), &cwd), "{path}");
    }
    // A `%` on its own, or around words, isn't a variable.
    for path in ["100%.txt", "a%b.txt", "50% off and 60% on.md"] {
        assert!(accepts(&edit_with(ToolKind::Edit, &[PathBuf::from(path)], None), &cwd), "{path}");
    }
}

#[test]
fn the_workspace_folder_itself_and_git_internals_ask() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("repo");
    std::fs::create_dir_all(cwd.join(".git/hooks")).unwrap();
    std::fs::create_dir_all(cwd.join("vendor/lib/.git")).unwrap();
    for path in [
        PathBuf::from("."),
        PathBuf::new(),
        cwd.clone(),
        cwd.join("."),
        PathBuf::from(".git"),
        PathBuf::from(".git/hooks/pre-commit"),
        PathBuf::from(".git/config"),
        cwd.join(".git/hooks/post-checkout"),
        PathBuf::from("vendor/lib/.git/config"),
        PathBuf::from(".GIT/config"),
        PathBuf::from(".git./config"),
    ] {
        for kind in [ToolKind::Edit, ToolKind::Delete] {
            assert!(!accepts(&edit_with(kind, std::slice::from_ref(&path), None), &cwd), "{kind:?} {path:?}");
        }
    }
    assert!(!accepts(&edit_with(ToolKind::Delete, &[], Some(json!({ "path": "." }))), &cwd));
    // Names that only look like it are ordinary files.
    for path in [".gitignore", ".github/workflows/ci.yml", "src/git/x.rs", ".git-blame-ignore-revs"] {
        assert!(accepts(&edit_with(ToolKind::Edit, &[PathBuf::from(path)], None), &cwd), "{path}");
    }
    #[cfg(unix)]
    {
        // Links to the root or into `.git` count where they point.
        std::os::unix::fs::symlink(&cwd, cwd.join("here")).unwrap();
        std::os::unix::fs::symlink(cwd.join(".git"), cwd.join("gitdir")).unwrap();
        assert!(!accepts(&edit_with(ToolKind::Delete, &[cwd.join("here")], None), &cwd));
        assert!(!accepts(&edit_with(ToolKind::Edit, &[cwd.join("gitdir/hooks/pre-commit")], None), &cwd));
    }
}

#[cfg(unix)]
#[test]
fn symlinks_count_where_they_point_even_when_dangling() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("repo");
    std::fs::create_dir_all(cwd.join("sub")).unwrap();
    std::fs::create_dir_all(root.path().join("home/.ssh")).unwrap();

    // `ws/link -> ~/.ssh/authorized_keys2`, which doesn't exist yet: a write through it lands outside.
    symlink(root.path().join("home/.ssh/authorized_keys2"), cwd.join("link")).unwrap();
    assert!(!accepts(&edit_with(ToolKind::Edit, &[cwd.join("link")], None), &cwd));
    // A dangling link to a folder that doesn't exist, with a file under it.
    symlink(root.path().join("gone"), cwd.join("gone_dir")).unwrap();
    assert!(!accepts(&edit_with(ToolKind::Edit, &[cwd.join("gone_dir/x.rs")], None), &cwd));
    // A dangling link to a new file inside the workspace is fine.
    symlink(cwd.join("sub/new.rs"), cwd.join("inside_link")).unwrap();
    assert!(accepts(&edit_with(ToolKind::Edit, &[cwd.join("inside_link")], None), &cwd));

    // Relative targets resolve from the link's own folder, `..` included.
    symlink("../..", cwd.join("sub/up")).unwrap();
    assert!(!accepts(&edit_with(ToolKind::Edit, &[cwd.join("sub/up/x.rs")], None), &cwd));
    symlink("../../gone/f.rs", cwd.join("sub/dangling_up")).unwrap();
    assert!(!accepts(&edit_with(ToolKind::Edit, &[cwd.join("sub/dangling_up")], None), &cwd));
    symlink("../other/new.rs", cwd.join("sub/sibling")).unwrap();
    assert!(accepts(&edit_with(ToolKind::Edit, &[cwd.join("sub/sibling")], None), &cwd));

    // A loop can't be resolved: ask.
    symlink("loop_b", cwd.join("loop_a")).unwrap();
    symlink("loop_a", cwd.join("loop_b")).unwrap();
    assert!(!accepts(&edit_with(ToolKind::Edit, &[cwd.join("loop_a")], None), &cwd));
    // A move's destination through a dangling link is checked the same way.
    let through = edit_with(ToolKind::Move, &[cwd.join("sub/a.rs")], Some(json!({ "destination": cwd.join("link").to_string_lossy() })));
    assert!(!accepts(&through, &cwd));
}
