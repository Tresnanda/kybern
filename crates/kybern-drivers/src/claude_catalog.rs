//! Claude Code's model catalog.
//!
//! Claude Code reports the list its `/model` picker shows in the `initialize`
//! control response: each entry's selector (`opus[1m]`), the concrete model it
//! runs as (`claude-opus-5-5[1m]`, on recent CLIs), a display name, a one-line
//! description and the effort levels it accepts. One zero-turn process answers
//! in about a second, and Claude Code has already applied the account default,
//! `ANTHROPIC_DEFAULT_*_MODEL` overrides, cloud providers and pinned models.
//!
//! The answer only changes with the CLI build, its environment and its
//! settings files, so it is cached on disk under exactly those inputs and
//! served immediately. Stale entries refresh in the background, a failed
//! refresh never replaces a good entry, and sessions on the default model
//! keep entries fresh for free because every session sends `initialize`.
//!
//! A catalog read is a full Claude Code startup, which refreshes an expiring
//! login and rotates its OAuth tokens. The read therefore lets the process
//! exit on its own, and a stale entry waits for the next session rather than
//! spending the login's refresh on a background probe.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ProbeContext;
use crate::ndjson::NdjsonChild;

/// Upper bound for one catalog read. It runs off the request path, so a
/// loaded machine (a 2-core remote host took ~4s) still completes it.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a probe waits for the first read when nothing is cached.
const COLD_WAIT: Duration = Duration::from_secs(12);
/// How long a probe waits when an earlier build's catalog can stand in.
const STAND_IN_WAIT: Duration = Duration::from_secs(3);
const REVALIDATE_AFTER: Duration = Duration::from_secs(10 * 60);
/// Minimum spacing between reads for one key, so a failing CLI is not
/// respawned on every picker open.
const RETRY_AFTER: Duration = Duration::from_secs(2 * 60);
const MAX_ENTRIES: usize = 32;
const FILE_VERSION: u32 = 1;
const REQUEST_ID: &str = "kybern-model-catalog";

/// Environment Claude Code consults when building its model list. Other
/// variables (per-session Kybern variables, proxies) never change it.
const CATALOG_ENV_PREFIXES: [&str; 5] = ["ANTHROPIC_", "CLAUDE_", "AWS_", "CLOUD_ML_", "VERTEX_"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CatalogModel {
    /// Selector Claude Code accepts for `--model`.
    pub value: String,
    /// Concrete id the selector runs as. Older CLIs omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_model: Option<String>,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub supports_effort: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
}

/// Parse the `models` array of an `initialize` response. `None` when absent
/// or empty, so callers fall back instead of showing an empty picker.
pub(crate) fn parse_models(models: &Value) -> Option<Vec<CatalogModel>> {
    let models: Vec<CatalogModel> = models
        .as_array()?
        .iter()
        .filter_map(|item| {
            let value = non_empty(item.get("value"))?;
            Some(CatalogModel {
                value: value.to_string(),
                resolved_model: non_empty(item.get("resolvedModel")).map(str::to_string),
                display_name: non_empty(item.get("displayName")).unwrap_or(value).to_string(),
                description: non_empty(item.get("description")).map(str::to_string),
                supports_effort: item.get("supportsEffort").and_then(Value::as_bool).unwrap_or(false),
                efforts: item
                    .get("supportedEffortLevels")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
            })
        })
        .collect();
    (!models.is_empty()).then_some(models)
}

/// Everything a catalog depends on. Secret values never enter the key: they
/// contribute only their variable names, and the key holds hashes, not text.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) struct CatalogKey {
    /// Canonical CLI path. Self-updates repoint `~/.local/bin/claude`, so a
    /// new build resolves to a new path or a new stamp.
    binary: String,
    /// Size and modification time of the CLI.
    stamp: String,
    /// Fingerprint of the catalog environment and the settings files.
    inputs: String,
}

impl CatalogKey {
    pub(crate) fn new(binary: &Path, context: &ProbeContext) -> Option<Self> {
        let binary = std::fs::canonicalize(binary).ok()?;
        let metadata = std::fs::metadata(&binary).ok()?;
        let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
        let mut hash = Fnv::default();
        for (key, value) in catalog_env(context) {
            hash.write(key.as_bytes());
            hash.write(if is_secret(&key) { b"<set>" } else { value.as_bytes() });
        }
        // Absent files are skipped, so a project without its own settings
        // shares the global probe's entry.
        for path in crate::claude_config::settings_paths(context) {
            if let Ok(contents) = std::fs::read(&path) {
                hash.write(&contents);
            }
        }
        Some(Self { binary: binary.to_string_lossy().into_owned(), stamp: format!("{}-{modified}", metadata.len()), inputs: hash.hex() })
    }
}

fn catalog_env(context: &ProbeContext) -> BTreeMap<String, String> {
    let relevant = |key: &str| CATALOG_ENV_PREFIXES.iter().any(|prefix| key.starts_with(prefix));
    let mut env: BTreeMap<String, String> = std::env::vars().filter(|(key, _)| relevant(key)).collect();
    env.extend(context.env.iter().filter(|(key, _)| relevant(key)).map(|(key, value)| (key.clone(), value.clone())));
    env
}

fn is_secret(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"].iter().any(|word| key.contains(word))
}

/// 64-bit FNV-1a: stable across Rust releases, unlike `DefaultHasher`, so
/// keys written by one daemon build still match after an upgrade.
struct Fnv(u64);

impl Default for Fnv {
    fn default() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
}

impl Fnv {
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes.iter().chain(std::iter::once(&0)) {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }

    fn hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    key: CatalogKey,
    /// Unix seconds.
    fetched_at: u64,
    models: Vec<CatalogModel>,
}

impl Entry {
    fn age(&self) -> Duration {
        Duration::from_secs(unix_now().saturating_sub(self.fetched_at))
    }
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    entries: Vec<Entry>,
}

type PendingRead = Shared<BoxFuture<'static, Option<Vec<CatalogModel>>>>;

#[derive(Default)]
struct State {
    loaded: bool,
    entries: Vec<Entry>,
    pending: HashMap<CatalogKey, PendingRead>,
    attempts: HashMap<CatalogKey, Instant>,
}

/// Last-known-good catalogs, optionally persisted to one JSON file.
#[derive(Default)]
pub struct ModelCatalog {
    file: Option<PathBuf>,
    state: Mutex<State>,
}

impl ModelCatalog {
    pub fn persistent(file: PathBuf) -> Self {
        Self { file: Some(file), state: Mutex::default() }
    }

    /// The catalog for this CLI and context. A cached entry returns at once
    /// (refreshing in the background once stale); otherwise this waits a
    /// bounded time for a read and falls back to an earlier build's entry.
    /// A read that outlives the wait keeps running and fills the cache.
    pub(crate) async fn models(self: &Arc<Self>, binary: &Path, context: &ProbeContext) -> Option<Vec<CatalogModel>> {
        let key = CatalogKey::new(binary, context)?;
        let (cached, stand_in) = {
            let state = self.lock();
            let cached = state.entries.iter().find(|entry| entry.key == key).map(|entry| (entry.models.clone(), entry.age()));
            (cached, stand_in(&state.entries, &key))
        };
        if let Some((models, age)) = cached {
            if age >= REVALIDATE_AFTER && !crate::claude_config::login_needs_refresh(context).await {
                let _ = self.read(key, binary, context);
            }
            return Some(models);
        }
        let Some(pending) = self.read(key, binary, context) else { return stand_in };
        let wait = if stand_in.is_some() { STAND_IN_WAIT } else { COLD_WAIT };
        match tokio::time::timeout(wait, pending).await {
            Ok(Some(models)) => Some(models),
            _ => stand_in,
        }
    }

    /// Explicit reload bypasses age/retry throttling, joins an existing read,
    /// and leaves the previous catalog intact if the bounded read fails.
    pub(crate) async fn refresh(self: &Arc<Self>, binary: &Path, context: &ProbeContext) -> Option<Vec<CatalogModel>> {
        let key = CatalogKey::new(binary, context)?;
        let fallback = {
            let mut state = self.lock();
            state.attempts.remove(&key);
            state.entries.iter().find(|entry| entry.key == key).map(|entry| entry.models.clone()).or_else(|| stand_in(&state.entries, &key))
        };
        let Some(pending) = self.read(key, binary, context) else { return fallback };
        match tokio::time::timeout(COLD_WAIT, pending).await {
            Ok(Some(models)) => Some(models),
            _ => fallback,
        }
    }

    /// Store a catalog a live session reported in its `initialize` response.
    pub(crate) fn record(&self, key: CatalogKey, models: Vec<CatalogModel>) {
        self.store(key, models);
    }

    fn read(self: &Arc<Self>, key: CatalogKey, binary: &Path, context: &ProbeContext) -> Option<PendingRead> {
        let mut state = self.lock();
        if let Some(pending) = state.pending.get(&key) {
            return Some(pending.clone());
        }
        if state.attempts.get(&key).is_some_and(|at| at.elapsed() < RETRY_AFTER) {
            return None;
        }
        state.attempts.insert(key.clone(), Instant::now());
        let catalog = self.clone();
        let (binary, context, task_key) = (binary.to_path_buf(), context.clone(), key.clone());
        // Spawned rather than awaited in place, so the read finishes and
        // fills the cache even when the probe that started it stops waiting.
        let task = tokio::spawn(async move {
            let models = read_catalog(&binary, &context).await;
            match &models {
                Some(models) => catalog.store(task_key.clone(), models.clone()),
                None => tracing::debug!(binary = %binary.display(), "Claude Code did not report a model catalog"),
            }
            catalog.lock().pending.remove(&task_key);
            models
        });
        let pending = async move { task.await.ok().flatten() }.boxed().shared();
        state.pending.insert(key, pending.clone());
        Some(pending)
    }

    fn store(&self, key: CatalogKey, models: Vec<CatalogModel>) {
        let mut state = self.lock();
        state.entries.retain(|entry| entry.key != key);
        // Entries stay in write order, so the oldest are at the front.
        state.entries.push(Entry { key, fetched_at: unix_now(), models });
        let excess = state.entries.len().saturating_sub(MAX_ENTRIES);
        state.entries.drain(..excess);
        self.persist(&state.entries);
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if !state.loaded {
            state.loaded = true;
            state.entries = self.load();
        }
        state
    }

    fn load(&self) -> Vec<Entry> {
        let Some(file) = &self.file else { return Vec::new() };
        let Ok(contents) = std::fs::read(file) else { return Vec::new() };
        match serde_json::from_slice::<CacheFile>(&contents) {
            Ok(cache) if cache.version == FILE_VERSION => cache.entries,
            Ok(_) => Vec::new(),
            Err(error) => {
                tracing::warn!(path = %file.display(), %error, "ignored unreadable Claude model catalog cache");
                Vec::new()
            }
        }
    }

    fn persist(&self, entries: &[Entry]) {
        let Some(file) = &self.file else { return };
        let cache = CacheFile { version: FILE_VERSION, entries: entries.to_vec() };
        let result = serde_json::to_vec(&cache).map_err(std::io::Error::other).and_then(|bytes| {
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let temp = file.with_extension("json.tmp");
            std::fs::write(&temp, bytes)?;
            std::fs::rename(&temp, file)
        });
        if let Err(error) = result {
            tracing::warn!(path = %file.display(), %error, "could not save the Claude model catalog cache");
        }
    }
}

/// The freshest catalog from the same CLI path, preferring the same build.
/// It is shown only while the exact entry is being read.
fn stand_in(entries: &[Entry], key: &CatalogKey) -> Option<Vec<CatalogModel>> {
    entries
        .iter()
        .filter(|entry| entry.key.binary == key.binary && entry.key.inputs == key.inputs)
        .max_by_key(|entry| (entry.key.stamp == key.stamp, entry.fetched_at))
        .map(|entry| entry.models.clone())
}

/// Ask a zero-turn Claude Code process for its catalog, then close its input.
/// No model request is made and no session is written.
async fn read_catalog(binary: &Path, context: &ProbeContext) -> Option<Vec<CatalogModel>> {
    let mut command = crate::claude::contextual_command(binary, context);
    command.args(["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--no-session-persistence"]);
    let child = NdjsonChild::spawn(command).ok()?;
    tracing::debug!(binary = %binary.display(), "reading Claude Code's model catalog");
    let request = json!({ "type": "control_request", "request_id": REQUEST_ID, "request": { "subtype": "initialize" } });
    let models = match child.write(&request).await {
        Ok(()) => tokio::time::timeout(FETCH_TIMEOUT, async {
            loop {
                let frame = {
                    let mut lines = child.lines.lock().await;
                    lines.recv().await?
                };
                let response = &frame["response"];
                if frame.get("type").and_then(Value::as_str) == Some("control_response")
                    && response.get("request_id").and_then(Value::as_str) == Some(REQUEST_ID)
                {
                    return response.pointer("/response/models").and_then(parse_models);
                }
            }
        })
        .await
        .ok()
        .flatten(),
        Err(_) => None,
    };
    // Claude Code may still be saving a login it refreshed during startup.
    // End of input lets it finish and exit; killing it first can leave a
    // retired refresh token on disk and sign the user out.
    tokio::spawn(async move { child.close().await });
    models
}

fn non_empty(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty())
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| duration.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from Claude Code 2.1.281's `initialize` response.
    fn current_cli() -> Value {
        json!([
            { "value": "default", "resolvedModel": "claude-opus-5-5[1m]", "displayName": "Default (recommended)",
              "description": "Opus 5.5 with 1M context · Best for everyday, complex tasks",
              "supportsEffort": true, "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"] },
            { "value": "opus[1m]", "resolvedModel": "claude-opus-5-5[1m]", "displayName": "Opus (1M context)",
              "description": "Opus 5.5 with 1M context · Best for everyday, complex tasks",
              "supportsEffort": true, "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"] },
            { "value": "haiku", "resolvedModel": "claude-haiku-4-5-20251001", "displayName": "Haiku",
              "description": "Haiku 4.5 · Fastest for quick answers" },
            { "displayName": "No selector" }
        ])
    }

    fn key(binary: &str, stamp: &str) -> CatalogKey {
        CatalogKey { binary: binary.into(), stamp: stamp.into(), inputs: "0".into() }
    }

    fn model(value: &str) -> CatalogModel {
        CatalogModel {
            value: value.into(),
            resolved_model: None,
            display_name: value.into(),
            description: None,
            supports_effort: false,
            efforts: Vec::new(),
        }
    }

    #[test]
    fn parses_selectors_resolutions_descriptions_and_efforts() {
        let models = parse_models(&current_cli()).unwrap();
        assert_eq!(models.iter().map(|model| model.value.as_str()).collect::<Vec<_>>(), ["default", "opus[1m]", "haiku"]);
        assert_eq!(models[1].resolved_model.as_deref(), Some("claude-opus-5-5[1m]"));
        assert_eq!(models[1].efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert!(!models[2].supports_effort);
        assert_eq!(models[2].description.as_deref(), Some("Haiku 4.5 · Fastest for quick answers"));
        assert_eq!(parse_models(&json!([])), None);
        assert_eq!(parse_models(&Value::Null), None);
    }

    #[test]
    fn older_clis_without_resolved_models_still_parse() {
        let models =
            parse_models(&json!([{ "value": "sonnet", "displayName": "Sonnet", "description": "Sonnet 4.6 · Efficient" }])).unwrap();
        assert_eq!(models[0].resolved_model, None);
        assert_eq!(models[0].description.as_deref(), Some("Sonnet 4.6 · Efficient"));
    }

    #[test]
    fn keys_track_model_settings_but_never_secret_values() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("claude");
        std::fs::write(&binary, "#!/bin/sh\n").unwrap();
        let context = |pairs: &[(&str, &str)]| ProbeContext {
            binary: None,
            cwd: None,
            env: pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect(),
        };
        let base = CatalogKey::new(&binary, &context(&[("ANTHROPIC_API_KEY", "one")])).unwrap();
        assert_eq!(base, CatalogKey::new(&binary, &context(&[("ANTHROPIC_API_KEY", "two")])).unwrap());
        assert_eq!(base, CatalogKey::new(&binary, &context(&[("ANTHROPIC_API_KEY", "one"), ("KYBERN_THREAD", "x")])).unwrap());
        assert_ne!(
            base,
            CatalogKey::new(&binary, &context(&[("ANTHROPIC_API_KEY", "one"), ("ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-opus-4-8")]))
                .unwrap()
        );
        let text = serde_json::to_string(&base).unwrap();
        assert!(!text.contains("one"), "{text}");
    }

    #[test]
    fn saved_catalogs_survive_a_restart() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("cache/claude-models.json");
        ModelCatalog::persistent(file.clone()).record(key("/bin/claude", "1"), vec![model("opus")]);
        let reopened = ModelCatalog::persistent(file);
        let state = reopened.lock();
        assert_eq!(state.entries.len(), 1);
        assert_eq!(state.entries[0].models, [model("opus")]);
    }

    #[test]
    fn stand_ins_prefer_the_same_build_of_the_same_cli() {
        let entry = |key, fetched_at, value| Entry { key, fetched_at, models: vec![model(value)] };
        let entries = [
            entry(key("/bin/claude", "old"), 30, "older-build"),
            entry(key("/bin/claude", "new"), 10, "same-build"),
            entry(key("/other/claude", "new"), 50, "other-cli"),
        ];
        let changed_account = CatalogKey { inputs: "different-account".into(), ..key("/bin/claude", "new") };
        assert_eq!(stand_in(&entries, &changed_account), None, "fallback must never borrow another account/config's catalog");
        assert_eq!(stand_in(&entries, &key("/bin/claude", "new")).unwrap()[0].value, "same-build");
        assert_eq!(stand_in(&entries, &key("/bin/claude", "newest")).unwrap()[0].value, "older-build");
        assert_eq!(stand_in(&entries, &key("/missing/claude", "new")), None);
    }

    #[test]
    fn a_full_cache_drops_the_oldest_entries() {
        let catalog = ModelCatalog::default();
        for index in 0..=MAX_ENTRIES {
            catalog.record(key("/bin/claude", &index.to_string()), vec![model("opus")]);
        }
        let state = catalog.lock();
        assert_eq!(state.entries.len(), MAX_ENTRIES);
        assert_eq!(state.entries[0].key.stamp, "1");
        assert_eq!(state.entries[MAX_ENTRIES - 1].key.stamp, MAX_ENTRIES.to_string());
    }

    const REPLY: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"kybern-model-catalog","response":{"models":[{"value":"opus","resolvedModel":"claude-opus-5-5","displayName":"Opus"}]}}}"#;

    /// A stand-in `claude` that counts its launches, then answers
    /// `initialize` (or exits without answering).
    #[cfg(unix)]
    fn fake_cli(dir: &Path, answers: bool) -> (PathBuf, ProbeContext, PathBuf) {
        let body = if answers { format!("read request\necho '{REPLY}'\nsleep 5\n") } else { "exit 1\n".into() };
        fake_cli_running(dir, &body)
    }

    #[cfg(unix)]
    fn fake_cli_running(dir: &Path, body: &str) -> (PathBuf, ProbeContext, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let binary = dir.join("claude");
        let launches = dir.join("launches");
        std::fs::write(&binary, format!("#!/bin/sh\necho launch >> \"$KYBERN_TEST_LAUNCHES\"\n{body}")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let context = ProbeContext {
            binary: Some(binary.clone()),
            cwd: Some(dir.to_path_buf()),
            env: [
                ("KYBERN_TEST_LAUNCHES".to_string(), launches.to_string_lossy().into_owned()),
                ("CLAUDE_CONFIG_DIR".to_string(), dir.join("config").to_string_lossy().into_owned()),
            ]
            .into(),
        };
        (binary, context, launches)
    }

    #[cfg(unix)]
    fn launch_count(launches: &Path) -> usize {
        std::fs::read_to_string(launches).map_or(0, |text| text.lines().count())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_restarted_daemon_serves_the_saved_catalog_without_launching_the_cli() {
        let temp = tempfile::tempdir().unwrap();
        let (binary, context, launches) = fake_cli(temp.path(), true);
        let file = temp.path().join("cache/claude-models.json");

        let first = Arc::new(ModelCatalog::persistent(file.clone())).models(&binary, &context).await.unwrap();
        assert_eq!(first[0].resolved_model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(launch_count(&launches), 1);

        let restarted = Arc::new(ModelCatalog::persistent(file)).models(&binary, &context).await.unwrap();
        assert_eq!(restarted, first);
        assert_eq!(launch_count(&launches), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_read_is_not_cached_and_is_not_retried_immediately() {
        let temp = tempfile::tempdir().unwrap();
        let (binary, context, launches) = fake_cli(temp.path(), false);
        let catalog = Arc::new(ModelCatalog::default());
        assert_eq!(catalog.models(&binary, &context).await, None);
        assert_eq!(catalog.models(&binary, &context).await, None);
        assert_eq!(launch_count(&launches), 1);
        assert!(catalog.lock().entries.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_account_refresh_bypasses_fresh_models_and_keeps_previous_good_on_failure() {
        let temp = tempfile::tempdir().unwrap();
        let (binary, context, launches) = fake_cli(temp.path(), true);
        let catalog = Arc::new(ModelCatalog::default());
        let key = CatalogKey::new(&binary, &context).unwrap();
        catalog.record(key, vec![model("old-model")]);
        assert_eq!(catalog.models(&binary, &context).await.unwrap()[0].value, "old-model");
        assert_eq!(launch_count(&launches), 0);
        let refreshed = catalog.refresh(&binary, &context).await.unwrap();
        assert_eq!(refreshed[0].value, "opus");
        assert_eq!(launch_count(&launches), 1);
        // The fake CLI's answer depends on its script, so use an account-specific
        // valid cached key with a CLI that exits without an initialize response.
        let failed_dir = tempfile::tempdir().unwrap();
        let (failed_binary, failed_context, _) = fake_cli(failed_dir.path(), false);
        let failed_key = CatalogKey::new(&failed_binary, &failed_context).unwrap();
        catalog.record(failed_key, vec![model("previous-good")]);
        assert_eq!(catalog.refresh(&failed_binary, &failed_context).await.unwrap()[0].value, "previous-good");
    }

    /// Claude Code refreshes an expiring login during startup, sometimes
    /// after it has already answered `initialize`. The probe must let it save
    /// the rotated tokens instead of killing it as soon as the models arrive.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_catalog_read_lets_claude_finish_saving_a_refreshed_login() {
        let temp = tempfile::tempdir().unwrap();
        let saved = temp.path().join("saved-login");
        let body = format!("read request\necho '{REPLY}'\nwhile read line; do :; done\nsleep 0.3\necho rotated > '{}'\n", saved.display());
        let (binary, context, launches) = fake_cli_running(temp.path(), &body);
        let models = Arc::new(ModelCatalog::default()).models(&binary, &context).await.unwrap();
        assert_eq!(models[0].value, "opus");
        assert_eq!(launch_count(&launches), 1);
        tokio::time::timeout(Duration::from_secs(4), async {
            while !saved.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the probe stopped Claude Code before it saved the refreshed login");
    }

    /// A stale entry is still usable, so it is not worth a background Claude
    /// Code startup that would rotate an expiring login. The next session or
    /// a later probe with a fresh login refreshes it.
    #[cfg(unix)]
    #[tokio::test]
    async fn stale_entries_are_not_refreshed_while_the_login_is_due_for_a_refresh() {
        let temp = tempfile::tempdir().unwrap();
        let (binary, context, launches) = fake_cli(temp.path(), true);
        let config = temp.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        let login = |expires_at: u128| {
            let credentials = json!({ "claudeAiOauth": { "accessToken": "a", "refreshToken": "r", "expiresAt": expires_at } });
            std::fs::write(config.join(".credentials.json"), credentials.to_string()).unwrap();
        };
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let catalog = Arc::new(ModelCatalog::default());
        catalog.record(CatalogKey::new(&binary, &context).unwrap(), vec![model("cached")]);
        catalog.lock().entries[0].fetched_at = 0;

        login(now - 1000);
        assert_eq!(catalog.models(&binary, &context).await.unwrap()[0].value, "cached");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(launch_count(&launches), 0);

        login(now + 8 * 60 * 60 * 1000);
        assert_eq!(catalog.models(&binary, &context).await.unwrap()[0].value, "cached");
        tokio::time::timeout(Duration::from_secs(3), async {
            while catalog.lock().entries[0].models[0].value != "opus" {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("a background refresh");
        assert_eq!(launch_count(&launches), 1);
    }
}
