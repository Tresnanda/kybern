use kybern_protocol::process::NoWindow;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use kybern_protocol::ProviderModel;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;

use crate::{DriverError, ProbeContext, Result};

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Discovery {
    pub models: Vec<ProviderModel>,
}

/// How long a finished probe gets to exit on its own once its input is closed.
const STOP_GRACE: Duration = Duration::from_secs(2);

/// Ask Pi for the effective model catalog in the supplied project and environment.
///
/// `--no-session` keeps this probe out of the user's session history. `--offline` skips
/// Pi's startup catalog refresh: that refresh renews an expired OAuth login, and a probe
/// that is stopped as soon as it has its answers can lose the renewed token. The process
/// lives in its own process group so cancellation and timeouts also stop descendants
/// launched by extensions.
///
/// Pi reads its input only after extensions' `session_start`, so a startup dialog (an MCP
/// adapter asking to approve a project server) can never be answered. The probe then
/// runs again with `--no-approve`, which leaves the folder's own resources unloaded.
pub(super) async fn discover(bin: &Path, context: &ProbeContext) -> Result<Discovery> {
    discover_with_timeout(bin, context, DISCOVERY_TIMEOUT).await
}

async fn discover_with_timeout(bin: &Path, context: &ProbeContext, timeout: Duration) -> Result<Discovery> {
    // Without a project the probe would run extensions in whatever folder the daemon
    // started in. Give it an empty one of its own.
    let private = match &context.cwd {
        Some(_) => None,
        None => Some(PrivateDir::create()?),
    };
    let cwd = context.cwd.as_deref().or(private.as_ref().map(|dir| dir.0.as_path()));
    match discover_once(bin, context, cwd, &[], timeout).await {
        Err(Failure { error, startup_blocked: true }) => {
            tracing::debug!(%error, "Pi model discovery was blocked at startup; retrying without project resources");
            discover_once(bin, context, cwd, &["--no-approve"], timeout).await.map_err(|failure| failure.error)
        }
        result => result.map_err(|failure| failure.error),
    }
}

/// An empty folder only this probe knows. `create_dir` fails on an existing path,
/// so a planted symlink or folder cannot be adopted.
struct PrivateDir(std::path::PathBuf);

impl PrivateDir {
    fn create() -> std::io::Result<Self> {
        let path = std::env::temp_dir().join(format!("kybern-pi-probe-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for PrivateDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Failure {
    error: DriverError,
    /// Pi stopped before it could answer, or asked something nobody can answer yet.
    startup_blocked: bool,
}

impl From<DriverError> for Failure {
    fn from(error: DriverError) -> Self {
        Self { error, startup_blocked: false }
    }
}

async fn discover_once(
    bin: &Path,
    context: &ProbeContext,
    cwd: Option<&Path>,
    extra_args: &[&str],
    timeout: Duration,
) -> std::result::Result<Discovery, Failure> {
    let mut command = crate::binary::command(bin).no_window();
    // Preserve Pi's saved/default project-trust policy. In RPC mode an
    // undecided project is safely probed without loading its local resources.
    command.args(["--mode", "rpc", "--no-session", "--offline"]).args(extra_args);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    for (key, value) in &context.env {
        command.env(key, value);
    }
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command.spawn().map_err(DriverError::from)?;
    let tree = crate::process_tree::ProcessTree::new(child.id().expect("spawned Pi discovery process"));
    let mut stdin = child.stdin.take().ok_or_else(|| DriverError::Protocol("Pi RPC discovery did not provide stdin".into()))?;
    let stdout = child.stdout.take().ok_or_else(|| DriverError::Protocol("Pi RPC discovery did not provide stdout".into()))?;
    let mut lines = BufReader::new(stdout).lines();

    let exchange = async {
        // A write fails when Pi already exited at startup.
        let blocked = |error| Failure { error, startup_blocked: true };
        write_command(&mut stdin, &json!({ "type": "get_state" })).await.map_err(blocked)?;
        let state = read_response(&mut lines, &mut stdin, "get_state").await?;
        write_command(&mut stdin, &json!({ "type": "get_available_models" })).await.map_err(blocked)?;
        let available = read_response(&mut lines, &mut stdin, "get_available_models").await?;
        parse_discovery(&state, &available).map_err(Failure::from)
    };
    match tokio::time::timeout(timeout, exchange).await {
        Ok(Ok(discovery)) => {
            stop_gracefully(child, stdin, tree).await;
            Ok(discovery)
        }
        failure => {
            // No answer to protect: stop now, descendants included.
            drop(stdin);
            let _ = child.kill().await;
            drop(tree);
            match failure {
                Ok(Err(failure)) => Err(failure),
                Ok(Ok(_)) => unreachable!("handled above"),
                Err(_) => {
                    Err(DriverError::Protocol(format!("Pi model discovery timed out after {} milliseconds", timeout.as_millis())).into())
                }
            }
        }
    }
}

/// End of input first, which is how Pi stops on its own; then SIGTERM; a kill only when
/// both were ignored. Pi may still be writing a refreshed login when the answers arrive.
async fn stop_gracefully(mut child: tokio::process::Child, stdin: ChildStdin, tree: crate::process_tree::ProcessTree) {
    drop(stdin);
    if tokio::time::timeout(STOP_GRACE, child.wait()).await.is_ok() {
        // Extensions' own children may outlive Pi; the tree's drop signals and reaps them.
        drop(tree);
        return;
    }
    tree.terminate();
    if tokio::time::timeout(crate::process_tree::TERMINATE_GRACE, child.wait()).await.is_err() {
        tree.kill_now();
        let _ = child.kill().await;
    }
}

async fn write_command(stdin: &mut ChildStdin, command: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(command).map_err(|error| DriverError::Protocol(error.to_string()))?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await?;
    stdin.flush().await?;
    Ok(())
}

async fn read_response(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    stdin: &mut ChildStdin,
    expected_command: &str,
) -> std::result::Result<Value, Failure> {
    loop {
        let line = lines.next_line().await.map_err(DriverError::from)?.ok_or_else(|| Failure {
            error: DriverError::Protocol(format!("Pi RPC exited before responding to {expected_command}")),
            startup_blocked: true,
        })?;
        let frame: Value = serde_json::from_str(&line).map_err(|error| {
            DriverError::Protocol(format!("Pi RPC returned malformed JSON while waiting for {expected_command}: {error}"))
        })?;

        if frame.get("type").and_then(Value::as_str) == Some("extension_ui_request") {
            handle_extension_request(stdin, &frame).await.map_err(|error| Failure { error, startup_blocked: true })?;
            continue;
        }
        if frame.get("type").and_then(Value::as_str) != Some("response")
            || frame.get("command").and_then(Value::as_str) != Some(expected_command)
        {
            continue;
        }
        if frame.get("success").and_then(Value::as_bool) != Some(true) {
            let detail = frame
                .get("error")
                .and_then(|error| error.as_str().or_else(|| error.get("message").and_then(Value::as_str)))
                .unwrap_or("unknown error");
            return Err(DriverError::Protocol(format!("Pi RPC {expected_command} failed: {detail}")).into());
        }
        return frame
            .get("data")
            .cloned()
            .ok_or_else(|| DriverError::Protocol(format!("Pi RPC {expected_command} response omitted data")).into());
    }
}

async fn handle_extension_request(stdin: &mut ChildStdin, frame: &Value) -> Result<()> {
    let Some(method) = frame.get("method").and_then(Value::as_str) else {
        return Ok(());
    };
    if !matches!(method, "select" | "confirm" | "input" | "editor") {
        return Ok(());
    }
    let id = frame
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| DriverError::Protocol(format!("Pi extension {method} request omitted its id")))?;
    write_command(stdin, &json!({ "type": "extension_ui_response", "id": id, "cancelled": true })).await?;
    let title = frame.get("title").and_then(Value::as_str).unwrap_or(method);
    Err(DriverError::Protocol(format!("Pi model discovery was cancelled because extension startup requested {method}: {title}")))
}

fn parse_discovery(state: &Value, available: &Value) -> Result<Discovery> {
    let default_model = state.get("model").and_then(model_selector);
    let configured_effort =
        state.get("thinkingLevel").and_then(Value::as_str).filter(|level| THINKING_LEVELS.contains(level)).map(str::to_string);
    let items = available
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| DriverError::Protocol("Pi RPC get_available_models response omitted models".into()))?;

    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for item in items {
        let Some(model) = parse_model(item, default_model.as_deref(), configured_effort.as_deref()) else {
            continue;
        };
        if !seen.insert(model.id.clone()) {
            continue;
        }
        models.push(model);
    }
    // A selected custom model can be omitted by an older catalog endpoint.
    // get_state returns the same full Model shape, so retain it as the native
    // default instead of leaving the catalog without a usable fallback.
    if !models.iter().any(|model| model.is_default)
        && let Some(model) = state.get("model").and_then(|model| parse_model(model, default_model.as_deref(), configured_effort.as_deref()))
        && seen.insert(model.id.clone())
    {
        models.push(model);
    }
    models.sort_by(|a, b| a.provider.cmp(&b.provider).then_with(|| a.display_name.cmp(&b.display_name)).then_with(|| a.id.cmp(&b.id)));

    Ok(Discovery { models })
}

fn parse_model(model: &Value, default_model: Option<&str>, configured_effort: Option<&str>) -> Option<ProviderModel> {
    let id = model_selector(model)?;
    let provider = model.get("provider").and_then(Value::as_str).map(str::trim).filter(|provider| !provider.is_empty()).map(str::to_string);
    let display_name = model.get("name").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()).unwrap_or(&id).to_string();
    let efforts = model_supported_efforts(model);
    let default_effort = effective_effort(configured_effort, &efforts);
    Some(ProviderModel {
        display_name,
        is_default: default_model == Some(id.as_str()),
        parameters: Vec::new(),
        variants: Vec::new(),
        id,
        resolved_id: None,
        description: None,
        provider,
        efforts,
        default_effort,
    })
}

/// Split `selector` into the provider and model id Pi reported for it. Both can
/// contain `/` (a provider such as `hub=https://host/v1`, a model such as
/// `openrouter/auto`), so the first slash alone does not tell them apart.
/// `available` is the answer to `get_available_models`.
pub(super) fn split_reported_selector(available: &Value, selector: &str) -> Option<(String, String)> {
    available.get("models")?.as_array()?.iter().find_map(|model| {
        let provider = model.get("provider").and_then(Value::as_str)?.trim();
        let id = model.get("id").and_then(Value::as_str)?.trim();
        (!provider.is_empty() && !id.is_empty() && format!("{provider}/{id}") == selector).then(|| (provider.to_string(), id.to_string()))
    })
}

fn model_selector(model: &Value) -> Option<String> {
    let provider = model.get("provider").and_then(Value::as_str)?.trim();
    let id = model.get("id").and_then(Value::as_str)?.trim();
    if provider.is_empty() || id.is_empty() {
        return None;
    }
    Some(format!("{provider}/{id}"))
}

/// Mirror Pi's advertised thinking ladder without guessing provider-specific
/// values. Base levels are available unless explicitly disabled with `null`;
/// `xhigh` and `max` must be explicitly enabled by the model's map.
pub(super) fn model_supported_efforts(model: &Value) -> Vec<String> {
    if model.get("reasoning").and_then(Value::as_bool) != Some(true) {
        return Vec::new();
    }
    let level_map = model.get("thinkingLevelMap").and_then(Value::as_object);
    THINKING_LEVELS
        .into_iter()
        .filter(|level| {
            let mapped = level_map.and_then(|map| map.get(*level));
            if mapped == Some(&Value::Null) {
                return false;
            }
            !matches!(*level, "xhigh" | "max") || mapped.is_some()
        })
        .map(str::to_string)
        .collect()
}

/// Clamp a configured Pi thinking level exactly as Pi does when a model omits
/// it: prefer the next supported higher level, then the nearest lower level.
pub(super) fn effective_effort(requested: Option<&str>, supported: &[String]) -> Option<String> {
    if supported.is_empty() {
        return None;
    }
    let requested = requested?;
    let index = THINKING_LEVELS.iter().position(|level| *level == requested)?;
    if supported.iter().any(|level| level == requested) {
        return Some(requested.to_string());
    }
    THINKING_LEVELS[index + 1..]
        .iter()
        .chain(THINKING_LEVELS[..index].iter().rev())
        .find(|candidate| supported.iter().any(|level| level == **candidate))
        .map(|level| (*level).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_models_defaults_and_actual_thinking_capabilities() {
        let state = json!({
            "model": { "provider": "custom", "id": "deep-model" },
            "thinkingLevel": "max"
        });
        let available = json!({ "models": [
            {
                "provider": "plain",
                "id": "chat-only",
                "name": "Chat only",
                "reasoning": false,
                "thinkingLevelMap": { "max": "max" }
            },
            {
                "provider": "custom",
                "id": "deep-model",
                "name": "Locally configured Deep Model",
                "reasoning": true,
                "thinkingLevelMap": {
                    "off": null,
                    "minimal": null,
                    "medium": null,
                    "xhigh": "extra_high",
                    "max": null
                },
                "customProviderField": true
            },
            { "provider": "custom", "id": "deep-model", "name": "duplicate" },
            { "provider": "broken" },
            "malformed"
        ] });

        let discovery = parse_discovery(&state, &available).unwrap();
        assert_eq!(discovery.models.len(), 2);
        let custom = discovery.models.iter().find(|model| model.id == "custom/deep-model").unwrap();
        assert_eq!(custom.display_name, "Locally configured Deep Model");
        assert_eq!(custom.efforts, ["low", "high", "xhigh"]);
        assert_eq!(custom.default_effort.as_deref(), Some("xhigh"));
        assert!(custom.is_default);
        let plain = discovery.models.iter().find(|model| model.id == "plain/chat-only").unwrap();
        assert!(plain.efforts.is_empty());
        assert_eq!(plain.default_effort, None);
    }

    #[test]
    fn thinking_map_defaults_base_levels_and_can_disable_each_one() {
        assert_eq!(model_supported_efforts(&json!({ "reasoning": true })), ["off", "minimal", "low", "medium", "high"]);
        assert_eq!(
            model_supported_efforts(&json!({
                "reasoning": true,
                "thinkingLevelMap": { "off": null, "low": null, "xhigh": "x", "max": "m" }
            })),
            ["minimal", "medium", "high", "xhigh", "max"]
        );
        assert!(model_supported_efforts(&json!({ "reasoning": false })).is_empty());
        assert!(model_supported_efforts(&json!({ "reasoning": "yes" })).is_empty());
    }

    #[test]
    fn malformed_catalog_is_a_discovery_error() {
        let error = parse_discovery(&json!({}), &json!({ "models": "nope" })).unwrap_err();
        assert!(error.to_string().contains("omitted models"));
    }

    #[test]
    fn retains_the_configured_model_when_the_catalog_omits_it() {
        let state = json!({
            "model": {
                "provider": "local",
                "id": "custom-model",
                "name": "Custom model",
                "reasoning": true,
                "thinkingLevelMap": { "medium": null }
            },
            "thinkingLevel": "medium"
        });
        let discovery = parse_discovery(&state, &json!({ "models": [] })).unwrap();

        assert_eq!(discovery.models.len(), 1);
        assert_eq!(discovery.models[0].id, "local/custom-model");
        assert!(discovery.models[0].is_default);
        assert_eq!(discovery.models[0].default_effort.as_deref(), Some("high"));
    }

    #[cfg(unix)]
    fn executable_script(contents: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fake-pi");
        kybern_protocol::process::write_executable(&path, contents).unwrap();
        (directory, path)
    }

    /// Linux refuses to run a file that another test's freshly forked child
    /// still holds open for writing (ETXTBSY) until that child execs. Retry.
    #[cfg(unix)]
    async fn discover_fixture(binary: &std::path::Path, context: &ProbeContext) -> Result<Discovery> {
        for _ in 0..50 {
            match discover(binary, context).await {
                Err(error) if error.to_string().contains("Text file busy") => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await
                }
                result => return result,
            }
        }
        discover(binary, context).await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rpc_probe_is_ephemeral_and_uses_project_context() {
        let (directory, binary) = executable_script(
            r###"#!/bin/sh
[ "$1" = "--mode" ] && [ "$2" = "rpc" ] && [ "$3" = "--no-session" ] && [ "$4" = "--offline" ] && [ "$#" = 4 ] || exit 9
IFS= read -r state_request
[ "$state_request" = '{"type":"get_state"}' ] || exit 6
printf '%s\n' '{"type":"response","command":"get_state","success":true,"data":{"model":{"provider":"custom","id":"from-context"},"thinkingLevel":"medium"}}'
IFS= read -r models_request
[ "$models_request" = '{"type":"get_available_models"}' ] || exit 5
printf '{"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"custom","id":"%s","name":"%s","reasoning":true}]}}\n' "$PI_DISCOVERY_FIXTURE" "$(pwd)"
"###,
        );
        let mut context = ProbeContext { cwd: Some(directory.path().to_path_buf()), ..ProbeContext::default() };
        context.env.insert("PI_DISCOVERY_FIXTURE".into(), "from-context".into());

        let discovery = discover_fixture(&binary, &context).await.unwrap();
        assert_eq!(discovery.models.len(), 1);
        assert_eq!(discovery.models[0].id, "custom/from-context");
        assert_eq!(discovery.models[0].display_name, directory.path().canonicalize().unwrap().display().to_string());
        assert!(discovery.models[0].is_default);
        assert_eq!(discovery.models[0].default_effort.as_deref(), Some("medium"));
        assert!(!directory.path().join("session.jsonl").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_dialog_is_cancelled_without_approval_and_reported() {
        let (_directory, binary) = executable_script(
            r###"#!/bin/sh
IFS= read -r state_request
printf '%s\n' '{"type":"extension_ui_request","id":"startup-1","method":"confirm","title":"Trust extension?"}'
IFS= read -r answer
case "$answer" in *'"type":"extension_ui_response"'*'"id":"startup-1"'*'"cancelled":true'*) exit 0 ;; *) exit 4 ;; esac
"###,
        );

        let error = discover_fixture(&binary, &ProbeContext::default()).await.unwrap_err();
        assert!(error.to_string().contains("Trust extension?"));
    }

    /// Pi's startup catalog refresh renews an expired OAuth login; without `--offline`
    /// a probe stopped as soon as it has its answers can lose the renewed token.
    #[cfg(unix)]
    #[tokio::test]
    async fn probe_stops_by_closing_input_so_pi_can_finish_saving() {
        let (directory, binary) = executable_script(
            r###"#!/bin/sh
IFS= read -r state_request
printf '%s\n' '{"type":"response","command":"get_state","success":true,"data":{}}'
IFS= read -r models_request
printf '%s\n' '{"type":"response","command":"get_available_models","success":true,"data":{"models":[]}}'
# Like Pi: finish writing the renewed login once input ends, then exit.
while IFS= read -r line; do :; done
sleep 0.4
touch saved
"###,
        );
        let context = ProbeContext { cwd: Some(directory.path().to_path_buf()), ..ProbeContext::default() };

        discover_fixture(&binary, &context).await.unwrap();
        assert!(directory.path().join("saved").exists(), "the probe was stopped before Pi finished saving");
    }

    /// Pi reads input only after session_start, so a startup dialog cannot be answered:
    /// the probe has to ask again without the folder's own resources.
    #[cfg(unix)]
    #[tokio::test]
    async fn blocked_startup_is_retried_without_project_resources() {
        let (directory, binary) = executable_script(
            r###"#!/bin/sh
case " $* " in
  *" --no-approve "*) ;;
  *) printf '%s\n' '{"type":"extension_ui_request","id":"startup-1","method":"confirm","title":"Approve project server?"}'; IFS= read -r answer; exit 0 ;;
esac
IFS= read -r state_request
printf '%s\n' '{"type":"response","command":"get_state","success":true,"data":{"model":{"provider":"p","id":"m"}}}'
IFS= read -r models_request
printf '%s\n' '{"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"p","id":"m","name":"M"}]}}'
"###,
        );
        let context = ProbeContext { cwd: Some(directory.path().to_path_buf()), ..ProbeContext::default() };

        let discovery = discover_fixture(&binary, &context).await.unwrap();
        assert_eq!(discovery.models.len(), 1);
        assert_eq!(discovery.models[0].id, "p/m");
    }

    /// Without a project the probe must not run extensions in the daemon's own folder.
    #[cfg(unix)]
    #[tokio::test]
    async fn probe_without_a_project_runs_in_its_own_empty_folder() {
        let (_directory, binary) = executable_script(
            r###"#!/bin/sh
IFS= read -r state_request
printf '%s\n' '{"type":"response","command":"get_state","success":true,"data":{}}'
IFS= read -r models_request
printf '{"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"p","id":"m","name":"%s"}]}}\n' "$(pwd)"
"###,
        );

        let discovery = discover_fixture(&binary, &ProbeContext::default()).await.unwrap();
        let folder = std::path::PathBuf::from(&discovery.models[0].display_name);
        assert_ne!(folder, std::env::current_dir().unwrap().canonicalize().unwrap());
        assert!(folder.file_name().unwrap().to_string_lossy().starts_with("kybern-pi-probe-"), "{folder:?}");
        assert!(!folder.exists(), "the private folder is removed after the probe");
    }

    #[test]
    fn selectors_split_where_pi_reports_the_provider_to_end() {
        let available = json!({ "models": [
            { "provider": "openrouter", "id": "openrouter/auto" },
            { "provider": "hub=https://hub.example:8318/v1", "id": "claude-haiku-4-5" },
            { "provider": "anthropic", "id": "claude" },
        ] });
        let split = |selector| split_reported_selector(&available, selector);
        assert_eq!(split("openrouter/openrouter/auto"), Some(("openrouter".into(), "openrouter/auto".into())));
        assert_eq!(
            split("hub=https://hub.example:8318/v1/claude-haiku-4-5"),
            Some(("hub=https://hub.example:8318/v1".into(), "claude-haiku-4-5".into()))
        );
        assert_eq!(split("anthropic/claude"), Some(("anthropic".into(), "claude".into())));
        assert_eq!(split("unknown/model"), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn malformed_rpc_frame_is_reported() {
        let (_directory, binary) = executable_script(
            r###"#!/bin/sh
IFS= read -r state_request
printf '%s\n' 'not-json'
"###,
        );

        let error = discover_fixture(&binary, &ProbeContext::default()).await.unwrap_err();
        assert!(error.to_string().contains("malformed JSON"));
        assert!(error.to_string().contains("get_state"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_extension_descendants() {
        let (directory, binary) = executable_script(
            r###"#!/bin/sh
(sleep 0.3; touch escaped) &
sleep 10
"###,
        );
        let context = ProbeContext { cwd: Some(directory.path().to_path_buf()), ..ProbeContext::default() };

        let error = discover_with_timeout(&binary, &context, Duration::from_millis(40)).await.unwrap_err();
        assert!(error.to_string().contains("timed out after 40 milliseconds"));
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!directory.path().join("escaped").exists());
    }
}
