//! Thread-bound, read-only tools exposed directly to capable agent harnesses.
//!
//! These are deliberately not RPC methods. The orchestrator supplies the
//! owning thread id from the live driver session and this module never accepts
//! a caller-selected thread, project, or working directory.

use std::path::Path;

use anyhow::{Result, anyhow, bail, ensure};
use kybern_git::Repo;
use kybern_protocol::{ThreadId, TurnId};
use kybern_store::Store;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::terminal::TerminalManager;

pub(crate) const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
pub(crate) const MAX_RESULT_BYTES: usize = 256 * 1024;
pub(crate) const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
pub(crate) const MAX_CONCURRENT_REQUESTS: usize = 4;

const MAX_FILE_BYTES: u64 = 128 * 1024;
const MAX_TERMINAL_BYTES: usize = 64 * 1024;
const MAX_DIFF_PATCH_BYTES: usize = 192 * 1024;
const MAX_FILE_ENTRIES: usize = 500;
const MAX_RUNTIME_TASKS: usize = 200;
const MAX_TERMINALS: usize = 100;

#[derive(Clone)]
pub(crate) struct AppTools {
    store: Store,
    terminals: TerminalManager,
}

impl AppTools {
    pub(crate) fn new(store: Store, terminals: TerminalManager) -> Self {
        Self { store, terminals }
    }

    pub(crate) async fn execute(&self, thread_id: ThreadId, name: &str, arguments: Value) -> Result<Value> {
        ensure!(serde_json::to_vec(&arguments)?.len() <= MAX_ARGUMENT_BYTES, "tool arguments exceed the 64 KiB limit");
        ensure!(arguments.is_object(), "tool arguments must be a JSON object");

        let value = match name {
            "kybern_thread_context" => self.thread_context(thread_id, parse(arguments)?),
            "kybern_workspace_diff" => self.workspace_diff(thread_id, parse(arguments)?).await,
            "kybern_read_file" => self.read_file(thread_id, parse(arguments)?).await,
            "kybern_list_files" => self.list_files(thread_id, parse(arguments)?).await,
            "kybern_runtime_tasks" => self.runtime_tasks(thread_id, parse(arguments)?),
            "kybern_list_terminals" => self.list_terminals(thread_id, parse(arguments)?),
            "kybern_read_terminal" => self.read_terminal(thread_id, parse(arguments)?),
            _ => bail!("unknown Kybern app tool: {name}"),
        }?;
        ensure!(serde_json::to_vec(&value)?.len() <= MAX_RESULT_BYTES, "tool result exceeds the 256 KiB limit");
        Ok(value)
    }

    fn thread_context(&self, thread_id: ThreadId, _args: EmptyArgs) -> Result<Value> {
        let thread = self.thread(thread_id)?;
        let project = self.store.project_get(thread.project_id)?.ok_or_else(|| anyhow!("owning project no longer exists"))?;
        let notes = self.store.thread_notes(thread_id)?;
        Ok(json!({
            "thread": {
                "id": thread.id,
                "title": thread.title,
                "status": thread.status,
                "provider": thread.provider.kind,
                "model": thread.model,
                "effort": thread.effort,
                "permission_mode": thread.permission_mode,
                "cwd": thread.cwd,
                "worktree": thread.worktree,
            },
            "project": {
                "id": project.id,
                "name": project.name,
                "path": project.path,
                "is_git": project.is_git,
                "worktrees_default": project.worktrees_default,
            },
            "notes": notes,
        }))
    }

    async fn workspace_diff(&self, thread_id: ThreadId, args: WorkspaceDiffArgs) -> Result<Value> {
        let thread = self.thread(thread_id)?;
        ensure_relative_path(args.path.as_deref())?;
        let repo = Repo::new(&thread.cwd);
        let checkpoint = match args.turn_id {
            Some(turn_id) => {
                let checkpoint = self.store.checkpoint_get(turn_id)?.ok_or_else(|| anyhow!("no checkpoint for that turn"))?;
                ensure!(checkpoint.thread_id == thread_id, "checkpoint belongs to another thread");
                Some(checkpoint)
            }
            None => None,
        };
        ensure!(Repo::is_repo(Path::new(&thread.cwd)).await, "project is not a git repository");
        let (from, to) = match checkpoint {
            Some(checkpoint) => {
                let to = match checkpoint.after {
                    Some(after) => after,
                    None => repo.snapshot("kybern app-tool diff (in progress)").await?,
                };
                (checkpoint.before, to)
            }
            None => {
                let first = self
                    .store
                    .checkpoints_for_thread(thread_id)?
                    .into_iter()
                    .next()
                    .ok_or_else(|| anyhow!("thread has no checkpoints yet"))?;
                (first.before, repo.snapshot("kybern app-tool diff (now)").await?)
            }
        };
        let mut diff = repo.diff_with_options(&from, &to, args.include_patch, args.path.as_deref()).await?;
        if diff.files.len() > MAX_FILE_ENTRIES {
            diff.files.truncate(MAX_FILE_ENTRIES);
            diff.patch_truncated = true;
        }
        if truncate_utf8(&mut diff.patch, MAX_DIFF_PATCH_BYTES) {
            diff.patch_truncated = true;
        }
        serde_json::to_value(diff).map_err(Into::into)
    }

    async fn read_file(&self, thread_id: ThreadId, args: ReadFileArgs) -> Result<Value> {
        let thread = self.thread(thread_id)?;
        ensure!(!args.path.is_empty(), "path is required");
        ensure_relative_path(Some(&args.path))?;
        let max_bytes = args.max_bytes.unwrap_or(MAX_FILE_BYTES).clamp(1, MAX_FILE_BYTES);
        Ok(serde_json::to_value(crate::files::read_file(Path::new(&thread.cwd), &args.path, max_bytes).await?)?)
    }

    async fn list_files(&self, thread_id: ThreadId, args: ListFilesArgs) -> Result<Value> {
        let thread = self.thread(thread_id)?;
        ensure_relative_path(args.path.as_deref())?;
        let mut entries = crate::files::list_dir(Path::new(&thread.cwd), args.path.as_deref().unwrap_or("")).await?;
        let truncated = entries.len() > MAX_FILE_ENTRIES;
        entries.truncate(MAX_FILE_ENTRIES);
        Ok(json!({ "entries": entries, "truncated": truncated }))
    }

    fn runtime_tasks(&self, thread_id: ThreadId, _args: EmptyArgs) -> Result<Value> {
        self.thread(thread_id)?;
        let mut tasks = self.store.runtime_tasks_for_thread(thread_id)?;
        let truncated = tasks.len() > MAX_RUNTIME_TASKS;
        tasks.truncate(MAX_RUNTIME_TASKS);
        Ok(json!({ "tasks": tasks, "truncated": truncated }))
    }

    fn list_terminals(&self, thread_id: ThreadId, _args: EmptyArgs) -> Result<Value> {
        self.thread(thread_id)?;
        let mut terminals = self.terminals.list(Some(thread_id));
        let truncated = terminals.len() > MAX_TERMINALS;
        terminals.truncate(MAX_TERMINALS);
        Ok(json!({ "terminals": terminals, "truncated": truncated }))
    }

    fn read_terminal(&self, thread_id: ThreadId, args: ReadTerminalArgs) -> Result<Value> {
        self.thread(thread_id)?;
        let terminal = self.terminals.get(args.terminal_id).ok_or_else(|| anyhow!("terminal not found"))?;
        let info = terminal.info();
        ensure!(info.thread_id == Some(thread_id), "terminal belongs to another thread");
        let (_, bytes) = terminal.subscribe_output(true);
        let max_bytes = args.max_bytes.unwrap_or(MAX_TERMINAL_BYTES).clamp(1, MAX_TERMINAL_BYTES);
        let start = bytes.len().saturating_sub(max_bytes);
        let content = String::from_utf8_lossy(&bytes[start..]).into_owned();
        Ok(json!({ "terminal": info, "content": content, "truncated": start > 0 }))
    }

    fn thread(&self, thread_id: ThreadId) -> Result<kybern_protocol::Thread> {
        self.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("owning thread no longer exists"))
    }
}

fn parse<T: for<'de> Deserialize<'de>>(arguments: Value) -> Result<T> {
    serde_json::from_value(arguments).map_err(|error| anyhow!("invalid tool arguments: {error}"))
}

fn ensure_relative_path(path: Option<&str>) -> Result<()> {
    let Some(path) = path else { return Ok(()) };
    let path = Path::new(path);
    ensure!(!path.is_absolute(), "path must stay inside the project");
    ensure!(path.components().all(|part| matches!(part, std::path::Component::Normal(_))), "path must stay inside the project");
    Ok(())
}

fn truncate_utf8(text: &mut String, max_bytes: usize) -> bool {
    if text.len() <= max_bytes {
        return false;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    true
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceDiffArgs {
    #[serde(default)]
    turn_id: Option<TurnId>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default = "default_true")]
    include_patch: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadFileArgs {
    path: String,
    #[serde(default)]
    max_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListFilesArgs {
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadTerminalArgs {
    terminal_id: kybern_protocol::TerminalId,
    #[serde(default)]
    max_bytes: Option<usize>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use kybern_protocol::{Checkpoint, PermissionMode, Project, ProviderInstance, ProviderKind, Thread, ThreadStatus};
    use uuid::Uuid;

    struct Fixture {
        root: std::path::PathBuf,
        tools: AppTools,
        store: Store,
        thread: Thread,
        other_thread: Thread,
        terminals: TerminalManager,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("kybern-app-tools-test-{}", Uuid::now_v7()));
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("inside.txt"), "safe").unwrap();
            let store = Store::open_in_memory().unwrap();
            let now = Utc::now();
            let project = Project {
                id: Uuid::now_v7(),
                name: "fixture".into(),
                path: root.to_string_lossy().into(),
                is_git: false,
                worktrees_default: None,
                created_at: now,
                updated_at: now,
            };
            store.project_insert(&project).unwrap();
            let make_thread = |id| Thread {
                id,
                project_id: project.id,
                title: "Fixture".into(),
                provider: ProviderInstance::default_for(ProviderKind::Pi),
                model: None,
                effort: None,
                permission_mode: PermissionMode::Supervised,
                status: ThreadStatus::Running,
                worktree: None,
                cwd: project.path.clone(),
                provider_session_id: Some("secret-provider-id".into()),
                pinned: false,
                created_at: now,
                updated_at: now,
                last_seq: 0,
            };
            let thread = make_thread(Uuid::now_v7());
            let other_thread = make_thread(Uuid::now_v7());
            store.thread_upsert(&thread).unwrap();
            store.thread_upsert(&other_thread).unwrap();
            let terminals = TerminalManager::default();
            let tools = AppTools::new(store.clone(), terminals.clone());
            Self { root, tools, store, thread, other_thread, terminals }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[tokio::test]
    async fn context_is_bound_to_owner_and_excludes_provider_session_id() {
        let fixture = Fixture::new();
        let context = fixture.tools.execute(fixture.thread.id, "kybern_thread_context", json!({})).await.unwrap();
        assert_eq!(context["thread"]["id"], json!(fixture.thread.id));
        assert!(context["thread"].get("provider_session_id").is_none());
        assert!(!context.to_string().contains("secret-provider-id"));
        assert!(
            fixture
                .tools
                .execute(fixture.thread.id, "kybern_thread_context", json!({ "thread_id": fixture.other_thread.id }))
                .await
                .unwrap_err()
                .to_string()
                .contains("unknown field")
        );
    }

    #[tokio::test]
    async fn read_file_rejects_traversal_and_bounds_output() {
        let fixture = Fixture::new();
        let outside = fixture.root.parent().unwrap().join(format!("outside-{}", Uuid::now_v7()));
        std::fs::write(&outside, "private").unwrap();
        let error = fixture
            .tools
            .execute(
                fixture.thread.id,
                "kybern_read_file",
                json!({ "path": format!("../{}", outside.file_name().unwrap().to_string_lossy()) }),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("inside the project"));

        std::fs::write(fixture.root.join("large.txt"), vec![b'x'; (MAX_FILE_BYTES + 1024) as usize]).unwrap();
        let result = fixture
            .tools
            .execute(fixture.thread.id, "kybern_read_file", json!({ "path": "large.txt", "max_bytes": MAX_FILE_BYTES * 2 }))
            .await
            .unwrap();
        assert_eq!(result["content"].as_str().unwrap().len(), MAX_FILE_BYTES as usize);
        assert_eq!(result["truncated"], true);
        std::fs::remove_file(outside).unwrap();
    }

    #[tokio::test]
    async fn workspace_diff_rejects_another_threads_checkpoint() {
        let fixture = Fixture::new();
        let turn_id = Uuid::now_v7();
        fixture
            .store
            .checkpoint_upsert(&Checkpoint {
                thread_id: fixture.other_thread.id,
                turn_id,
                before: "before".into(),
                after: Some("after".into()),
                provider_turn_id: None,
                provider_turn_end: None,
                created_at: Utc::now(),
            })
            .unwrap();
        let error = fixture.tools.execute(fixture.thread.id, "kybern_workspace_diff", json!({ "turn_id": turn_id })).await.unwrap_err();
        assert!(error.to_string().contains("another thread"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_reads_cannot_cross_threads() {
        let fixture = Fixture::new();
        let terminal = fixture
            .terminals
            .create(
                None,
                Some(fixture.other_thread.id),
                fixture.root.to_string_lossy().into(),
                80,
                24,
                Some(vec!["/bin/sh".into(), "-c".into(), "printf other-thread".into()]),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while terminal.info().alive && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let error = fixture
            .tools
            .execute(fixture.thread.id, "kybern_read_terminal", json!({ "terminal_id": terminal.info().id }))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("another thread"));
        assert!(
            fixture.tools.execute(fixture.thread.id, "kybern_list_terminals", json!({})).await.unwrap()["terminals"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
