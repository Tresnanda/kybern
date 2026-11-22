//! Antigravity (`agy`), Google's coding-agent CLI, on one of two transports.
//!
//! **ACP** (`acp.rs`), when the installed `agy` is 1.5.0 or later and `agy acp`
//! initializes: one long-lived `agy acp` per session, a flavor of the shared ACP
//! client. Kybern answers agy's permission requests, so every permission mode
//! works, and steering, live model and effort switches and background replies
//! do too.
//!
//! **`-p`** (this file), the fallback, unchanged: one `agy` process per turn, so a
//! session handle is lazy: `spawn` checks the request and starts nothing, and each
//! `send_message` starts `agy -p= --input-format stream-json`, writes the prompt as
//! one NDJSON line on stdin, closes stdin, and maps the NDJSON that comes back.
//! Turns after the first pass `--conversation <id>`. It only runs in Full access
//! (`--dangerously-skip-permissions`): Kybern has no way to approve or limit its
//! tools there. `KYBERN_ANTIGRAVITY_PRINT_MODE=1` in the Antigravity environment
//! (Settings → Agents) forces it. Title one-shots always use it.
//!
//! Both reach the same conversations. Kybern's own tools reach agy through one
//! global MCP entry (`kybern mcp-bridge`, added with `agy mcp add`) that forwards
//! to the session's gateway; the session's endpoint and credential travel in the
//! environment of the `agy` process, never on its command line.
mod acp;
mod login;
mod stream;
pub(crate) mod tools;
mod usage;

pub use login::{LoginRead, StoredLogin, parse_login, read_login, read_login_state};
pub use stream::is_invalid_thinking_signature;
pub use usage::{
    ANTIGRAVITY_USER_AGENT_PREFIX, QuotaBucket, QuotaReading, forget_sign_in_waits, merge_buckets, parse_load_code_assist,
    parse_quota_summary, plan_name, read_account_usage, to_limits,
};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use kybern_protocol::process::NoWindow;
use kybern_protocol::rpc::{Problem, ProblemAction, ProblemKind};
use kybern_protocol::*;
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc};

use crate::binary::{at_least, resolve, version_of};
use crate::ndjson::{NdjsonChild, SessionLifetime};
use crate::{AgentDriver, AgentSession, DriverError, DriverEvent, ProbeContext, Result, SessionConfig, SpawnedSession};
use stream::TurnMapper;

/// `result.finished_reason` first shipped in this version.
const MIN_VERSION: (u64, u64, u64) = (1, 4, 11);
/// What `kybern mcp-bridge` reads from the environment `agy` hands it.
const BRIDGE_URL: &str = "KYBERN_MCP_URL";
const BRIDGE_AUTHORIZATION: &str = "KYBERN_MCP_AUTHORIZATION";
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const INSTALL_HINT: &str = "Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash (Windows PowerShell: irm https://antigravity.google/cli/install.ps1 | iex)";
/// The sentence every refused permission mode gets, wherever it is refused.
pub const FULL_ACCESS_ONLY: &str = "Antigravity only runs in Full access. Choose Full access, or pick another agent.";
/// Kybern cannot narrow Antigravity's tools, so it cannot lead a project.
pub const NO_LEAD: &str = "Antigravity can't lead a project: Kybern can't limit its tools. Choose Claude Code or Codex for the lead.";
pub(crate) const SIGN_IN: &str = "Antigravity isn't signed in. Sign in from Settings → Agents → Antigravity, then send your message again.";
/// The detail for a mode only the ACP transport can run, when the installed agy is too old for it.
pub const NEEDS_ACP: &str =
    "Antigravity needs agy 1.5 or later for this permission mode. Update it with `agy update`, or choose Full access.";
/// The detail for a mode only the ACP transport can run, when `agy acp` didn't start.
pub const ACP_DIDNT_START: &str = "agy acp didn't start or answer initialize; only Full access runs without it.";
/// Set to `1` in the Antigravity environment to always use `-p` (one process per turn, Full access only).
pub const PRINT_MODE_ENV: &str = "KYBERN_ANTIGRAVITY_PRINT_MODE";

/// How long SIGINT gets before SIGTERM. SIGKILL follows after
/// [`crate::process_tree::TERMINATE_GRACE`].
const INTERRUPT_GRACE: Duration = Duration::from_secs(3);
const MODELS_TTL: Duration = Duration::from_secs(10 * 60);
const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
const ONE_SHOT_TIMEOUT: Duration = Duration::from_secs(90);

/// How long a failed `agy acp` check holds before the next session or probe checks again.
const ACP_RETRY: Duration = Duration::from_secs(5 * 60);

/// Refuses every permission mode but Full access.
pub fn require_full_access(mode: PermissionMode) -> std::result::Result<(), &'static str> {
    if mode == PermissionMode::FullAccess { Ok(()) } else { Err(FULL_ACCESS_ONLY) }
}

/// A mode other than Full access, refused where only `-p` runs (forced, or no Antigravity driver).
pub fn full_access_only_problem() -> Problem {
    Problem::new(ProblemKind::InvalidInput, FULL_ACCESS_ONLY)
        .with_subject("antigravity")
        .with_copy("Antigravity only runs in Full access", "Choose Full access, or pick another agent.")
}

/// A mode other than Full access on an `agy` older than 1.5: update it.
pub fn needs_update_problem() -> Problem {
    crate::failure::update_needed_problem(ProviderKind::Antigravity, NEEDS_ACP)
        .with_copy("Update Antigravity to use this permission mode", "This mode needs agy 1.5 or later. Update it, or choose Full access.")
}

/// A mode other than Full access when `agy acp` didn't start: it may next time.
pub fn acp_failed_problem() -> Problem {
    Problem::new(ProblemKind::Internal, ACP_DIDNT_START)
        .with_subject("antigravity")
        .with_copy("Antigravity couldn't start in this permission mode", "Try again. If it keeps failing, choose Full access.")
        .with_action(ProblemAction::retry("Try again"))
}

#[derive(Default)]
pub struct AntigravityDriver {
    models: std::sync::Mutex<Option<CachedModels>>,
    catalog_file: Option<PathBuf>,
    /// Whether the installed `agy` takes ACP, as last checked.
    acp_check: std::sync::Mutex<Option<AcpCheck>>,
    /// What the last probe or session start found: which permission modes work.
    acp: std::sync::Mutex<Acp>,
}

/// Whether sessions run on `agy acp`, as the last probe or session start found.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Acp {
    /// Not checked since the daemon started: the session's start decides.
    #[default]
    Unknown,
    /// Every permission mode works.
    Ready,
    /// `PRINT_MODE_ENV` forces `-p`.
    Forced,
    /// `agy` is older than 1.5.0.
    TooOld,
    /// `agy acp` didn't start or initialize (or agy's version couldn't be read).
    Failed,
}

impl Acp {
    /// Why a mode other than Full access can't run, or `None` when it can (or the start decides).
    fn refusal(self) -> Option<Problem> {
        match self {
            Acp::Unknown | Acp::Ready => None,
            Acp::Forced => Some(full_access_only_problem()),
            Acp::TooOld => Some(needs_update_problem()),
            Acp::Failed => Some(acp_failed_problem()),
        }
    }
}

/// One check of whether a binary takes ACP, keyed on the version `agy` reports (a `.cmd` or npm
/// launcher doesn't change on disk when agy updates). A success holds for that version; a failure
/// holds for [`ACP_RETRY`], and nothing holds across a daemon restart.
struct AcpCheck {
    binary: PathBuf,
    version: String,
    usable: bool,
    at: Instant,
}

impl AcpCheck {
    /// The cached answer for `binary` at `version`, while it holds.
    fn answer(&self, binary: &Path, version: &str, now: Instant) -> Option<bool> {
        let holds = self.usable || now.saturating_duration_since(self.at) < ACP_RETRY;
        (self.binary == binary && self.version == version && holds).then_some(self.usable)
    }
}

/// `PRINT_MODE_ENV` is on.
fn forced_print(value: Option<&String>) -> bool {
    value.is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

struct CachedModels {
    binary: PathBuf,
    at: Instant,
    models: Vec<ProviderModel>,
}

impl AntigravityDriver {
    /// Keep the model list in `file` so a restarted daemon lists models at once.
    pub fn with_catalog_file(file: PathBuf) -> Self {
        Self { catalog_file: Some(file), ..Self::default() }
    }

    /// Whether a session should run on ACP: not forced to `-p`, `agy` 1.5.0 or later, and `agy acp`
    /// initializes. The last check is reused while it holds ([`AcpCheck::answer`]); with `recheck`, a
    /// failure is checked again at once.
    async fn acp_state(&self, binary: &Path, env: &BTreeMap<String, String>, recheck: bool) -> Acp {
        if forced_print(env.get(PRINT_MODE_ENV)) {
            return Acp::Forced;
        }
        let Some(version) = version_of(binary, &["--version"]).await else { return Acp::Failed };
        if !at_least(&version, acp::MIN_ACP_VERSION) {
            return Acp::TooOld;
        }
        let cached = self.lock_check().as_ref().and_then(|check| check.answer(binary, &version, Instant::now()));
        let usable = match cached {
            Some(usable) if usable || !recheck => usable,
            _ => {
                let usable = acp::initializes(binary, env).await;
                *self.lock_check() = Some(AcpCheck { binary: binary.to_path_buf(), version, usable, at: Instant::now() });
                usable
            }
        };
        if usable { Acp::Ready } else { Acp::Failed }
    }

    fn lock_check(&self) -> std::sync::MutexGuard<'_, Option<AcpCheck>> {
        self.acp_check.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn record(&self, state: Acp) {
        *self.acp.lock().unwrap_or_else(|e| e.into_inner()) = state;
    }

    /// ACP failed to start for this binary: `-p` until the check is due again.
    fn forget_acp(&self, binary: &Path) {
        if let Some(check) = self.lock_check().as_mut().filter(|check| check.binary == binary) {
            check.usable = false;
            check.at = Instant::now();
        }
        self.record(Acp::Failed);
    }

    fn cached(&self, binary: &Path, max_age: Duration) -> Option<Vec<ProviderModel>> {
        let guard = self.models.lock().unwrap_or_else(|error| error.into_inner());
        guard.as_ref().filter(|cache| cache.binary == binary && cache.at.elapsed() < max_age).map(|cache| cache.models.clone())
    }

    fn last_good(&self, binary: &Path) -> Vec<ProviderModel> {
        let remembered = self.models.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(cache) = remembered.as_ref().filter(|cache| cache.binary == binary) {
            return cache.models.clone();
        }
        drop(remembered);
        self.catalog_file
            .as_ref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    async fn models(&self, binary: &Path, context: &ProbeContext, fresh: bool) -> Vec<ProviderModel> {
        if !fresh && let Some(models) = self.cached(binary, MODELS_TTL) {
            return models;
        }
        let mut command = Command::new(binary).no_window();
        command.arg("models").envs(&context.env).stdin(std::process::Stdio::null());
        crate::no_browser::quiet(&mut command, &context.env);
        if let Some(cwd) = context.cwd.as_deref().filter(|cwd| cwd.is_dir()) {
            command.current_dir(cwd);
        }
        let output = match tokio::time::timeout(MODELS_TIMEOUT, crate::process_tree::output(&mut command)).await {
            Ok(Ok(output)) if output.status.success() => output,
            // Signed out, offline or slow: keep whatever the last good read had.
            _ => return self.last_good(binary),
        };
        let models = parse_models(&String::from_utf8_lossy(&output.stdout));
        if models.is_empty() {
            return self.last_good(binary);
        }
        if let Some(file) = &self.catalog_file
            && let Ok(bytes) = serde_json::to_vec(&models)
        {
            let _ = std::fs::write(file, bytes);
        }
        *self.models.lock().unwrap_or_else(|error| error.into_inner()) =
            Some(CachedModels { binary: binary.to_path_buf(), at: Instant::now(), models: models.clone() });
        models
    }

    async fn probe_context(&self, context: &ProbeContext, fresh: bool) -> ProviderStatus {
        let kind = ProviderKind::Antigravity;
        let mut status = ProviderStatus {
            kind,
            display_name: kind.display_name().into(),
            available: false,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            supported_permission_modes: vec![PermissionMode::FullAccess],
            supports_fork: false,
            supports_model_switch: true,
            supports_effort_switch: true,
            supported_efforts: EFFORTS.iter().map(|effort| effort.to_string()).collect(),
            models: vec![],
            instances: vec!["default".into()],
        };
        let binary = match resolve(kind, context.binary.as_ref()) {
            Ok(binary) => binary,
            Err(error) => {
                status.unavailable_reason = Some(format!("{error}. {INSTALL_HINT}"));
                return status;
            }
        };
        status.binary_path = Some(binary.display().to_string());
        match version_of(&binary, &["--version"]).await {
            Some(version) => {
                status.available = at_least(&version, MIN_VERSION);
                if !status.available {
                    status.unavailable_reason = Some(format!(
                        "Antigravity {version} is older than the required {}.{}.{}. Update it with `agy update`.",
                        MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2
                    ));
                }
                status.version = Some(version);
            }
            None => status.unavailable_reason = Some("Could not read Antigravity's version. Verify the configured agy executable.".into()),
        }
        if status.available {
            status.models = self.models(&binary, context, fresh).await;
            let acp = self.acp_state(&binary, &context.env, false).await;
            self.record(acp);
            if acp == Acp::Ready {
                status.supported_permission_modes = PermissionMode::ALL.to_vec();
            }
        }
        status
    }
}

/// Whether `agy models` succeeds with at least one model, which only a signed-in
/// `agy` does. Used when its login is somewhere Kybern cannot read.
pub async fn signed_in_by_models(binary: &Path, context: &ProbeContext) -> bool {
    let mut command = Command::new(binary).no_window();
    command.arg("models").envs(&context.env).stdin(std::process::Stdio::null());
    crate::no_browser::quiet(&mut command, &context.env);
    match tokio::time::timeout(MODELS_TIMEOUT, crate::process_tree::output(&mut command)).await {
        Ok(Ok(output)) if output.status.success() => !parse_models(&String::from_utf8_lossy(&output.stdout)).is_empty(),
        _ => false,
    }
}

/// `agy models`: a "Fetching available models..." line, then `slug<TAB>Display name`.
/// The first slug is the default.
///
/// `agy` lists each thinking tier of a model as its own slug
/// (`gemini-3.8-flash-high`, `-medium`, `-low`, named "Gemini 3.8 Flash (High)"…).
/// Two or more tiers of one model become one row whose efforts are the tiers,
/// so pickers show a single model with an effort slider. The row's id is the
/// first tier `agy` listed (a real slug, so it still runs without the catalog),
/// and its default effort is that tier. [`turn_model`] turns the row and the
/// chosen effort back into the tier's slug.
pub fn parse_models(text: &str) -> Vec<ProviderModel> {
    let mut entries: Vec<(&str, &str)> = Vec::new();
    for line in text.lines() {
        let Some((slug, name)) = line.split_once('\t') else { continue };
        let (slug, name) = (slug.trim(), name.trim());
        if slug.is_empty() || slug.contains(char::is_whitespace) || entries.iter().any(|(seen, _)| *seen == slug) {
            continue;
        }
        entries.push((slug, name));
    }
    // Tiers of each base, in the order `agy` listed them.
    let mut tiers: BTreeMap<&str, Vec<&'static str>> = BTreeMap::new();
    for (slug, name) in &entries {
        if let Some((base, tier, _)) = split_tier(slug, name) {
            tiers.entry(base).or_default().push(tier);
        }
    }
    let mut models: Vec<ProviderModel> = Vec::new();
    let mut grouped: Vec<&str> = Vec::new();
    for (slug, name) in entries {
        let family = split_tier(slug, name).filter(|(base, _, _)| tiers.get(base).is_some_and(|list| list.len() > 1));
        let (display_name, efforts, default_effort) = match family {
            Some((base, _, _)) if grouped.contains(&base) => continue,
            Some((base, tier, family_name)) => {
                grouped.push(base);
                let listed = &tiers[base];
                let efforts = EFFORTS.iter().filter(|effort| listed.contains(effort)).map(|effort| effort.to_string()).collect();
                (family_name.to_string(), efforts, Some(tier.to_string()))
            }
            None => (if name.is_empty() { crate::models::prettify_model_id(slug) } else { name.to_string() }, vec![], None),
        };
        models.push(ProviderModel {
            id: slug.to_string(),
            display_name,
            resolved_id: None,
            description: None,
            provider: None,
            efforts,
            default_effort,
            is_default: models.is_empty(),
            parameters: vec![],
            variants: vec![],
        });
    }
    models
}

/// `gemini-3.8-flash-high` named "Gemini 3.8 Flash (High)" → (`gemini-3.8-flash`,
/// `high`, "Gemini 3.8 Flash"). The slug's suffix and the name's parenthesis
/// must both name the tier, so `gpt-oss-120b-medium` alone stays a plain model
/// and `claude-opus-4-6-thinking` is never mistaken for one.
fn split_tier<'a>(slug: &'a str, name: &'a str) -> Option<(&'a str, &'static str, &'a str)> {
    EFFORTS.iter().find_map(|tier| {
        let base = slug.strip_suffix(tier)?.strip_suffix('-').filter(|base| !base.is_empty())?;
        let open = name.rfind(" (")?;
        let label = name[open + 2..].strip_suffix(')')?;
        label.eq_ignore_ascii_case(tier).then_some((base, *tier, name[..open].trim_end()))
    })
}

/// A model `agy` lists once per tier, as [`parse_models`] grouped it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TierFamily {
    base: String,
    tiers: Vec<String>,
}

/// The tiered families in a catalog [`parse_models`] built.
fn tier_families(models: &[ProviderModel]) -> Vec<TierFamily> {
    models
        .iter()
        .filter(|model| model.efforts.len() > 1)
        .filter_map(|model| {
            let tier = model.default_effort.as_deref()?;
            let base = model.id.strip_suffix(tier)?.strip_suffix('-')?;
            Some(TierFamily { base: base.to_string(), tiers: model.efforts.clone() })
        })
        .collect()
}

/// The `--model` and `--effort` of a turn. A tier of a grouped family runs the
/// tier the effort names (`gemini-3.8-flash-high` at low effort runs
/// `gemini-3.8-flash-low`) and sends no `--effort`, because the tier is the
/// effort; an effort the family has no tier for keeps the held tier. Any other
/// model passes through with its effort.
fn turn_model(model: Option<&str>, effort: Option<&str>, families: &[TierFamily]) -> (Option<String>, Option<String>) {
    let tiered = model.and_then(|model| {
        families.iter().find_map(|family| {
            let held = model.strip_prefix(family.base.as_str())?.strip_prefix('-')?;
            family.tiers.iter().any(|tier| tier == held).then_some((family, held))
        })
    });
    match tiered {
        Some((family, held)) => {
            let tier = effort.filter(|effort| family.tiers.iter().any(|tier| tier == effort)).unwrap_or(held);
            (Some(format!("{}-{tier}", family.base)), None)
        }
        None => (model.map(str::to_string), effort.map(str::to_string)),
    }
}

fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 128
        && !model.starts_with('-')
        && model.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/'))
}

#[async_trait]
impl AgentDriver for AntigravityDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Antigravity
    }

    fn supports_fork(&self) -> bool {
        false
    }

    fn permission_mode_refusal(&self, mode: PermissionMode) -> Option<DriverError> {
        if mode == PermissionMode::FullAccess {
            return None;
        }
        self.acp.lock().unwrap_or_else(|e| e.into_inner()).refusal().map(DriverError::problem)
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        self.probe_context(&ProbeContext { binary: binary.cloned(), ..ProbeContext::default() }, false).await
    }

    async fn probe_with_context(&self, context: &ProbeContext) -> ProviderStatus {
        self.probe_context(context, false).await
    }

    async fn probe_fresh_with_context(&self, context: &ProbeContext) -> ProviderStatus {
        self.probe_context(context, true).await
    }

    async fn list_sessions(
        &self,
        context: &ProbeContext,
        cursor: Option<&str>,
        query: &str,
    ) -> Result<kybern_protocol::methods::SessionsListResult> {
        crate::sessions::list(ProviderKind::Antigravity, context, cursor, query).await
    }

    async fn read_session(&self, context: &ProbeContext, id: &str) -> Result<crate::sessions::SessionHistory> {
        crate::sessions::read(ProviderKind::Antigravity, context, id).await
    }

    async fn open_session_reader(&self, context: &ProbeContext) -> Result<Box<dyn crate::sessions::SessionReader>> {
        crate::sessions::reader(ProviderKind::Antigravity, context).await
    }

    /// A single tool-free run. Runs in a scratch folder with `--mode plan` so it
    /// never touches the checkout, and removes the temporary conversation `agy`
    /// wrote so one-shots do not clutter `agy`'s history or Kybern's session scan.
    async fn one_shot(&self, _cwd: &Path, prompt: &str, binary: Option<&PathBuf>, env: &BTreeMap<String, String>) -> Result<String> {
        let bin = resolve(ProviderKind::Antigravity, binary)?;
        let scratch = Scratch::new()?;
        let work_dir = scratch.work_dir();
        std::fs::create_dir_all(&work_dir)?;
        let mut command = Command::new(&bin).no_window();
        command.current_dir(&work_dir).args(["--output-format", "stream-json", "--input-format", "stream-json", "--mode", "plan"]);
        command.arg("--log-file").arg(scratch.log_file()).arg("-p=").envs(env);
        let child = NdjsonChild::spawn(command)?;
        let mut mapper = TurnMapper::new(None);
        let run = async {
            child.write(&prompt_line(prompt)).await?;
            child.close_stdin().await?;
            let mut lines = child.lines.lock().await;
            while let Some(line) = lines.recv().await {
                mapper.handle(&line);
            }
            mapper.one_shot_answer().ok_or_else(|| DriverError::Protocol("Antigravity returned no answer".into()))
        };
        let result = tokio::time::timeout(ONE_SHOT_TIMEOUT, run).await;
        child.kill().await;
        if let Some(conversation_id) = mapper.conversation().map(str::to_string)
            && let Some(home) = env_home(env)
        {
            let scratch_dir = work_dir.clone();
            let _ = tokio::task::spawn_blocking(move || cleanup_one_shot_conversation(&home, &conversation_id, &scratch_dir)).await;
        }
        match result {
            Ok(result) => result,
            Err(_) => Err(DriverError::Protocol("Antigravity one-shot timed out".into())),
        }
    }

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        if config.fork || config.rewind.is_some() {
            return Err(DriverError::Unsupported(
                "Antigravity can't fork or rewind a conversation. Rewind restores the workspace only.".into(),
            ));
        }
        if let Some(bridge) = config.native_tool_bridge.as_ref() {
            bridge.validate()?;
            if bridge.restrictions.require_enforcement {
                return Err(DriverError::Unsupported(NO_LEAD.into()));
            }
        }
        let binary = resolve(ProviderKind::Antigravity, config.binary.as_ref())?;
        let env: BTreeMap<String, String> = config.env.iter().map(|(key, value)| (key.clone(), value.clone())).collect();
        let full_access = config.permission_mode == PermissionMode::FullAccess;
        // A mode only ACP runs checks an earlier failure again: it can't run otherwise.
        let state = self.acp_state(&binary, &env, !full_access).await;
        self.record(state);
        if state == Acp::Ready {
            let flavor = acp::AgyAcp::new(env_home(&env), config.native_tool_bridge.as_ref())?;
            let failed_to_start = flavor.failed_to_start.clone();
            match crate::acp::spawn(flavor, config.clone()).await {
                Ok(session) => return Ok(session),
                Err(error) if failed_to_start.load(Ordering::SeqCst) => {
                    self.forget_acp(&binary);
                    if !full_access {
                        return Err(error);
                    }
                    // `agy acp` didn't come up: `-p` takes Full access sessions over, as if ACP had never been there.
                    tracing::warn!(target: "kybern::antigravity", %error, "agy acp didn't start; using -p");
                }
                Err(error) => return Err(error),
            }
        } else if !full_access && let Some(problem) = state.refusal() {
            return Err(DriverError::problem(problem));
        }
        self.spawn_print(config, binary).await
    }
}

impl AntigravityDriver {
    /// A `-p` session: lazy, one `agy` process per turn.
    async fn spawn_print(&self, config: SessionConfig, binary: PathBuf) -> Result<SpawnedSession> {
        require_full_access(config.permission_mode).map_err(|sentence| DriverError::Unsupported(sentence.into()))?;
        // The guide (and any role text) rides in the first prompt, because `agy` has
        // no system channel Kybern can reach. The daemon renders it from the tools
        // this session really has, so it never advertises one the agent cannot call.
        // A resumed conversation that already holds the block gets nothing; one that
        // never received it gets it once.
        let guide = match (&config.resume_session_id, config.resume_lacks_instructions) {
            (None, _) | (Some(_), true) => config.native_tool_bridge.as_ref().and_then(|bridge| bridge.provider_instructions()),
            (Some(_), false) => None,
        };
        let mut env: BTreeMap<String, String> = config.env.into_iter().collect();
        let home = env_home(&env);
        // The bridge process `agy` starts inherits these; without them it serves no tools.
        for key in [BRIDGE_URL, BRIDGE_AUTHORIZATION] {
            env.remove(key);
        }
        if let Some(bridge) = config.native_tool_bridge.as_ref()
            && let (Some(endpoint), Some(authorization)) = (&bridge.endpoint, &bridge.authorization)
        {
            env.insert(BRIDGE_URL.into(), endpoint.clone());
            env.insert(BRIDGE_AUTHORIZATION.into(), authorization.clone());
        }
        let scratch = Arc::new(Scratch::new()?);
        let (tx, events) = mpsc::channel(1024);
        let _ = tx.send(DriverEvent::CommandsUpdated(native_commands())).await;
        let model = config.model.filter(|model| valid_model(model));
        let effort = config.effort.filter(|effort| EFFORTS.contains(&effort.as_str()));
        let state = State { conversation: config.resume_session_id, model, effort, guide, turn: None, closed: false, next_turn: 0 };
        let session = Session {
            state: Arc::new(Mutex::new(state)),
            run: Arc::new(Run { families: tier_families(&self.last_good(&binary)), binary, cwd: config.cwd, env, home, scratch, tx }),
        };
        Ok(SpawnedSession { session: Box::new(session), events })
    }
}

/// A per-session scratch folder: `agy`'s log file and the images of a prompt.
/// Removed with the session.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        let dir = std::env::temp_dir().join(format!("kybern-agy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }

    fn log_file(&self) -> PathBuf {
        self.0.join("agy.log")
    }

    fn work_dir(&self) -> PathBuf {
        self.0.join("work")
    }

    fn image_dir(&self) -> PathBuf {
        self.0.join("images")
    }
}

#[cfg(windows)]
const HOME_KEYS: [&str; 2] = ["USERPROFILE", "HOME"];
#[cfg(not(windows))]
const HOME_KEYS: [&str; 2] = ["HOME", "USERPROFILE"];

fn env_home(env: &BTreeMap<String, String>) -> Option<PathBuf> {
    env_home_with(env, |key| std::env::var(key).ok())
}

fn env_home_with(env: &BTreeMap<String, String>, host: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    HOME_KEYS
        .iter()
        .find_map(|key| env.get(*key).cloned().filter(|home| !home.is_empty()).or_else(|| host(key).filter(|home| !home.is_empty())))
        .map(PathBuf::from)
}

fn valid_conversation_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

enum WorkspaceOwnership {
    /// No workspace URI was recorded on the summary row (`NULL`, empty, or `[]`).
    Absent,
    /// At least one recorded workspace URI points at `expected`.
    Matches,
    /// One or more workspace URIs are present and none match `expected`.
    Different,
}

fn summary_workspace_ownership_text(raw: &str, expected: &Path) -> WorkspaceOwnership {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return WorkspaceOwnership::Absent;
    }
    let uris: Vec<String> = match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Null) => return WorkspaceOwnership::Absent,
        Ok(Value::Array(items)) => {
            items.into_iter().filter_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)).collect()
        }
        Ok(Value::String(uri)) => {
            let uri = uri.trim();
            if uri.is_empty() {
                return WorkspaceOwnership::Absent;
            }
            vec![uri.to_string()]
        }
        _ => vec![trimmed.to_string()],
    };
    if uris.is_empty() {
        return WorkspaceOwnership::Absent;
    }
    let expected_canon = std::fs::canonicalize(expected).unwrap_or_else(|_| expected.to_path_buf());
    let matches = uris.into_iter().filter_map(|uri| crate::sessions::antigravity::uri_path(&uri)).any(|path| {
        let candidate = PathBuf::from(&path);
        let candidate_canon = std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
        candidate == expected || candidate_canon == expected_canon
    });
    if matches { WorkspaceOwnership::Matches } else { WorkspaceOwnership::Different }
}

fn summary_workspace_ownership(value: &rusqlite::types::Value, expected: &Path) -> WorkspaceOwnership {
    match value {
        rusqlite::types::Value::Null => WorkspaceOwnership::Absent,
        rusqlite::types::Value::Text(raw) => summary_workspace_ownership_text(raw, expected),
        rusqlite::types::Value::Blob(bytes) => match std::str::from_utf8(bytes) {
            Ok(raw) => summary_workspace_ownership_text(raw, expected),
            Err(_) => WorkspaceOwnership::Different,
        },
        _ => WorkspaceOwnership::Different,
    }
}

/// Remove the files and summary row `agy` wrote for a temporary `one_shot` conversation.
/// Best-effort: never fails the caller when a file is already gone or locked, and refuses
/// to delete a summary row (or its files) when a workspace is present and doesn't match
/// `scratch_work_dir`.
pub(crate) fn cleanup_one_shot_conversation(home: &Path, conversation_id: &str, scratch_work_dir: &Path) {
    if !valid_conversation_id(conversation_id) {
        return;
    }
    let root = home.join(".gemini").join("antigravity-cli");
    if !root.is_dir() {
        return;
    }
    let summaries = root.join("conversation_summaries.db");
    if summaries.is_file()
        && let Ok(conn) = rusqlite::Connection::open_with_flags(
            &summaries,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    {
        let _ = conn.busy_timeout(Duration::from_millis(500));
        // When no summary row was written yet (e.g. timed out early) or schema differs,
        // keep going for any temporary files without deleting any summary row.
        if let Ok(value) =
            conn.query_row("SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?1", [conversation_id], |row| {
                row.get::<_, rusqlite::types::Value>(0)
            })
        {
            match summary_workspace_ownership(&value, scratch_work_dir) {
                WorkspaceOwnership::Matches | WorkspaceOwnership::Absent => {
                    let _ = conn.execute("DELETE FROM conversation_summaries WHERE conversation_id = ?1", [conversation_id]);
                }
                // A summary row exists for a different workspace: leave both the row and its files untouched.
                WorkspaceOwnership::Different => return,
            }
        }
    }
    let conversations = root.join("conversations");
    for suffix in [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"] {
        let _ = std::fs::remove_file(conversations.join(format!("{conversation_id}{suffix}")));
    }
    let _ = std::fs::remove_dir_all(root.join("brain").join(conversation_id));
    let _ = std::fs::remove_file(root.join("annotations").join(format!("{conversation_id}.pbtxt")));
    let _ = std::fs::remove_file(root.join("presence").join(format!("{conversation_id}.lock")));
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// What every turn needs and a session never changes.
struct Run {
    binary: PathBuf,
    /// Tiered models from the catalog at spawn: their effort picks the slug.
    families: Vec<TierFamily>,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
    home: Option<PathBuf>,
    scratch: Arc<Scratch>,
    tx: mpsc::Sender<DriverEvent>,
}

struct State {
    conversation: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    /// Kybern's instructions block, until a prompt that can carry it is sent.
    guide: Option<String>,
    turn: Option<Turn>,
    closed: bool,
    next_turn: u64,
}

struct Turn {
    id: u64,
    child: Arc<NdjsonChild>,
    interrupted: Arc<AtomicBool>,
    /// Dropping it stops the process tree and the reader task.
    _lifetime: SessionLifetime,
}

pub struct Session {
    state: Arc<Mutex<State>>,
    run: Arc<Run>,
}

/// The one NDJSON line `agy` reads for a turn.
fn prompt_line(text: &str) -> Value {
    json!({"event": "user", "message": {"role": "user", "content": text}})
}

/// The argument list for one turn (without the binary).
fn turn_args(model: Option<&str>, effort: Option<&str>, conversation: Option<&str>, log_file: &Path) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> =
        ["--output-format", "stream-json", "--input-format", "stream-json", "--dangerously-skip-permissions"].map(Into::into).into();
    if let Some(model) = model {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(effort) = effort {
        args.extend(["--effort".into(), effort.into()]);
    }
    if let Some(conversation) = conversation {
        args.extend(["--conversation".into(), conversation.into()]);
    }
    args.extend(["--log-file".into(), log_file.into()]);
    // `-p=` attached: a bare `-p` swallows the next flag as the prompt.
    args.push("-p=".into());
    args
}

#[async_trait]
impl AgentSession for Session {
    async fn send_message(&self, _message_id: &str, message: &UserMessage) -> Result<()> {
        let mut state = self.state.lock().await;
        if state.closed {
            return Err(DriverError::ProcessExited("session is closed; send again to resume".into()));
        }
        if state.turn.is_some() {
            return Err(DriverError::Protocol(
                "Antigravity is still working on the previous message. Wait for it, or interrupt it first.".into(),
            ));
        }
        let text = prompt_text(message, &self.run.scratch);
        // Slash commands (skills) must stay at the start of the prompt; the guide waits for the next ordinary one.
        let guide = if text.trim_start().starts_with('/') { None } else { state.guide.take() };
        let prompt = match &guide {
            Some(guide) => crate::cursor::with_guide(guide, &text),
            None => text,
        };
        let (model, effort) = turn_model(state.model.as_deref(), state.effort.as_deref(), &self.run.families);
        let mut command = Command::new(&self.run.binary).no_window();
        command.current_dir(&self.run.cwd).args(turn_args(
            model.as_deref(),
            effort.as_deref(),
            state.conversation.as_deref(),
            &self.run.scratch.log_file(),
        ));
        command.envs(&self.run.env);
        let spawned = async {
            let child = NdjsonChild::spawn(command)?;
            let sent = async {
                child.write(&prompt_line(&prompt)).await?;
                child.close_stdin().await
            }
            .await;
            match sent {
                Ok(()) => Ok(child),
                Err(error) => {
                    child.kill().await;
                    Err(error)
                }
            }
        }
        .await;
        let child = match spawned {
            Ok(child) => Arc::new(child),
            Err(error) => {
                // The agent never saw it; offer the guide again with the retry.
                if guide.is_some() {
                    state.guide = guide;
                }
                return Err(error);
            }
        };
        let id = state.next_turn;
        state.next_turn += 1;
        let interrupted = Arc::new(AtomicBool::new(false));
        let mut lifetime = SessionLifetime::new(child.clone());
        let task = tokio::spawn(run_turn(
            Arc::downgrade(&self.state),
            self.run.clone(),
            child.clone(),
            interrupted.clone(),
            id,
            guide,
            state.conversation.clone(),
        ));
        lifetime.track(task);
        state.turn = Some(Turn { id, child, interrupted, _lifetime: lifetime });
        Ok(())
    }

    async fn interrupt(&self) -> Result<()> {
        let child = {
            let state = self.state.lock().await;
            let Some(turn) = state.turn.as_ref() else { return Ok(()) };
            turn.interrupted.store(true, Ordering::SeqCst);
            turn.child.clone()
        };
        tokio::spawn(async move {
            // Ctrl+C lets `agy` write its own "interrupted" result and take its tool
            // children down with it; escalate only if it does not leave.
            if child.interrupt() && tokio::time::timeout(INTERRUPT_GRACE, child.wait()).await.is_ok() {
                return;
            }
            // SIGTERM, then SIGKILL after the process-tree grace (Windows: forced stop).
            child.kill().await;
        });
        Ok(())
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        require_full_access(mode).map_err(|sentence| DriverError::Unsupported(sentence.into()))
    }

    async fn set_model(&self, model: &str) -> Result<()> {
        if !valid_model(model) {
            return Err(DriverError::Protocol("Choose one of Antigravity's listed models.".into()));
        }
        self.state.lock().await.model = Some(model.to_string());
        Ok(())
    }

    async fn set_effort(&self, effort: &str) -> Result<()> {
        if !EFFORTS.contains(&effort) {
            return Err(DriverError::Protocol("Antigravity's effort is low, medium, high, xhigh or max.".into()));
        }
        self.state.lock().await.effort = Some(effort.to_string());
        Ok(())
    }

    async fn respond_permission(&self, _: &str, _: &ApprovalDecision) -> Result<()> {
        Err(DriverError::Unsupported("Antigravity runs in Full access and never asks for approval".into()))
    }

    async fn close(&self) -> Result<()> {
        let turn = {
            let mut state = self.state.lock().await;
            state.closed = true;
            state.turn.take()
        };
        if let Some(turn) = turn {
            turn.child.kill().await;
        }
        let _ = self.run.tx.send(DriverEvent::Exited { code: None, error: None }).await;
        Ok(())
    }
}

/// Read one turn's output, report how it ended, and free the session for the next message.
async fn run_turn(
    state: Weak<Mutex<State>>,
    run: Arc<Run>,
    child: Arc<NdjsonChild>,
    interrupted: Arc<AtomicBool>,
    id: u64,
    guide: Option<String>,
    conversation: Option<String>,
) {
    let mut mapper = TurnMapper::resumed(run.home.clone(), conversation);
    {
        let mut lines = child.lines.lock().await;
        while let Some(line) = lines.recv().await {
            for event in mapper.handle(&line) {
                if run.tx.send(event).await.is_err() {
                    return;
                }
            }
        }
    }
    // Stdout closed: the process is leaving. Do not wait on it forever.
    let code = match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
        Ok(code) => code,
        Err(_) => {
            child.kill().await;
            None
        }
    };
    let mut last_stderr = None;
    for attempt in 0..2 {
        let mut stderr = child.stderr.lock().await;
        while let Ok(line) = stderr.try_recv() {
            if !line.trim().is_empty() {
                last_stderr = Some(line);
            }
        }
        drop(stderr);
        if last_stderr.is_some() || code == Some(0) || attempt == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    let was_interrupted = interrupted.load(Ordering::SeqCst);
    let conversation = mapper.conversation().map(str::to_string);
    let started = mapper.saw_init();
    let events = mapper.finish(code, last_stderr.as_deref(), was_interrupted);
    let poisoned = mapper.conversation_poisoned();
    // Update session state and release the turn slot before delivering the terminal event so an
    // immediate follow-up `send_message` sees the freed slot and updated conversation id.
    let turn = if let Some(state) = state.upgrade() {
        let mut state = state.lock().await;
        if poisoned {
            // The saved conversation's thinking block has a bad/missing signature:
            // never reuse it on the next turn.
            state.conversation = None;
            if state.guide.is_none() {
                state.guide = guide;
            }
        } else {
            if let Some(conversation) = conversation {
                state.conversation = Some(conversation);
            }
            // The prompt never reached a conversation: carry the guide on the retry.
            if !started && state.guide.is_none() {
                state.guide = guide;
            }
        }
        if state.turn.as_ref().is_some_and(|turn| turn.id == id) { state.turn.take() } else { None }
    } else {
        None
    };
    for event in events {
        if run.tx.send(event).await.is_err() {
            break;
        }
    }
    // Dropping the turn stops this task, so it is the last thing done.
    drop(turn);
}

/// The text of a prompt. Images are saved in the session's scratch folder and
/// named by path so the agent can open them.
fn prompt_text(message: &UserMessage, scratch: &Scratch) -> String {
    use base64::Engine;
    let mut out = String::new();
    let mut images = 0;
    for part in &message.parts {
        match part {
            ContentPart::Text { text } => out.push_str(text),
            ContentPart::FileMention { path } => {
                out.push('@');
                out.push_str(path);
            }
            ContentPart::ThreadReference { thread_id, title, .. } => out.push_str(&thread_reference_text(*thread_id, title)),
            ContentPart::Skill { name, .. } => {
                out.push('/');
                out.push_str(name);
            }
            ContentPart::Mention { name, .. } => {
                out.push('@');
                out.push_str(name);
            }
            ContentPart::Image { media_type, data } => {
                images += 1;
                let extension = match media_type.as_str() {
                    "image/png" => "png",
                    "image/jpeg" | "image/jpg" => "jpg",
                    "image/gif" => "gif",
                    "image/webp" => "webp",
                    _ => "img",
                };
                let saved =
                    base64::engine::general_purpose::STANDARD.decode(data).ok().filter(|bytes| bytes.len() <= 20 * 1024 * 1024).and_then(
                        |bytes| {
                            let dir = scratch.image_dir();
                            std::fs::create_dir_all(&dir).ok()?;
                            let path = dir.join(format!("image-{}.{extension}", uuid::Uuid::new_v4()));
                            std::fs::write(&path, bytes).ok()?;
                            Some(path)
                        },
                    );
                match saved {
                    Some(path) => out.push_str(&format!("[image {images}: {}]", path.display())),
                    None => out.push_str("[image]"),
                }
            }
            ContentPart::Attachment { name, .. } => {
                out.push('[');
                out.push_str(name);
                out.push(']');
            }
            ContentPart::Media { .. } => out.push_str("[image]"),
            ContentPart::ThreadMessage { .. } | ContentPart::AgentResults { .. } | ContentPart::SystemRow { .. } => {
                if let Some(flat) = part.orchestration_text() {
                    out.push_str(&flat);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;

fn native_commands() -> Vec<kybern_protocol::ProviderCommand> {
    crate::provider_commands(&json!([
        {"name":"goal", "description":"Set a goal"},
        {"name":"plan", "description":"Plan the work"},
        {"name":"grill-me", "description":"Explore requirements through questions"},
        {"name":"learn", "description":"Learn from this conversation"}
    ]))
}

#[cfg(test)]
mod command_tests {
    #[test]
    fn print_mode_advertises_only_supported_commands() {
        assert_eq!(super::native_commands().iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["goal", "plan", "grill-me", "learn"]);
    }
}
