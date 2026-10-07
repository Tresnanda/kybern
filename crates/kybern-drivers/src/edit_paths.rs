//! Which files does a tool call edit?
//!
//! Pure helpers the daemon uses to guard shared checkouts: given a driver's
//! [`ToolCall`] they return the raw paths the call writes, and
//! [`normalize_edit_path`] turns one into a checkout-relative path (or rejects
//! it when it lies outside the checkout). Shell commands are out of scope, as
//! are read, search and list tools: they return nothing.
//!
//! # What was verified and what is assumed
//!
//! Verified against the drivers in this crate and the locally installed
//! harness binaries (strings and bundled sources):
//!
//! - Claude (`claude.rs` forwards `tool_use` verbatim; Claude Code 2.1.290):
//!   `Edit`, `Write`, `MultiEdit` use `input.file_path`; `NotebookEdit` uses
//!   `input.notebook_path`.
//! - Codex (`codex.rs` emits `apply_patch` with `input.changes` taken from the
//!   `fileChange` item): `changes[].path`, plus `changes[].kind.move_path` for
//!   renames.
//! - OpenCode (installed `opencode` binary): `edit` and `write` take
//!   `filePath`; `apply_patch` takes `patchText` containing
//!   `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:`
//!   headers.
//! - Cursor ACP (`cursor/acp.rs`): the tool name is the lowercased
//!   `ToolKind` (`edit`, `delete`, `move`, ...) and the input is
//!   `{ title, raw }`; paths are only reliable at completion in
//!   `output.diffs[].path` ([`edited_paths_from_completion`]).
//! - Cursor SDK (`cursor/stream.rs` uses `toolCall.type` as the name; the
//!   installed `cursor-agent` bundle reads `editToolCall` / `deleteToolCall`
//!   `args.path`): `edit` and `delete` with `input.path`.
//! - OMP (installed `omp` binary): `write` and `edit` (replace mode) use
//!   `path` or `file_path`, with `rename` for moves; `edit` in
//!   `apply_patch` mode carries the `*** Update File:` text in `input`;
//!   `edit` in hashline mode carries `[path]` header lines (and `MV <path>`
//!   renames) in `input`.
//!
//! Assumed (not seen in a fixture or binary of the installed versions):
//!
//! - OpenCode `patch` (older releases) and `multiedit` use the same keys as
//!   `edit` / `apply_patch`.
//! - Pi: `write` and `edit` take `path` (from the pi coding agent's public
//!   tool schema; the `pi` binary is not installed here). Pi has no patch
//!   tool.
//! - Cursor ACP `move` input keys are guessed, so move paths come from
//!   completion diffs.
//! - OMP `ast_edit` takes glob `paths`, not concrete files, so it yields
//!   nothing.
//! - Codex may report `changes` as a path-keyed object in older protocol
//!   versions; both shapes are accepted.
//!
//! Tools whose name does not appear in the explicit list are treated as
//! editing only when the name clearly says so (for example `edit_file`,
//! `write_file`, `str_replace_editor`). MCP and Kybern tools never count.

use std::path::{Component, Path, PathBuf};

use kybern_protocol::ToolCall;
use serde_json::Value;

/// Keys that hold the single file a tool edits, in preference order.
const PATH_KEYS: [&str; 6] = ["notebook_path", "file_path", "filePath", "filepath", "path", "target_file"];

/// Keys that hold the destination of a move or rename.
const MOVE_KEYS: [&str; 5] = ["rename", "new_path", "move_path", "new_file_path", "destination"];

/// Keys that hold patch text with `*** Update File:` style headers.
const PATCH_TEXT_KEYS: [&str; 3] = ["patchText", "patch_text", "patch"];

/// Canonical (lowercase, alphanumeric only) tool names that always edit files.
const EDIT_TOOLS: [&str; 20] = [
    "edit",
    "write",
    "multiedit",
    "notebookedit",
    "editfile",
    "writefile",
    "createfile",
    "strreplace",
    "strreplaceeditor",
    "strreplaceedit",
    "applypatch",
    "patch",
    "multipatch",
    "filechange",
    "delete",
    "deletefile",
    "move",
    "movefile",
    "renamefile",
    "updatefile",
];

/// Cursor ACP kinds that never write files, even if they report diffs.
const READ_ONLY_KINDS: [&str; 7] = ["read", "search", "execute", "fetch", "think", "switchmode", "other"];

/// Paths a started tool call writes, as the tool gave them (not normalized),
/// deduplicated with first-seen order kept. Empty for read, search, shell and
/// unknown tools.
pub fn edited_paths(tool: &ToolCall) -> Vec<String> {
    let canon = canonical_name(&tool.name);
    if !is_edit_tool(&tool.name, &canon) {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Some(obj) = tool.input.as_object() {
        collect_object(obj, &canon, 0, &mut out);
    }
    dedupe(out)
}

/// Paths a completed tool call wrote, for harnesses that only report them at
/// completion (Cursor ACP: `output.diffs[].path`). Empty when `output` has no
/// diffs or the tool is a read-only kind.
pub fn edited_paths_from_completion(tool_name: &str, output: &Value) -> Vec<String> {
    let canon = canonical_name(tool_name);
    if READ_ONLY_KINDS.contains(&canon.as_str()) || is_foreign_tool(tool_name, &canon) {
        return Vec::new();
    }
    let out = output.get("diffs").and_then(Value::as_array).into_iter().flatten().filter_map(|diff| non_empty(diff.get("path"))).collect();
    dedupe(out)
}

/// Turns a tool-reported path into a path relative to `cwd` with `/`
/// separators. Absolute paths inside `cwd` are made relative and `.` / `..`
/// are resolved lexically (falling back to symlink resolution when the
/// lexical check fails). Returns `None` for paths outside `cwd`, `cwd` itself,
/// empty input and non-file URLs.
pub fn normalize_edit_path(cwd: &Path, raw: &str) -> Option<String> {
    let raw = raw.trim();
    let raw = raw.strip_prefix("file://").unwrap_or(raw);
    if raw.is_empty() || raw.contains("://") || raw.contains('\0') {
        return None;
    }
    let base = lexical(cwd);
    let abs = lexical(&cwd.join(raw));
    let rel = match abs.strip_prefix(&base) {
        Ok(rel) => rel.to_path_buf(),
        Err(_) => real(&abs).strip_prefix(real(&base)).ok()?.to_path_buf(),
    };
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?.to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn canonical_name(name: &str) -> String {
    name.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
}

/// MCP and Kybern tools are never file edits for this purpose.
fn is_foreign_tool(name: &str, canon: &str) -> bool {
    name.to_ascii_lowercase().starts_with("mcp") || canon.starts_with("kybern")
}

fn is_edit_tool(name: &str, canon: &str) -> bool {
    if is_foreign_tool(name, canon) {
        return false;
    }
    if EDIT_TOOLS.contains(&canon) {
        return true;
    }
    // Generic fallback: only names that clearly say they edit files.
    const BLOCKED: [&str; 6] = ["todo", "plan", "read", "note", "task", "memory"];
    if BLOCKED.iter().any(|word| canon.contains(word)) {
        return false;
    }
    const PREFIXES: [&str; 6] = ["edit", "write", "strreplace", "applypatch", "createfile", "deletefile"];
    const SUFFIXES: [&str; 4] = ["edit", "patch", "editfile", "writefile"];
    PREFIXES.iter().any(|p| canon.starts_with(p)) || SUFFIXES.iter().any(|s| canon.ends_with(s))
}

fn collect_object(obj: &serde_json::Map<String, Value>, canon: &str, depth: usize, out: &mut Vec<String>) {
    if let Some(path) = PATH_KEYS.iter().find_map(|key| non_empty(obj.get(*key))) {
        out.push(path);
    }
    if let Some(path) = MOVE_KEYS.iter().find_map(|key| non_empty(obj.get(*key))) {
        out.push(path);
    }
    for key in PATCH_TEXT_KEYS {
        if let Some(text) = obj.get(key).and_then(Value::as_str) {
            out.extend(patch_text_paths(text));
        }
    }
    // OMP carries patch or hashline text in `input`.
    if let Some(text) = obj.get("input").and_then(Value::as_str) {
        let patch = patch_text_paths(text);
        if !patch.is_empty() {
            out.extend(patch);
        } else if canon == "edit" {
            out.extend(hashline_paths(text));
        }
    }
    // Codex: `changes` is an array of `{ path, kind }` (older protocol: an
    // object keyed by path).
    match obj.get("changes") {
        Some(Value::Array(changes)) => {
            for change in changes.iter().filter_map(Value::as_object) {
                if let Some(path) = non_empty(change.get("path")) {
                    out.push(path);
                }
                if let Some(path) = non_empty(change.get("kind").and_then(|kind| kind.get("move_path"))) {
                    out.push(path);
                }
            }
        }
        Some(Value::Object(changes)) => out.extend(changes.keys().filter(|key| !key.trim().is_empty()).cloned()),
        _ => {}
    }
    if depth == 0 {
        // OMP multi-file `edits[]` entries and Cursor ACP's `raw` input.
        if let Some(edits) = obj.get("edits").and_then(Value::as_array) {
            for edit in edits.iter().filter_map(Value::as_object) {
                collect_object(edit, canon, 1, out);
            }
        }
        if let Some(raw) = obj.get("raw").and_then(Value::as_object) {
            collect_object(raw, canon, 1, out);
        }
    }
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Paths named by `*** Add|Update|Delete|Edit File:` and `*** Move to:` lines.
fn patch_text_paths(text: &str) -> Vec<String> {
    const HEADERS: [&str; 5] = ["*** Add File:", "*** Update File:", "*** Delete File:", "*** Edit File:", "*** Move to:"];
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            HEADERS.iter().find_map(|header| line.strip_prefix(header)).map(|rest| unquote(rest.trim()))
        })
        .filter(|path| !path.is_empty())
        .collect()
}

/// OMP hashline edits: a `[path]` header line starts each file and an
/// `MV <path>` line renames it. Line edits in between never start with `[`.
fn hashline_paths(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_file = false;
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix('[') {
            let inner = rest.strip_suffix(']').unwrap_or(rest);
            let path = unquote(strip_hash_suffix(inner.trim()));
            if !path.is_empty() {
                out.push(path);
                in_file = true;
            }
        } else if in_file && let Some(rest) = line.trim().strip_prefix("MV ") {
            let path = unquote(strip_hash_suffix(rest.trim()));
            if !path.is_empty() {
                out.push(path);
            }
        }
    }
    out
}

fn strip_hash_suffix(text: &str) -> &str {
    match text.rfind('#') {
        Some(at) if text.len() - at == 5 && text[at + 1..].chars().all(|c| c.is_ascii_hexdigit()) => &text[..at],
        _ => text,
    }
}

fn unquote(text: &str) -> String {
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && (bytes[0] == b'"' || bytes[0] == b'\'') && bytes[0] == bytes[bytes.len() - 1] {
        text[1..text.len() - 1].to_string()
    } else {
        text.to_string()
    }
}

fn dedupe(paths: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    paths.into_iter().filter(|path| seen.insert(path.clone())).collect()
}

/// Resolves `.` and `..` without touching the filesystem. `..` never climbs
/// above a root; on a relative path it is kept so callers can reject it.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonicalizes the longest existing ancestor and appends the rest, so paths
/// that do not exist yet (a file about to be created) still resolve symlinks
/// in their directory.
fn real(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut head = path.to_path_buf();
    loop {
        if let Ok(canon) = head.canonicalize() {
            return rest.iter().rev().fold(canon, |acc, part| acc.join(part));
        }
        match (head.file_name().map(|name| name.to_os_string()), head.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                head = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(name: &str, input: Value) -> ToolCall {
        ToolCall { id: "t1".into(), name: name.into(), input, parent_id: None }
    }

    fn paths(name: &str, input: Value) -> Vec<String> {
        edited_paths(&call(name, input))
    }

    #[test]
    fn claude_edit_write_multiedit_use_file_path() {
        for name in ["Edit", "Write", "MultiEdit"] {
            assert_eq!(
                paths(name, json!({"file_path": "/repo/src/a.rs", "old_string": "x", "new_string": "y"})),
                vec!["/repo/src/a.rs"],
                "{name}"
            );
        }
    }

    #[test]
    fn claude_notebook_edit_uses_notebook_path() {
        assert_eq!(paths("NotebookEdit", json!({"notebook_path": "/repo/n.ipynb", "new_source": "1"})), vec!["/repo/n.ipynb"]);
    }

    #[test]
    fn claude_read_only_and_shell_tools_are_empty() {
        for name in ["Read", "Grep", "Glob", "Bash", "WebFetch", "TodoWrite", "Task", "Agent"] {
            assert!(paths(name, json!({"file_path": "/repo/a.rs", "path": "/repo", "command": "rm a.rs"})).is_empty(), "{name}");
        }
    }

    #[test]
    fn codex_apply_patch_reads_changes_and_moves() {
        let input = json!({"changes": [
            {"path": "src/a.rs", "kind": {"type": "update", "move_path": null}, "diff": "@@"},
            {"path": "src/b.rs", "kind": {"type": "update", "move_path": "src/c.rs"}, "diff": "@@"},
            {"path": "src/new.rs", "kind": {"type": "add"}, "diff": "+x"},
            {"path": "src/a.rs", "kind": {"type": "update"}},
        ]});
        assert_eq!(paths("apply_patch", input), vec!["src/a.rs", "src/b.rs", "src/c.rs", "src/new.rs"]);
    }

    #[test]
    fn codex_changes_object_is_keyed_by_path() {
        let input = json!({"changes": {"a.rs": {"type": "add", "content": ""}, "b.rs": {"type": "delete"}}});
        assert_eq!(paths("apply_patch", input), vec!["a.rs", "b.rs"]);
    }

    #[test]
    fn codex_other_tools_are_empty() {
        assert!(paths("shell", json!({"command": ["ls"]})).is_empty());
        assert!(paths("mcp:fs/write_file", json!({"path": "/repo/a.rs"})).is_empty());
        assert!(paths("apply_patch", json!({"changes": []})).is_empty());
    }

    #[test]
    fn opencode_edit_write_use_file_path_camel_case() {
        assert_eq!(paths("edit", json!({"filePath": "/repo/a.ts", "oldString": "a", "newString": "b"})), vec!["/repo/a.ts"]);
        assert_eq!(paths("write", json!({"filePath": "/repo/b.ts", "content": "x"})), vec!["/repo/b.ts"]);
        assert_eq!(
            paths("multiedit", json!({"filePath": "/repo/c.ts", "edits": [{"oldString": "a", "newString": "b"}]})),
            vec!["/repo/c.ts"]
        );
    }

    #[test]
    fn opencode_apply_patch_parses_every_header() {
        let patch = "*** Begin Patch\n*** Add File: hello.txt\n+Hello\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print(\"Hi\")\n+print(\"Hello\")\n*** Delete File: obsolete.txt\n*** End Patch";
        assert_eq!(paths("apply_patch", json!({"patchText": patch})), vec!["hello.txt", "src/app.py", "src/main.py", "obsolete.txt"]);
        assert_eq!(paths("patch", json!({"patchText": patch})).len(), 4);
    }

    #[test]
    fn opencode_read_only_tools_are_empty() {
        for name in ["read", "grep", "glob", "list", "bash", "webfetch", "todowrite", "task"] {
            assert!(paths(name, json!({"filePath": "/repo/a.ts", "path": "/repo"})).is_empty(), "{name}");
        }
    }

    #[test]
    fn pi_write_and_edit_use_path() {
        assert_eq!(paths("write", json!({"path": "src/a.ts", "content": "x"})), vec!["src/a.ts"]);
        assert_eq!(paths("edit", json!({"path": "src/b.ts", "oldText": "a", "newText": "b"})), vec!["src/b.ts"]);
        assert!(paths("read", json!({"path": "src/b.ts"})).is_empty());
        assert!(paths("bash", json!({"command": "echo hi > a"})).is_empty());
        assert!(paths("grep", json!({"pattern": "x", "path": "src"})).is_empty());
    }

    #[test]
    fn omp_edit_modes() {
        assert_eq!(paths("edit", json!({"file_path": "src/a.ts", "oldText": "a", "newText": "b"})), vec!["src/a.ts"]);
        assert_eq!(paths("edit", json!({"file_path": "src/a.ts", "rename": "src/b.ts"})), vec!["src/a.ts", "src/b.ts"]);
        assert_eq!(paths("edit", json!({"file_path": "scripts/old.ts", "op": "delete"})), vec!["scripts/old.ts"]);
        assert_eq!(paths("edit", json!({"edits": [{"path": "a.ts"}, {"file_path": "b.ts"}, {"path": "a.ts"}]})), vec!["a.ts", "b.ts"]);
        assert_eq!(paths("write", json!({"path": "docs/x.md", "content": "x"})), vec!["docs/x.md"]);
        let patch = "*** Begin Patch\n*** Update File: src/z.ts\n@@\n-a\n+b\n*** End Patch";
        assert_eq!(paths("edit", json!({"input": patch})), vec!["src/z.ts"]);
    }

    #[test]
    fn omp_hashline_headers_and_renames() {
        let input = "[src/a.ts#1a2b]\n+ 3|let x = 1;\n[\"src/with space.ts\"]\nMV src/moved.ts\n";
        assert_eq!(paths("edit", json!({"input": input})), vec!["src/a.ts", "src/with space.ts", "src/moved.ts"]);
        assert!(paths("write", json!({"input": "[nope]"})).is_empty());
    }

    #[test]
    fn omp_ast_edit_globs_are_ignored() {
        assert!(paths("ast_edit", json!({"paths": ["src/**/*.ts"], "ops": []})).is_empty());
        assert!(paths("ast_grep", json!({"paths": ["src/**/*.ts"]})).is_empty());
    }

    #[test]
    fn cursor_sdk_edit_and_delete_use_path() {
        assert_eq!(paths("edit", json!({"path": "src/a.rs", "streamContent": "x"})), vec!["src/a.rs"]);
        assert_eq!(paths("delete", json!({"path": "src/old.rs"})), vec!["src/old.rs"]);
        for name in ["read", "shell", "glob", "grep", "ls", "task", "createPlan", "readLints", "semSearch", "webFetch"] {
            assert!(paths(name, json!({"path": "src", "command": "rm -rf x"})).is_empty(), "{name}");
        }
    }

    #[test]
    fn cursor_sdk_mcp_tool_is_not_an_edit() {
        assert!(paths("mcp__fs__write_file", json!({"path": "a.rs"})).is_empty());
    }

    #[test]
    fn cursor_acp_start_reads_raw_input_when_present() {
        assert_eq!(paths("edit", json!({"title": "Edit a.rs", "raw": {"path": "src/a.rs"}})), vec!["src/a.rs"]);
        assert!(paths("edit", json!({"title": "Edit a.rs", "raw": null})).is_empty());
        assert!(paths("read", json!({"title": "Read a.rs", "raw": {"path": "src/a.rs"}})).is_empty());
        assert!(paths("execute", json!({"title": "ls", "raw": {"command": "ls"}})).is_empty());
    }

    #[test]
    fn cursor_acp_completion_reads_diffs() {
        let output = json!({
            "raw": null,
            "diffs": [
                {"path": "/repo/src/a.rs", "old": "a", "new": "b"},
                {"path": "/repo/src/b.rs", "old": null, "new": "c"},
                {"path": "/repo/src/a.rs", "old": "b", "new": "d"},
            ],
            "content": [],
            "title": "Edit",
        });
        assert_eq!(edited_paths_from_completion("edit", &output), vec!["/repo/src/a.rs", "/repo/src/b.rs"]);
        assert_eq!(edited_paths_from_completion("delete", &json!({"diffs": [{"path": "x.rs", "old": "a", "new": null}]})), vec!["x.rs"]);
    }

    #[test]
    fn cursor_acp_completion_ignores_missing_diffs_and_read_kinds() {
        assert!(edited_paths_from_completion("edit", &json!({"diffs": []})).is_empty());
        assert!(edited_paths_from_completion("edit", &json!({"raw": "ok"})).is_empty());
        assert!(edited_paths_from_completion("edit", &Value::Null).is_empty());
        assert!(edited_paths_from_completion("read", &json!({"diffs": [{"path": "a.rs"}]})).is_empty());
        assert!(edited_paths_from_completion("execute", &json!({"diffs": [{"path": "a.rs"}]})).is_empty());
        assert!(edited_paths_from_completion("mcp__x__y", &json!({"diffs": [{"path": "a.rs"}]})).is_empty());
        assert!(edited_paths_from_completion("edit", &json!({"diffs": [{"old": "a"}, {"path": "  "}]})).is_empty());
    }

    #[test]
    fn unknown_tools_fall_back_only_when_the_name_says_edit() {
        assert_eq!(paths("edit_file", json!({"path": "a.rs"})), vec!["a.rs"]);
        assert_eq!(paths("write_file", json!({"file_path": "b.rs"})), vec!["b.rs"]);
        assert_eq!(paths("str_replace_editor", json!({"path": "c.rs", "command": "str_replace"})), vec!["c.rs"]);
        assert_eq!(paths("MyPatch", json!({"patch": "*** Update File: d.rs\n"})), vec!["d.rs"]);
        for name in [
            "list_dir",
            "run_tests",
            "update_plan",
            "TodoWrite",
            "read_file",
            "kybern_note_create",
            "kybern_task_update",
            "search",
            "web_search",
        ] {
            assert!(paths(name, json!({"path": "a.rs", "file_path": "a.rs"})).is_empty(), "{name}");
        }
    }

    #[test]
    fn malformed_inputs_yield_nothing() {
        assert!(paths("Edit", Value::Null).is_empty());
        assert!(paths("Edit", json!("a.rs")).is_empty());
        assert!(paths("Edit", json!({"file_path": 3})).is_empty());
        assert!(paths("Edit", json!({"file_path": "  "})).is_empty());
        assert!(paths("apply_patch", json!({"changes": "nope"})).is_empty());
        assert!(paths("apply_patch", json!({"changes": [null, 1, {"kind": {}}]})).is_empty());
    }

    #[test]
    fn duplicates_collapse_with_order_preserved() {
        let input = json!({"changes": [{"path": "b.rs"}, {"path": "a.rs"}, {"path": "b.rs"}]});
        assert_eq!(paths("apply_patch", input), vec!["b.rs", "a.rs"]);
    }

    #[test]
    fn normalize_makes_absolute_paths_relative() {
        let cwd = Path::new("/repo");
        assert_eq!(normalize_edit_path(cwd, "/repo/src/a.rs").as_deref(), Some("src/a.rs"));
        assert_eq!(normalize_edit_path(Path::new("/repo/"), "/repo/a.rs").as_deref(), Some("a.rs"));
        assert_eq!(normalize_edit_path(cwd, "src/a.rs").as_deref(), Some("src/a.rs"));
    }

    #[test]
    fn normalize_resolves_dots_lexically() {
        let cwd = Path::new("/repo");
        assert_eq!(normalize_edit_path(cwd, "./src/./a.rs").as_deref(), Some("src/a.rs"));
        assert_eq!(normalize_edit_path(cwd, "src/../lib/a.rs").as_deref(), Some("lib/a.rs"));
        assert_eq!(normalize_edit_path(cwd, "/repo/src/../a.rs").as_deref(), Some("a.rs"));
        assert_eq!(normalize_edit_path(cwd, "../repo/a.rs").as_deref(), Some("a.rs"));
        assert_eq!(normalize_edit_path(Path::new("/repo/sub/../x"), "/repo/x/a.rs").as_deref(), Some("a.rs"));
    }

    #[test]
    fn normalize_rejects_outside_empty_and_virtual_paths() {
        let cwd = Path::new("/repo");
        assert_eq!(normalize_edit_path(cwd, "../other/a.rs"), None);
        assert_eq!(normalize_edit_path(cwd, "src/../../a.rs"), None);
        assert_eq!(normalize_edit_path(cwd, "/etc/passwd"), None);
        assert_eq!(normalize_edit_path(cwd, "/repository/a.rs"), None);
        assert_eq!(normalize_edit_path(cwd, "/repo"), None);
        assert_eq!(normalize_edit_path(cwd, "."), None);
        assert_eq!(normalize_edit_path(cwd, ""), None);
        assert_eq!(normalize_edit_path(cwd, "   "), None);
        assert_eq!(normalize_edit_path(cwd, "https://example.com/a"), None);
        assert_eq!(normalize_edit_path(cwd, "conflict://*"), None);
        assert_eq!(normalize_edit_path(cwd, "/.."), None);
    }

    #[test]
    fn normalize_accepts_file_urls_and_trims() {
        let cwd = Path::new("/repo");
        assert_eq!(normalize_edit_path(cwd, "file:///repo/a.rs").as_deref(), Some("a.rs"));
        assert_eq!(normalize_edit_path(cwd, "  src/a.rs \n").as_deref(), Some("src/a.rs"));
    }

    #[test]
    fn normalize_handles_relative_cwd() {
        assert_eq!(normalize_edit_path(Path::new("."), "src/a.rs").as_deref(), Some("src/a.rs"));
        assert_eq!(normalize_edit_path(Path::new("."), "../a.rs"), None);
    }

    #[cfg(unix)]
    #[test]
    fn normalize_resolves_symlinked_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let real_root = dir.path().join("real");
        std::fs::create_dir_all(real_root.join("src")).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real_root, &link).unwrap();
        // The agent reports the symlink's target; the daemon knows the link.
        let reported = real_root.join("src/new.rs");
        assert_eq!(normalize_edit_path(&link, reported.to_str().unwrap()).as_deref(), Some("src/new.rs"));
        // And the other way round.
        let reported = link.join("src/a.rs");
        assert_eq!(normalize_edit_path(&real_root, reported.to_str().unwrap()).as_deref(), Some("src/a.rs"));
        // A path really outside still fails.
        let outside = dir.path().join("elsewhere/a.rs");
        assert_eq!(normalize_edit_path(&link, outside.to_str().unwrap()), None);
    }

    #[test]
    fn end_to_end_extract_then_normalize() {
        let cwd = Path::new("/repo");
        let raw = paths("Edit", json!({"file_path": "/repo/src/a.rs"}));
        let normalized: Vec<_> = raw.iter().filter_map(|p| normalize_edit_path(cwd, p)).collect();
        assert_eq!(normalized, vec!["src/a.rs"]);
    }
}
