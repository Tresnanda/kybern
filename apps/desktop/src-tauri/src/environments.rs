//! Saved client environments. Metadata is separate from daemon data; device
//! credentials live in the OS credential store and never in the registry.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use kybern_client::{Client, Endpoint, address};
use kybern_protocol::methods::{DaemonInfoMethod, Empty, PairRequest, PairResponse};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::EndpointInfo;
use crate::remote::{self, SshConfig};

const LOCAL: &str = "local";
const SERVICE: &str = "dev.kybern.desktop.environments";
static REGISTRY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvironmentProfile {
    pub id: String,
    pub name: String,
    pub url: Option<String>,
    pub environment_id: Option<String>,
    pub hostname: Option<String>,
    pub local: bool,
    /// Present for machines reached through an SSH tunnel that Kybern manages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConfig>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvironmentRegistry {
    pub selected_id: String,
    pub environments: Vec<EnvironmentProfile>,
}

impl Default for EnvironmentRegistry {
    fn default() -> Self {
        Self { selected_id: LOCAL.into(), environments: vec![] }
    }
}

#[derive(Serialize)]
pub struct EnvironmentEndpoint {
    pub profile: EnvironmentProfile,
    pub endpoint: EndpointInfo,
}

#[derive(Deserialize)]
pub struct SaveEnvironment {
    pub id: Option<String>,
    pub name: String,
    pub url: String,
    pub code: Option<String>,
    pub expected_environment_id: Option<String>,
    pub token: Option<String>,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
}

fn local_profile() -> EnvironmentProfile {
    let external = std::env::var("KYBERN_URL").ok();
    EnvironmentProfile {
        id: LOCAL.into(),
        name: if external.is_some() {
            "Configured environment"
        } else if cfg!(target_os = "macos") {
            "This Mac"
        } else {
            "This computer"
        }
        .into(),
        local: external.is_none(),
        url: external,
        environment_id: None,
        hostname: None,
        ssh: None,
    }
}

fn registry_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf> {
    let root = match std::env::var_os("KYBERN_CLIENT_CONFIG_DIR") {
        Some(path) => PathBuf::from(path),
        None => app.path().app_config_dir()?,
    };
    Ok(root.join("environments.json"))
}

fn read_registry(path: &Path) -> Result<EnvironmentRegistry> {
    let mut registry: EnvironmentRegistry = match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).context("Read saved environments; restore environments.json from a backup if it is damaged")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => EnvironmentRegistry::default(),
        Err(e) => return Err(e.into()),
    };
    registry.environments.retain(|profile| profile.id != LOCAL);
    if registry.selected_id != LOCAL && !registry.environments.iter().any(|p| p.id == registry.selected_id) {
        registry.selected_id = LOCAL.into();
    }
    Ok(registry)
}

fn write_registry(path: &Path, registry: &EnvironmentRegistry) -> Result<()> {
    std::fs::create_dir_all(path.parent().context("Environment registry has no parent")?)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::now_v7()));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(registry)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result.context("Save environment settings")
}

fn credential(id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, id).context("Open the system credential store")
}

fn read_token(id: &str) -> Result<String> {
    credential(id)?.get_password().context("Unlock the system credential store or pair this environment again")
}

fn resolve_profile(registry: &EnvironmentRegistry, id: &str) -> Result<EnvironmentProfile> {
    if id == LOCAL {
        return Ok(local_profile());
    }
    registry.environments.iter().find(|p| p.id == id).cloned().context("This environment was removed; choose another environment")
}

#[tauri::command]
pub async fn environments_list<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<EnvironmentRegistry, String> {
    let _guard = REGISTRY_LOCK.lock().await;
    let result = (|| -> Result<_> {
        let mut registry = read_registry(&registry_path(&app)?)?;
        registry.environments.insert(0, local_profile());
        Ok(registry)
    })();
    result.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn environment_open<R: tauri::Runtime>(app: tauri::AppHandle<R>, id: String) -> Result<EnvironmentEndpoint, String> {
    async fn inner<R: tauri::Runtime>(app: tauri::AppHandle<R>, id: String) -> Result<EnvironmentEndpoint> {
        let mut profile = {
            let _guard = REGISTRY_LOCK.lock().await;
            resolve_profile(&read_registry(&registry_path(&app)?)?, &id)?
        };
        let endpoint = if id == LOCAL {
            let endpoint = crate::endpoint().await.map_err(anyhow::Error::msg)?;
            let info = tokio::time::timeout(Duration::from_secs(15), async {
                let client = Client::connect(&Endpoint { url: endpoint.url.clone(), token: endpoint.token.clone() }).await?;
                client.call::<DaemonInfoMethod>(Empty {}).await
            })
            .await
            .context("The local environment is taking too long to start; retry the connection")??;
            crate::ensure_compatible(&info)?;
            profile.environment_id = Some(info.environment_id);
            profile.hostname = Some(info.hostname);
            endpoint
        } else {
            let token = tokio::task::spawn_blocking({
                let id = id.clone();
                move || read_token(&id)
            })
            .await??;
            let url = if let Some(ssh) = &profile.ssh {
                let port = remote::ensure_tunnel(&id, ssh).await?;
                let url = format!("ws://127.0.0.1:{port}/ws");
                if port != ssh.local_port || profile.url.as_deref() != Some(&url) {
                    let _guard = REGISTRY_LOCK.lock().await;
                    let path = registry_path(&app)?;
                    let mut registry = read_registry(&path)?;
                    if let Some(saved) = registry.environments.iter_mut().find(|p| p.id == id) {
                        saved.url = Some(url.clone());
                        if let Some(saved_ssh) = &mut saved.ssh {
                            saved_ssh.local_port = port;
                        }
                        write_registry(&path, &registry)?;
                    }
                    profile.url = Some(url.clone());
                    if let Some(profile_ssh) = &mut profile.ssh {
                        profile_ssh.local_port = port;
                    }
                }
                url
            } else {
                profile.url.clone().context("This environment has no address; edit it and reconnect")?
            };
            EndpointInfo { http_base: address::http_base(&url)?, url, token, spawned: false }
        };
        Ok(EnvironmentEndpoint { profile, endpoint })
    }
    inner(app, id).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn environment_select<R: tauri::Runtime>(app: tauri::AppHandle<R>, id: String) -> Result<(), String> {
    let _guard = REGISTRY_LOCK.lock().await;
    (|| -> Result<()> {
        let path = registry_path(&app)?;
        let mut registry = read_registry(&path)?;
        resolve_profile(&registry, &id)?;
        registry.selected_id = id;
        write_registry(&path, &registry)
    })()
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn environment_save<R: tauri::Runtime>(app: tauri::AppHandle<R>, input: SaveEnvironment) -> Result<EnvironmentProfile, String> {
    save_environment(&app, input).await.map_err(|e| format!("{e:#}"))
}

/// Pair (or re-use a credential), verify the identity and persist the profile.
pub(crate) async fn save_environment<R: tauri::Runtime>(app: &tauri::AppHandle<R>, input: SaveEnvironment) -> Result<EnvironmentProfile> {
    {
        let _guard = REGISTRY_LOCK.lock().await;
        let path = registry_path(app)?;
        let mut registry = read_registry(&path)?;
        if input.id.as_deref() == Some(LOCAL) {
            bail!("The local environment is managed by Kybern");
        }
        // An id that is not saved yet (an SSH bootstrap chooses its id before
        // pairing so the tunnel is keyed by it) creates the profile.
        let existing = input.id.as_ref().and_then(|id| registry.environments.iter().find(|p| &p.id == id).cloned());
        let name = input.name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            bail!("Enter an environment name of 1–80 characters");
        }
        let url = address::normalize(&input.url)?;
        let code = input.code.as_deref().map(str::trim).filter(|v| !v.is_empty());
        let supplied = input.token.as_deref().map(str::trim).filter(|v| !v.is_empty());
        if code.is_some() && supplied.is_some() {
            bail!("Use a pairing code or a device token, not both");
        }
        let mut paired_identity = None;
        let token = if let Some(code) = code {
            let response = reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()?
                .post(format!("{}/pair", address::http_base(&url)?))
                .json(&PairRequest { code: code.into(), device_name: Some(format!("Kybern desktop · {name}")) })
                .send()
                .await
                .context("Reach this environment; check its address and private network connection")?;
            if !response.status().is_success() {
                bail!("Pairing failed ({}). Check the code or create a new invitation on that machine", response.status());
            }
            let paired: PairResponse = response.json().await.context("Read the pairing response")?;
            paired_identity = Some(paired.environment_id);
            paired.token
        } else if let Some(token) = supplied {
            token.into()
        } else if let Some(existing) = &existing {
            read_token(&existing.id)?
        } else {
            bail!("Enter a pairing code from the other machine");
        };
        let info = tokio::time::timeout(Duration::from_secs(15), async {
            let client = Client::connect(&Endpoint { url: url.clone(), token: token.clone() }).await?;
            client.call::<DaemonInfoMethod>(Empty {}).await
        })
        .await
        .context("Connection timed out; check the machine and its network")??;
        crate::ensure_compatible(&info)?;
        if input.expected_environment_id.as_ref().is_some_and(|expected| expected != &info.environment_id)
            || paired_identity.as_ref().is_some_and(|expected| expected != &info.environment_id)
            || existing.as_ref().and_then(|p| p.environment_id.as_ref()).is_some_and(|expected| expected != &info.environment_id)
        {
            bail!("This address belongs to a different environment. Add it separately to keep your projects and credentials isolated");
        }
        if registry
            .environments
            .iter()
            .any(|p| p.environment_id.as_deref() == Some(&info.environment_id) && Some(&p.id) != input.id.as_ref())
        {
            bail!("This environment is already saved. Select it from the environment menu");
        }
        let id = input.id.unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let profile = EnvironmentProfile {
            id: id.clone(),
            name: name.into(),
            url: Some(url),
            environment_id: Some(info.environment_id),
            hostname: Some(info.hostname),
            local: false,
            ssh: input.ssh.or_else(|| existing.as_ref().and_then(|p| p.ssh.clone())),
        };
        let old_token = existing.as_ref().and_then(|p| read_token(&p.id).ok());
        credential(&id)?.set_password(&token).context("Save the device credential in the system credential store")?;
        registry.environments.retain(|p| p.id != id);
        registry.environments.push(profile.clone());
        if let Err(error) = write_registry(&path, &registry) {
            if let Some(old) = old_token {
                let _ = credential(&id)?.set_password(&old);
            } else {
                let _ = credential(&id)?.delete_credential();
            }
            return Err(error);
        }
        Ok(profile)
    }
}

#[tauri::command]
pub async fn environment_remove<R: tauri::Runtime>(app: tauri::AppHandle<R>, id: String) -> Result<(), String> {
    let _guard = REGISTRY_LOCK.lock().await;
    // Forgetting a connection never shuts down or changes the remote host; it
    // only closes this device's tunnel.
    remote::stop_tunnel(&id).await;
    (|| -> Result<()> {
        if id == LOCAL {
            bail!("The local environment cannot be removed");
        }
        let path = registry_path(&app)?;
        let mut registry = read_registry(&path)?;
        resolve_profile(&registry, &id)?;
        let entry = credential(&id)?;
        let previous_token = match entry.get_password() {
            Ok(token) => Some(token),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => return Err(e).context("Unlock the system credential store to remove this environment"),
        };
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e).context("Remove the saved device credential"),
        }
        registry.environments.retain(|p| p.id != id);
        if registry.selected_id == id {
            registry.selected_id = LOCAL.into();
        }
        if let Err(error) = write_registry(&path, &registry) {
            if let Some(token) = previous_token {
                entry.set_password(&token).context("Restore the credential after environment settings could not be saved")?;
            }
            return Err(error);
        }
        Ok(())
    })()
    .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_roundtrip_contains_metadata_only_and_recovers_a_missing_selection() {
        let root = std::env::temp_dir().join(format!("kybern-registry-{}", uuid::Uuid::now_v7()));
        let path = root.join("environments.json");
        let registry = EnvironmentRegistry {
            selected_id: "removed".into(),
            environments: vec![EnvironmentProfile {
                id: "saved".into(),
                name: "Build machine".into(),
                url: Some("wss://host/ws".into()),
                environment_id: Some("stable".into()),
                hostname: Some("host".into()),
                local: false,
                ssh: None,
            }],
        };
        write_registry(&path, &registry).unwrap();
        let loaded = read_registry(&path).unwrap();
        assert_eq!(loaded.selected_id, LOCAL);
        assert_eq!(loaded.environments[0].environment_id.as_deref(), Some("stable"));
        assert!(!std::fs::read_to_string(&path).unwrap().contains("token"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
