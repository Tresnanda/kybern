//! `kybern continue`: move a thread to another machine (design §7.2).
//!
//! The work (hand-off note, branch, uncommitted changes) and the visible conversation go to the target;
//! this thread becomes read-only with a link to the continuation. A running thread moves when its turn
//! ends, and an offline machine gets the thread when it returns.

use anyhow::{Context, Result};
use clap::Args;
use kybern_client::Client;
use kybern_protocol::methods::*;
use kybern_protocol::*;

#[derive(Args)]
pub struct ContinueArgs {
    /// The thread to move.
    thread: String,
    /// The machine to continue on: its name or id (see `kybern machines list`).
    #[arg(long, short)]
    machine: String,
    /// Print the hand-off note and stop, so you can edit it and pass it back with --note-file.
    #[arg(long)]
    show_note: bool,
    /// Send this file as the hand-off note instead of the generated one.
    #[arg(long)]
    note_file: Option<std::path::PathBuf>,
    /// Which of the machine's checkouts, when it has several of this repository: a project id, name or path.
    #[arg(long)]
    project: Option<String>,
    /// Title of the continuing thread. Defaults to this thread's.
    #[arg(long)]
    title: Option<String>,
    /// Agent for the continuing thread: claude, codex, opencode, pi, omp or cursor. Defaults to this thread's.
    #[arg(long)]
    agent: Option<String>,
    #[arg(long)]
    model: Option<String>,
    /// Permission mode for the continuing thread, which also caps it. Defaults to this thread's.
    #[arg(long)]
    mode: Option<String>,
}

#[derive(Args)]
pub struct ContinueAbandonArgs {
    /// The thread whose move to give up.
    thread: String,
    /// Give up even when the other machine cannot be asked; if it did create the thread there will be two.
    #[arg(long)]
    force: bool,
}

fn parse<T: serde::de::DeserializeOwned>(what: &str, value: &str) -> Result<T> {
    serde_json::from_value(serde_json::Value::String(value.to_lowercase())).with_context(|| format!("{value:?} is not a known {what}"))
}

pub async fn run(client: &Client, args: ContinueArgs, json: bool) -> Result<()> {
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
        .call::<ThreadsMoveToMachine>(ThreadsMoveToMachineParams {
            thread_id,
            machine: args.machine,
            project: args.project,
            handoff_note,
            title: args.title,
            provider: args.agent.as_deref().map(|agent| parse("agent", agent)).transpose()?,
            model: args.model,
            effort: None,
            permission_mode: args.mode.as_deref().map(|mode| parse("permission mode", mode)).transpose()?,
            operation_id: None,
        })
        .await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    println!("Moving to {}. It is in the outbox as {} ({}).", result.target_name, result.item.id, result.item.state.as_str());
    println!("The thread moves when its turn ends and {} is online; `kybern outbox list` shows when it arrives.", result.target_name);
    Ok(())
}

pub async fn abandon(client: &Client, args: ContinueAbandonArgs, json: bool) -> Result<()> {
    let thread_id: ThreadId = args.thread.parse().context("thread id must be a UUID")?;
    let result = client.call::<ThreadsMoveAbandon>(ThreadsMoveAbandonParams { thread_id, force: args.force }).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    println!(
        "{}",
        match result.outcome {
            MoveAbandonOutcome::Released => "The move is abandoned; the thread is yours again.",
            MoveAbandonOutcome::Completed =>
                "The other machine had already created the thread, so the move is done; this thread is read-only.",
            MoveAbandonOutcome::Nothing => "This thread has no move to abandon.",
        }
    );
    Ok(())
}
