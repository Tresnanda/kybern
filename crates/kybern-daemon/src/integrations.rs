use crate::state::AppState;
use anyhow::{Result, anyhow, bail};
use kybern_drivers::ProbeContext;
use kybern_protocol::{methods::*, *};

fn context(state: &AppState, project_id: ProjectId, provider: ProviderKind) -> Result<ProbeContext> {
    let project = state.store.project_get(project_id)?.ok_or_else(|| anyhow!("Project not found. Select another project."))?;
    let settings = state.settings.get().providers.get(&provider).cloned().unwrap_or_default();
    Ok(ProbeContext { binary: settings.binary.map(Into::into), cwd: Some(project.path.into()), env: settings.env })
}

pub async fn list(state: &AppState, params: IntegrationsListParams) -> Result<IntegrationsCatalog> {
    let context = context(state, params.project_id, params.provider)?;
    let mut catalog=match params.provider {
        ProviderKind::ClaudeCode=>kybern_drivers::claude_integrations::list(&context).await?,
        ProviderKind::Codex=>kybern_drivers::codex_integrations::list(&context).await?,
        _=>IntegrationsCatalog {items:vec![],warnings:vec!["This agent manages integrations through its own configuration. Kybern currently provides a native catalog for Claude Code and Codex.".into()]},
    };
    catalog.items.sort_by(|a, b| b.installed.cmp(&a.installed).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(catalog)
}

pub async fn change(state: &AppState, params: IntegrationChangeParams) -> Result<IntegrationChangeResult> {
    static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _gate = GATE.lock().await;
    let context = context(state, params.project_id, params.provider)?;
    match params.provider {
        ProviderKind::ClaudeCode if params.kind == IntegrationKind::Plugin => {
            Ok(kybern_drivers::claude_integrations::change(&context, &params.id, params.scope.as_deref(), params.action).await?)
        }
        ProviderKind::Codex => Ok(kybern_drivers::codex_integrations::change(&context, &params.id, params.kind, params.action).await?),
        _ => bail!("This agent does not support this integration action."),
    }
}

pub async fn login(state: &AppState, params: IntegrationLoginParams) -> Result<TerminalInfo> {
    let thread = state.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
    if thread.provider.kind != ProviderKind::ClaudeCode {
        bail!("Open this connector's setup page to sign in.");
    }
    let mut context = context(state, thread.project_id, thread.provider.kind)?;
    context.cwd = Some(thread.cwd.clone().into());
    let catalog = kybern_drivers::claude_integrations::list(&context).await?;
    if !catalog.items.iter().any(|item| item.kind == IntegrationKind::Connector && item.id == params.name && item.can_login) {
        bail!("This connection no longer needs sign-in or is unavailable. Refresh the catalog.");
    }
    let binary = kybern_drivers::binary::resolve(ProviderKind::ClaudeCode, context.binary.as_ref())?;
    let command =
        vec![binary.to_string_lossy().into_owned(), "mcp".into(), "login".into(), "--no-browser".into(), "--".into(), params.name];
    // A real PTY retains Claude's redirect-paste flow on a remote phone too.
    Ok(state.terminals.create_with_env(None, Some(thread.id), thread.cwd, 100, 30, Some(command), &context.env)?.info())
}
