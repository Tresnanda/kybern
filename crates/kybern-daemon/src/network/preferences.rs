//! Legacy daemon preference files use signed field clocks on a separate exchange.
//! GPUIX/mobile have no custom keybinding/theme-file consumers; appearance stays device-local.
use super::{keys, ops, peers::PeerLink, spaces};
use crate::state::AppState;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use kybern_protocol::{methods::*, *};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

const KEY: &str = "network.preferences.v1";
const BASE: &str = "network.preferences.disk.v1";
type Registers = BTreeMap<String, OpEnvelope>;

fn filename(name: &str) -> bool {
    name == "keybindings.json"
        || name.strip_prefix("themes/").is_some_and(|n| {
            n.ends_with(".json")
                && n.len() <= 128
                && n.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
                && !n.starts_with('.')
        })
}
fn fields(state: &AppState) -> anyhow::Result<Registers> {
    let mut all: Registers = state.store.meta_get(KEY)?.map(|s| serde_json::from_str(&s)).transpose()?.unwrap_or_default();
    // Repair older oversized stores deterministically. Retain deletion clocks;
    // do not admit an unbounded succession of names after create/delete cycles.
    while all.len() > 65 {
        all.pop_last();
    }
    Ok(all)
}
fn parse(e: &OpEnvelope) -> anyhow::Result<SpaceField> {
    Ok(serde_json::from_str(&e.body)?)
}
fn stamp(e: &OpEnvelope) -> anyhow::Result<(u64, String, String)> {
    Ok((parse(e)?.lamport, e.signer.clone(), e.id.clone()))
}
fn disk(state: &AppState, name: &str) -> anyhow::Result<Value> {
    let path = state.settings.dir().join(name);
    if let Some(parent) = path.parent() {
        anyhow::ensure!(
            !std::fs::symlink_metadata(parent).is_ok_and(|m| m.file_type().is_symlink()),
            "Preference folder must not be a symlink. Move the files into the data folder to sync them."
        );
    }
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 32768 => {
            Ok(serde_json::from_slice(&std::fs::read(path)?)?)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        _ => anyhow::bail!("Preference file is not a regular JSON file under 32 KiB"),
    }
}
fn observe(state: &AppState) -> anyhow::Result<Registers> {
    let mut all = fields(state)?;
    let Some(m) = state.network.membership().filter(|m| m.self_is_member()) else { return Ok(all) };
    let mut baseline: BTreeMap<String, Value> =
        state.store.meta_get(BASE)?.map(|s| serde_json::from_str(&s)).transpose()?.unwrap_or_default();
    let mut names: Vec<String> = all.keys().cloned().collect();
    names.push("keybindings.json".into());
    let themes = state.settings.dir().join("themes");
    if std::fs::symlink_metadata(&themes).is_ok_and(|m| m.file_type().is_symlink()) {
        anyhow::bail!("Themes folder must not be a symlink");
    }
    if let Ok(entries) = std::fs::read_dir(themes) {
        names.extend(entries.flatten().take(64).map(|e| format!("themes/{}", e.file_name().to_string_lossy())).filter(|n| filename(n)));
    }
    names.sort();
    names.dedup();
    for name in names {
        if !all.contains_key(&name) && all.len() >= 65 {
            continue;
        }
        let Ok(value) = disk(state, &name) else { continue };
        if baseline.get(&name) == Some(&value) || (!baseline.contains_key(&name) && value.is_null()) {
            continue;
        }
        let clock = all.values().filter_map(|e| parse(e).ok()).map(|f| f.lamport).max().unwrap_or(0).saturating_add(1);
        let e = spaces::seal(m, clock, name.clone(), "preference", value.clone())?;
        all.insert(name.clone(), e);
        baseline.insert(name, value);
    }
    state.store.meta_set(KEY, &serde_json::to_string(&all)?)?;
    baseline.retain(|name, _| all.contains_key(name));
    state.store.meta_set(BASE, &serde_json::to_string(&baseline)?)?;
    Ok(all)
}
fn merge(state: &AppState, mut all: Registers, incoming: &[OpEnvelope]) -> anyhow::Result<Registers> {
    anyhow::ensure!(incoming.len() <= 65, "Too many preference files");
    let m = state.network.membership().ok_or_else(|| anyhow::anyhow!("No network"))?;
    let projection = m.projection();
    for e in incoming {
        anyhow::ensure!(e.body.len() <= 65536 && e.id == ops::op_id(&e.body), "Invalid preference hash or size");
        let f = parse(e)?;
        anyhow::ensure!(filename(&f.entity) && f.field == "preference" && f.lamport < i64::MAX as u64, "Invalid preference field");
        anyhow::ensure!(
            projection.network_id.as_ref() == Some(&f.network_id) || projection.merged_networks.contains(&f.network_id),
            "Foreign preference network"
        );
        let signer = projection.entry(&e.signer).ok_or_else(|| anyhow::anyhow!("Preference signer is not a member"))?;
        keys::verify_signature(&signer.descriptor.signing_key, &spaces::input(&e.body), &B64.decode(&e.signature)?)?;
        if !all.contains_key(&f.entity) && all.len() >= 65 {
            continue;
        }
        if all.get(&f.entity).is_none_or(|old| stamp(old).ok() < stamp(e).ok()) {
            all.insert(f.entity, e.clone());
        }
    }
    anyhow::ensure!(all.len() <= 65, "Too many preference files");
    let mut baseline = BTreeMap::new();
    for (name, e) in &all {
        let f = parse(e)?;
        if disk(state, name)? != f.value {
            let path = state.settings.dir().join(name);
            if f.value.is_null() {
                if path.exists() {
                    std::fs::remove_file(&path)?;
                }
            } else {
                if let Some(parent) = path.parent() {
                    anyhow::ensure!(
                        !std::fs::symlink_metadata(parent).is_ok_and(|m| m.file_type().is_symlink()),
                        "Preference folder must not be a symlink"
                    );
                    std::fs::create_dir_all(parent)?;
                }
                let bytes = serde_json::to_vec_pretty(&f.value)?;
                anyhow::ensure!(bytes.len() <= 32768, "Preference file is too large");
                let temp = path.with_extension(format!("json.{}.network-tmp", uuid::Uuid::new_v4()));
                // create_new refuses a pre-existing path or symlink.
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
                let written = (|| -> std::io::Result<()> {
                    file.write_all(&bytes)?;
                    file.sync_all()?;
                    drop(file);
                    std::fs::rename(&temp, &path)
                })();
                if written.is_err() {
                    let _ = std::fs::remove_file(&temp);
                }
                written?;
            }
        }
        baseline.insert(name.clone(), f.value);
    }
    state.store.meta_set(KEY, &serde_json::to_string(&all)?)?;
    baseline.retain(|name, _| all.contains_key(name));
    state.store.meta_set(BASE, &serde_json::to_string(&baseline)?)?;
    Ok(all)
}
pub async fn serve(state: &AppState, p: PeerSpacesSyncParams) -> Result<PeerSpacesSyncResult, RpcError> {
    let _guard = state.network.spaces_lock.lock().await;
    let local = observe(state).map_err(RpcError::internal)?;
    let all = merge(state, local, &p.fields).map_err(RpcError::invalid_params)?;
    let ids: Vec<_> = all.values().map(|e| e.id.clone()).collect();
    let fields = all.into_values().filter(|e| !p.ids.contains(&e.id)).collect();
    Ok(PeerSpacesSyncResult { digest: ops::digest_of(&ids), ids, fields })
}
pub async fn sync(state: &AppState, link: &Arc<PeerLink>) {
    if !state.network.peers.status(&link.machine_id).presence.is_some_and(|p| p.features.iter().any(|f| f == features::PREFERENCES_SYNC_V1))
    {
        return;
    }
    let local = {
        let _guard = state.network.spaces_lock.lock().await;
        observe(state)
    };
    let Ok(local) = local else { return };
    let ids: Vec<_> = local.values().map(|e| e.id.clone()).collect();
    let p = PeerSpacesSyncParams { digest: ops::digest_of(&ids), ids, fields: local.into_values().collect() };
    let Ok(answer) = link.call::<PeerPreferencesSync>(p).await else { return };
    let _guard = state.network.spaces_lock.lock().await;
    if let Ok(local) = observe(state) {
        let _ = merge(state, local, &answer.fields);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn create_delete_cycles_remain_bounded() {
        let Some(cluster) = super::super::harness::Cluster::new(&[super::super::harness::NodeSpec::owner("prefs")]) else { return };
        let node = cluster.start("prefs", false).await;
        cluster.form(&node, &[], JoinVia::Auto).await;
        let dir = node.state.settings.dir().join("themes");
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..100 {
            let path = dir.join(format!("theme-{i}.json"));
            std::fs::write(&path, "{}").unwrap();
            observe(&node.state).unwrap();
            std::fs::remove_file(path).unwrap();
            let all = observe(&node.state).unwrap();
            assert_eq!(all.len(), (i + 1).min(65));
            assert!(all.values().all(|e| parse(e).unwrap().value.is_null()));
            merge(&node.state, all, &[]).unwrap();
        }
    }
}
