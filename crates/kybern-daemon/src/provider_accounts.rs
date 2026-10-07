//! Native account isolation. Default never changes the regular CLI's credentials.
use crate::state::AppState;
use anyhow::{Result, anyhow, ensure};
use kybern_protocol::{methods::*, *};
use std::{collections::BTreeMap, path::PathBuf};

pub fn resolve(settings: &ProviderSettings, project: Option<&str>, explicit: Option<&str>) -> String {
    explicit
        .or_else(|| project.and_then(|path| settings.project_accounts.get(path).map(String::as_str)))
        .or(settings.default_account.as_deref())
        .unwrap_or("default")
        .to_string()
}

pub fn environment(settings: &ProviderSettings, kind: ProviderKind, instance: &str) -> Result<BTreeMap<String, String>> {
    let mut env = settings.env.clone();
    if instance == "default" {
        return Ok(env);
    }
    let account = settings
        .accounts
        .get(instance)
        .ok_or_else(|| anyhow!("Account '{instance}' is unavailable. Choose another account in Settings."))?;
    let dir = PathBuf::from(&account.directory);
    ensure!(dir.is_absolute(), "Account directory must be absolute.");
    let path = |child: &str| dir.join(child).to_string_lossy().to_string();
    // A named native account must not be silently replaced by the regular
    // process/global provider API key. Empty overrides also suppress inherited
    // keys for native probes and PTY sign-in without altering the user's shell.
    let credentials: &[&str] = match kind {
        ProviderKind::ClaudeCode => &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
        ProviderKind::Codex => &["OPENAI_API_KEY", "CODEX_API_KEY"],
        ProviderKind::Cursor => &["CURSOR_API_KEY"],
        ProviderKind::Pi | ProviderKind::Omp | ProviderKind::Opencode => &[
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GROQ_API_KEY",
            "OPENROUTER_API_KEY",
            "MISTRAL_API_KEY",
            "XAI_API_KEY",
            "AI_GATEWAY_API_KEY",
            "CEREBRAS_API_KEY",
            "TOGETHER_API_KEY",
            "DEEPSEEK_API_KEY",
        ],
    };
    for key in credentials {
        env.insert((*key).into(), String::new());
    }
    match kind {
        ProviderKind::ClaudeCode => {
            env.insert("CLAUDE_CONFIG_DIR".into(), account.directory.clone());
        }
        ProviderKind::Codex => {
            env.insert("CODEX_HOME".into(), account.directory.clone());
        }
        ProviderKind::Cursor => {
            env.insert("KYBERN_CURSOR_AUTH_FILE".into(), path("auth.json"));
            env.insert("KYBERN_CURSOR_STATE_DIR".into(), path("sessions"));
        }
        ProviderKind::Pi => {
            env.insert("PI_CODING_AGENT_DIR".into(), account.directory.clone());
        }
        ProviderKind::Omp => {
            env.insert("PI_CODING_AGENT_DIR".into(), account.directory.clone());
            // Native named profiles ignore PI_CODING_AGENT_DIR. Select the
            // default profile inside this account root to keep credentials isolated.
            env.insert("OMP_PROFILE".into(), String::new());
        }
        ProviderKind::Opencode => {
            env.insert("XDG_DATA_HOME".into(), path("data"));
            env.insert("XDG_CONFIG_HOME".into(), path("config"));
            env.insert("XDG_STATE_HOME".into(), path("state"));
            env.insert("XDG_CACHE_HOME".into(), path("cache"));
        }
    }
    Ok(env)
}

pub fn validate(settings: &Settings) -> Result<()> {
    for (kind, provider) in &settings.providers {
        for (id, account) in &provider.accounts {
            ensure!(
                id != "default" && !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
                "Invalid account identity."
            );
            ensure!(!account.name.trim().is_empty() && account.name.len() <= 120, "Enter an account name up to 120 characters.");
            ensure!(PathBuf::from(&account.directory).is_absolute(), "{} account directory must be absolute.", kind.display_name());
        }
        for id in provider.default_account.iter().chain(provider.project_accounts.values()) {
            environment(provider, *kind, id)?;
        }
    }
    Ok(())
}

pub fn create(state: &AppState, params: AccountsCreateParams) -> Result<ProviderInstance> {
    ensure!(!params.name.trim().is_empty() && params.name.len() <= 120, "Enter an account name up to 120 characters.");
    let id = uuid::Uuid::now_v7().to_string();
    let directory = match params.directory {
        Some(directory) => {
            let path = PathBuf::from(directory);
            ensure!(path.is_absolute() && path.is_dir(), "Choose an existing absolute account directory.");
            path.canonicalize()?
        }
        None => state.settings.dir().join("accounts").join(params.kind.as_str()).join(&id),
    };
    let mut settings = state.settings.get();
    let provider = settings.providers.entry(params.kind).or_default();
    ensure!(
        !provider.accounts.values().any(|account| PathBuf::from(&account.directory) == directory),
        "This directory is already registered. Choose its existing account."
    );
    let created = !directory.exists();
    if created {
        std::fs::create_dir_all(&directory)?;
    }
    #[cfg(unix)]
    if created {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    provider
        .accounts
        .insert(id.clone(), ProviderAccount { name: params.name.trim().into(), directory: directory.to_string_lossy().into_owned() });
    if let Err(error) = state.settings.set(settings) {
        if created {
            let _ = std::fs::remove_dir(&directory);
        }
        return Err(error);
    }
    Ok(ProviderInstance { kind: params.kind, instance: id })
}

pub fn context(state: &AppState, instance: &ProviderInstance) -> Result<kybern_drivers::ProbeContext> {
    let settings = state.settings.get();
    let provider = settings.providers.get(&instance.kind).cloned().unwrap_or_default();
    Ok(kybern_drivers::ProbeContext {
        binary: provider.binary.clone().map(Into::into),
        cwd: Some(state.settings.dir().into()),
        env: environment(&provider, instance.kind, &instance.instance)?,
    })
}

pub fn sign_in(state: &AppState, instance: ProviderInstance) -> Result<TerminalInfo> {
    ensure!(instance.instance != "default", "The default uses your regular CLI login. Create a named account to sign in separately.");
    let context = context(state, &instance)?;
    let mut terminal_env = context.env.clone();
    let command = if instance.kind == ProviderKind::Cursor {
        let command = kybern_drivers::cursor::login_command(&context)?;
        let raw = command.as_std();
        for (key, value) in raw.get_envs() {
            if let Some(value) = value {
                terminal_env.insert(key.to_string_lossy().into_owned(), value.to_string_lossy().into_owned());
            }
        }
        std::iter::once(raw.get_program()).chain(raw.get_args()).map(|arg| arg.to_string_lossy().into_owned()).collect()
    } else {
        let binary = kybern_drivers::binary::resolve(instance.kind, context.binary.as_ref())?;
        let args: &[&str] = match instance.kind {
            ProviderKind::ClaudeCode => &["auth", "login"],
            ProviderKind::Codex => &["login"],
            ProviderKind::Opencode => &["auth", "login"],
            // Interactive native /login selects the upstream provider.
            ProviderKind::Pi => &[],
            ProviderKind::Omp => &["auth-broker", "login"],
            ProviderKind::Cursor => unreachable!(),
        };
        std::iter::once(binary.to_string_lossy().into_owned()).chain(args.iter().map(|s| s.to_string())).collect()
    };
    let terminal = state.terminals.create_with_env(
        None,
        None,
        state.settings.dir().to_string_lossy().into_owned(),
        100,
        30,
        Some(command),
        &terminal_env,
    )?;
    if instance.kind == ProviderKind::Pi {
        terminal.write(b"/login\r")?;
    }
    Ok(terminal.info())
}

pub async fn catalog(state: &AppState, params: AccountsCatalogParams) -> Result<ProviderStatus> {
    let mut context = context(state, &params.provider)?;
    if let Some(project_id) = params.project_id {
        context.cwd = Some(state.store.project_get(project_id)?.ok_or_else(|| anyhow!("Project not found."))?.path.into());
    }
    let cache_key = serde_json::to_string(&(params.provider.clone(), &context.env, &context.cwd, &context.binary))?;
    let driver = state.drivers.get(params.provider.kind).ok_or_else(|| anyhow!("Harness is unavailable."))?;
    let mut statuses = state
        .provider_catalogs
        .get_or_refresh(cache_key, params.force_refresh, || async move { vec![driver.probe_with_context(&context).await] })
        .await;
    let mut status = statuses.remove(0);
    let settings = state.settings.get();
    status.instances = std::iter::once("default".to_string())
        .chain(settings.providers.get(&params.provider.kind).into_iter().flat_map(|p| p.accounts.keys().cloned()))
        .collect();
    Ok(status)
}

pub async fn usage(state: &AppState, instance: ProviderInstance) -> Result<ProviderUsage> {
    let context = context(state, &instance)?;
    let cwd = context.cwd.as_deref().unwrap();
    let limits = match instance.kind {
        ProviderKind::ClaudeCode => {
            kybern_drivers::claude::read_account_usage(cwd, context.binary.as_ref(), &context.env).await.ok().map(|(limits, _)| limits)
        }
        ProviderKind::Codex => kybern_drivers::codex::read_account_limits(cwd, context.binary.as_ref(), &context.env).await,
        ProviderKind::Cursor => kybern_drivers::cursor::usage::read_account_usage(&context.env).await.map(|usage| usage.limits),
        _ => None,
    };
    Ok(ProviderUsage { limits, ..Default::default() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn precedence_and_default_isolation() {
        let mut p = ProviderSettings::default();
        p.default_account = Some("work".into());
        p.project_accounts.insert("/project".into(), "project".into());
        assert_eq!(resolve(&p, Some("/project"), Some("thread")), "thread");
        assert_eq!(resolve(&p, Some("/project"), None), "project");
        assert_eq!(resolve(&p, None, None), "work");
        assert_eq!(environment(&p, ProviderKind::ClaudeCode, "default").unwrap(), p.env);
        p.accounts.insert("work".into(), ProviderAccount { name: "Work".into(), directory: "/isolated".into() });
        let claude = environment(&p, ProviderKind::ClaudeCode, "work").unwrap();
        assert_eq!(claude["CLAUDE_CONFIG_DIR"], "/isolated");
        assert!(!claude.contains_key("HOME"));
        let cursor = environment(&p, ProviderKind::Cursor, "work").unwrap();
        assert_eq!(cursor["KYBERN_CURSOR_AUTH_FILE"], "/isolated/auth.json");
        assert_eq!(cursor["KYBERN_CURSOR_STATE_DIR"], "/isolated/sessions");
        assert!(environment(&p, ProviderKind::Codex, "missing").is_err());
    }
}

#[cfg(test)]
mod native_environment_tests {
    use super::*;
    #[test]
    fn named_native_process_does_not_inherit_regular_cli_api_credentials() {
        let mut provider = ProviderSettings::default();
        provider.env.insert("CURSOR_API_KEY".into(), "regular-cli-sentinel".into());
        provider.accounts.insert("work".into(), ProviderAccount { name: "Work".into(), directory: "/scratch-work-account".into() });
        let named = environment(&provider, ProviderKind::Cursor, "work").unwrap();
        let output = std::process::Command::new("/usr/bin/env")
            .env_clear()
            .env("CURSOR_API_KEY", "inherited-cli-sentinel")
            .envs(&named)
            .output()
            .unwrap();
        let captured = String::from_utf8(output.stdout).unwrap();
        assert!(!captured.contains("regular-cli-sentinel"));
        assert!(!captured.contains("inherited-cli-sentinel"));
        assert!(captured.contains("KYBERN_CURSOR_AUTH_FILE=/scratch-work-account/auth.json"));
        assert_eq!(environment(&provider, ProviderKind::Cursor, "default").unwrap()["CURSOR_API_KEY"], "regular-cli-sentinel");
    }
}
