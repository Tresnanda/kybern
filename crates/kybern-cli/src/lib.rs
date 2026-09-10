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
enum IntegrationsCmd {
    List {
        project: String,
        #[arg(long, default_value = "claude-code")]
        provider: ProviderKind,
    },
    Change {
        project: String,
        id: String,
        #[arg(value_parser = ["install", "uninstall", "enable", "disable", "update"])]
        action: String,
        #[arg(long, default_value = "claude-code")]
        provider: ProviderKind,
        #[arg(long, default_value = "plugin", value_parser = ["plugin", "connector"])]
        kind: String,
        #[arg(long)]
        scope: Option<String>,
    },
    /// Start Claude connector sign-in in a thread terminal.
    Login { thread: String, name: String },
}

#[derive(Subcommand)]
enum ArtifactsCmd {
    List {
        thread: String,
        #[arg(long)]
        before_seq: Option<i64>,
        #[arg(long, default_value_t = 30)]
        limit: u32,
    },
    Read {
        thread: String,
        path: String,
    },
    /// Issue a single-use preview ticket (expires after 60 seconds).
    Preview {
        thread: String,
        path: String,
    },
}

#[derive(Subcommand)]
enum Cmd {
    /// Show daemon info.
    Info,
    /// Show what the daemon is holding open: clients, agent processes, terminals, queued work.
    Activity,
    /// Stop the local daemon gracefully.
    StopDaemon,
    /// List providers and their availability.
    Providers {
        /// Resolve project-scoped provider settings for this project id or path.
        #[arg(long)]
        project: Option<String>,
        /// Bypass the daemon's short-lived provider catalog cache.
        #[arg(long)]
        refresh: bool,
    },
    /// List saved conversations from an agent harness.
    Sessions {
        #[arg(long)]
        query: Option<String>,
        #[arg(long)]
        provider: ProviderKind,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Continue a saved harness session in Kybern, importing its history.
    Resume {
        #[arg(long)]
        provider: ProviderKind,
        session_id: String,
    },
    /// Show harness update results, or request an update when idle.
    HarnessUpdates {
        #[arg(long)]
        run: Option<ProviderKind>,
    },
    /// Show the daemon's own update state, check the release feed, or install the newest version when idle.
    DaemonUpdate {
        /// Ask the release feed for the newest version.
        #[arg(long)]
        check: bool,
        /// Install the newest version once nothing is running, then restart the daemon.
        #[arg(long)]
        run: bool,
    },
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
        #[arg(long)]
        effort: Option<String>,
        #[arg(long, value_parser = parse_mode)]
        mode: Option<PermissionMode>,
        #[arg(long)]
        worktree: bool,
        /// Branch to start from: the worktree forks from it, or the checkout switches to it.
        #[arg(long)]
        branch: Option<String>,
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
    /// Steer the currently running turn using the provider's native input control.
    Steer { thread: String, prompt: Vec<String> },
    /// Read or update a thread's personal notes.
    Notes {
        thread: String,
        /// Replace the notes with this UTF-8 file (an empty file clears them).
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// Print a thread's transcript.
    Show {
        thread: String,
        /// Show only the newest N entries; JSON output includes an older-page cursor.
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long, requires = "limit")]
        before_seq: Option<i64>,
        #[arg(long)]
        through_seq: Option<i64>,
    },
    /// Manage durable follow-ups on this environment.
    Queue {
        #[command(subcommand)]
        cmd: QueueCmd,
    },
    /// Follow live events for one thread or all threads.
    Watch {
        thread: Option<String>,
        /// Replay from this seq first (0 = full history).
        #[arg(long)]
        after: Option<i64>,
    },
    /// Interrupt the running turn.
    Interrupt { thread: String },
    /// Compact context using the harness native operation.
    Compact { thread: String },
    /// Answer a non-blocking question; provide one answer per question in order.
    Answer {
        thread: String,
        request_id: String,
        #[arg(required = true)]
        answers: Vec<String>,
    },
    /// Release an idle agent process; preserve its conversation for resume.
    Release { thread: String },
    /// Inspect or control provider-owned agents and background processes.
    Tasks {
        thread: String,
        #[command(subcommand)]
        cmd: Option<TasksCmd>,
    },
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
        /// Address reachable from the receiving device (e.g. an HTTPS proxy or SSH tunnel).
        #[arg(long)]
        address: Option<String>,
        /// Also listen on this machine's Tailscale address (remembered across restarts),
        /// so devices on the tailnet can scan the invitation and connect directly.
        #[arg(long)]
        tailscale: bool,
    },
    /// List or revoke access tokens.
    Tokens {
        #[command(subcommand)]
        cmd: Option<TokensCmd>,
    },
    /// Git status for a thread's working directory.
    Git { thread: String },
    /// List a project's local branches, most recently committed first.
    Branches { project: String },
    /// Find files in a project by fuzzy path match
    Files {
        project: String,
        #[arg(default_value = "")]
        query: String,
    },
    /// Manage provider-owned plugins and connectors.
    Integrations {
        #[command(subcommand)]
        cmd: IntegrationsCmd,
    },
    /// Inspect native Claude artifact receipts and local source files.
    Artifacts {
        #[command(subcommand)]
        cmd: ArtifactsCmd,
    },
    /// List skills available to an agent in a project.
    Skills {
        project: String,
        #[arg(long, default_value = "codex")]
        provider: ProviderKind,
    },
    /// List one directory of a project (relative path, empty for the root)
    Ls {
        project: String,
        #[arg(default_value = "")]
        path: String,
    },
    /// Print a project file
    Cat { project: String, path: String },
    /// Read a linked file relative to a conversation workspace.
    ThreadCat { thread: String, path: String },
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
enum QueueCmd {
    List { thread: Option<String> },
    Add { thread: String, prompt: Vec<String> },
    Edit { thread: String, id: String, prompt: Vec<String> },
    Remove { thread: String, id: String },
}

#[derive(Subcommand)]
enum ProjectsCmd {
    List,
    /// Browse directories on the connected environment.
    Browse {
        path: Option<String>,
    },
    Add {
        path: PathBuf,
        #[arg(long)]
        name: Option<String>,
    },
    Remove {
        id: String,
    },
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
    Send {
        terminal: String,
        input: Vec<String>,
    },
    /// Stream a terminal's output to stdout (replays scrollback first). Ctrl-C to stop.
    Attach {
        terminal: String,
    },
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
    Close {
        terminal: String,
    },
}

#[derive(Subcommand)]
enum ApprovalsCmd {
    /// Submit a provider-native JSON answer to a question or form.
    Answer {
        id: String,
        response: String,
    },
    List,
    Allow {
        id: String,
        #[arg(long)]
        always: bool,
    },
    Deny {
        id: String,
        #[arg(long)]
        reason: Option<String>,
    },
}

#[derive(Subcommand)]
enum TasksCmd {
    /// List task history as well as active work.
    List {
        #[arg(long)]
        all: bool,
    },
    /// Stop one task without interrupting its parent thread.
    Stop { task: String },
    /// Move one foreground task to the background.
    Background { task: String },
}

fn parse_mode(s: &str) -> Result<PermissionMode, String> {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .map_err(|_| format!("unknown mode {s}; use supervised|accept-edits|auto|full-access"))
}

/// Run the CLI with the process arguments. `kybern` is a thin wrapper around this.
#[tokio::main]
pub async fn run() -> Result<()> {
    let cli = Cli::parse();
    let ep = Endpoint::resolve(cli.url.clone(), cli.token.clone(), cli.data_dir.clone())?;
    let client = Client::connect(&ep).await?;
    let json = cli.json;

    match cli.cmd {
        Cmd::Info => {
            let info = client.call::<DaemonInfoMethod>(Empty {}).await?;
            if json { println!("{}", serde_json::to_string_pretty(&info)?) } else { render::info(&info) }
        }
        Cmd::Activity => {
            let activity = client.call::<DaemonActivityMethod>(Empty {}).await?;
            if json { println!("{}", serde_json::to_string_pretty(&activity)?) } else { render::activity(&activity) }
        }
        Cmd::StopDaemon => {
            client.call::<DaemonShutdown>(Empty {}).await?;
            if json {
                println!("{}", serde_json::to_string(&Empty {})?);
            } else {
                println!("kybernd stopping");
            }
        }
        Cmd::Providers { project, refresh } => {
            let project_id = match project {
                Some(project) => Some(resolve_project(&client, &project, false).await?),
                None => None,
            };
            let r = client.call::<ProvidersList>(ProvidersListParams { project_id, force_refresh: refresh }).await?;
            if json { println!("{}", serde_json::to_string_pretty(&r)?) } else { render::providers(&r.providers) }
        }
        Cmd::Sessions { provider, project, cursor, query } => {
            let project_id = match project {
                Some(project) => Some(resolve_project(&client, &project, false).await?),
                None => None,
            };
            let result = client.call::<SessionsList>(SessionsListParams { provider, project_id, cursor, query }).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                for session in result.sessions {
                    println!("{}  {}  {}", session.id, session.title, session.cwd);
                }
                if let Some(cursor) = result.next_cursor {
                    println!("More sessions: --cursor {cursor}");
                }
            }
        }
        Cmd::Resume { provider, session_id } => {
            let thread = client.call::<SessionsResume>(SessionsResumeParams { provider, session_id }).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&thread)?);
            } else {
                println!("{}", thread.id);
            }
        }
        Cmd::HarnessUpdates { run } => {
            if let Some(kind) = run {
                let result = client.call::<HarnessUpdatesRun>(HarnessUpdateParams { kind }).await?;
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                let result = client.call::<HarnessUpdatesList>(Empty {}).await?;
                println!("{}", serde_json::to_string_pretty(&result)?);
            }
        }
        Cmd::DaemonUpdate { check, run } => {
            let result = if run {
                client.call::<DaemonUpdateRun>(Empty {}).await?
            } else if check {
                client.call::<DaemonUpdateCheck>(Empty {}).await?
            } else {
                client.call::<DaemonUpdateStatusMethod>(Empty {}).await?
            };
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        Cmd::Projects { cmd } => match cmd {
            ProjectsCmd::List => {
                let r = client.call::<ProjectsList>(Empty {}).await?;
                if json { println!("{}", serde_json::to_string_pretty(&r)?) } else { render::projects(&r.projects) }
            }
            ProjectsCmd::Browse { path } => {
                let result = client.call::<ProjectsBrowse>(ProjectsBrowseParams { path }).await?;
                println!("{}", serde_json::to_string_pretty(&result)?);
            }
            ProjectsCmd::Add { path, name } => {
                let p = client
                    .call::<ProjectsAdd>(ProjectsAddParams { path: host_path(&client, &path.to_string_lossy()).await?, name })
                    .await?;
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
        Cmd::New { project, provider, model, effort, mode, worktree, branch, detach, prompt } => {
            let project_id = resolve_project(&client, &project, true).await?;
            let prompt = join_prompt(prompt)?;
            let sub = if detach {
                None
            } else {
                Some(client.call::<EventsSubscribe>(EventsSubscribeParams { thread_id: None, after_seq: None }).await?)
            };
            let thread = client
                .call::<ThreadsCreate>(ThreadsCreateParams {
                    project_id,
                    provider: ProviderInstance::default_for(provider.parse().map_err(|e: String| anyhow!(e))?),
                    model,
                    effort,
                    permission_mode: mode,
                    use_worktree: if worktree { Some(true) } else { None },
                    base_branch: branch,
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
            let sub = if detach {
                None
            } else {
                Some(client.call::<EventsSubscribe>(EventsSubscribeParams { thread_id: Some(thread_id), after_seq: None }).await?)
            };
            let r = client.call::<ThreadsSend>(ThreadsSendParams { thread_id, message: UserMessage::text(prompt) }).await?;
            eprintln!("turn {}", r.turn_id);
            if let Some(sub) = sub {
                render::follow_turn(&client, sub.subscription_id, thread_id, json).await?;
            }
        }
        Cmd::Steer { thread, prompt } => {
            let result = client
                .call::<ThreadsSteer>(QueuedMessage {
                    thread_id: thread.parse()?,
                    id: uuid::Uuid::now_v7(),
                    message: UserMessage::text(join_prompt(prompt)?),
                })
                .await?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        Cmd::Notes { thread, file } => {
            let thread_id = thread.parse()?;
            let mut notes = client.call::<ThreadNotesGet>(ThreadsInterruptParams { thread_id }).await?;
            if let Some(file) = file {
                notes = client
                    .call::<ThreadNotesSet>(ThreadNotesSetParams {
                        thread_id,
                        text: std::fs::read_to_string(file)?,
                        expected_revision: notes.revision,
                    })
                    .await?;
            }
            if json {
                println!("{}", serde_json::to_string_pretty(&notes)?);
            } else {
                println!("{}", notes.text);
            }
        }
        Cmd::Queue { cmd } => match cmd {
            QueueCmd::List { thread } => {
                let result = client.call::<QueueList>(QueueListParams { thread_id: thread.map(|id| id.parse()).transpose()? }).await?;
                println!("{}", serde_json::to_string_pretty(&result)?);
            }
            QueueCmd::Add { thread, prompt } => {
                let id = uuid::Uuid::now_v7();
                client
                    .call::<QueueAdd>(QueuedMessage { id, thread_id: thread.parse()?, message: UserMessage::text(prompt.join(" ")) })
                    .await?;
                println!("{id}");
            }
            QueueCmd::Remove { thread, id } => {
                client.call::<QueueRemove>(QueueRemoveParams { thread_id: thread.parse()?, id: id.parse()? }).await?;
            }
            QueueCmd::Edit { thread, id, prompt } => {
                let thread_id = thread.parse()?;
                let id: MessageId = id.parse()?;
                let mut item = client
                    .call::<QueueList>(QueueListParams { thread_id: Some(thread_id) })
                    .await?
                    .messages
                    .into_iter()
                    .find(|item| item.id == id)
                    .ok_or_else(|| anyhow!("Queued message not found."))?;
                let text = join_prompt(prompt)?;
                item.message.parts.retain(|part| !matches!(part, ContentPart::Text { .. }));
                item.message.parts.insert(0, ContentPart::Text { text });
                client.call::<QueueUpdate>(item).await?;
            }
        },
        Cmd::Show { thread, limit, before_seq, through_seq } => {
            let r = client
                .call::<ThreadsGet>(ThreadsGetParams { thread_id: thread.parse()?, transcript_limit: limit, before_seq, through_seq })
                .await?;
            if json { println!("{}", serde_json::to_string_pretty(&r)?) } else { render::transcript(&r) }
        }
        Cmd::Watch { thread, after } => {
            let thread_id = thread.map(|t| t.parse::<ThreadId>()).transpose()?;
            let sub = client.call::<EventsSubscribe>(EventsSubscribeParams { thread_id, after_seq: after }).await?;
            render::watch(&client, sub.subscription_id, json).await?;
        }
        Cmd::Release { thread } => {
            client.call::<ThreadsRelease>(ThreadsInterruptParams { thread_id: thread.parse()? }).await?;
        }
        Cmd::Answer { thread, request_id, answers } => {
            client.call::<ThreadsAnswer>(ThreadsAnswerParams { thread_id: thread.parse()?, request_id, answers }).await?;
        }
        Cmd::Compact { thread } => {
            let result = client.call::<ThreadsCompact>(ThreadsInterruptParams { thread_id: thread.parse()? }).await?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        Cmd::Interrupt { thread } => {
            client.call::<ThreadsInterrupt>(ThreadsInterruptParams { thread_id: thread.parse()? }).await?;
            println!("interrupt sent");
        }
        Cmd::Tasks { thread, cmd } => {
            let thread_id = thread.parse()?;
            match cmd.unwrap_or(TasksCmd::List { all: false }) {
                TasksCmd::List { all } => {
                    let result = client.call::<TasksList>(TasksListParams { thread_id, include_completed: all }).await?;
                    if json {
                        println!("{}", serde_json::to_string_pretty(&result)?);
                    } else if result.tasks.is_empty() {
                        println!("no provider tasks");
                    } else {
                        for task in result.tasks {
                            println!(
                                "{:<38} {:<9} {:<11} {}",
                                task.id,
                                format!("{:?}", task.kind).to_lowercase(),
                                format!("{:?}", task.status).to_lowercase(),
                                task.title
                            );
                        }
                    }
                }
                TasksCmd::Stop { task } => {
                    let result = client.call::<TaskStop>(TaskControlParams { thread_id, task_id: task }).await?;
                    if json {
                        println!("{}", serde_json::to_string_pretty(&result)?);
                    } else {
                        println!("stop requested for {}", result.title);
                    }
                }
                TasksCmd::Background { task } => {
                    let result = client.call::<TaskBackground>(TaskControlParams { thread_id, task_id: task }).await?;
                    if json {
                        println!("{}", serde_json::to_string_pretty(&result)?);
                    } else {
                        println!("moved {} to the background", result.title);
                    }
                }
            }
        }
        Cmd::Approvals { cmd } => match cmd.unwrap_or(ApprovalsCmd::List) {
            ApprovalsCmd::List => {
                let r = client.call::<ApprovalsList>(ApprovalsListParams { thread_id: None }).await?;
                if json { println!("{}", serde_json::to_string_pretty(&r)?) } else { render::approvals(&r.approvals) }
            }
            ApprovalsCmd::Answer { id, response } => {
                client
                    .call::<ApprovalsRespond>(ApprovalsRespondParams {
                        approval_id: id.parse()?,
                        decision: ApprovalDecision::Submit { response: serde_json::from_str(&response)? },
                    })
                    .await?;
            }
            ApprovalsCmd::Allow { id, always } => {
                let decision = if always { ApprovalDecision::AllowAlways } else { ApprovalDecision::AllowOnce };
                client.call::<ApprovalsRespond>(ApprovalsRespondParams { approval_id: id.parse()?, decision }).await?;
                println!("allowed");
            }
            ApprovalsCmd::Deny { id, reason } => {
                client
                    .call::<ApprovalsRespond>(ApprovalsRespondParams {
                        approval_id: id.parse()?,
                        decision: ApprovalDecision::Deny { reason },
                    })
                    .await?;
                println!("denied");
            }
        },
        Cmd::Archive { thread } => {
            client.call::<ThreadsArchive>(ThreadsArchiveParams { thread_id: thread.parse()? }).await?;
            println!("archived");
        }
        Cmd::Checkpoints { thread } => {
            let r = client.call::<ThreadsCheckpoints>(ThreadsCheckpointsParams { thread_id: thread.parse()? }).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&r)?)
            } else {
                for c in r.checkpoints {
                    println!(
                        "{}  {} → {}  {}",
                        c.turn_id,
                        &c.before[..10],
                        c.after.as_deref().map(|a| &a[..10]).unwrap_or("(running)"),
                        c.created_at.to_rfc3339()
                    );
                }
            }
        }
        Cmd::Diff { thread, turn, stat } => {
            let d = client
                .call::<ThreadsDiff>(ThreadsDiffParams {
                    thread_id: thread.parse()?,
                    turn_id: turn.map(|t| t.parse()).transpose()?,
                    include_patch: !stat,
                    path: None,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&d)?)
            } else {
                for f in &d.files {
                    println!("{:<10} +{:<5} -{:<5} {}", format!("{:?}", f.status).to_lowercase(), f.additions, f.deletions, f.path);
                }
                if !stat && !d.patch.is_empty() {
                    println!("\n{}", d.patch);
                    if d.patch_truncated {
                        eprintln!("\n(diff output truncated at 1 MiB; use git diff for the full patch)");
                    }
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
        Cmd::Pair { label, address, tailscale } => {
            // Validate before minting a code, so a typo doesn't waste an invitation.
            let address = address.map(|value| kybern_client::address::normalize(&value)).transpose()?;
            let info = client.call::<DaemonInfoMethod>(Empty {}).await?;
            if tailscale {
                let exposure = client.call::<ExposureSet>(ExposureSetParams { tailscale: true }).await?;
                if !json {
                    eprintln!("Listening on {}", exposure.listeners.join(", "));
                }
            }
            let mut pairing = client.call::<PairingCreate>(PairingCreateParams { label }).await?;
            if let Some(address) = address {
                pairing.endpoints = vec![address];
            }
            let report = kybern_client::pairing::PairingReport::new(&pairing, &info.environment_id)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", report.render());
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
        Cmd::Files { project, query } => {
            let r = client.call::<FilesSearch>(FilesSearchParams { project_id: project.parse()?, query, limit: 30 }).await?;
            for f in &r.files {
                println!("{f}");
            }
            eprintln!("{} of {} files", r.files.len(), r.total);
        }
        Cmd::Integrations { cmd } => match cmd {
            IntegrationsCmd::List { project, provider } => {
                let project_id = resolve_project(&client, &project, false).await?;
                let result = client.call::<IntegrationsList>(IntegrationsListParams { project_id, provider }).await?;
                println!("{}", serde_json::to_string_pretty(&result)?);
            }
            IntegrationsCmd::Change { project, id, action, provider, kind, scope } => {
                let project_id = resolve_project(&client, &project, false).await?;
                let result = client
                    .call::<IntegrationChange>(IntegrationChangeParams {
                        project_id,
                        provider,
                        id,
                        scope,
                        action: serde_json::from_value(serde_json::Value::String(action))?,
                        kind: serde_json::from_value(serde_json::Value::String(kind))?,
                    })
                    .await?;
                println!("{}", serde_json::to_string_pretty(&result)?);
            }
            IntegrationsCmd::Login { thread, name } => {
                let result = client.call::<IntegrationLogin>(IntegrationLoginParams { thread_id: thread.parse()?, name }).await?;
                println!("{}", serde_json::to_string_pretty(&result)?);
            }
        },
        Cmd::Artifacts { cmd } => match cmd {
            ArtifactsCmd::List { thread, before_seq, limit } => {
                let result = client.call::<ArtifactsList>(ArtifactsListParams { thread_id: thread.parse()?, before_seq, limit }).await?;
                println!("{}", serde_json::to_string_pretty(&result)?);
            }
            ArtifactsCmd::Read { thread, path } => {
                let result = client.call::<ArtifactRead>(ArtifactReadParams { thread_id: thread.parse()?, path }).await?;
                if json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    print!("{}", result.content);
                }
            }
            ArtifactsCmd::Preview { thread, path } => {
                let result = client.call::<ArtifactPreview>(ArtifactReadParams { thread_id: thread.parse()?, path }).await?;
                println!("{}", serde_json::to_string_pretty(&result)?);
            }
        },
        Cmd::Skills { project, provider } => {
            let project_id = resolve_project(&client, &project, false).await?;
            let r = client.call::<SkillsList>(SkillsListParams { project_id, provider }).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&r)?);
            } else {
                for skill in r.skills {
                    println!(
                        "${:<28} {:<8} {}",
                        skill.name,
                        format!("{:?}", skill.scope).to_lowercase(),
                        skill.description.unwrap_or_default()
                    );
                }
            }
        }
        Cmd::Ls { project, path } => {
            let r = client.call::<FilesList>(FilesListParams { project_id: project.parse()?, path }).await?;
            for e in &r.entries {
                match e.kind {
                    FileEntryKind::Directory => println!("{}/", e.name),
                    FileEntryKind::File => println!("{}  {}", e.name, e.size.unwrap_or(0)),
                }
            }
        }
        Cmd::ThreadCat { thread, path } => {
            let r = client.call::<ThreadFileRead>(ThreadFileReadParams { thread_id: thread.parse()?, path, max_bytes: 512 * 1024 }).await?;
            if r.binary {
                eprintln!("binary file, {} bytes", r.size);
            } else {
                print!("{}", r.content);
                if r.truncated {
                    eprintln!("\n[file truncated]");
                }
            }
        }
        Cmd::Cat { project, path } => {
            let r = client.call::<FilesRead>(FilesReadParams { project_id: project.parse()?, path, max_bytes: 512 * 1024 }).await?;
            if r.binary {
                eprintln!("binary file, {} bytes", r.size);
            } else {
                print!("{}", r.content);
                if r.truncated {
                    eprintln!("\n[truncated at 512 KiB of {} bytes]", r.size);
                }
            }
        }
        Cmd::Git { thread } => {
            let r = client.call::<GitStatusMethod>(GitStatusParams { thread_id: thread.parse()? }).await?;
            println!("{}", serde_json::to_string_pretty(&r)?);
        }
        Cmd::Branches { project } => {
            let project_id = resolve_project(&client, &project, false).await?;
            let r = client.call::<GitBranches>(GitBranchesParams { project_id }).await?;
            for b in r.branches {
                let upstream = b.upstream.map(|u| format!("  -> {u}")).unwrap_or_default();
                println!("{} {}{upstream}", if b.is_current { "*" } else { " " }, b.name);
            }
        }
        Cmd::Commit { thread, message } => {
            let r = client.call::<GitCommit>(GitCommitParams { thread_id: thread.parse()?, message }).await?;
            println!("{}  {}", &r.commit[..10], r.message.lines().next().unwrap_or(""));
        }
        Cmd::Pr { cmd } => match cmd {
            PrCmd::Create { thread, title, body, base, draft } => {
                let r = client
                    .call::<PrCreate>(PrCreateParams { thread_id: thread.parse()?, title, body, base, draft, commit_first: true })
                    .await?;
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

async fn host_path(client: &Client, path: &str) -> Result<String> {
    let explicit = std::env::var_os("KYBERN_URL").is_some() || std::env::args().any(|arg| arg == "--url" || arg.starts_with("--url="));
    let path = if !explicit && !PathBuf::from(path).is_absolute() && !path.starts_with('~') {
        std::env::current_dir()?.join(path).to_string_lossy().into_owned()
    } else {
        path.into()
    };
    Ok(client.call::<ProjectsBrowse>(ProjectsBrowseParams { path: Some(path) }).await?.path)
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
    let list = client.call::<ProjectsList>(Empty {}).await?;
    if let Some(p) = list.projects.iter().find(|p| p.path == key || p.name == key) {
        return Ok(p.id);
    }
    let path = host_path(client, key).await?;
    if let Some(project) = list.projects.iter().find(|project| project.path == path) {
        return Ok(project.id);
    }
    if add_if_missing {
        let p = client.call::<ProjectsAdd>(ProjectsAddParams { path, name: None }).await?;
        eprintln!("added project {} ({})", p.name, p.id);
        return Ok(p.id);
    }
    Err(anyhow!("project {key} not found"))
}
