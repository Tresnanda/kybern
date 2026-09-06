//! Claude Code's effective model and effort settings.
//!
//! Claude does not expose a `model/list` RPC like Codex. Its defaults are a
//! layered configuration problem, so probing must follow the same inputs the
//! spawned CLI receives instead of inventing an "auto" value.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;

use crate::ProbeContext;

const MODEL_ENV: &str = "ANTHROPIC_MODEL";
const DEFAULT_MODEL_ENV: &str = "ANTHROPIC_DEFAULT_MODEL";
const EFFORT_ENV: &str = "CLAUDE_CODE_EFFORT_LEVEL";

#[derive(Debug, Clone)]
pub(super) struct ClaudeConfig {
    /// Selector Claude Code will use (`fable[1m]`, `opus`, or a full id).
    pub model: String,
    /// Effective effort after environment, per-model, global, and model
    /// defaults have been applied.
    pub effort: String,
    /// A deployment-specific target for a family alias, when configured.
    pub alias_target: Option<String>,
    preferences: ClaudePreferences,
    environment_effort: Option<String>,
}

impl ClaudeConfig {
    pub fn effort_for(&self, model: &str) -> String {
        self.environment_effort
            .clone()
            .or_else(|| self.preferences.effort_for(model))
            .unwrap_or_else(|| model_default_effort(model).to_string())
    }
}

#[derive(Debug, Clone, Default)]
struct ClaudePreferences {
    model: Option<String>,
    effort_level: Option<String>,
    model_efforts: BTreeMap<String, String>,
}

impl ClaudePreferences {
    fn merge(&mut self, value: &Value) {
        if let Some(model) = non_empty_string(value.get("model")) {
            self.model = Some(model.to_string());
        }
        if let Some(effort) = value.get("effortLevel").and_then(Value::as_str).and_then(valid_effort) {
            self.effort_level = Some(effort.to_string());
        }
        if let Some(settings) = value.get("modelSettings").and_then(Value::as_object) {
            for (model, settings) in settings {
                if let Some(effort) = settings.get("effortLevel").and_then(Value::as_str).and_then(valid_effort) {
                    self.model_efforts.insert(model.to_ascii_lowercase(), effort.to_string());
                }
            }
        }
    }

    fn effort_for(&self, model: &str) -> Option<String> {
        model_lookup_keys(model).into_iter().find_map(|key| self.model_efforts.get(&key).cloned()).or_else(|| self.effort_level.clone())
    }
}

pub(super) async fn resolve(context: &ProbeContext, binary: &Path) -> ClaudeConfig {
    let preferences = load_preferences(context);
    let environment_model = environment_value(context, MODEL_ENV).and_then(non_empty_owned);
    let default_model = environment_value(context, DEFAULT_MODEL_ENV).and_then(non_empty_owned);
    let configured_model = environment_model.or_else(|| preferences.model.clone());
    let needs_account_default = configured_model.as_deref().is_none_or(is_default_selector) && default_model.is_none();
    let account_default = if needs_account_default { account_default_model(context, binary).await } else { None };
    let model = match configured_model {
        Some(model) if !is_default_selector(&model) => model,
        _ => default_model.or(account_default).unwrap_or_else(|| "sonnet".to_string()),
    };
    let environment_effort = environment_value(context, EFFORT_ENV).as_deref().and_then(valid_effort).map(str::to_string);
    let effort =
        environment_effort.clone().or_else(|| preferences.effort_for(&model)).unwrap_or_else(|| model_default_effort(&model).to_string());
    let alias_target = alias_target(context, &model);

    ClaudeConfig { model, effort, alias_target, preferences, environment_effort }
}

fn load_preferences(context: &ProbeContext) -> ClaudePreferences {
    let mut preferences = ClaudePreferences::default();
    for path in settings_paths(context) {
        let Ok(contents) = std::fs::read_to_string(&path) else { continue };
        match serde_json::from_str::<Value>(&contents) {
            Ok(value) => preferences.merge(&value),
            Err(error) => tracing::warn!(path = %path.display(), %error, "ignored invalid Claude Code settings"),
        }
    }
    preferences
}

fn settings_paths(context: &ProbeContext) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let config_dir =
        environment_value(context, "CLAUDE_CONFIG_DIR").filter(|value| !value.trim().is_empty()).map(PathBuf::from).or_else(|| {
            environment_value(context, "HOME").filter(|value| !value.trim().is_empty()).map(|home| PathBuf::from(home).join(".claude"))
        });
    if let Some(config_dir) = config_dir {
        paths.push(config_dir.join("settings.json"));
    }

    if let Some(cwd) = context.cwd.as_deref() {
        paths.push(cwd.join(".claude/settings.json"));
        paths.push(cwd.join(".claude/settings.local.json"));
        if let Some(root) = repository_root(cwd) {
            paths.push(root.join(".claude/settings.local.json"));
        }
    }

    if let Some(managed) = managed_settings_path(context) {
        paths.push(managed);
    }

    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    paths
}

fn repository_root(path: &Path) -> Option<&Path> {
    path.ancestors().find(|ancestor| ancestor.join(".git").exists())
}

fn managed_settings_path(context: &ProbeContext) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json"))
    } else if cfg!(target_os = "linux") {
        Some(PathBuf::from("/etc/claude-code/managed-settings.json"))
    } else if cfg!(target_os = "windows") {
        environment_value(context, "PROGRAMDATA").map(|root| PathBuf::from(root).join("ClaudeCode/managed-settings.json"))
    } else {
        None
    }
}

async fn account_default_model(context: &ProbeContext, binary: &Path) -> Option<String> {
    let mut command = Command::new(binary);
    command.args(["auth", "status", "--json"]).env_remove("NODE_OPTIONS");
    if let Some(cwd) = context.cwd.as_deref() {
        command.current_dir(cwd);
    }
    command.envs(&context.env);
    let output = tokio::time::timeout(Duration::from_secs(2), crate::process_tree::output(&mut command)).await.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    let status: Value = serde_json::from_slice(&output.stdout).ok()?;
    account_default_from_status(&status)
}

fn account_default_from_status(status: &Value) -> Option<String> {
    let provider = status.get("apiProvider").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    if provider.contains("foundry") {
        return Some("sonnet".into());
    }
    if provider.contains("bedrock") || provider.contains("vertex") || provider.contains("agent") {
        return Some("opus".into());
    }

    let subscription = status.get("subscriptionType").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    if matches!(subscription.as_str(), "max" | "enterprise" | "team_premium" | "team-premium") {
        return Some("opus".into());
    }
    if matches!(subscription.as_str(), "pro" | "team" | "team_standard" | "team-standard") {
        return Some("sonnet".into());
    }

    let auth_method = status.get("authMethod").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    (auth_method.contains("api") || provider.contains("firstparty") || provider.contains("first_party")).then(|| "opus".into())
}

fn alias_target(context: &ProbeContext, model: &str) -> Option<String> {
    let family = model_family(model)?;
    let key = match family {
        "fable" => "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "opus" => "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "sonnet" => "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "haiku" => "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        _ => return None,
    };
    environment_value(context, key).and_then(non_empty_owned)
}

fn model_family(model: &str) -> Option<&'static str> {
    let model = model.to_ascii_lowercase();
    ["fable", "opus", "sonnet", "haiku"].into_iter().find(|family| model == *family || model.starts_with(&format!("{family}[")))
}

fn model_lookup_keys(model: &str) -> Vec<String> {
    let lower = model.to_ascii_lowercase();
    let mut keys = vec![lower.clone()];
    if let Some(index) = lower.find('[') {
        keys.push(lower[..index].to_string());
    }
    keys
}

fn model_default_effort(model: &str) -> &'static str {
    if model.to_ascii_lowercase().contains("opus-4-7") { "xhigh" } else { "high" }
}

fn environment_value(context: &ProbeContext, key: &str) -> Option<String> {
    context.env.get(key).cloned().or_else(|| std::env::var(key).ok())
}

fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty())
}

fn non_empty_owned(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn valid_effort(value: &str) -> Option<&str> {
    let value = value.trim();
    matches!(value, "low" | "medium" | "high" | "xhigh" | "max").then_some(value)
}

fn is_default_selector(model: &str) -> bool {
    matches!(model.trim().to_ascii_lowercase().as_str(), "" | "default" | "inherit")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_user_project_local_and_managed_settings_in_precedence_order() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/settings.json"), r#"{"model":"sonnet","effortLevel":"low"}"#).unwrap();
        std::fs::write(project.join(".claude/settings.json"), r#"{"model":"opus","effortLevel":"medium"}"#).unwrap();
        std::fs::write(project.join(".claude/settings.local.json"), r#"{"model":"fable[1m]"}"#).unwrap();

        let context = ProbeContext {
            cwd: Some(project),
            env: BTreeMap::from([("HOME".into(), home.to_string_lossy().into_owned())]),
            ..ProbeContext::default()
        };
        let preferences = load_preferences(&context);

        assert_eq!(preferences.model.as_deref(), Some("fable[1m]"));
        assert_eq!(preferences.effort_for("fable[1m]").as_deref(), Some("medium"));
    }

    #[test]
    fn exact_and_context_family_effort_precede_the_global_effort() {
        let mut preferences = ClaudePreferences::default();
        preferences.merge(&serde_json::json!({
            "effortLevel": "medium",
            "modelSettings": { "fable": { "effortLevel": "xhigh" } }
        }));

        assert_eq!(preferences.effort_for("fable[1m]").as_deref(), Some("xhigh"));
        assert_eq!(preferences.effort_for("sonnet").as_deref(), Some("medium"));
    }

    #[test]
    fn account_type_resolves_claude_codes_documented_default_family() {
        assert_eq!(account_default_from_status(&serde_json::json!({ "subscriptionType": "max" })).as_deref(), Some("opus"));
        assert_eq!(account_default_from_status(&serde_json::json!({ "subscriptionType": "pro" })).as_deref(), Some("sonnet"));
        assert_eq!(account_default_from_status(&serde_json::json!({ "apiProvider": "foundry" })).as_deref(), Some("sonnet"));
        assert_eq!(account_default_from_status(&serde_json::json!({ "apiProvider": "bedrock" })).as_deref(), Some("opus"));
    }

    #[test]
    fn opus_4_7_keeps_its_exception_to_the_normal_high_default() {
        assert_eq!(model_default_effort("claude-opus-4-7"), "xhigh");
        assert_eq!(model_default_effort("fable[1m]"), "high");
    }
}
