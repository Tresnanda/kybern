//! Thread-bound, read-only tools exposed directly to capable agent harnesses.
//!
//! These are deliberately not RPC methods. The orchestrator supplies the
//! owning thread id from the live driver session and this module never accepts
//! a caller-selected thread, project, or working directory.

use std::path::Path;

use anyhow::{Result, anyhow, bail, ensure};
use kybern_git::Repo;
use kybern_protocol::*;
use kybern_store::Store;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

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

/// Native tools spare the model UUID bookkeeping. A transport retry uses the
/// same operation; an optional readable key also survives a model-level retry.
/// The public RPC contract still requires explicit UUID operation IDs.
pub(crate) fn prepare_native_operation(
    thread_id: ThreadId,
    session_id: uuid::Uuid,
    turn_id: TurnId,
    call_id: &str,
    name: &str,
    arguments: &mut Value,
) -> Result<Option<OperationId>> {
    if !matches!(
        name,
        "kybern_thread_send"
            | "kybern_collaboration_spawn"
            | "kybern_collaboration_send"
            | "kybern_collaboration_report"
            | "kybern_collaboration_cancel"
            | "kybern_collaboration_context_put"
    ) {
        return Ok(None);
    }
    let object = arguments.as_object_mut().ok_or_else(|| anyhow!("tool arguments must be an object"))?;
    let request_key = object.remove("request_key");
    if let Some(value) = object.get("operation_id").filter(|value| !value.is_null()) {
        ensure!(request_key.as_ref().is_none_or(Value::is_null), "Use request_key or operation_id, not both.");
        let id = value.as_str().and_then(|value| uuid::Uuid::parse_str(value).ok()).ok_or_else(|| {
            anyhow!(
                "operation_id must be a UUID. Omit it to let Kybern handle retries, or use a short request_key; no shell command is needed."
            )
        })?;
        return Ok(Some(id));
    }
    let identity = match request_key.filter(|value| !value.is_null()) {
        Some(value) => {
            let key = value.as_str().map(str::trim).filter(|key| !key.is_empty() && key.len() <= 128).ok_or_else(|| {
                anyhow!("request_key must be a non-empty label of at most 128 bytes. Reuse it only for the same operation.")
            })?;
            json!(["kybern-native-key-v1", thread_id, name, key])
        }
        None => json!(["kybern-native-call-v1", thread_id, session_id, turn_id, name, call_id]),
    };
    let digest = Sha256::digest(serde_json::to_vec(&identity)?);
    let mut bytes: [u8; 16] = digest[..16].try_into().expect("SHA-256 contains 16 bytes");
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let id = uuid::Uuid::from_bytes(bytes);
    object.insert("operation_id".into(), json!(id));
    Ok(Some(id))
}

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
            "kybern_threads_search" => self.threads_search(thread_id, parse(arguments)?),
            "kybern_thread_read" => self.thread_read(parse(arguments)?),
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
                "parent_thread_id": thread.parent_thread_id,
                "coordinator_project_id": thread.coordinator_project_id,
                "collaboration_group_id": thread.collaboration_group_id,
            },
            "project": {
                "id": project.id,
                "name": project.name,
                "path": project.path,
                "is_git": project.is_git,
                "worktrees_default": project.worktrees_default,
            },
            "notes": notes,
            "collaboration": {
                "available": true,
                "guidance": "Use kybern_threads_search and kybern_thread_read to inspect prior chats without waking them. Use kybern_thread_send for an addressed durable message. kybern_collaboration_spawn creates a managed Kybern child chat; group setup is automatic. Provider-native subagents and external plugins remain separate options."
            }
        }))
    }

    fn threads_search(&self, caller_thread_id: ThreadId, args: ThreadSearchArgs) -> Result<Value> {
        let caller = self.thread(caller_thread_id)?;
        let requested_project = args.project_id.unwrap_or(caller.project_id);
        let project_id = (!args.all_projects).then_some(requested_project);
        let preferred_project_id = args.all_projects.then_some(requested_project);
        Ok(serde_json::to_value(self.store.search_thread_history(
            project_id,
            preferred_project_id,
            args.query.as_deref(),
            args.include_archived,
            args.cursor.as_deref(),
            args.limit.unwrap_or(50),
        )?)?)
    }

    fn thread_read(&self, args: ThreadReadArgs) -> Result<Value> {
        Ok(serde_json::to_value(self.store.read_thread_history(
            args.thread_id,
            args.before_seq,
            args.through_seq,
            args.limit.unwrap_or(100),
            args.message_seq,
            args.text_offset,
        )?)?)
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

pub(crate) fn native_tool_definitions() -> Vec<kybern_drivers::NativeToolDefinition> {
    use kybern_drivers::NativeToolDefinition;
    let object = |properties: Value, required: &[&str]| {
        json!({
            "type": "object", "additionalProperties": false, "properties": properties, "required": required
        })
    };
    let mut definitions = vec![
        NativeToolDefinition { name: "kybern_thread_context".into(), description: "Read the active Kybern thread, project, user notes, and available harness/profile/model/effort choices. Use these choices when selecting a worker; a loading catalog refreshes in the background.".into(), input_schema: object(json!({}), &[]) },
        NativeToolDefinition { name: "kybern_workspace_diff".into(), description: "Read the active thread worktree diff.".into(), input_schema: object(json!({"turn_id":{"type":["string","null"],"format":"uuid"},"path":{"type":["string","null"]},"include_patch":{"type":"boolean"}}), &[]) },
        NativeToolDefinition { name: "kybern_read_file".into(), description: "Read a relative file in the active thread workspace.".into(), input_schema: object(json!({"path":{"type":"string"},"max_bytes":{"type":"integer","minimum":1}}), &["path"]) },
        NativeToolDefinition { name: "kybern_list_files".into(), description: "List a relative directory in the active thread workspace.".into(), input_schema: object(json!({"path":{"type":["string","null"]}}), &[]) },
        NativeToolDefinition { name: "kybern_runtime_tasks".into(), description: "Read provider-owned runtime tasks for the active thread.".into(), input_schema: object(json!({}), &[]) },
        NativeToolDefinition { name: "kybern_list_terminals".into(), description: "List terminals owned by the active thread.".into(), input_schema: object(json!({}), &[]) },
        NativeToolDefinition { name: "kybern_read_terminal".into(), description: "Read recent output from a terminal owned by the active thread.".into(), input_schema: object(json!({"terminal_id":{"type":"string","format":"uuid"},"max_bytes":{"type":"integer","minimum":1}}), &["terminal_id"]) },
        NativeToolDefinition { name: "kybern_threads_search".into(), description: "Find current, old, or archived Kybern threads. Defaults to this project; pass an explicit project_id or all_projects to search other projects on this daemon. This is read-only and never wakes a thread.".into(), input_schema: object(json!({"project_id":{"type":["string","null"],"format":"uuid"},"all_projects":{"type":"boolean"},"query":{"type":["string","null"]},"include_archived":{"type":"boolean"},"cursor":{"type":["string","null"]},"limit":{"type":"integer","minimum":1,"maximum":100}}), &[]) },
        NativeToolDefinition { name: "kybern_thread_read".into(), description: "Read bounded persisted messages from any thread on this daemon with source attribution. This never starts, resumes, or wakes its provider. To continue a truncated message, pass the returned through_seq and message_seq, and set text_offset to next_text_offset.".into(), input_schema: object(json!({"thread_id":{"type":"string","format":"uuid"},"before_seq":{"type":["integer","null"]},"through_seq":{"type":["integer","null"]},"message_seq":{"type":["integer","null"]},"text_offset":{"type":["integer","null"],"minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200}}), &["thread_id"]) },
        NativeToolDefinition { name: "kybern_thread_send".into(), description: "Send a durable attributed message to an existing thread. The recipient keeps its project, workspace, provider, permission mode, and assignment ownership; busy recipients queue the message.".into(), input_schema: object(json!({
            "operation_id":{"type":"string","format":"uuid"}, "assignment_id":{"type":["string","null"],"format":"uuid"}, "to_thread_id":{"type":"string","format":"uuid"},
            "purpose":{"enum":["progress","question","reply","change_request","result","failure","redirect"]}, "reply_to":{"type":["string","null"],"format":"uuid"}, "body":{"type":"string"}
        }), &["operation_id","to_thread_id","purpose","body"]) },
        NativeToolDefinition { name: "kybern_collaboration_spawn".into(), description: "Spawn a Kybern helper/worker/subagent using Codex, Claude, OpenCode, pi, OMP, or Cursor, or assign an existing member. Use for managed delegation requests so the helper appears as a real child chat in Kybern. Group setup and the owned parent assignment are automatic. Read kybern_thread_context for harness/model/effort choices; preserve the requested model and effort. Omitted base_revision uses the source workspace's committed HEAD for isolated editing; research and review also work in non-Git projects.".into(), input_schema: object(json!({
            "operation_id":{"type":"string","format":"uuid"}, "parent_assignment_id":{"type":["string","null"],"format":"uuid"},
            "owner_thread_id":{"type":["string","null"],"format":"uuid"}, "child":{"anyOf":[{"type":"object","additionalProperties":false,"properties":{"provider":{"type":"object","additionalProperties":false,"properties":{"kind":{"enum":["claude-code","codex","opencode","pi","omp","cursor"]},"instance":{"type":"string","description":"Configured harness profile name, usually default. This is not a model name; put a model such as gpt-5.6-luna in child.model."}},"required":["kind","instance"]},"model":{"type":["string","null"],"description":"Exact model ID for the selected harness. Set this when the user requests a model; provider.instance does not select a model."},"effort":{"type":["string","null"],"description":"Reasoning effort supported by the selected model. Preserve the user requested effort; if unsupported, report the available levels instead of silently substituting."},"permission_mode":{"enum":["supervised","accept-edits","auto","full-access",null],"description":"Omit unless the user requests a different worker permission policy. Kybern inherits the parent mode for the same harness or a full-access parent; otherwise supervised. Do not broaden permissions to bypass a pending approval. Choose only permissions authorized for the delegated work."},"base_revision":{"type":["string","null"],"description":"Optional git base; defaults to the source chat workspace's committed HEAD and is resolved to a commit OID."}},"required":["provider"]},{"type":"null"}]},
            "title":{"type":"string"}, "instructions":{"type":"string"}, "kind":{"enum":["edit","review","research","integration","coordination"]}
        }), &["operation_id","title","instructions","kind"]) },
        NativeToolDefinition { name: "kybern_collaboration_send".into(), description: "Send an attributed progress update, question, reply, change request, result, or failure to another group thread.".into(), input_schema: object(json!({
            "operation_id":{"type":"string","format":"uuid"}, "assignment_id":{"type":["string","null"],"format":"uuid"}, "to_thread_id":{"type":"string","format":"uuid"},
            "purpose":{"enum":["progress","question","reply","change_request","result","failure","redirect"]}, "reply_to":{"type":["string","null"],"format":"uuid"}, "body":{"type":"string"}
        }), &["operation_id","to_thread_id","purpose","body"]) },
        NativeToolDefinition { name: "kybern_collaboration_read".into(), description: "Read this caller's group and optionally a participant's bounded recent transcript, results, and worktree reference. Returned messages addressed to you count as delivered and will not wake you again.".into(), input_schema: object(json!({"thread_id":{"type":["string","null"],"format":"uuid"},"transcript_limit":{"type":"integer","minimum":1,"maximum":100}}), &[]) },
        NativeToolDefinition { name: "kybern_collaboration_wait".into(), description: "Wait without polling for assignment, message, or shared-context changes in this caller's group. Pass the returned cursor into the next wait; assignment_ids correlates exact delegated work. A timeout is a normal empty response, not a failure.".into(), input_schema: object(json!({"assignment_ids":{"type":"array","items":{"type":"string","format":"uuid"}},"cursor":{"type":["string","null"]},"timeout_ms":{"type":"integer","minimum":1,"maximum":30000}}), &[]) },
        NativeToolDefinition { name: "kybern_collaboration_report".into(), description: "Explicitly finish an owned assignment with a structured success, partial, or failed result.".into(), input_schema: object(json!({
            "operation_id":{"type":"string","format":"uuid"},"assignment_id":{"type":"string","format":"uuid"},"outcome":{"enum":["success","partial","failed"]},"summary":{"type":"string"},
            "changes":{"type":"array","items":{"type":"string"}},"checks":{"type":"array","items":{"type":"string"}},"artifacts":{"type":"array","items":{"type":"string"}},"unresolved":{"type":"array","items":{"type":"string"}}
        }), &["operation_id","assignment_id","outcome","summary"]) },
        NativeToolDefinition { name: "kybern_collaboration_cancel".into(), description: "Cancel an assignment within the caller's group.".into(), input_schema: object(json!({"operation_id":{"type":"string","format":"uuid"},"assignment_id":{"type":"string","format":"uuid"},"reason":{"type":["string","null"]}}), &["operation_id","assignment_id"]) },
        NativeToolDefinition { name: "kybern_collaboration_context_read".into(), description: "Selectively read current project knowledge and group notes, including the plan, user instructions, findings, and worker results.".into(), input_schema: object(json!({"keys":{"type":"array","items":{"type":"string"}},"kinds":{"type":"array","items":{"enum":["brief","plan","decision","research","instruction","result_reference"]}},"cursor":{"type":["string","null"]},"limit":{"type":"integer","minimum":1,"maximum":200}}), &[]) },
        NativeToolDefinition { name: "kybern_collaboration_context_put".into(), description: "Add or revise project knowledge. Use plan for the current plan and completion status, research for reusable findings, decision for choices, and result_reference for evidence. Worker reports are saved automatically; curate reusable knowledge and keep plans current as work progresses. Agent callers cannot author authority-bearing briefs/instructions or overwrite user-authored entries.".into(), input_schema: object(json!({
            "operation_id":{"type":"string","format":"uuid"},"entry_id":{"type":["string","null"],"format":"uuid"},"key":{"type":"string"},"kind":{"enum":["plan","decision","research","result_reference"]},"body":{"type":"string"},"expected_revision":{"type":["integer","null"]},"source_refs":{"type":"array","items":{"type":"string"}}
        }), &["operation_id","key","kind","body"]) },
    ];
    for tool in &mut definitions {
        if tool.input_schema["properties"].get("operation_id").is_none() {
            continue;
        }
        tool.input_schema["properties"]["operation_id"] = json!({
            "type": ["string", "null"], "format": "uuid",
            "description": "Optional advanced retry UUID. Usually omit: Kybern assigns this automatically."
        });
        tool.input_schema["properties"]["request_key"] = json!({
            "type": ["string", "null"], "maxLength": 128,
            "description": "Optional short unique label for this operation. Reuse for the same request on retry; choose a new label for new work. Do not also supply operation_id."
        });
        if let Some(required) = tool.input_schema["required"].as_array_mut() {
            required.retain(|value| value != "operation_id");
        }
        tool.description.push_str(" Kybern handles operation IDs; omit operation_id. Use request_key for a retryable label if needed.");
    }
    definitions
}

pub(crate) fn parse<T: for<'de> Deserialize<'de>>(arguments: Value) -> Result<T> {
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
struct ThreadSearchArgs {
    #[serde(default)]
    project_id: Option<ProjectId>,
    #[serde(default)]
    all_projects: bool,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    include_archived: bool,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ThreadReadArgs {
    thread_id: ThreadId,
    #[serde(default)]
    before_seq: Option<EventSeq>,
    #[serde(default)]
    through_seq: Option<EventSeq>,
    #[serde(default)]
    message_seq: Option<EventSeq>,
    #[serde(default)]
    text_offset: Option<u64>,
    #[serde(default)]
    limit: Option<u32>,
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

    #[test]
    fn native_operation_retries_are_scoped_without_model_generated_uuids() {
        let thread = Uuid::now_v7();
        let session = Uuid::now_v7();
        let turn = Uuid::now_v7();
        let normalize = |thread, session, turn, call, name, mut args: Value| {
            prepare_native_operation(thread, session, turn, call, name, &mut args).unwrap().unwrap()
        };
        let name = "kybern_collaboration_report";
        let first = normalize(thread, session, turn, "call-1", name, json!({"summary":"done"}));
        assert_eq!(first, normalize(thread, session, turn, "call-1", name, json!({"summary":"done"})));
        assert_ne!(first, normalize(thread, session, turn, "call-2", name, json!({"summary":"done"})));
        assert_ne!(first, normalize(thread, session, Uuid::now_v7(), "call-1", name, json!({})));
        assert_ne!(first, normalize(Uuid::now_v7(), session, turn, "call-1", name, json!({})));
        assert_ne!(first, normalize(thread, session, turn, "call-1", "kybern_collaboration_spawn", json!({})));
        let key = json!({"request_key":"report-readme"});
        let keyed = normalize(thread, session, turn, "call-2", name, key.clone());
        assert_eq!(keyed, normalize(thread, Uuid::now_v7(), Uuid::now_v7(), "retry", name, key));
        assert_ne!(keyed, normalize(thread, session, turn, "call-2", name, json!({"request_key":"another-report"})));
        // Explicit IDs remain valid for clients retrying an acknowledged operation.
        assert_eq!(first, normalize(thread, session, turn, "retry", name, json!({"operation_id":first})));
        let mut malformed = json!({"operation_id":"readme-report"});
        let error = prepare_native_operation(thread, session, turn, "call", name, &mut malformed).unwrap_err();
        assert!(error.to_string().contains("no shell command is needed"));
        let mut ambiguous = json!({"operation_id":first,"request_key":"report"});
        assert!(prepare_native_operation(thread, session, turn, "call", name, &mut ambiguous).is_err());
        for tool in native_tool_definitions().iter().filter(|tool| tool.input_schema["properties"].get("operation_id").is_some()) {
            assert!(!tool.input_schema["required"].as_array().unwrap().contains(&json!("operation_id")));
            assert!(tool.input_schema["properties"].get("request_key").is_some());
        }
    }

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
                parent_thread_id: None,
                coordinator_project_id: None,
                collaboration_group_id: None,
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

    #[tokio::test]
    async fn thread_discovery_and_history_are_bounded_inert_and_keep_stable_references() {
        let fixture = Fixture::new();
        let turn_id = Uuid::now_v7();
        let referenced = UserMessage {
            parts: vec![ContentPart::ThreadReference {
                thread_id: fixture.thread.id,
                title: "Fixture".into(),
                project_id: Some(fixture.thread.project_id),
            }],
        };
        fixture
            .store
            .event_append(
                fixture.other_thread.id,
                Some(turn_id),
                EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: referenced },
            )
            .unwrap();
        fixture
            .store
            .event_append(
                fixture.other_thread.id,
                Some(turn_id),
                EventPayload::AssistantMessageCompleted {
                    message_id: Uuid::now_v7(),
                    origin: EventOrigin::default(),
                    text: "A durable answer from an old thread".into(),
                    thinking: None,
                },
            )
            .unwrap();
        let before = fixture.store.thread_get(fixture.other_thread.id).unwrap().unwrap();
        let search =
            fixture.tools.execute(fixture.thread.id, "kybern_threads_search", json!({"query":"durable answer","limit":1})).await.unwrap();
        assert_eq!(search["threads"][0]["thread"]["id"], json!(fixture.other_thread.id));
        let read = fixture
            .tools
            .execute(fixture.thread.id, "kybern_thread_read", json!({"thread_id":fixture.other_thread.id,"limit":2}))
            .await
            .unwrap();
        assert_eq!(read["messages"].as_array().unwrap().len(), 2);
        assert_eq!(read["messages"][0]["text"], format!("@thread[{}] Fixture", fixture.thread.id));
        assert_eq!(read["messages"][1]["attribution"]["kind"], "agent");
        let after = fixture.store.thread_get(fixture.other_thread.id).unwrap().unwrap();
        assert_eq!(after.status, before.status);
        assert_eq!(after.provider_session_id, before.provider_session_id);
    }
}
