//! Collaboration commands accept mutation documents so nested policies, result
//! evidence, and context references retain their exact structure on retries.

use std::io::Read;
use std::path::PathBuf;

use anyhow::{Context, Result, bail, ensure};
use clap::{Args, Subcommand};
use kybern_client::Client;
use kybern_protocol::methods::*;
use serde_json::{Value, json};
use uuid::Uuid;

const MAX_INPUT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Args)]
pub struct MutationInput {
    /// JSON request file. Use - to read standard input. Fields follow the RPC schema.
    #[arg(long, value_name = "PATH")]
    input: PathBuf,
    /// Reuse this operation ID when retrying an uncertain request.
    #[arg(long)]
    operation_id: Option<Uuid>,
}

#[derive(Debug, Subcommand)]
pub enum CollaborationCmd {
    /// Discover old threads or read bounded persisted messages without waking them.
    Threads {
        #[command(subcommand)]
        cmd: CollaborationThreadsCmd,
    },
    /// Discover or create the project's persistent coordinator chat.
    Coordinator {
        #[command(subcommand)]
        cmd: CoordinatorCmd,
    },
    /// Manage lasting objectives and group policy.
    Groups {
        #[command(subcommand)]
        cmd: GroupsCmd,
    },
    /// Attach existing threads as participants or references.
    Members {
        #[command(subcommand)]
        cmd: MembersCmd,
    },
    /// Delegate, inspect, finish, or cancel bounded work.
    Assignments {
        #[command(subcommand)]
        cmd: AssignmentsCmd,
    },
    /// Send or inspect attributed peer communication.
    Messages {
        #[command(subcommand)]
        cmd: MessagesCmd,
    },
    /// Read and revise shared knowledge with revision checks.
    Context {
        #[command(subcommand)]
        cmd: ContextCmd,
    },
    /// Wait for particular assignments without starting model inference.
    Wait {
        group: Uuid,
        #[arg(long = "assignment")]
        assignments: Vec<Uuid>,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 30, value_parser = clap::value_parser!(u64).range(0..=60))]
        timeout_seconds: u64,
    },
}

#[derive(Debug, Subcommand)]
pub enum CollaborationThreadsCmd {
    Search {
        #[arg(long)]
        project: Option<Uuid>,
        #[arg(long)]
        all_projects: bool,
        #[arg(long)]
        query: Option<String>,
        #[arg(long)]
        include_archived: bool,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },
    Read {
        thread: Uuid,
        #[arg(long)]
        before_seq: Option<i64>,
        #[arg(long)]
        through_seq: Option<i64>,
        #[arg(long)]
        message_seq: Option<i64>,
        #[arg(long)]
        text_offset: Option<u64>,
        #[arg(long, default_value_t = 100)]
        limit: u32,
    },
}

#[derive(Debug, Subcommand)]
pub enum CoordinatorCmd {
    Get {
        project: Uuid,
    },
    Create(MutationInput),
    /// Change an idle coordinator's harness while keeping its conversation and knowledge.
    SwitchHarness(MutationInput),
}

#[derive(Debug, Subcommand)]
pub enum GroupsCmd {
    List {
        #[arg(long)]
        project: Option<Uuid>,
        #[arg(long)]
        include_stopped: bool,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: u32,
    },
    Get {
        group: Uuid,
    },
    Create(MutationInput),
    Update(MutationInput),
    /// Pause, stop, resume, or complete a group using a control request.
    Control(MutationInput),
}

#[derive(Debug, Subcommand)]
pub enum MembersCmd {
    Attach(MutationInput),
    Detach(MutationInput),
}

#[derive(Debug, Subcommand)]
pub enum AssignmentsCmd {
    List {
        group: Uuid,
        #[arg(long)]
        include_finished: bool,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: u32,
    },
    Get {
        assignment: Uuid,
    },
    /// Spawn a worker or assign an existing participant using a JSON request.
    Create(MutationInput),
    Update(MutationInput),
    /// Record an outcome, changes, checks, artifacts, and unresolved issues.
    Complete(MutationInput),
    Cancel(MutationInput),
}

#[derive(Debug, Subcommand)]
pub enum MessagesCmd {
    List {
        group: Uuid,
        #[arg(long)]
        thread: Option<Uuid>,
        #[arg(long)]
        assignment: Option<Uuid>,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: u32,
    },
    Send(MutationInput),
}

#[derive(Debug, Subcommand)]
pub enum ContextCmd {
    List {
        group: Uuid,
        #[arg(long = "key")]
        keys: Vec<String>,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: u32,
    },
    /// Read saved revisions of an entry, including earlier user corrections.
    History {
        entry: Uuid,
        #[arg(long)]
        before_revision: Option<i64>,
        #[arg(long, default_value_t = 100)]
        limit: u32,
    },
    /// Write a new context revision with its expected current revision.
    Put(MutationInput),
}

pub async fn run(client: &Client, cmd: CollaborationCmd) -> Result<()> {
    let (method, params) = request(cmd)?;
    if let Some(operation_id) = params.get("operation_id").and_then(Value::as_str) {
        // Print before sending so a lost response can be retried without
        // creating another operation. Machine-readable output stays on stdout.
        eprintln!("Operation ID: {operation_id}");
    }
    let result = client.call_raw(method, params).await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn request(cmd: CollaborationCmd) -> Result<(&'static str, Value)> {
    Ok(match cmd {
        CollaborationCmd::Threads { cmd } => match cmd {
            CollaborationThreadsCmd::Search { project, all_projects, query, include_archived, cursor, limit } => typed::<ThreadsSearch>(
                json!({"project_id":project,"all_projects":all_projects,"query":query,"include_archived":include_archived,"cursor":cursor,"limit":limit}),
            )?,
            CollaborationThreadsCmd::Read { thread, before_seq, through_seq, message_seq, text_offset, limit } => typed::<ThreadsRead>(
                json!({"thread_id":thread,"before_seq":before_seq,"through_seq":through_seq,"message_seq":message_seq,"text_offset":text_offset,"limit":limit}),
            )?,
        },
        CollaborationCmd::Coordinator { cmd } => match cmd {
            CoordinatorCmd::Get { project } => typed::<CollaborationCoordinatorGet>(json!({"project_id":project}))?,
            CoordinatorCmd::Create(input) => typed::<CollaborationCoordinatorGetOrCreate>(read_mutation(input)?)?,
            CoordinatorCmd::SwitchHarness(input) => typed::<CollaborationCoordinatorSwitchHarness>(read_mutation(input)?)?,
        },
        CollaborationCmd::Groups { cmd } => match cmd {
            GroupsCmd::List { project, include_stopped, cursor, limit } => typed::<CollaborationGroupsList>(
                json!({ "project_id": project, "include_stopped": include_stopped, "cursor": cursor, "limit": limit }),
            )?,
            GroupsCmd::Get { group } => typed::<CollaborationGroupsGet>(json!({ "group_id": group }))?,
            GroupsCmd::Create(input) => typed::<CollaborationGroupsCreate>(read_mutation(input)?)?,
            GroupsCmd::Update(input) => typed::<CollaborationGroupsUpdate>(read_mutation(input)?)?,
            GroupsCmd::Control(input) => typed::<CollaborationGroupsControl>(read_mutation(input)?)?,
        },
        CollaborationCmd::Members { cmd } => match cmd {
            MembersCmd::Attach(input) => typed::<CollaborationMembersAttach>(read_mutation(input)?)?,
            MembersCmd::Detach(input) => typed::<CollaborationMembersDetach>(read_mutation(input)?)?,
        },
        CollaborationCmd::Assignments { cmd } => match cmd {
            AssignmentsCmd::List { group, include_finished, cursor, limit } => typed::<CollaborationAssignmentsList>(
                json!({ "group_id": group, "include_finished": include_finished, "cursor": cursor, "limit": limit }),
            )?,
            AssignmentsCmd::Get { assignment } => typed::<CollaborationAssignmentsGet>(json!({ "assignment_id": assignment }))?,
            AssignmentsCmd::Create(input) => typed::<CollaborationAssignmentsCreate>(read_mutation(input)?)?,
            AssignmentsCmd::Update(input) => typed::<CollaborationAssignmentsUpdate>(read_mutation(input)?)?,
            AssignmentsCmd::Complete(input) => typed::<CollaborationAssignmentsComplete>(read_mutation(input)?)?,
            AssignmentsCmd::Cancel(input) => typed::<CollaborationAssignmentsCancel>(read_mutation(input)?)?,
        },
        CollaborationCmd::Messages { cmd } => match cmd {
            MessagesCmd::List { group, thread, assignment, cursor, limit } => typed::<CollaborationMessagesList>(
                json!({ "group_id": group, "thread_id": thread, "assignment_id": assignment, "cursor": cursor, "limit": limit }),
            )?,
            MessagesCmd::Send(input) => typed::<CollaborationMessagesSend>(read_mutation(input)?)?,
        },
        CollaborationCmd::Context { cmd } => match cmd {
            ContextCmd::List { group, keys, cursor, limit } => {
                typed::<CollaborationContextList>(json!({ "group_id": group, "keys": keys, "cursor": cursor, "limit": limit }))?
            }
            ContextCmd::History { entry, before_revision, limit } => typed::<CollaborationContextHistoryMethod>(
                json!({ "entry_id": entry, "before_revision": before_revision, "limit": limit }),
            )?,
            ContextCmd::Put(input) => typed::<CollaborationContextPut>(read_mutation(input)?)?,
        },
        CollaborationCmd::Wait { group, assignments, cursor, timeout_seconds } => typed::<CollaborationWait>(
            json!({ "group_id": group, "assignment_ids": assignments, "cursor": cursor, "timeout_ms": timeout_seconds * 1000 }),
        )?,
    })
}

fn typed<M: Method>(value: Value) -> Result<(&'static str, Value)> {
    let params: M::Params = serde_json::from_value(value).with_context(|| format!("Invalid request for {}", M::NAME))?;
    Ok((M::NAME, serde_json::to_value(params)?))
}

fn read_mutation(input: MutationInput) -> Result<Value> {
    let mut bytes = Vec::new();
    if input.input.as_os_str() == "-" {
        std::io::stdin().lock().take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes).context("read request from standard input")?;
    } else {
        std::fs::File::open(&input.input)
            .with_context(|| format!("open {}", input.input.display()))?
            .take(MAX_INPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .with_context(|| format!("read {}", input.input.display()))?;
    }
    ensure!(bytes.len() as u64 <= MAX_INPUT_BYTES, "Request is larger than 1 MiB. Reduce the request file and retry.");
    let value: Value = serde_json::from_slice(&bytes).context("Request must be a JSON object matching the collaboration RPC schema")?;
    with_operation_id(value, input.operation_id)
}

fn with_operation_id(mut value: Value, requested: Option<Uuid>) -> Result<Value> {
    let object = value.as_object_mut().context("Request must be a JSON object")?;
    let existing = match object.get("operation_id") {
        Some(Value::String(id)) => Some(id.parse::<Uuid>().context("operation_id must be a UUID")?),
        Some(_) => bail!("operation_id must be a UUID string"),
        None => None,
    };
    if let (Some(existing), Some(requested)) = (existing, requested) {
        ensure!(existing == requested, "--operation-id differs from the request file. Reuse the original ID or update the file.");
    }
    let id = existing.or(requested).unwrap_or_else(Uuid::now_v7);
    object.insert("operation_id".into(), Value::String(id.to_string()));
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_retry_identity_and_nested_request_content() {
        let operation_id = Uuid::now_v7();
        let original = json!({ "operation_id": operation_id, "objective": "Review changes", "policy": { "max_active_assignments": 2 } });
        assert_eq!(with_operation_id(original.clone(), None).unwrap(), original);
        assert_eq!(with_operation_id(original.clone(), Some(operation_id)).unwrap(), original);
        assert!(with_operation_id(original, Some(Uuid::now_v7())).is_err());
    }

    #[test]
    fn refuses_invalid_mutation_identity_before_sending() {
        assert!(with_operation_id(json!([]), None).is_err());
        assert!(with_operation_id(json!({ "operation_id": null }), None).is_err());
        assert!(with_operation_id(json!({ "operation_id": "invalid" }), None).is_err());
        let value = with_operation_id(json!({ "objective": "Keep the exact body\nincluding newlines" }), None).unwrap();
        assert!(value["operation_id"].as_str().unwrap().parse::<Uuid>().is_ok());
        assert_eq!(value["objective"], "Keep the exact body\nincluding newlines");
    }
}
