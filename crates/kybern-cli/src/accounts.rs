//! `kybern accounts`: identity-aware listing and the browser sign-in flow.

use std::io::Write;
use std::time::Duration;

use anyhow::{Result, anyhow};
use clap::ValueEnum;
use kybern_client::Client;
use kybern_protocol::methods::*;
use kybern_protocol::*;

#[derive(Clone, Copy, PartialEq, ValueEnum)]
pub enum LoginModeArg {
    Browser,
    Paste,
    DeviceCode,
    Terminal,
}

impl From<LoginModeArg> for AccountLoginMode {
    fn from(mode: LoginModeArg) -> Self {
        match mode {
            LoginModeArg::Browser => AccountLoginMode::Browser,
            LoginModeArg::Paste => AccountLoginMode::Paste,
            LoginModeArg::DeviceCode => AccountLoginMode::DeviceCode,
            LoginModeArg::Terminal => AccountLoginMode::Terminal,
        }
    }
}

fn status_text(status: AccountStatus) -> &'static str {
    match status {
        AccountStatus::SignedIn => "signed in",
        AccountStatus::NeedsSignIn => "needs sign-in",
        AccountStatus::SignedOut => "signed out",
        AccountStatus::Unknown => "unknown",
    }
}

pub fn render_list(accounts: &[AccountSummary]) {
    for account in accounts {
        let identity = account.identity.as_ref();
        let email = identity.and_then(|identity| identity.email.as_deref()).unwrap_or("email unavailable");
        let plan = identity.and_then(|identity| identity.plan.as_deref());
        let mut line = format!("{:<38} {}", account.provider.instance, account.name);
        if account.is_default {
            line.push_str(" (default)");
        }
        line.push_str(&format!("  {email}"));
        if let Some(plan) = plan {
            line.push_str(&format!(" · {plan}"));
        }
        if account.provider.instance == "default" {
            line.push_str(" · Same as your terminal");
        }
        line.push_str(&format!("  [{}]", status_text(account.status)));
        if let Some(color) = &account.color {
            line.push_str(&format!("  {color}"));
        }
        println!("{line}");
    }
}

fn prompt(label: &str) -> Result<String> {
    print!("{label}");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

fn describe(login: &AccountLogin) {
    if let Some(url) = &login.url {
        println!("Open this page to sign in:\n{url}");
    }
    if let Some(code) = &login.user_code {
        println!("Enter this one-time code: {code}");
    }
}

/// Run a sign-in to the end: print the page or code, read a pasted code when
/// asked, then offer the suggested name. Ctrl-C cancels the login, which
/// deletes its staging folder on the daemon.
pub async fn login(
    client: &Client,
    kind: ProviderKind,
    account: Option<String>,
    mode: LoginModeArg,
    directory: Option<String>,
    upstream: Option<String>,
) -> Result<()> {
    let mut login = client
        .call::<AccountsLoginStart>(AccountLoginStartParams { kind, instance: account.clone(), mode: mode.into(), directory, upstream })
        .await?;
    let id = login.id.clone();
    describe(&login);
    if let Some(terminal) = &login.terminal {
        println!("Finish in the terminal: terminal id {}", terminal.id);
    }
    let run = async {
        let mut printed = (login.url.clone(), login.user_code.clone());
        loop {
            match login.phase {
                AccountLoginPhase::SignedIn | AccountLoginPhase::Failed | AccountLoginPhase::Canceled => {
                    return Ok::<_, anyhow::Error>(login);
                }
                _ => {}
            }
            if mode == LoginModeArg::Paste && login.phase == AccountLoginPhase::Waiting && login.url.is_some() {
                let code = tokio::task::spawn_blocking(|| prompt("Paste the sign-in code: ")).await??;
                login = client.call::<AccountsLoginInput>(AccountLoginInputParams { id: id.clone(), code }).await?;
                if login.error.is_some() {
                    println!("{}", login.error.as_deref().unwrap_or_default());
                }
                continue;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
            login = client.call::<AccountsLoginGet>(AccountLoginIdParams { id: id.clone() }).await?;
            let now = (login.url.clone(), login.user_code.clone());
            if now != printed {
                describe(&login);
                printed = now;
            }
        }
    };
    let login = tokio::select! {
        done = run => done?,
        _ = tokio::signal::ctrl_c() => {
            let _ = client.call::<AccountsLoginCancel>(AccountLoginIdParams { id: id.clone() }).await;
            return Err(anyhow!("Sign-in canceled."));
        }
    };
    match login.phase {
        AccountLoginPhase::Failed => Err(anyhow!(login.error.unwrap_or_else(|| "Unable to sign in.".into()))),
        AccountLoginPhase::Canceled => Err(anyhow!("Sign-in canceled.")),
        _ => {
            let identity = login.identity.clone().unwrap_or_default();
            let who = identity.email.clone().map(|email| format!("Signed in as {email}")).unwrap_or_else(|| "Signed in".into());
            println!("{who}{}", identity.plan.map(|plan| format!(" ({plan})")).unwrap_or_default());
            if let Some(instance) = &login.instance {
                if let Some(old) = &login.previous_email {
                    println!("{instance} was {old}. It now uses {}.", identity.email.unwrap_or_default());
                }
                return Ok(());
            }
            if let Some(other) = &login.duplicate_of {
                println!(
                    "Already added as {other}. Run `kybern accounts login --provider {kind} --account {other}` to sign in again.",
                    kind = kind.as_str()
                );
                return Ok(());
            }
            let suggested = login.suggested_name.clone().unwrap_or_else(|| "Account".into());
            let typed = tokio::task::spawn_blocking(move || prompt(&format!("Name [{suggested}]: "))).await??;
            let name = if typed.is_empty() { login.suggested_name.clone().unwrap_or_else(|| "Account".into()) } else { typed };
            let instance = client
                .call::<AccountsLoginFinish>(AccountLoginFinishParams {
                    id: login.id.clone(),
                    name,
                    color: login.suggested_color.clone(),
                    make_default: false,
                })
                .await?;
            println!("{}", serde_json::to_string_pretty(&instance)?);
            Ok(())
        }
    }
}
