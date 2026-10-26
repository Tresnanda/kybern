//! The `kybern_request_login` tool: a sign-in card for a developer CLI.
//!
//! The card is a daemon-owned approval (`LOGIN_REQUEST_TOOL`) that follows the
//! sign-in through `RequestProgress`. The user picks a way (the browser, driven
//! by a hidden terminal, or a visible terminal tab); the daemon runs the CLI's
//! sign-in, shows the page and one-time code, takes a pasted code, and decides
//! success only by running the recipe's verify command every two seconds. The
//! tool returns once the CLI is signed in, the user declines, or the wait ends.

use kybern_protocol::process::NoWindow;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use chrono::Utc;
use kybern_drivers::login_recipes::{self, LoginRecipe};
use kybern_protocol::*;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::Instant;
use uuid::Uuid;

use super::{LiveSession, Orchestrator};
use crate::cli_login::{self, PtyEvent, PtyRun, Screen};
use crate::requests::RequestAct;

pub(crate) const TOOL: &str = LOGIN_REQUEST_TOOL;
/// A sign-in page stays valid about this long.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The card waits this long for a choice before the call gives up.
const ASK_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const POLL: Duration = Duration::from_secs(2);
/// How long the success state stays up before the card leaves.
const DONE_HOLD: Duration = Duration::from_millis(900);
/// The gateway's own budget for the call.
pub(crate) const CALL_BUDGET: Duration = Duration::from_secs(25 * 60 + 60);

pub(crate) fn is_tool(name: &str) -> bool {
    name == TOOL
}

pub(crate) fn call_budget(name: &str) -> Option<Duration> {
    is_tool(name).then_some(CALL_BUDGET)
}

pub(crate) fn tool_definition() -> kybern_drivers::NativeToolDefinition {
    let known = login_recipes::RECIPES.iter().map(|recipe| recipe.cli).collect::<Vec<_>>().join(", ");
    kybern_drivers::NativeToolDefinition {
        name: TOOL.into(),
        description: format!(
            "Ask the user to sign in to a developer CLI and wait until it is signed in. Use it when a command fails because you are not signed in \
             (gh, vercel, supabase, npm, gcloud, fly, wrangler, eas: cli is one of {known}) instead of asking the user to run the login themselves. \
             Kybern checks first and returns at once when the CLI is already signed in. Otherwise the user gets a card, signs in with the browser \
             or a terminal tab, and Kybern confirms it by running the CLI's own check. The sign-in is the user's own login on this Mac, for every \
             project. For gh it also sets up git to use it. For any other CLI pass command (the exact sign-in command) and verify (a command that \
             exits 0 only when signed in); the user signs in from a terminal tab. reason says why you need it, in a sentence. The call waits up to \
             20 minutes. status is \"signed_in\" or \"already_signed_in\" (retry what failed; account says who, when known), \"declined\" (the user \
             said no: do not ask again unless they ask), \"cancelled\" (the run ended) or \"timed_out\". Result: {{status, cli, account?}}."
        ),
        input_schema: json!({
            "type": "object", "additionalProperties": false,
            "properties": {
                "cli": {"type":"string","minLength":1,"maxLength":40,"pattern":"^[A-Za-z0-9._-]+$","description":"The CLI to sign in, e.g. gh."},
                "reason": {"type":"string","minLength":1,"maxLength":300,"description":"Why you need it, in a sentence the user can judge."},
                "command": {"type":["string","null"],"maxLength":300,"description":"Only for a CLI Kybern does not know: the exact sign-in command."},
                "verify": {"type":["string","null"],"maxLength":300,"description":"Only for a CLI Kybern does not know: a command that exits 0 only when signed in."}
            },
            "required": ["cli", "reason"]
        }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawArguments {
    cli: String,
    reason: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    verify: Option<String>,
}

/// What signing in means for one request: a table recipe or the agent's own command.
#[derive(Clone, Debug)]
enum Plan {
    Known(&'static LoginRecipe),
    Custom { cli: String, command: String, verify: String },
}

impl Plan {
    fn cli(&self) -> &str {
        match self {
            Plan::Known(recipe) => recipe.cli,
            Plan::Custom { cli, .. } => cli,
        }
    }

    fn service(&self) -> String {
        match self {
            Plan::Known(recipe) => recipe.service.to_string(),
            Plan::Custom { cli, .. } => cli.clone(),
        }
    }
}

fn parse(arguments: Value) -> Result<(Plan, String)> {
    let raw: RawArguments = serde_json::from_value(arguments).map_err(|error| {
        anyhow!("Invalid arguments for kybern_request_login: {error}. Pass cli and reason (and command and verify for a CLI Kybern does not know).")
    })?;
    let reason = raw.reason.trim().to_owned();
    if reason.is_empty() || reason.chars().count() > 300 {
        bail!("reason must be 1 to 300 characters. Say in a sentence why you need this sign-in.");
    }
    let cli = raw.cli.trim().to_owned();
    if cli.is_empty() || !cli.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        bail!("cli must be the CLI's name, such as gh.");
    }
    if let Some(recipe) = login_recipes::recipe(&cli) {
        return Ok((Plan::Known(recipe), reason));
    }
    let clean = |value: Option<String>| value.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
    match (clean(raw.command), clean(raw.verify)) {
        (Some(command), Some(verify)) if !command.contains('\0') && !verify.contains('\0') => {
            Ok((Plan::Custom { cli, command, verify }, reason))
        }
        _ => bail!(
            "Kybern has no sign-in recipe for `{cli}`. Pass command (the exact sign-in command) and verify (a command that exits 0 only when signed in), or ask the user to sign in themselves."
        ),
    }
}

/// The card's rows and copy for a plan.
fn card_input(plan: &Plan, reason: &str) -> LoginRequestInput {
    match plan {
        Plan::Known(recipe) => LoginRequestInput {
            cli: recipe.cli.into(),
            service: recipe.service.into(),
            reason: reason.into(),
            account: recipe.account.into(),
            access: recipe.access.map(str::to_owned),
            signs_in: recipe.signs_in.into(),
            command: recipe.command_line(),
            methods: if recipe.terminal_only { vec!["terminal".into()] } else { vec!["browser".into(), "terminal".into()] },
            custom: false,
        },
        Plan::Custom { cli, command, verify } => LoginRequestInput {
            cli: cli.clone(),
            service: cli.clone(),
            reason: reason.into(),
            account: "whichever account the command signs in".into(),
            access: None,
            signs_in: format!("`{cli}` for this Mac. Kybern checks with `{verify}`"),
            command: command.clone(),
            methods: vec!["terminal".into()],
            custom: true,
        },
    }
}

fn outcome(status: &str, plan: &Plan, account: Option<&str>) -> Value {
    let mut value = json!({ "status": status, "cli": plan.cli() });
    if let Some(account) = account {
        value["account"] = json!(account);
    }
    value
}

/// Where a custom or table sign-in is checked: the thread's folder, so a
/// project `.npmrc` decides which registry `npm whoami` asks.
pub(super) struct Checker {
    plan: Plan,
    binary: PathBuf,
    cwd: PathBuf,
}

impl Checker {
    #[cfg(test)]
    pub(super) fn for_test(recipe: &'static LoginRecipe, binary: PathBuf, cwd: PathBuf) -> Self {
        Self { plan: Plan::Known(recipe), binary, cwd }
    }

    pub(super) async fn signed_in(&self) -> Option<Option<String>> {
        match &self.plan {
            Plan::Known(recipe) => cli_login::verify(recipe, &self.binary, &self.cwd).await,
            Plan::Custom { verify, .. } => {
                let mut command = tokio::process::Command::new(cli_login::shell()).no_window();
                command
                    .args(["-lc", verify])
                    .current_dir(&self.cwd)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(true);
                match tokio::time::timeout(Duration::from_secs(10), command.status()).await {
                    Ok(Ok(status)) if status.success() => Some(None),
                    _ => None,
                }
            }
        }
    }
}

/// One sign-in attempt that is running.
struct Attempt {
    pty: PtyRun,
    screen: Screen,
    method: &'static str,
    url_file: Option<PathBuf>,
    started: Instant,
    exited: bool,
}

impl Orchestrator {
    pub(super) async fn execute_request_login(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        arguments: Value,
    ) -> Result<Value> {
        let (plan, reason) = parse(arguments)?;
        let cwd = PathBuf::from(&thread.cwd);
        let binary = match &plan {
            Plan::Known(recipe) => cli_login::locate(recipe.binaries).await.ok_or_else(|| {
                anyhow!(
                    "`{}` isn't installed on this Mac. Ask the user to install it, then call kybern_request_login again.",
                    recipe.binaries[0]
                )
            })?,
            Plan::Custom { .. } => PathBuf::new(),
        };
        let checker = Checker { plan: plan.clone(), binary, cwd };
        let (this, live, thread_id) = (self.clone(), live.clone(), thread.id);
        // The wait runs in its own task: if the harness gives up on the call
        // first, a sign-in the user already finished still completes.
        tokio::spawn(async move { this.run_login_request(thread_id, turn_id, live, checker, reason).await })
            .await
            .map_err(|_| anyhow!("The sign-in request failed. Call kybern_request_login again."))?
    }

    async fn run_login_request(
        &self,
        thread_id: ThreadId,
        turn_id: TurnId,
        live: Arc<LiveSession>,
        checker: Checker,
        reason: String,
    ) -> Result<Value> {
        let plan = checker.plan.clone();
        let input = card_input(&plan, &reason);
        let summary = format!("Sign in to {}", plan.service());
        // A custom command is never run before the user chose it on the card.
        if matches!(plan, Plan::Known(_))
            && let Some(account) = checker.signed_in().await
        {
            // No card to show: leave the record a card would, so the transcript says it.
            let key = format!("login:{}", Uuid::now_v7());
            let (card, _) =
                self.open_daemon_card(thread_id, turn_id, &live, key, TOOL, serde_json::to_value(&input)?, summary, None).await?;
            let mut response = outcome("already_signed_in", &plan, account.as_deref());
            response["service"] = json!(plan.service());
            self.finish_daemon_card(thread_id, turn_id, &live, card, ApprovalDecision::Submit { response }).await?;
            return Ok(outcome("already_signed_in", &plan, account.as_deref()));
        }
        let key = format!("login:{}", Uuid::now_v7());
        let (card, mut decision) =
            self.open_daemon_card(thread_id, turn_id, &live, key, TOOL, serde_json::to_value(&input)?, summary, None).await?;
        let hub = self.requests().clone();
        let mut acts = hub.register(RequestProgress {
            approval_id: card,
            thread_id,
            kind: RequestKind::Login,
            phase: RequestPhase::Asking,
            method: None,
            url: None,
            user_code: None,
            terminal: None,
            account: None,
            error: None,
            ends_at: None,
            remaining_ms: None,
            updated_at: Utc::now(),
        });
        let _guard = scopeguard(hub.clone(), card);
        let terminals = self.inner.app_tools.terminal_manager().clone();
        let data_dir = self.inner.paths.root.clone();
        let hard_stop = Instant::now() + ASK_TIMEOUT + LOGIN_TIMEOUT;
        let mut attempt: Option<Attempt> = None;
        let mut poll = tokio::time::interval(POLL);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut asked_until = Instant::now() + ASK_TIMEOUT;

        let result: Result<Value> = loop {
            let attempt_deadline = attempt.as_ref().map(|a| a.started + LOGIN_TIMEOUT);
            tokio::select! {
                decided = super::request_tools::wait_decision(&mut decision) => {
                    break Ok(match decided {
                        Some(ApprovalDecision::Deny { reason }) if reason.as_deref() == Some("turn ended") => outcome("cancelled", &plan, None),
                        Some(ApprovalDecision::Deny { reason }) if reason.as_deref() == Some("timed out") => outcome("timed_out", &plan, None),
                        Some(ApprovalDecision::Deny { .. }) => outcome("declined", &plan, None),
                        Some(ApprovalDecision::Submit { response }) => response,
                        _ => outcome("cancelled", &plan, None),
                    });
                }
                act = acts.recv() => {
                    let Some(act) = act else { break Ok(outcome("cancelled", &plan, None)) };
                    if let Err(error) = self.login_act(&act, &plan, &checker, &terminals, &data_dir, thread_id, card, &mut attempt).await {
                        hub.update(card, |p| { p.phase = RequestPhase::Failed; p.error = Some(error.to_string()); });
                        attempt = None;
                    } else if attempt.is_some() {
                        asked_until = Instant::now() + LOGIN_TIMEOUT;
                    }
                }
                event = async { match attempt.as_mut() { Some(a) => a.pty.events.recv().await, None => std::future::pending().await } }, if attempt.as_ref().is_some_and(|a| !a.exited) => {
                    if let Some(attempt) = attempt.as_mut() {
                        self.login_event(event, &plan, card, attempt, &hub);
                    }
                }
                _ = poll.tick(), if attempt.is_some() => {
                    if let Some(account) = checker.signed_in().await {
                        let Some(done) = attempt.take() else { continue };
                        let method = done.method;
                        drop(done);
                        if let Plan::Known(recipe) = &plan
                            && let Some(args) = recipe.post_login_args
                        {
                            // Best effort: `gh auth setup-git` lets git use the new sign-in.
                            cli_login::run_quiet(&checker.binary, args, &checker.cwd).await;
                        }
                        hub.update(card, |p| { p.phase = RequestPhase::Done; p.account = account.clone(); p.method = Some(method.into()); p.error = None; });
                        tokio::time::sleep(DONE_HOLD).await;
                        let mut response = outcome("signed_in", &plan, account.as_deref());
                        response["service"] = json!(plan.service());
                        let ours = self.finish_daemon_card(thread_id, turn_id, &live, card, ApprovalDecision::Submit { response: response.clone() }).await?;
                        let _ = ours;
                        break Ok(outcome("signed_in", &plan, account.as_deref()));
                    }
                    if attempt.as_ref().is_some_and(|a| a.exited) {
                        let message = attempt.as_ref().map(|a| fail_message(&plan, a)).unwrap_or_default();
                        attempt = None;
                        hub.update(card, |p| { p.phase = RequestPhase::Failed; p.error = Some(message); p.url = None; p.user_code = None; p.ends_at = None; });
                    }
                }
                _ = async { match attempt_deadline { Some(at) => tokio::time::sleep_until(at).await, None => std::future::pending().await } } => {
                    attempt = None;
                    hub.update(card, |p| { p.phase = RequestPhase::Failed; p.error = Some("The sign-in timed out after 15 min. Try again.".into()); p.url = None; p.user_code = None; p.ends_at = None; });
                    asked_until = Instant::now() + ASK_TIMEOUT;
                }
                _ = tokio::time::sleep_until(asked_until), if attempt.is_none() => {
                    break Ok(self.close_login_card_as_timed_out(thread_id, turn_id, &live, card, &plan).await?);
                }
                _ = tokio::time::sleep_until(hard_stop) => {
                    break Ok(self.close_login_card_as_timed_out(thread_id, turn_id, &live, card, &plan).await?);
                }
            }
        };
        drop(attempt);
        result
    }

    async fn close_login_card_as_timed_out(
        &self,
        thread_id: ThreadId,
        turn_id: TurnId,
        live: &LiveSession,
        card: ApprovalId,
        plan: &Plan,
    ) -> Result<Value> {
        let decision = ApprovalDecision::Deny { reason: Some("timed out".into()) };
        self.finish_daemon_card(thread_id, turn_id, live, card, decision).await?;
        Ok(outcome("timed_out", plan, None))
    }

    /// One button press on the card.
    #[allow(clippy::too_many_arguments)]
    async fn login_act(
        &self,
        act: &RequestAct,
        plan: &Plan,
        checker: &Checker,
        terminals: &crate::terminal::TerminalManager,
        data_dir: &Path,
        thread_id: ThreadId,
        card: ApprovalId,
        attempt: &mut Option<Attempt>,
    ) -> Result<()> {
        let hub = self.requests();
        match act.action.as_str() {
            "browser" | "retry" | "terminal" => {
                if !act.can_write {
                    bail!("Signing in changes this Mac's own login, so it needs this device's full access. Sign in from the Mac itself.");
                }
                let terminal = act.action == "terminal";
                let browser = !terminal;
                if browser && let Plan::Known(recipe) = plan {
                    if recipe.terminal_only {
                        bail!("{} signs in from a terminal. Choose Sign in from a terminal.", recipe.service);
                    }
                } else if browser {
                    bail!("This sign-in runs in a terminal. Choose Sign in from a terminal.");
                }
                *attempt = None;
                let started = Instant::now();
                let ends_at = Utc::now() + chrono::Duration::from_std(LOGIN_TIMEOUT)?;
                let run = if terminal {
                    let command = match plan {
                        Plan::Known(recipe) => {
                            let words = recipe.login_args.iter().map(|arg| cli_login::quote(arg)).collect::<Vec<_>>().join(" ");
                            format!("{} {words}", cli_login::quote(&checker.binary.to_string_lossy()))
                        }
                        Plan::Custom { command, .. } => command.clone(),
                    };
                    let env = cli_login::run_env(&checker.binary);
                    let pty = cli_login::spawn_pty(
                        terminals,
                        Some(thread_id),
                        &checker.cwd,
                        vec![cli_login::shell(), "-lc".into(), command],
                        &env,
                    )?;
                    Attempt { pty, screen: Screen::default(), method: "terminal", url_file: None, started, exited: false }
                } else {
                    let Plan::Known(recipe) = plan else { unreachable!("checked above") };
                    let shim = crate::account_login::install_shim(data_dir)?;
                    let url_file = cli_login::ensure_url_file(data_dir, &card.to_string())?;
                    let mut env = cli_login::run_env(&checker.binary);
                    let path = env.get("PATH").cloned().unwrap_or_default();
                    env.insert("PATH".into(), format!("{}:{path}", shim.display()));
                    let opener = shim.join("open").to_string_lossy().into_owned();
                    env.insert("BROWSER".into(), opener.clone());
                    env.insert("GH_BROWSER".into(), opener);
                    env.insert("KYBERN_LOGIN_URL_FILE".into(), url_file.to_string_lossy().into_owned());
                    let command: Vec<String> = std::iter::once(checker.binary.to_string_lossy().into_owned())
                        .chain(recipe.login_args.iter().map(|a| a.to_string()))
                        .collect();
                    let pty = cli_login::spawn_pty(terminals, None, &checker.cwd, command, &env)?;
                    Attempt { pty, screen: Screen::default(), method: "browser", url_file: Some(url_file), started, exited: false }
                };
                let info = terminal.then(|| run.pty.terminal.info());
                hub.update(card, |p| {
                    p.phase = RequestPhase::Waiting;
                    p.method = Some(run.method.into());
                    p.url = None;
                    p.user_code = None;
                    p.error = None;
                    p.terminal = info;
                    p.ends_at = Some(ends_at);
                });
                *attempt = Some(run);
                Ok(())
            }
            "paste" => {
                let Some(run) = attempt.as_mut().filter(|run| run.method == "browser") else {
                    bail!("This sign-in isn't waiting for a code. Choose Sign in with the browser.");
                };
                let code = act.value.as_deref().unwrap_or("").trim();
                if code.is_empty() || code.len() > 4096 || code.contains(['\r', '\n', '\0']) {
                    bail!("Paste the code from the sign-in page.");
                }
                run.pty.terminal.write(format!("{code}\r").as_bytes())?;
                run.screen.pasted = true;
                hub.update(card, |p| {
                    p.phase = RequestPhase::Verifying;
                    p.error = None;
                });
                Ok(())
            }
            "cancel" => {
                if let Some(run) = attempt.take() {
                    if run.method == "terminal" {
                        let _ = run.pty.terminal.write(&[3]);
                    }
                    drop(run);
                }
                hub.update(card, |p| {
                    p.phase = RequestPhase::Failed;
                    p.error =
                        Some(format!("The sign-in was cancelled. Try again, or sign in from a terminal to see what {} says.", plan.cli()));
                    p.url = None;
                    p.user_code = None;
                    p.ends_at = None;
                });
                Ok(())
            }
            other => bail!("This card has no `{other}` action."),
        }
    }

    /// Output or exit of the running sign-in.
    fn login_event(
        &self,
        event: Option<PtyEvent>,
        plan: &Plan,
        card: ApprovalId,
        attempt: &mut Attempt,
        hub: &crate::requests::RequestHub,
    ) {
        let Plan::Known(recipe) = plan else {
            // A custom command runs in a visible terminal; only its end and the verify poll matter.
            if matches!(event, None | Some(PtyEvent::Exit)) {
                attempt.exited = true;
            }
            return;
        };
        match event {
            Some(PtyEvent::Out(text)) => {
                if attempt.method != "browser" {
                    return;
                }
                for _ in 0..attempt.screen.push(&text) {
                    let _ = attempt.pty.terminal.write(b"\x1b[1;1R");
                }
                for _ in 0..attempt.screen.enters_owed() {
                    let _ = attempt.pty.terminal.write(b"\r");
                }
                let (page, code) = attempt.screen.device();
                let page = attempt.url_file.as_deref().and_then(cli_login::shim_url).or(page);
                let wants_code = !attempt.screen.pasted && attempt.screen.wants_code(recipe.paste_markers);
                hub.update(card, |p| {
                    if page.is_some() {
                        p.url = page;
                    }
                    if code.is_some() {
                        p.user_code = code;
                    }
                    if wants_code && p.phase == RequestPhase::Waiting {
                        p.phase = RequestPhase::PasteCode;
                    }
                });
            }
            Some(PtyEvent::Exit) => {
                // The verify poll decides: success may land a moment after the CLI exits.
                attempt.exited = true;
                hub.update(card, |p| {
                    if p.phase == RequestPhase::Waiting || p.phase == RequestPhase::PasteCode {
                        p.phase = RequestPhase::Verifying;
                    }
                });
            }
            None => attempt.exited = true,
        }
    }
}

/// Why a sign-in that ended did not sign in, in a sentence that says what to do next.
fn fail_message(plan: &Plan, attempt: &Attempt) -> String {
    if attempt.method == "terminal" {
        return format!("The terminal closed before {} was signed in. Try again, or sign in from the terminal.", plan.cli());
    }
    if attempt.screen.pasted {
        return "That code didn't work. Open the sign-in page again and paste the new code.".into();
    }
    match attempt.screen.last_line() {
        Some(line) => format!("{line} Try again, or sign in from a terminal."),
        None => format!("{} stopped before signing in. Try again, or sign in from a terminal.", plan.service()),
    }
}

/// Stops tracking the card however the request ends.
struct HubGuard {
    hub: crate::requests::RequestHub,
    card: ApprovalId,
}

impl Drop for HubGuard {
    fn drop(&mut self) {
        self.hub.remove(self.card);
    }
}

fn scopeguard(hub: crate::requests::RequestHub, card: ApprovalId) -> HubGuard {
    HubGuard { hub, card }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_and_custom_requests_parse() {
        let (plan, _) = parse(json!({"cli":"gh","reason":"push"})).unwrap();
        assert!(matches!(plan, Plan::Known(r) if r.cli == "gh"));
        let (plan, _) = parse(json!({"cli":"flyctl","reason":"deploy"})).unwrap();
        assert_eq!(plan.cli(), "fly");
        let error = parse(json!({"cli":"mytool","reason":"x"})).unwrap_err().to_string();
        assert!(error.contains("no sign-in recipe") && error.contains("verify"), "{error}");
        let (plan, _) = parse(json!({"cli":"mytool","reason":"x","command":"mytool login","verify":"mytool whoami"})).unwrap();
        assert!(matches!(plan, Plan::Custom { .. }));
        assert!(parse(json!({"cli":"gh; rm -rf /","reason":"x"})).is_err());
        assert!(parse(json!({"cli":"gh","reason":""})).is_err());
    }

    #[test]
    fn cards_offer_the_ways_a_cli_supports() {
        let (eas, _) = parse(json!({"cli":"eas","reason":"build"})).unwrap();
        assert_eq!(card_input(&eas, "build").methods, vec!["terminal"]);
        let (gh, _) = parse(json!({"cli":"gh","reason":"push"})).unwrap();
        let input = card_input(&gh, "push");
        assert_eq!(input.methods, vec!["browser", "terminal"]);
        assert_eq!(input.access.as_deref(), Some("repo, read:org, workflow"));
    }
}
