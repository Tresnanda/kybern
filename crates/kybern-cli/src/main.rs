mod render;

use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use clap::{Parser, Subcommand};
use kybern_protocol::methods::*;
use kybern_protocol::*;

use kybern_client::{Client, Endpoint};

#[derive(Parser)]
#[command(name = "kybern", version, about = "Command-line client for the kybern daemon")]
struct Cli {
    /// Daemon WebSocket URL, e.g. ws://127.0.0.1:4173/ws
    #[arg(long, global = true)]
    url: Option<String>,
    /// Bearer token. Defaults to ~/.kybern/daemon.token
    #[arg(long, global = true)]
    token: Option<String>,
    /// Data dir to read token/port from.
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    /// Emit raw JSON instead of formatted output.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Show daemon info.
    Info,
    /// List providers and their availability.
    Providers,
    /// Manage projects.
    Projects {
        #[command(subcommand)]
        cmd: ProjectsCmd,
    },
    /// List threads.
    Threads {
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        archived: bool,
    },
    /// Create a thread and send the first message, streaming the turn.
    New {
        /// Project id, or a path (added if missing).
        #[arg(long, short)]
        project: String,
        #[arg(long, default_value = "claude-code")]
        provider: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long, value_parser = parse_mode)]
        mode: Option<PermissionMode>,
        #[arg(long)]
        worktree: bool,
        /// Do not stream; return the thread id immediately.
        #[arg(long)]
        detach: bool,
        prompt: Vec<String>,
    },
    /// Send a message to an existing thread and stream the turn.
    Send {
        thread: String,
        #[arg(long)]
        detach: bool,
        prompt: Vec<String>,
    },
    /// Print a thread's transcript.
    Show { thread: String },
    /// Follow live events for one thread or all threads.
    Watch {
        thread: Option<String>,
        /// Replay from this seq first (0 = full history).
        #[arg(long)]
        after: Option<i64>,
    },
    /// Interrupt the running turn.
    Interrupt { thread: String },
    /// List or answer pending approvals.
    Approvals {
        #[command(subcommand)]
        cmd: Option<ApprovalsCmd>,
    },
    /// Archive a thread.
    Archive { thread: String },
    /// List git checkpoints for a thread.
    Checkpoints { thread: String },
    /// Show the diff for a thread (whole thread) or one turn.
    Diff {
        thread: String,
        #[arg(long)]
        turn: Option<String>,
        /// Only list files, no patch.
        #[arg(long)]
        stat: bool,
    },
    /// Restore the working tree to the state before a turn.
    Revert { thread: String, turn: String },
    /// Show or edit settings.
    Settings {
        #[command(subcommand)]
        cmd: Option<SettingsCmd>,
    },
    /// Token usage and cost.
    Usage {
        #[arg(long, value_parser = ["provider", "model", "day", "thread"], default_value = "provider")]
        by: String,
        /// Only turns in the last N days.
        #[arg(long)]
        days: Option<i64>,
    },
    /// Pair another device: prints a one-time code and the endpoints to use.
    Pair {
        #[arg(long)]
        label: Option<String>,
    },
    /// List or revoke access tokens.
    Tokens {
        #[command(subcommand)]
        cmd: Option<TokensCmd>,
    },
    /// Git status for a thread's working directory.
    Git { thread: String },
    /// Commit everything in a thread's working directory.
    Commit {
        thread: String,
        #[arg(long, short)]
        message: Option<String>,
    },
    /// Pull requests via the GitHub CLI.
    Pr {
        #[command(subcommand)]
        cmd: PrCmd,
    },
    /// Terminals owned by the daemon.
    Terminal {
        #[command(subcommand)]
        cmd: TerminalCmd,
    },
    /// Call any RPC method with raw JSON params.
    Call { method: String, params: Option<String> },
}

#[derive(Subcommand)]
enum ProjectsCmd {
    List,
    Add {
        path: PathBuf,
        #[arg(long)]
        name: Option<String>,
    },
    Remove { id: String },
}

#[derive(Subcommand)]
enum TokensCmd {
    List,
    Revoke { id: String },
}

#[derive(Subcommand)]
enum PrCmd {
    /// Create a pull request from a thread's branch (commits and pushes first).
    Create {
        thread: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        body: Option<String>,
        #[arg(long)]
        base: Option<String>,
        #[arg(long)]
        draft: bool,
    },
    /// List pull requests for a project.
    List {
        project: String,
        #[arg(long, default_value = "open")]
        state: String,
    },
}

#[derive(Subcommand)]
enum SettingsCmd {
    /// Print settings as JSON.
    Show,
    /// Replace settings from a JSON file (or stdin with `-`).
    Set { file: String },
}

#[derive(Subcommand)]
enum TerminalCmd {
    /// List terminals.
    List,
    /// Create a terminal in a thread's directory (or --cwd) and print its id.
    Create {
        #[arg(long)]
        thread: Option<String>,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Send a line of input to a terminal.
    Send { terminal: String, input: Vec<String> },
    /// Stream a terminal's output to stdout (replays scrollback first). Ctrl-C to stop.
    Attach { terminal: String },
    /// Create a terminal, run one command, print its output for a few seconds, close it.
    Run {
        #[arg(long)]
        thread: Option<String>,
        #[arg(long)]
        cwd: Option<String>,
        #[arg(long, default_value_t = 3)]
        seconds: u64,
        command: Vec<String>,
    },
    Close { terminal: String },
}

#[derive(Subcommand)]
enum ApprovalsCmd {
    List,
    Allow { id: String, #[arg(long)] always: bool },
    Deny { id: String, #[arg(long)] reason: Option<String> },
}

fn parse_mode(s: &str) -> Result<PermissionMode, String> {
    serde_json::from_value(serde_json::Value::String(s.to_string())).map_err(|_| format!("unknown mode {s}; use supervised|accept-edits|auto|full-access"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let ep = Endpoint::resolve(cli.url.clone(), cli.token.clone(), cli.data_dir.clone())?;
    let client = Client::connect(&ep).await?;
    let json = cli.json;

    match cli.cmd {
        Cmd::Info => {
            let info = client.call::<DaemonInfoMethod>(Empty {}).await?;
            if json { println!("{}", serde_json::to_string_pretty(&info)?) } else { render::info(&info) }
        }
        Cmd::Providers => {
            let r = client.call::<ProvidersList>(Empty {}).await?;
            if json { println!("{}", serde_json::to_string_pretty(&r)?) } else { render::providers(&r.providers) }
        }
        Cmd::Projects { cmd } => match cmd {
            ProjectsCmd::List => {
                let r = client.call::<ProjectsList>(Empty {}).await?;
                if json { println!("{}", serde_json::to_string_pretty(&r)?) } else { render::projects(&r.projects) }
            }
            ProjectsCmd::Add { path, name } => {
                let p = client.call::<ProjectsAdd>(ProjectsAddParams { path: absolute(&path)?, name }).await?;
                if json { println!("{}", serde_json::to_string_pretty(&p)?) } else { println!("{}  {}  {}", p.id, p.name, p.path) }
            }
            ProjectsCmd::Remove { id } => {
                client.call::<ProjectsRemove>(ProjectsRemoveParams { project_id: id.parse()? }).await?;
                println!("removed");
            }
        },
        Cmd::Threads { project, archived } => {
            let project_id = match project {
                Some(p) => Some(resolve_project(&client, &p, false).await?),
                None => None,
            };
            let r = client.call::<ThreadsList>(ThreadsListParams { project_id, include_archived: archived }).await?;
            if json { println!("{}", serde_json::to_string_pretty(&r)?) } else { render::threads(&r.threads) }
        }
        Cmd::New { project, provider, model, mode, worktree, detach, prompt } => {
            let project_id = resolve_project(&client, &project, true).await?;
            let prompt = join_prompt(prompt)?;
            let sub = if detach { None } else { Some(client.call::<EventsSubscribe>(EventsSubscribeParams { thread_id: None, after_seq: None }).await?) };
            let thread = client
                .call::<ThreadsCreate>(ThreadsCreateParams {
                    project_id,
                    provider: ProviderInstance::default_for(provider.parse().map_err(|e: String| anyhow!(e))?),
                    model,
                    permission_mode: mode,
                    use_worktree: if worktree { Some(true) } else { None },
                    title: None,
                    message: Some(UserMessage::text(prompt)),
                })
                .await?;
            eprintln!("thread {}", thread.id);
            if let Some(sub) = sub {
                render::follow_turn(&client, sub.subscription_id, thread.id, json).await?;
            }
        }
        Cmd::Send { thread, detach, prompt } => {
            let thread_id: ThreadId = thread.parse().context("thread id must be a UUID")?;
            let prompt = join_prompt(prompt)?;
            let sub = if detach { None } else { Some(client.call::<EventsSubscribe>(EventsSubscribeParams { thread_id: Some(thread_id), after_seq: None }).await?) };
            let r = client.call::<ThreadsSend>(ThreadsSendParams { thread_id, message: UserMessage::text(prompt) }).await?;
            eprintln!("turn {}", r.turn_id);
            if let Some(sub) = sub {
                render::follow_turn(&client, sub.subscription_id, thread_id, json).await?;
            }
        }
        Cmd::Show { thread } => {
            let r = client.call::<ThreadsGet>(ThreadsGetParams { thread_id: thread.parse()? }).await?;
            if json { println!("{}", serde_json::to_string_pretty(&r)?) } else { render::transcript(&r) }
        }
        Cmd::Watch { thread, after } => {
            let thread_id = thread.map(|t| t.parse::<ThreadId>()).transpose()?;
            let sub = client.call::<EventsSubscribe>(EventsSubscribeParams { thread_id, after_seq: after }).await?;
            render::watch(&client, sub.subscription_id, json).await?;
        }
        Cmd::Interrupt { thread } => {
            client.call::<ThreadsInterrupt>(ThreadsInterruptParams { thread_id: thread.parse()? }).await?;
            println!("interrupt sent");
        }
        Cmd::Approvals { cmd } => match cmd.unwrap_or(ApprovalsCmd::List) {
            ApprovalsCmd::List => {
                let r = client.call::<ApprovalsList>(ApprovalsListParams { thread_id: None }).await?;
                if json { println!("{}", serde_json::to_string_pretty(&r)?) } else { render::approvals(&r.approvals) }
            }
            ApprovalsCmd::Allow { id, always } => {
                let decision = if always { ApprovalDecision::AllowAlways } else { ApprovalDecision::AllowOnce };
                client.call::<ApprovalsRespond>(ApprovalsRespondParams { approval_id: id.parse()?, decision }).await?;
                println!("allowed");
            }
            ApprovalsCmd::Deny { id, reason } => {
                client.call::<ApprovalsRespond>(ApprovalsRespondParams { approval_id: id.parse()?, decision: ApprovalDecision::Deny { reason } }).await?;
                println!("denied");
            }
        },
        Cmd::Archive { thread } => {
            client.call::<ThreadsArchive>(ThreadsArchiveParams { thread_id: thread.parse()? }).await?;
            println!("archived");
        }
        Cmd::Checkpoints { thread } => {
            let r = client.call::<ThreadsCheckpoints>(ThreadsCheckpointsParams { thread_id: thread.parse()? }).await?;
            if json { println!("{}", serde_json::to_string_pretty(&r)?) } else {
                for c in r.checkpoints {
                    println!("{}  {} → {}  {}", c.turn_id, &c.before[..10], c.after.as_deref().map(|a| &a[..10]).unwrap_or("(running)"), c.created_at.to_rfc3339());
                }
            }
        }
        Cmd::Diff { thread, turn, stat } => {
            let d = client.call::<ThreadsDiff>(ThreadsDiffParams { thread_id: thread.parse()?, turn_id: turn.map(|t| t.parse()).transpose()? }).await?;
            if json { println!("{}", serde_json::to_string_pretty(&d)?) } else {
                for f in &d.files {
                    println!("{:<10} +{:<5} -{:<5} {}", format!("{:?}", f.status).to_lowercase(), f.additions, f.deletions, f.path);
                }
                if !stat && !d.patch.is_empty() {
                    println!("\n{}", d.patch);
                }
            }
        }
        Cmd::Revert { thread, turn } => {
            let r = client.call::<ThreadsRevert>(ThreadsRevertParams { thread_id: thread.parse()?, turn_id: turn.parse()? }).await?;
            println!("working tree restored to {}{}", &r.commit[..10], if r.conversation_rewound { " (conversation rewound)" } else { "" });
        }
        Cmd::Settings { cmd } => match cmd.unwrap_or(SettingsCmd::Show) {
            SettingsCmd::Show => println!("{}", serde_json::to_string_pretty(&client.call::<SettingsGet>(Empty {}).await?)?),
            SettingsCmd::Set { file } => {
                let text = if file == "-" { std::io::read_to_string(std::io::stdin())? } else { std::fs::read_to_string(&file)? };
                let settings: Settings = serde_json::from_str(&text)?;
                let r = client.call::<SettingsUpdate>(SettingsUpdateParams { settings }).await?;
                println!("{}", serde_json::to_string_pretty(&r)?);
            }
        },
        Cmd::Usage { by, days } => {
            let group_by = serde_json::from_value(serde_json::Value::String(by))?;
            let since = days.map(|d| chrono::Utc::now() - chrono::Duration::days(d));
            let r = client.call::<UsageSummary>(UsageSummaryParams { since, group_by }).await?;
            if json { println!("{}", serde_json::to_string_pretty(&r)?) } else { render::usage(&r) }
        }
        Cmd::Pair { label } => {
            let r = client.call::<PairingCreate>(PairingCreateParams { label }).await?;
            println!("Pairing code: {}   (expires {})", r.code, r.expires_at.format("%H:%M"));
            for e in r.endpoints {
                println!("  {e}");
            }
        }
        Cmd::Tokens { cmd } => match cmd.unwrap_or(TokensCmd::List) {
            TokensCmd::List => {
                let r = client.call::<TokensList>(Empty {}).await?;
                for t in r.tokens {
                    println!("{}  {:<20} {}{}", t.id, t.label, t.created_at.format("%Y-%m-%d"), if t.revoked { "  (revoked)" } else { "" });
                }
            }
            TokensCmd::Revoke { id } => {
                client.call::<TokensRevoke>(TokensRevokeParams { token_id: id.parse()? }).await?;
                println!("revoked");
            }
        },
        Cmd::Git { thread } => {
            let r = client.call::<GitStatusMethod>(GitStatusParams { thread_id: thread.parse()? }).await?;
            println!("{}", serde_json::to_string_pretty(&r)?);
        }
        Cmd::Commit { thread, message } => {
            let r = client.call::<GitCommit>(GitCommitParams { thread_id: thread.parse()?, message }).await?;
            println!("{}  {}", &r.commit[..10], r.message.lines().next().unwrap_or(""));
        }
        Cmd::Pr { cmd } => match cmd {
            PrCmd::Create { thread, title, body, base, draft } => {
                let r = client.call::<PrCreate>(PrCreateParams { thread_id: thread.parse()?, title, body, base, draft, commit_first: true }).await?;
                println!("#{}  {}\n{}", r.number, r.title, r.url);
            }
            PrCmd::List { project, state } => {
                let project_id = resolve_project(&client, &project, false).await?;
                let r = client.call::<PrList>(PrListParams { project_id, state, limit: 30 }).await?;
                for pr in r.pull_requests {
                    println!("#{:<5} {:<8} {}  {}", pr.number, pr.state.to_lowercase(), pr.title, pr.url);
                }
            }
        },
        Cmd::Terminal { cmd } => render::terminal(&client, cmd, json).await?,
        Cmd::Call { method, params } => {
            let params = match params {
                Some(p) => serde_json::from_str(&p)?,
                None => serde_json::Value::Null,
            };
            let v = client.call_raw(&method, params).await?;
            println!("{}", serde_json::to_string_pretty(&v)?);
        }
    }
    Ok(())
}

pub(crate) use TerminalCmd as TerminalCommand;

fn absolute(p: &PathBuf) -> Result<String> {
    Ok(std::fs::canonicalize(p).with_context(|| format!("{} does not exist", p.display()))?.to_string_lossy().to_string())
}

fn join_prompt(parts: Vec<String>) -> Result<String> {
    let s = parts.join(" ");
    if s.trim().is_empty() {
        return Err(anyhow!("prompt is empty"));
    }
    Ok(s)
}

async fn resolve_project(client: &Client, key: &str, add_if_missing: bool) -> Result<ProjectId> {
    if let Ok(id) = key.parse::<ProjectId>() {
        return Ok(id);
    }
    let path = absolute(&PathBuf::from(key))?;
    let list = client.call::<ProjectsList>(Empty {}).await?;
    if let Some(p) = list.projects.iter().find(|p| p.path == path || p.name == key) {
        return Ok(p.id);
    }
    if add_if_missing {
        let p = client.call::<ProjectsAdd>(ProjectsAddParams { path, name: None }).await?;
        eprintln!("added project {} ({})", p.name, p.id);
        return Ok(p.id);
    }
    Err(anyhow!("project {key} not found"))
}
