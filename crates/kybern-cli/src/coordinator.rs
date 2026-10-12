//! Commands for a project's Coordinator and for reading other threads' history.

use anyhow::{Context, Result, anyhow};
use clap::Subcommand;
use kybern_client::Client;
use kybern_protocol::methods::*;
use kybern_protocol::{PermissionMode, ProviderInstance};
use serde_json::json;
use uuid::Uuid;

#[derive(Debug, Subcommand)]
pub enum HistoryCmd {
    /// Find threads by title or message text without waking them.
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
    /// Read a thread's saved messages in bounded pages.
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
    /// Show the project's Coordinator thread, or null when it has none.
    Get { project: Uuid },
    /// Open the project's Coordinator, creating it when the project has none.
    Open {
        project: Uuid,
        #[arg(long, default_value = "claude-code")]
        provider: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        effort: Option<String>,
        #[arg(long, value_parser = crate::parse_mode)]
        mode: Option<PermissionMode>,
        /// The project brief, saved as the pinned brief note when the project has none.
        #[arg(long, conflicts_with = "brief_file")]
        brief: Option<String>,
        /// Read the project brief from a file (`-` reads standard input).
        #[arg(long)]
        brief_file: Option<String>,
    },
    /// Move an idle Coordinator to another harness or model; its conversation stays.
    SwitchHarness {
        project: Uuid,
        #[arg(long)]
        provider: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        effort: Option<String>,
        #[arg(long, value_parser = crate::parse_mode)]
        mode: Option<PermissionMode>,
    },
}

pub async fn history(client: &Client, cmd: HistoryCmd) -> Result<()> {
    let result = match cmd {
        HistoryCmd::Search { project, all_projects, query, include_archived, cursor, limit } => {
            client
                .call_raw(
                    ThreadsSearch::NAME,
                    json!({"project_id":project,"all_projects":all_projects,"query":query,"include_archived":include_archived,"cursor":cursor,"limit":limit}),
                )
                .await?
        }
        HistoryCmd::Read { thread, before_seq, through_seq, message_seq, text_offset, limit } => {
            client
                .call_raw(
                    ThreadsRead::NAME,
                    json!({"thread_id":thread,"before_seq":before_seq,"through_seq":through_seq,"message_seq":message_seq,"text_offset":text_offset,"limit":limit}),
                )
                .await?
        }
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn provider(name: &str) -> Result<ProviderInstance> {
    Ok(ProviderInstance::default_for(name.parse().map_err(|error: String| anyhow!(error))?))
}

pub async fn coordinator(client: &Client, cmd: CoordinatorCmd) -> Result<()> {
    let result = match cmd {
        CoordinatorCmd::Get { project } => {
            serde_json::to_value(client.call::<CoordinatorGet>(CoordinatorGetParams { project_id: project }).await?)?
        }
        CoordinatorCmd::Open { project, provider: kind, model, effort, mode, brief, brief_file } => {
            let initial_brief = match (brief, brief_file) {
                (Some(text), _) => Some(text),
                (None, Some(path)) if path == "-" => {
                    let mut text = String::new();
                    std::io::Read::read_to_string(&mut std::io::stdin().lock(), &mut text).context("read the brief from standard input")?;
                    Some(text)
                }
                (None, Some(path)) => Some(std::fs::read_to_string(&path).with_context(|| format!("read {path}"))?),
                (None, None) => None,
            };
            let opened = client
                .call::<CoordinatorOpen>(CoordinatorOpenParams {
                    project_id: project,
                    provider: provider(&kind)?,
                    model,
                    effort,
                    permission_mode: mode,
                    initial_brief,
                })
                .await?;
            serde_json::to_value(opened)?
        }
        CoordinatorCmd::SwitchHarness { project, provider: kind, model, effort, mode } => serde_json::to_value(
            client
                .call::<CoordinatorSwitchHarness>(CoordinatorSwitchHarnessParams {
                    project_id: project,
                    provider: provider(&kind)?,
                    model,
                    effort,
                    permission_mode: mode,
                })
                .await?,
        )?,
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
