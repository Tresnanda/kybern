//! `kybern fork`: give another machine a copy of a thread's work (design §7.1).
//!
//! The branch and a snapshot of the uncommitted changes go to the target machine only; they reach
//! `origin` only with `--push-origin`. An offline machine gets the fork when it returns.

use anyhow::{Context, Result};
use clap::Args;
use kybern_client::Client;
use kybern_protocol::methods::*;
use kybern_protocol::*;

#[derive(Args)]
pub struct ForkArgs {
    /// The thread to fork.
    thread: String,
    /// The machine to fork to: its name or id (see `kybern machines list`).
    #[arg(long, short)]
    machine: String,
    /// Print the hand-off note and stop, so you can edit it and pass it back with --note-file.
    #[arg(long)]
    show_note: bool,
    /// Send this file as the hand-off note instead of the generated one.
    #[arg(long)]
    note_file: Option<std::path::PathBuf>,
    /// Also push the fork branch to origin. Off by default: the repository may be public.
    #[arg(long)]
    push_origin: bool,
    /// Which of the machine's checkouts, when it has several of this repository: a project id, name or path.
    #[arg(long)]
    project: Option<String>,
    /// Title of the new thread. Defaults to this thread's.
    #[arg(long)]
    title: Option<String>,
    /// Agent for the new thread: claude-code, codex, opencode, pi, omp, cursor or antigravity. Defaults to this thread's.
    #[arg(long)]
    agent: Option<String>,
    #[arg(long)]
    model: Option<String>,
    /// Permission mode for the new thread, which also caps it. Defaults to this thread's.
    #[arg(long)]
    mode: Option<String>,
}

fn parse<T: serde::de::DeserializeOwned>(what: &str, value: &str) -> Result<T> {
    serde_json::from_value(serde_json::Value::String(value.to_lowercase())).with_context(|| format!("{value:?} is not a known {what}"))
}

pub async fn run(client: &Client, args: ForkArgs, json: bool) -> Result<()> {
    let thread_id: ThreadId = args.thread.parse().context("thread id must be a UUID")?;
    if args.show_note {
        let result = client.call::<ThreadsForkNote>(ThreadsForkNoteParams { thread_id }).await?;
        if json {
            println!("{}", serde_json::to_string_pretty(&result)?)
        } else {
            println!("{}", result.note)
        }
        return Ok(());
    }
    let handoff_note = args
        .note_file
        .as_ref()
        .map(|path| std::fs::read_to_string(path).with_context(|| format!("read {}", path.display())))
        .transpose()?;
    let result = client
        .call::<ThreadsForkToMachine>(ThreadsForkToMachineParams {
            thread_id,
            machine: args.machine,
            project: args.project,
            push_origin: args.push_origin,
            handoff_note,
            title: args.title,
            provider: args.agent.as_deref().map(|agent| parse("agent", agent)).transpose()?,
            model: args.model,
            effort: None,
            permission_mode: args.mode.as_deref().map(|mode| parse("permission mode", mode)).transpose()?,
            operation_id: None,
            provision: None,
        })
        .await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    println!("Forking to {}: branch {} ({})", result.target_name, result.branch, &result.commit[..result.commit.len().min(9)]);
    println!("It is in the outbox as {} ({}); `kybern outbox list` shows when it arrives.", result.item.id, result.item.state.as_str());
    Ok(())
}
