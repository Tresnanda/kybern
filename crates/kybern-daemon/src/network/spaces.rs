//! Network-wide Spaces: signed field registers, an atomic local projection and digest anti-entropy.
//! Membership only supplies signing keys and authorization; Spaces never writes membership operations.
use super::{
    Membership, keys, ops,
    peers::{PeerLink, effective_scopes},
};
use crate::state::AppState;
use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use chrono::Utc;
use kybern_protocol::{methods::*, *};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use uuid::Uuid;

const DOMAIN: &str = "kybern-spaces-v1\0";
const IMPORT: u64 = 0;
const MAX_BATCH: usize = 16384;
const LOGO_MAX: usize = 2 * 1024 * 1024;

type FieldEntry = (OpEnvelope, SpaceField);
type Fields = Vec<FieldEntry>;
type Placement = (SpaceProject, SpaceId, (u64, String, String));
fn input(body: &str) -> Vec<u8> {
    [DOMAIN.as_bytes(), body.as_bytes()].concat()
}
fn stamp<'a>(e: &'a OpEnvelope, f: &SpaceField) -> (u64, &'a str, &'a str) {
    (f.lamport, &e.signer, &e.id)
}
fn parsed(state: &AppState) -> Result<Fields> {
    let Some(m) = state.network.membership() else {
        return Ok(vec![]);
    };
    let projection = m.projection();
    let mut fields = Vec::new();
    for e in state.store.space_replica_fields()? {
        let f: SpaceField = serde_json::from_str(&e.body)?;
        if projection.network_id.as_ref() == Some(&f.network_id) || projection.merged_networks.contains(&f.network_id) {
            fields.push((e, f));
        }
    }
    Ok(fields)
}
fn active(state: &AppState) -> Option<&Membership> {
    state.network.membership().map(Arc::as_ref).filter(|m| m.self_is_member() && !m.key_mismatch())
}
fn seal(m: &Membership, lamport: u64, entity: String, field: &str, value: Value) -> Result<OpEnvelope> {
    let f = SpaceField {
        network_id: m.network_id().ok_or_else(|| anyhow::anyhow!("no network"))?,
        lamport,
        entity,
        field: field.into(),
        value,
        at: Utc::now(),
    };
    let body = serde_json::to_string(&f)?;
    Ok(OpEnvelope { id: ops::op_id(&body), signer: m.machine_id(), signature: B64.encode(m.keys().sign(&input(&body))), body })
}
fn next(fields: &Fields) -> u64 {
    fields.iter().map(|(_, f)| f.lamport).max().unwrap_or(0).saturating_add(1)
}
fn reference(machine: &str, p: &Project) -> SpaceProject {
    SpaceProject {
        machine_id: machine.into(),
        project_id: p.id,
        previous_machine_ids: vec![],
        kind: p.kind,
        repo: p.repo.clone(),
        repos: p.repos.clone(),
    }
}
fn project_entity(p: &SpaceProject) -> String {
    format!("project:{}:{}", p.machine_id, p.project_id)
}
fn space_entity(id: SpaceId) -> String {
    format!("space:{id}")
}
fn birth_value(space: &Space) -> Result<Value> {
    let mut birth = space.clone();
    // Image asset ids belong to this daemon. Only the paired content-hash register crosses machines.
    if matches!(birth.logo, SpaceLogo::Image { .. }) {
        birth.logo = SpaceLogo::Initials;
    }
    Ok(serde_json::to_value(birth)?)
}

/// Import a pre-sync local rail once. Imports have clock zero, so they cannot overwrite established edits.
/// If both ends are fresh, the session's initiating machine raises its default and placements to clock one.
fn bootstrap(state: &AppState, _initiator: bool) -> Result<()> {
    let Some(m) = active(state) else {
        return Ok(());
    };
    let fields = parsed(state)?;
    let me = m.machine_id();
    let imported = fields.iter().any(|(e, f)| e.signer == me && f.entity == "network" && f.field == "imported");
    if imported {
        return Ok(());
    }
    let mut add = Vec::new();
    let clock = IMPORT;
    for space in state.store.spaces_list()? {
        let entity = space_entity(space.id);
        add.push(seal(m, IMPORT, entity.clone(), "birth", birth_value(&space)?)?);
        if space.is_default {
            add.push(seal(m, clock, "network".into(), "default", json!(space.id))?);
        }
        // Images travel by content hash; asset ids remain a local projection detail.
        if let Some(hash) = logo_hash(state, &space.logo)? {
            add.push(seal(m, IMPORT, entity, "logo", json!({"hash": hash}))?);
        }
    }
    for p in state.store.projects_list()?.into_iter().filter(|p| !is_free_chat_project(p.id)) {
        if let Some(space) = p.space_id {
            let project = reference(&me, &p);
            add.push(seal(m, clock, project_entity(&project), "placement", json!({"project":project,"space_id":space}))?);
        }
    }
    add.push(seal(m, IMPORT, "network".into(), "imported", json!(true))?);
    if state.store.meta_get("spaces.replica.prefer_local")?.as_deref() == Some("true") {
        add.push(seal(m, IMPORT, "network".into(), "preferred", json!(true))?);
    }
    state.store.space_replica_keep(&add)?;
    Ok(())
}
/// Record an explicit Add/Join/Enable action. This preference is considered only before establishment.
pub fn prefer_local(state: &AppState) -> Result<()> {
    state.store.meta_set("spaces.replica.prefer_local", "true")?;
    if let Some(m) = active(state) {
        bootstrap(state, false)?;
        let fields = parsed(state)?;
        if !fields.iter().any(|(_, f)| f.field == "established")
            && !fields.iter().any(|(e, f)| e.signer == m.machine_id() && f.field == "preferred")
        {
            state.store.space_replica_keep(&[seal(m, IMPORT, "network".into(), "preferred", json!(true))?])?;
        }
    }
    Ok(())
}
fn establish(state: &AppState, fallback_initiator: bool) -> Result<()> {
    let m = active(state).ok_or_else(|| anyhow::anyhow!("no network"))?;
    let fields = parsed(state)?;
    if fields.iter().any(|(_, f)| f.field == "established") {
        return Ok(());
    }
    let preferred = fields.iter().filter(|(_, f)| f.field == "preferred").map(|(e, _)| e.signer.as_str()).max();
    let own = m.machine_id();
    if preferred.map(|id| id != own).unwrap_or(!fallback_initiator) {
        return Ok(());
    }
    let clock = next(&fields);
    let mut latest = BTreeMap::new();
    for (e, f) in &fields {
        if e.signer == own && (f.field == "default" || f.field == "placement") {
            let entry = latest.entry((&f.entity, &f.field)).or_insert((e, f));
            if stamp(e, f) > stamp(entry.0, entry.1) {
                *entry = (e, f);
            }
        }
    }
    let mut add = Vec::new();
    for (_, f) in latest.values() {
        add.push(seal(m, clock, f.entity.clone(), &f.field, f.value.clone())?);
    }
    add.push(seal(m, clock, "network".into(), "established", json!(true))?);
    state.store.space_replica_keep(&add)?;
    gossip(state, None);
    Ok(())
}
fn logo_hash(state: &AppState, logo: &SpaceLogo) -> Result<Option<String>> {
    let SpaceLogo::Image { asset_id } = logo else {
        return Ok(None);
    };
    let bytes = std::fs::read(state.paths.assets.join(asset_id.to_string()))?;
    if bytes.len() > LOGO_MAX {
        bail!("space logo exceeds 2 MB");
    }
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
    state.store.space_logo_put(&hash, &bytes)?;
    Ok(Some(hash))
}
fn logo_id(hash: &str) -> Result<Uuid> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        bail!("invalid logo hash");
    }
    let mut bytes = [0; 16];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hash[2 * i..2 * i + 2], 16)?;
    }
    Ok(Uuid::from_bytes(bytes))
}
fn install_logo(state: &AppState, hash: &str) -> Result<SpaceLogo> {
    let id = logo_id(hash)?;
    if let Some(bytes) = state.store.space_logo_get(hash)? {
        std::fs::create_dir_all(&state.paths.assets)?;
        let path = state.paths.assets.join(id.to_string());
        if !path.exists() {
            std::fs::write(path, &bytes)?;
        }
        if state.store.asset_get(id)?.is_none() {
            state.store.asset_insert(&AssetInfo {
                id,
                name: "space-logo.png".into(),
                media_type: "image/png".into(),
                size: bytes.len() as u64,
                created_at: Utc::now(),
            })?;
        }
    } else {
        // Clients cache failed asset requests. Announce an image id only once the local bytes exist.
        return Ok(SpaceLogo::Initials);
    }
    Ok(SpaceLogo::Image { asset_id: id })
}

#[derive(Default)]
struct Projection {
    spaces: Vec<Space>,
    aliases: BTreeMap<SpaceId, SpaceId>,
    placements: Vec<Placement>,
}
impl Projection {
    fn canonical(&self, id: SpaceId) -> SpaceId {
        self.aliases.get(&id).copied().unwrap_or(id)
    }
    fn resolved(&self, id: SpaceId) -> SpaceId {
        let id = self.canonical(id);
        if self.spaces.iter().any(|s| s.id == id) { id } else { self.spaces.iter().find(|s| s.is_default).expect("default").id }
    }
}
fn projection(state: &AppState, fields: &Fields) -> Result<Projection> {
    let mut out = Projection::default();
    let mut births: BTreeMap<SpaceId, Space> = BTreeMap::new();
    let mut birth_fields: BTreeMap<SpaceId, &FieldEntry> = BTreeMap::new();
    let mut latest: BTreeMap<(&str, &str), &FieldEntry> = BTreeMap::new();
    let mut dead = BTreeSet::new();
    for pair @ (e, f) in fields {
        let entry = latest.entry((&f.entity, &f.field)).or_insert(pair);
        if stamp(e, f) > stamp(&entry.0, &entry.1) {
            *entry = pair;
        }
        if f.field == "birth" {
            let s: Space = serde_json::from_value(f.value.clone())?;
            // The first birth of an id is immutable; a later update cannot turn a rename into a merge.
            let replace = births.get(&s.id).is_none_or(|old| {
                let old_field = birth_fields[&s.id];
                (s.updated_at, stamp(e, f)) < (old.updated_at, stamp(&old_field.0, &old_field.1))
            });
            if replace {
                birth_fields.insert(s.id, pair);
                births.insert(s.id, s);
            }
        }
        if f.field == "deleted" && f.value == json!(true) {
            dead.insert(f.entity.clone());
        }
    }
    let observed = |id: SpaceId, other: SpaceId| {
        fields.iter().any(|(_, f)| {
            f.entity == space_entity(id)
                && f.field == "birth"
                && f.value.get("_seen").and_then(Value::as_array).is_some_and(|ids| ids.contains(&json!(other)))
        })
    };
    for s in births.values() {
        let winner = births
            .values()
            .filter(|q| q.id < s.id && q.name.to_lowercase() == s.name.to_lowercase() && !observed(s.id, q.id) && !observed(q.id, s.id))
            .map(|q| out.canonical(q.id))
            .min()
            .unwrap_or(s.id);
        out.aliases.insert(s.id, winner);
    }
    // A delete of any alias permanently deletes that creation, including aliases learned later.
    let dead: BTreeSet<_> = births.keys().filter(|id| dead.contains(&space_entity(**id))).map(|id| out.canonical(*id)).collect();
    let mut grouped: BTreeMap<(SpaceId, &str), &FieldEntry> = BTreeMap::new();
    for pair @ (e, f) in fields {
        if let Some(id) = f.entity.strip_prefix("space:").and_then(|id| Uuid::parse_str(id).ok()) {
            if f.field == "birth" && birth_fields.get(&id).is_some_and(|first| !std::ptr::eq(*first, pair)) {
                continue;
            }
            let id = out.canonical(id);
            let entry = grouped.entry((id, &f.field)).or_insert(pair);
            if stamp(e, f) > stamp(&entry.0, &entry.1) {
                *entry = pair;
            }
        }
    }
    let protected_default = latest
        .get(&("network", "default"))
        .and_then(|(_, f)| serde_json::from_value::<SpaceId>(f.value.clone()).ok())
        .map(|id| out.canonical(id));
    for (id, birth) in &births {
        if out.canonical(*id) != *id || (dead.contains(id) && protected_default != Some(*id)) {
            continue;
        }
        let mut s = birth.clone();
        // Alias births also contribute attributes using the exact same deterministic stamp.
        if let Some((_, f)) = grouped.get(&(*id, "birth")) {
            let b: Space = serde_json::from_value(f.value.clone())?;
            s.name = b.name;
            s.color = b.color;
            s.logo = b.logo;
            s.position = b.position;
        }
        for field in ["name", "color", "logo", "position"] {
            if let Some((e, f)) = grouped.get(&(*id, field)) {
                if grouped.get(&(*id, "birth")).is_some_and(|(be, bf)| {
                    let paired_logo = field == "logo" && f.entity == bf.entity && e.signer == be.signer && f.lamport == bf.lamport;
                    !paired_logo && stamp(e, f) < stamp(be, bf)
                }) {
                    continue;
                }
                s.updated_at = s.updated_at.max(f.at);
                match field {
                    "name" => s.name = serde_json::from_value(f.value.clone())?,
                    "color" => s.color = serde_json::from_value(f.value.clone())?,
                    "position" => s.position = serde_json::from_value(f.value.clone())?,
                    "logo" => {
                        s.logo = if let Some(hash) = f.value.get("hash").and_then(Value::as_str) {
                            install_logo(state, hash)?
                        } else {
                            serde_json::from_value(f.value.clone())?
                        }
                    }
                    _ => {}
                }
            }
        }
        // A legacy image id is useful only until a hash has been imported.
        if matches!(s.logo, SpaceLogo::Image { .. }) && !grouped.contains_key(&(*id, "logo")) {
            s.logo = SpaceLogo::Initials;
        }
        s.is_default = false;
        out.spaces.push(s);
    }
    if out.spaces.is_empty() {
        bail!("Spaces replica has no live space");
    }
    let default = latest
        .get(&("network", "default"))
        .and_then(|(_, f)| serde_json::from_value::<SpaceId>(f.value.clone()).ok())
        .map(|id| out.canonical(id));
    let default = default.filter(|id| out.spaces.iter().any(|s| s.id == *id)).unwrap_or(out.spaces[0].id);
    // Established spaces that collide through a rename keep their identities and readable unique labels.
    let mut counts = BTreeMap::<String, usize>::new();
    for s in &out.spaces {
        *counts.entry(s.name.to_lowercase()).or_default() += 1;
    }
    for s in &mut out.spaces {
        s.is_default = s.id == default;
        if counts[&s.name.to_lowercase()] > 1 {
            s.name = format!("{} ({})", s.name.chars().take(21).collect::<String>(), &s.id.simple().to_string()[24..]);
        }
    }
    out.spaces.sort_by_key(|s| (s.position, s.id));
    for (i, s) in out.spaces.iter_mut().enumerate() {
        s.position = i as u32;
    }
    for (e, f) in latest.values().filter(|(_, f)| f.field == "placement") {
        let project: SpaceProject = match latest.get(&(f.entity.as_str(), "identity")) {
            Some((_, identity)) => serde_json::from_value(identity.value.clone())?,
            None => serde_json::from_value(f.value["project"].clone())?,
        };
        let space: SpaceId = serde_json::from_value(f.value["space_id"].clone())?;
        out.placements.push((project, space, (f.lamport, e.signer.clone(), e.id.clone())));
    }
    for (_, f) in latest.values().filter(|(_, f)| f.field == "identity") {
        let project: SpaceProject = serde_json::from_value(f.value.clone())?;
        if !out.placements.iter().any(|(p, _, _)| p.machine_id == project.machine_id && p.project_id == project.project_id) {
            // An identity-only checkout contributes connectivity, with an implicit default below every signed import.
            out.placements.push((project, default, (0, String::new(), String::new())));
        }
    }
    Ok(out)
}
fn same_instance(a: &SpaceProject, b: &SpaceProject) -> bool {
    a.project_id == b.project_id
        && (a.machine_id == b.machine_id
            || a.previous_machine_ids.contains(&b.machine_id)
            || b.previous_machine_ids.contains(&a.machine_id))
}
fn group_keys(p: &SpaceProject) -> BTreeSet<String> {
    p.repos
        .iter()
        .filter_map(|r| r.root_commit.as_ref().map(|v| format!("root:{v}")).or_else(|| r.remote.as_ref().map(|v| format!("remote:{v}"))))
        .collect()
}
/// Match root sets transitively, and attach remote-only identities only when the root group is unambiguous.
fn matches_for<'a>(p: &SpaceProject, placements: &'a [Placement]) -> Vec<&'a Placement> {
    if p.kind == ProjectKind::Group {
        let keys = group_keys(p);
        return placements
            .iter()
            .filter(|(q, _, _)| {
                q.kind == ProjectKind::Group && ((!keys.is_empty() && keys == group_keys(q)) || (keys.is_empty() && same_instance(p, q)))
            })
            .collect();
    }
    let singles: Vec<_> = placements.iter().filter(|(q, _, _)| q.kind != ProjectKind::Group).collect();
    let mut roots: BTreeSet<String> = p.repo.as_ref().into_iter().flat_map(|r| r.roots().cloned()).collect();
    let remote = p.repo.as_ref().and_then(|r| r.remote.as_ref());
    if roots.is_empty()
        && let Some(remote) = remote
    {
        // Build connected root components before deciding if the remote is ambiguous.
        let candidates: Vec<_> = singles
            .iter()
            .filter(|(q, _, _)| {
                q.repo.as_ref().and_then(|r| r.remote.as_ref()) == Some(remote)
                    && q.repo.as_ref().is_some_and(|r| r.roots().next().is_some())
            })
            .collect();
        if let Some((q, _, _)) = candidates.first() {
            roots.extend(q.repo.as_ref().into_iter().flat_map(|r| r.roots().cloned()));
            expand_roots(&mut roots, &singles);
            if candidates.iter().any(|(q, _, _)| !q.repo.as_ref().is_some_and(|r| r.roots().any(|v| roots.contains(v)))) {
                roots.clear();
            }
        }
    }
    expand_roots(&mut roots, &singles);
    let mut remote_components = BTreeSet::new();
    if let Some(remote) = remote {
        for (q, _, _) in &singles {
            if q.repo.as_ref().and_then(|r| r.remote.as_ref()) == Some(remote) {
                let mut component: BTreeSet<_> = q.repo.as_ref().into_iter().flat_map(|r| r.roots().cloned()).collect();
                expand_roots(&mut component, &singles);
                if let Some(root) = component.first() {
                    remote_components.insert(root.clone());
                }
            }
        }
        if p.repo.as_ref().is_some_and(|r| r.roots().next().is_some())
            && let Some(root) = roots.first()
        {
            remote_components.insert(root.clone());
        }
    }
    singles
        .into_iter()
        .filter(|(q, _, _)| {
            if same_instance(p, q) {
                return true;
            }
            let Some(r) = &q.repo else {
                return false;
            };
            if !roots.is_empty() && r.roots().any(|v| roots.contains(v)) {
                return true;
            }
            r.roots().next().is_none()
                && remote.is_some()
                && r.remote.as_ref() == remote
                && (roots.is_empty() || remote_components.len() <= 1)
        })
        .collect()
}
fn expand_roots(roots: &mut BTreeSet<String>, singles: &[&Placement]) {
    loop {
        let before = roots.len();
        for (q, _, _) in singles {
            if let Some(r) = &q.repo
                && r.roots().any(|v| roots.contains(v))
            {
                roots.extend(r.roots().cloned());
            }
        }
        if roots.len() == before {
            break;
        }
    }
}
fn local_matches<'a>(state: &AppState, p: &SpaceProject, placements: &'a [Placement]) -> Vec<&'a Placement> {
    let mut matched = matches_for(p, placements);
    let previous = super::membership::previous_machine_ids(&state.store).unwrap_or_default();
    for candidate @ (q, _, _) in placements {
        if q.project_id == p.project_id && previous.contains(&q.machine_id) && !matched.iter().any(|r| std::ptr::eq(*r, candidate)) {
            matched.push(candidate);
        }
    }
    matched
}
fn materialize(state: &AppState) -> Result<()> {
    let fields = parsed(state)?;
    if fields.is_empty() {
        return Ok(());
    }
    let view = projection(state, &fields)?;
    let me = active(state).map(Membership::machine_id).unwrap_or_else(|| state.environment_id.clone());
    let mut placements = Vec::new();
    for p in state.store.projects_list()?.iter().filter(|p| !is_free_chat_project(p.id)) {
        if let Some((_, space, _)) =
            local_matches(state, &reference(&me, p), &view.placements).into_iter().max_by_key(|(_, _, stamp)| stamp)
        {
            placements.push((p.id, view.resolved(*space)));
        }
    }
    let before = state.store.spaces_list()?;
    let projects_before = state.store.projects_list()?;
    if before != view.spaces
        || placements.iter().any(|(id, space)| projects_before.iter().any(|p| p.id == *id && p.space_id != Some(*space)))
    {
        state.store.space_replica_project(&view.spaces, &placements)?;
    }
    if before != view.spaces {
        state.orchestrator.publish_spaces();
    }
    let digest = ops::digest_of(&fields.iter().map(|(e, _)| e.id.clone()).collect::<Vec<_>>());
    if state.store.meta_get("spaces.replica.projected")?.as_deref() != Some(&digest) {
        state.store.meta_set("spaces.replica.projected", &digest)?;
        state.network.notify_utility("spaces.placements_changed", json!({}));
    }
    if projects_before.iter().map(|p| (p.id, p.space_id)).collect::<Vec<_>>()
        != state.store.projects_list()?.iter().map(|p| (p.id, p.space_id)).collect::<Vec<_>>()
    {
        state.orchestrator.publish_projects();
    }
    Ok(())
}

/// Capture only changed fields, so concurrent colour/name edits do not overwrite each other.
pub fn record(state: &AppState, before: &[Space], project_move: Option<ProjectId>) -> Result<()> {
    let Some(m) = active(state) else {
        return Ok(());
    };
    bootstrap(state, false)?;
    let fields = parsed(state)?;
    let clock = next(&fields);
    let after = state.store.spaces_list()?;
    let mut add = Vec::new();
    for s in &after {
        let entity = space_entity(s.id);
        if let Some(old) = before.iter().find(|old| old.id == s.id) {
            for (field, changed, value) in [
                ("name", old.name != s.name, json!(s.name)),
                ("color", old.color != s.color, json!(s.color)),
                ("position", old.position != s.position, json!(s.position)),
            ] {
                if changed {
                    add.push(seal(m, clock, entity.clone(), field, value)?);
                }
            }
            if old.logo != s.logo {
                let value = match logo_hash(state, &s.logo)? {
                    Some(hash) => json!({"hash":hash}),
                    None => serde_json::to_value(&s.logo)?,
                };
                add.push(seal(m, clock, entity, "logo", value)?);
            }
        } else {
            let mut birth = birth_value(s)?;
            birth["_seen"] = json!(
                fields
                    .iter()
                    .filter(|(_, f)| f.field == "birth"
                        && f.value.get("name").and_then(Value::as_str).is_some_and(|name| name.to_lowercase() == s.name.to_lowercase()))
                    .filter_map(|(_, f)| f.value.get("id").cloned())
                    .collect::<Vec<_>>()
            );
            add.push(seal(m, clock, entity.clone(), "birth", birth)?);
            if let Some(hash) = logo_hash(state, &s.logo)? {
                add.push(seal(m, clock, entity, "logo", json!({"hash":hash}))?);
            }
        }
    }
    for old in before.iter().filter(|old| !after.iter().any(|s| s.id == old.id)) {
        add.push(seal(m, clock, space_entity(old.id), "deleted", json!(true))?);
    }
    if let Some(id) = project_move
        && let Some(p) = state.store.project_get(id)?
        && let Some(space) = p.space_id
    {
        let p = reference(&m.machine_id(), &p);
        add.push(seal(m, clock, project_entity(&p), "placement", json!({"project":p,"space_id":space}))?);
    }
    state.store.space_replica_keep(&add)?;
    materialize(state)?;
    gossip(state, None);
    Ok(())
}
/// Called before a local mutation, under spaces_lock, so the initial local state is never lost.
pub fn prepare(state: &AppState) -> Result<()> {
    bootstrap(state, false)
}

pub async fn place(state: &AppState, p: SpacesPlaceParams) -> Result<SpacesListResult, RpcError> {
    if is_free_chat_project(p.project.project_id) {
        return Err(RpcError::invalid_params("Free chat isn't in a space."));
    }
    let _guard = state.network.spaces_lock.lock().await;
    if state.store.space_get(p.space_id).map_err(RpcError::internal)?.is_none() {
        return Err(RpcError::not_found("space"));
    }
    if let Some(m) = active(state) {
        if !m.is_member(&p.project.machine_id) {
            return Err(RpcError::invalid_params("The project belongs to a machine outside this network."));
        }
        bootstrap(state, false).map_err(RpcError::internal)?;
        let fields = parsed(state).map_err(RpcError::internal)?;
        let add = seal(m, next(&fields), project_entity(&p.project), "placement", json!({"project":p.project,"space_id":p.space_id}))
            .map_err(RpcError::internal)?;
        state.store.space_replica_keep(&[add]).map_err(RpcError::internal)?;
        materialize(state).map_err(RpcError::internal)?;
        gossip(state, None);
    } else {
        state.orchestrator.move_project(p.project.project_id, p.space_id)?;
    }
    list(state)
}
fn validate(state: &AppState, envelopes: &[OpEnvelope]) -> Result<()> {
    if envelopes.len() > MAX_BATCH {
        bail!("too many Spaces fields");
    }
    let m = active(state).ok_or_else(|| anyhow::anyhow!("no network"))?;
    let projection = m.projection();
    for e in envelopes {
        if e.body.len() > 65536 || e.id != ops::op_id(&e.body) {
            bail!("invalid Spaces field hash or size");
        }
        let f: SpaceField = serde_json::from_str(&e.body)?;
        if projection.network_id.as_ref() != Some(&f.network_id) && !projection.merged_networks.contains(&f.network_id) {
            bail!("foreign Spaces network");
        }
        let signer = projection.entry(&e.signer).ok_or_else(|| anyhow::anyhow!("unknown Spaces signer"))?;
        // Historical signed data from removed members stays verifiable; their sessions cannot write new data.
        keys::verify_signature(&signer.descriptor.signing_key, &input(&e.body), &B64.decode(&e.signature)?)?;
        if f.lamport > i64::MAX as u64 || f.entity.len() > 256 {
            bail!("invalid Spaces clock or entity");
        }
        match f.field.as_str() {
            "birth" => {
                let s: Space = serde_json::from_value(f.value.clone())?;
                if f.entity != space_entity(s.id) || s.name.trim().is_empty() || s.name.chars().count() > 32 {
                    bail!("invalid Space birth");
                }
            }
            "name" => {
                let v: String = serde_json::from_value(f.value.clone())?;
                if v.trim().is_empty() || v.chars().count() > 32 {
                    bail!("invalid Space name");
                }
            }
            "color" => {
                let _: SpaceColor = serde_json::from_value(f.value.clone())?;
            }
            "position" => {
                let _: u32 = serde_json::from_value(f.value.clone())?;
            }
            "logo" => {
                if let Some(hash) = f.value.get("hash").and_then(Value::as_str) {
                    logo_id(hash)?;
                } else {
                    let l: SpaceLogo = serde_json::from_value(f.value.clone())?;
                    if matches!(l, SpaceLogo::Image { .. }) {
                        bail!("logos must use content hashes");
                    }
                }
            }
            "default" => {
                let _: SpaceId = serde_json::from_value(f.value.clone())?;
                if f.entity != "network" {
                    bail!("invalid default register");
                }
            }
            "deleted" | "imported" | "established" | "preferred" => {
                if f.value != json!(true) {
                    bail!("invalid tombstone/import");
                }
            }
            "identity" => {
                let p: SpaceProject = serde_json::from_value(f.value.clone())?;
                if f.entity != project_entity(&p) || is_free_chat_project(p.project_id) || p.previous_machine_ids.len() > 256 {
                    bail!("invalid project identity");
                }
            }
            "placement" => {
                let p: SpaceProject = serde_json::from_value(f.value["project"].clone())?;
                let _: SpaceId = serde_json::from_value(f.value["space_id"].clone())?;
                if f.entity != project_entity(&p) || is_free_chat_project(p.project_id) {
                    bail!("invalid placement");
                }
            }
            _ => bail!("unknown Spaces field"),
        }
    }
    Ok(())
}
pub async fn serve(state: &AppState, link: &Arc<PeerLink>, p: PeerSpacesSyncParams) -> Result<PeerSpacesSyncResult, RpcError> {
    let _guard = state.network.spaces_lock.lock().await;
    validate(state, &p.fields).map_err(RpcError::invalid_params)?;
    // Import BEFORE projecting a network rail over the old daemon's local rail.
    bootstrap(state, false).map_err(RpcError::internal)?;
    let before = parsed(state).map_err(RpcError::internal)?.len();
    state.store.space_replica_keep(&p.fields).map_err(RpcError::internal)?;
    let known: BTreeSet<_> = parsed(state).map_err(RpcError::internal)?.into_iter().map(|(e, _)| e.id).collect();
    if p.ids.iter().all(|id| known.contains(id)) {
        establish(state, false).map_err(RpcError::internal)?;
    }
    materialize(state).map_err(RpcError::internal)?;
    let fields: Vec<_> = parsed(state).map_err(RpcError::internal)?.into_iter().map(|(e, _)| e).collect();
    let ids: Vec<_> = fields.iter().map(|e| e.id.clone()).collect();
    let digest = ops::digest_of(&ids);
    if fields.len() != before {
        gossip(state, Some(&link.machine_id));
        // A pushed image reference should render without waiting for this receiver's next worker tick.
        let receiver = state.clone();
        tokio::spawn(async move {
            fetch_logos(&receiver).await;
        });
    }
    let fields = if digest == p.digest { vec![] } else { fields.into_iter().filter(|e| !p.ids.contains(&e.id)).take(256).collect() };
    Ok(PeerSpacesSyncResult { digest, ids, fields })
}
pub fn serve_logo(state: &AppState, p: PeerSpaceLogoParams) -> Result<PeerSpaceLogoResult, RpcError> {
    logo_id(&p.hash).map_err(RpcError::invalid_params)?;
    let bytes = state.store.space_logo_get(&p.hash).map_err(RpcError::internal)?.ok_or_else(|| RpcError::not_found("Space logo"))?;
    Ok(PeerSpaceLogoResult { data: B64.encode(bytes) })
}
pub async fn sync(state: &AppState, link: &Arc<PeerLink>, initiator: bool) {
    if !effective_scopes(&state.network, link).contains(&Scope::MachinePeer) {
        return;
    }
    let fields = {
        let _guard = state.network.spaces_lock.lock().await;
        if let Err(e) = bootstrap(state, initiator) {
            tracing::warn!(%e,"Spaces import failed");
            return;
        }
        let Ok(fields) = parsed(state) else {
            return;
        };
        fields
    };
    let ids = fields.iter().map(|(e, _)| e.id.clone()).collect::<Vec<_>>();
    // Exchange the digest first. Initialization preferences are small control fields; content follows only if missing.
    let control = fields.iter().filter(|(_, f)| f.entity == "network").map(|(e, _)| e.clone()).collect();
    let first = PeerSpacesSyncParams { digest: ops::digest_of(&ids), ids, fields: control };
    let mut answer = match link.call::<PeerSpacesSync>(first).await {
        Ok(v) => v,
        Err(_) => return,
    };
    loop {
        let (local, ids) = {
            let _guard = state.network.spaces_lock.lock().await;
            if let Err(e) = validate(state, &answer.fields).and_then(|_| state.store.space_replica_keep(&answer.fields)) {
                tracing::warn!(%e,"Spaces sync failed");
                return;
            }
            let Ok(fields) = parsed(state) else {
                return;
            };
            let ids = fields.iter().map(|(e, _)| e.id.clone()).collect::<Vec<_>>();
            (fields, ids)
        };
        let have: BTreeSet<_> = ids.iter().collect();
        if answer.ids.iter().any(|id| !have.contains(id)) {
            // Pull the next bounded page before establishing the initial preference.
            answer = match link.call::<PeerSpacesSync>(PeerSpacesSyncParams { digest: ops::digest_of(&ids), ids, fields: vec![] }).await {
                Ok(v) => v,
                Err(_) => return,
            };
            if answer.fields.is_empty() {
                return;
            }
            continue;
        }
        let local = {
            let _guard = state.network.spaces_lock.lock().await;
            if let Err(e) = establish(state, initiator) {
                tracing::warn!(%e,"Spaces initialization failed");
                return;
            }
            parsed(state).unwrap_or(local)
        };
        let ids = local.iter().map(|(e, _)| e.id.clone()).collect::<Vec<_>>();
        let peer: BTreeSet<_> = answer.ids.iter().collect();
        let missing = local.into_iter().filter(|(e, _)| !peer.contains(&e.id)).take(256).map(|(e, _)| e).collect::<Vec<_>>();
        if missing.is_empty() {
            break;
        }
        answer = match link.call::<PeerSpacesSync>(PeerSpacesSyncParams { digest: ops::digest_of(&ids), ids, fields: missing }).await {
            Ok(v) => v,
            Err(_) => return,
        };
    }
    {
        let _guard = state.network.spaces_lock.lock().await;
        if let Err(e) = materialize(state) {
            tracing::warn!(%e,"Spaces projection failed");
            return;
        }
    }
    fetch_logos(state).await;
    reconcile(state).await;
}

fn gossip(state: &AppState, except: Option<&str>) {
    for link in state.network.peers.links() {
        if Some(link.machine_id.as_str()) == except {
            continue;
        }
        let state = state.clone();
        tokio::spawn(async move {
            Box::pin(sync(&state, &link, false)).await;
        });
    }
}
async fn fetch_logos(state: &AppState) {
    let Ok(fields) = parsed(state) else {
        return;
    };
    let hashes: BTreeSet<_> = fields.iter().filter_map(|(_, f)| f.value.get("hash").and_then(Value::as_str).map(str::to_string)).collect();
    for hash in hashes {
        if state.store.space_logo_get(&hash).ok().flatten().is_some() {
            continue;
        }
        for link in state.network.peers.links() {
            if !effective_scopes(&state.network, &link).contains(&Scope::MachinePeer) {
                continue;
            }
            if let Ok(answer) = link.call::<PeerSpaceLogo>(PeerSpaceLogoParams { hash: hash.clone() }).await
                && let Ok(bytes) = B64.decode(answer.data)
                && bytes.len() <= LOGO_MAX
            {
                use sha2::{Digest, Sha256};
                let actual: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
                if actual == hash && crate::thumbnail::square_logo(&bytes).is_ok() {
                    let _ = state.store.space_logo_put(&hash, &bytes);
                    let _guard = state.network.spaces_lock.lock().await;
                    let _ = materialize(state);
                    break;
                }
            }
        }
    }
}
/// Refresh identity projections and import new local projects without undoing established placements.
pub async fn reconcile(state: &AppState) {
    let _guard = state.network.spaces_lock.lock().await;
    let Some(m) = active(state) else {
        return;
    };
    if parsed(state).is_ok_and(|fields| fields.is_empty()) {
        return;
    }
    if let Err(e) = (|| -> Result<()> {
        bootstrap(state, false)?;
        let fields = parsed(state)?;
        let view = projection(state, &fields)?;
        let mut add = Vec::new();
        for p in state.store.projects_list()?.into_iter().filter(|p| !is_free_chat_project(p.id)) {
            let mut project = reference(&m.machine_id(), &p);
            project.previous_machine_ids = super::membership::previous_machine_ids(&state.store)?;
            let entity = project_entity(&project);
            let identity = fields
                .iter()
                .filter(|(_, f)| f.entity == entity && f.field == "identity")
                .max_by(|(a, af), (b, bf)| stamp(a, af).cmp(&stamp(b, bf)));
            if identity.is_none_or(|(_, f)| serde_json::from_value::<SpaceProject>(f.value.clone()).ok().as_ref() != Some(&project)) {
                add.push(seal(m, next(&fields), entity.clone(), "identity", serde_json::to_value(&project)?)?);
            }
            let has_placement = fields.iter().any(|(_, f)| f.entity == entity && f.field == "placement");
            let inherited = local_matches(state, &project, &view.placements).into_iter().any(|(_, _, s)| !s.1.is_empty());
            let default = view.spaces.iter().find(|s| s.is_default).unwrap().id;
            if !has_placement && !inherited && p.space_id.is_some_and(|id| id != default) {
                // A newly added project explicitly chose a non-default Space. Automatic clone inheritance never writes this register.
                let clock = if fields.iter().any(|(_, f)| f.field == "established") { next(&fields) } else { IMPORT };
                add.push(seal(m, clock, entity, "placement", json!({"project":project,"space_id":p.space_id.unwrap()}))?);
            }
        }
        if !add.is_empty() {
            state.store.space_replica_keep(&add)?;
            gossip(state, None);
        }
        materialize(state)
    })() {
        tracing::warn!(%e,"Spaces projection refresh failed");
    }
}

/// The rail and every known logical placement, including remote-only projects.
pub fn list(state: &AppState) -> Result<SpacesListResult, RpcError> {
    let fields = parsed(state).map_err(RpcError::internal)?;
    let placements = if fields.is_empty() {
        vec![]
    } else {
        let view = projection(state, &fields).map_err(RpcError::internal)?;
        view.placements
            .iter()
            .map(|(p, id, stamp)| {
                let matches = if active(state).is_some_and(|m| m.machine_id() == p.machine_id) {
                    local_matches(state, p, &view.placements)
                } else {
                    matches_for(p, &view.placements)
                };
                let winner = matches.into_iter().max_by_key(|(_, _, s)| s);
                let (id, stamp) = winner.map(|(_, id, s)| (*id, s)).unwrap_or((*id, stamp));
                SpacePlacement {
                    project: p.clone(),
                    space_id: view.resolved(id),
                    lamport: stamp.0,
                    signer: stamp.1.clone(),
                    op_id: stamp.2.clone(),
                }
            })
            .collect()
    };
    Ok(SpacesListResult { spaces: state.orchestrator.list_spaces()?, placements })
}

#[cfg(test)]
mod tests {
    use super::super::{
        SelfInfo, Timing,
        peers::{self, Direction, FrameSink},
        tailscale::Fake,
        testutil::TempDir,
    };
    use super::*;
    use tokio::sync::mpsc;
    struct Node {
        state: AppState,
        _dir: TempDir,
    }
    impl Node {
        fn new(name: &str) -> Self {
            let dir = TempDir::new(name);
            let paths = crate::config::Paths::resolve(Some(dir.path().into())).unwrap();
            let state = AppState::initialize_with(&paths, Arc::new(Fake::new(dir.path().join("tailscale.json"))), Timing::fast()).unwrap();
            state.network.set_enabled(true);
            Self { state, _dir: dir }
        }
        fn m(&self) -> &Membership {
            self.state.network.membership().unwrap()
        }
        fn info(&self) -> SelfInfo {
            SelfInfo { name: self.m().machine_id(), os: "test".into(), ts_node_id: None, ts_name: None, port: None }
        }
        fn spaces(&self) -> Vec<Space> {
            self.state.store.spaces_list().unwrap()
        }
        async fn create(&self, name: &str) -> Space {
            prepare(&self.state).unwrap();
            let before = self.spaces();
            let s = self.state.orchestrator.create_space(name.into(), None, None).await.unwrap();
            record(&self.state, &before, None).unwrap();
            s
        }
        async fn patch(&self, id: SpaceId, name: Option<&str>, color: Option<SpaceColor>) {
            prepare(&self.state).unwrap();
            let before = self.spaces();
            self.state.orchestrator.update_space(id, name.map(str::to_string), color, None).await.unwrap();
            record(&self.state, &before, None).unwrap();
        }
        fn delete(&self, id: SpaceId) {
            prepare(&self.state).unwrap();
            let before = self.spaces();
            self.state.orchestrator.delete_space(id).unwrap();
            record(&self.state, &before, None).unwrap();
        }
        fn project(&self, name: &str, roots: &[&str], remote: Option<&str>, space: SpaceId) -> Project {
            let now = Utc::now();
            let p = Project {
                id: Uuid::now_v7(),
                name: name.into(),
                path: self._dir.path().join(name).to_string_lossy().into_owned(),
                is_git: !roots.is_empty(),
                repo: Some(RepoIdentity {
                    root_commit: roots.first().map(|s| s.to_string()),
                    root_commits: roots.iter().map(|s| s.to_string()).collect(),
                    remote: remote.map(str::to_string),
                }),
                repos: vec![],
                space_id: Some(space),
                created_at: now,
                updated_at: now,
                kind: ProjectKind::Single,
                members: vec![],
                worktree_copy: vec![],
                instructions_offer_dismissed: false,
                worktrees_default: None,
                task_prefix: None,
                brief_in_all_threads: false,
                coordinator: None,
            };
            self.state.store.project_insert(&p).unwrap();
            let identity = ProjectRepoIdentity { repo: p.repo.clone(), repos: p.repos.clone() };
            self.state.store.project_set_repo_identity(p.id, Some(&identity)).unwrap();
            p
        }
    }
    impl Drop for Node {
        fn drop(&mut self) {
            self.state.shutdown.cancel();
            self.state.network.peers.close_all();
        }
    }
    fn form(a: &Node, b: &Node) {
        a.m().genesis("owner", "test", &a.info()).unwrap();
        a.m().add(b.m().self_descriptor(&b.info()), JoinVia::Auto).unwrap();
        b.m().join(a.m().all_ops()).unwrap();
    }
    struct Sink(mpsc::UnboundedSender<String>);
    #[async_trait::async_trait]
    impl FrameSink for Sink {
        async fn send(&self, v: Value) -> bool {
            self.0.send(v.to_string()).is_ok()
        }
    }
    struct Wire {
        a: Arc<PeerLink>,
        b: Arc<PeerLink>,
        tasks: Vec<tokio::task::JoinHandle<()>>,
    }
    impl Drop for Wire {
        fn drop(&mut self) {
            self.a.close();
            self.b.close();
            for t in &self.tasks {
                t.abort();
            }
        }
    }
    fn wire(a: &Node, b: &Node) -> Wire {
        let (atx, mut arx) = mpsc::unbounded_channel::<String>();
        let (btx, mut brx) = mpsc::unbounded_channel::<String>();
        let al = PeerLink::new(b.m().machine_id(), Direction::Dialed, None, vec![Scope::MachinePeer], Arc::new(Sink(btx)));
        let bl = PeerLink::new(a.m().machine_id(), Direction::Accepted, None, vec![Scope::MachinePeer], Arc::new(Sink(atx)));
        let aa = al.clone();
        let ast = a.state.clone();
        let ba = bl.clone();
        let bst = b.state.clone();
        let ta = tokio::spawn(async move {
            while let Some(v) = arx.recv().await {
                peers::inbound(&ast, &aa, &v).await;
            }
        });
        let tb = tokio::spawn(async move {
            while let Some(v) = brx.recv().await {
                peers::inbound(&bst, &ba, &v).await;
            }
        });
        Wire { a: al, b: bl, tasks: vec![ta, tb] }
    }
    async fn exchange(a: &Node, b: &Node, initial: bool) {
        let w = wire(a, b);
        sync(&a.state, &w.a, initial).await;
        sync(&a.state, &w.a, false).await;
        assert_eq!(
            ops::digest_of(&parsed(&a.state).unwrap().iter().map(|(e, _)| e.id.clone()).collect::<Vec<_>>()),
            ops::digest_of(&parsed(&b.state).unwrap().iter().map(|(e, _)| e.id.clone()).collect::<Vec<_>>())
        );
    }
    #[tokio::test]
    async fn first_merge_unions_names_and_initiators_default_and_placement_win() {
        let a = Node::new("space-a");
        let b = Node::new("space-b");
        let ad = a.spaces()[0].id;
        let bd = b.spaces()[0].id;
        a.patch(ad, Some("A"), None).await;
        b.patch(bd, Some("C"), None).await;
        let ab = a.create("B").await;
        b.create("D").await;
        let pa = a.project("a", &["root"], None, ab.id);
        let pb = b.project("b", &["root"], None, bd);
        form(&a, &b);
        exchange(&a, &b, true).await;
        assert_eq!(a.spaces(), b.spaces());
        assert_eq!(a.spaces().iter().map(|s| s.name.as_str()).collect::<BTreeSet<_>>(), ["A", "B", "C", "D"].into());
        assert_eq!(a.spaces().iter().find(|s| s.is_default).unwrap().id, ad);
        assert_eq!(b.state.store.project_get(pb.id).unwrap().unwrap().space_id, Some(ab.id));
        assert_eq!(a.state.store.project_get(pa.id).unwrap().unwrap().space_id, Some(ab.id));
        assert!(a.state.store.network_ops_list().unwrap().iter().all(|op| !op.kind.contains("space")));
    }
    #[tokio::test]
    async fn offline_field_edits_and_conflicting_moves_converge_without_losing_other_fields() {
        let a = Node::new("space-a");
        let b = Node::new("space-b");
        let work = a.create("Work").await;
        form(&a, &b);
        exchange(&a, &b, true).await;
        a.patch(work.id, Some("Build"), None).await;
        b.patch(work.id, None, Some(SpaceColor::Pink)).await;
        exchange(&a, &b, false).await;
        let s = a.spaces().into_iter().find(|s| s.id == work.id).unwrap();
        assert_eq!((s.name.as_str(), s.color), ("Build", SpaceColor::Pink));
        let home = a.create("Home").await;
        exchange(&a, &b, false).await;
        let pa = a.project("p", &["r"], None, work.id);
        reconcile(&a.state).await;
        exchange(&a, &b, false).await;
        let project = reference(&a.m().machine_id(), &pa);
        place(&a.state, SpacesPlaceParams { project: project.clone(), space_id: home.id }).await.unwrap();
        place(&b.state, SpacesPlaceParams { project, space_id: work.id }).await.unwrap();
        exchange(&a, &b, false).await;
        let av = list(&a.state).unwrap();
        let bv = list(&b.state).unwrap();
        assert_eq!(av.placements, bv.placements);
    }
    #[tokio::test]
    async fn deletion_is_permanent_falls_back_to_default_and_later_moves_and_recreation_survive() {
        let a = Node::new("space-a");
        let b = Node::new("space-b");
        let work = a.create("Work").await;
        let home = a.create("Home").await;
        let p = a.project("p", &["r"], None, work.id);
        form(&a, &b);
        exchange(&a, &b, true).await;
        a.delete(work.id);
        b.patch(work.id, Some("Stale rename"), None).await;
        exchange(&a, &b, false).await;
        assert!(!a.spaces().iter().any(|s| s.id == work.id));
        assert_eq!(a.state.store.project_get(p.id).unwrap().unwrap().space_id, a.spaces().iter().find(|s| s.is_default).map(|s| s.id));
        place(&b.state, SpacesPlaceParams { project: reference(&a.m().machine_id(), &p), space_id: home.id }).await.unwrap();
        exchange(&a, &b, false).await;
        assert_eq!(a.state.store.project_get(p.id).unwrap().unwrap().space_id, Some(home.id));
        let again = a.create("Work").await;
        exchange(&a, &b, false).await;
        assert!(b.spaces().iter().any(|s| s.id == again.id));
        assert_ne!(again.id, work.id);
    }
    #[tokio::test]
    async fn independent_same_names_merge_but_concurrent_renames_are_disambiguated_and_overflow_is_kept() {
        let a = Node::new("space-a");
        let b = Node::new("space-b");
        let work = a.create("Work").await;
        let twin = b.create("work").await;
        let x = a.create("X").await;
        let y = b.create("Y").await;
        for i in 0..26 {
            a.create(&format!("a{i}")).await;
            b.create(&format!("b{i}")).await;
        }
        form(&a, &b);
        exchange(&a, &b, true).await;
        assert_eq!(a.spaces().len(), 56); // Personal and Work coalesce; all 52 distinct imports survive.
        assert!(a.state.orchestrator.create_space("blocked".into(), None, None).await.is_err());
        assert_eq!(a.spaces().iter().filter(|s| s.id == work.id || s.id == twin.id).count(), 1);
        a.patch(x.id, Some("Shared"), None).await;
        b.patch(y.id, Some("Shared"), None).await;
        exchange(&a, &b, false).await;
        let shared: Vec<_> = a.spaces().into_iter().filter(|s| s.name.starts_with("Shared (")).collect();
        assert_eq!(shared.len(), 2);
        assert_ne!(shared[0].name, shared[1].name);
    }
    #[tokio::test]
    async fn later_joiner_imports_new_spaces_without_overwriting_established_network() {
        let a = Node::new("space-a");
        let b = Node::new("space-b");
        form(&a, &b);
        exchange(&a, &b, true).await;
        let work = a.create("Work").await;
        let pa = a.project("p", &["r"], None, work.id);
        reconcile(&a.state).await;
        exchange(&a, &b, false).await;
        let c = Node::new("space-upgraded");
        let cd = c.spaces()[0].id;
        let cp = c.project("clone", &["r"], None, cd);
        c.create("New offline space").await;
        a.m().add(c.m().self_descriptor(&c.info()), JoinVia::Auto).unwrap();
        c.m().join(a.m().all_ops()).unwrap();
        exchange(&c, &a, true).await;
        assert_eq!(c.state.store.project_get(cp.id).unwrap().unwrap().space_id, Some(work.id));
        assert!(a.spaces().iter().any(|s| s.name == "New offline space"));
        assert_eq!(a.state.store.project_get(pa.id).unwrap().unwrap().space_id, Some(work.id));
    }
    #[tokio::test]
    async fn new_clones_identity_refresh_local_fallback_and_group_keys_preserve_logical_semantics() {
        let a = Node::new("space-a");
        let b = Node::new("space-b");
        let work = a.create("Work").await;
        a.project("p", &["a", "m"], Some("host/fork"), work.id);
        form(&a, &b);
        exchange(&a, &b, true).await;
        let bd = b.spaces().into_iter().find(|s| s.is_default).unwrap().id;
        let p = b.project("clone", &["m", "z"], Some("host/other"), bd);
        reconcile(&b.state).await;
        assert_eq!(b.state.store.project_get(p.id).unwrap().unwrap().space_id, Some(work.id));
        let remote = b.project("shallow", &[], Some("host/fork"), bd);
        reconcile(&b.state).await;
        assert_eq!(b.state.store.project_get(remote.id).unwrap().unwrap().space_id, Some(work.id));
        let plain = b.project("folder", &[], None, bd);
        reconcile(&b.state).await;
        assert_eq!(b.state.store.project_get(plain.id).unwrap().unwrap().space_id, Some(bd));
        let mut group = reference(&a.m().machine_id(), &p);
        group.kind = ProjectKind::Group;
        group.repos = vec![RepoIdentity { root_commit: Some("a".into()), ..Default::default() }];
        let single = reference(&a.m().machine_id(), &p);
        assert!(matches_for(&group, &[(single, work.id, (1, "a".into(), "b".into()))]).is_empty());
    }
    #[tokio::test]
    async fn signatures_network_scope_and_leave_rejoin_keep_local_state_without_old_tombstones() {
        let a = Node::new("space-a");
        let b = Node::new("space-b");
        let work = a.create("Work").await;
        form(&a, &b);
        exchange(&a, &b, true).await;
        let mut field = a.state.store.space_replica_fields().unwrap().remove(0);
        field.signature = B64.encode([0u8; 64]);
        assert!(validate(&b.state, &[field]).is_err());
        a.delete(work.id);
        exchange(&a, &b, false).await;
        let rail = b.spaces();
        b.m().leave_and_reset().unwrap();
        assert_eq!(rail, b.spaces());
        assert!(b.state.store.space_replica_fields().unwrap().is_empty());
        b.m().genesis("new-owner", "new-tailnet", &b.info()).unwrap();
        let local = b.create("Work").await;
        assert!(b.spaces().iter().any(|s| s.id == local.id));
        assert!(validate(&b.state, &a.state.store.space_replica_fields().unwrap()).is_err());
    }
    #[tokio::test]
    async fn explicit_desktop_initiator_wins_even_when_the_other_machine_dials() {
        let a = Node::new("space-desktop");
        let b = Node::new("space-dialer");
        let ad = a.spaces()[0].id;
        a.patch(ad, Some("Desktop default"), None).await;
        prefer_local(&a.state).unwrap();
        form(&a, &b);
        exchange(&b, &a, true).await;
        assert_eq!(a.spaces().iter().find(|s| s.is_default).unwrap().id, ad);
        assert_eq!(a.spaces(), b.spaces());
    }
    #[tokio::test]
    async fn fallback_identity_rebases_after_rejoin_and_adopts_moves_made_while_away() {
        let a = Node::new("space-a");
        let b = Node::new("space-b");
        let work = a.create("Work").await;
        let folder = b.project("folder", &[], None, b.spaces()[0].id);
        form(&a, &b);
        exchange(&a, &b, true).await;
        let old = b.m().machine_id();
        // A retains the authoritative move while B's retained local projection is deliberately stale.
        place(&a.state, SpacesPlaceParams { project: reference(&old, &folder), space_id: work.id }).await.unwrap();
        a.m().remove(&old, RemoveReason::User).unwrap();
        b.m().leave_and_reset().unwrap();
        a.m().add(b.m().self_descriptor(&b.info()), JoinVia::Code).unwrap();
        b.m().join(a.m().all_ops()).unwrap();
        exchange(&b, &a, true).await;
        reconcile(&b.state).await;
        assert_eq!(b.state.store.project_get(folder.id).unwrap().unwrap().space_id, Some(work.id));
        let rebased = list(&b.state)
            .unwrap()
            .placements
            .into_iter()
            .find(|p| p.project.machine_id == b.m().machine_id() && p.project.project_id == folder.id)
            .unwrap();
        assert_eq!(rebased.space_id, work.id);
    }
    #[tokio::test]
    async fn logos_are_content_addressed_and_a_second_holder_can_supply_them() {
        let a = Node::new("space-logo-a");
        let b = Node::new("space-logo-b");
        let work = a.create("Work").await;
        let image = image::RgbaImage::from_pixel(128, 128, image::Rgba([1, 100, 220, 255]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let bytes = bytes.into_inner();
        let id = Uuid::now_v7();
        std::fs::create_dir_all(&a.state.paths.assets).unwrap();
        std::fs::write(a.state.paths.assets.join(id.to_string()), &bytes).unwrap();
        a.state
            .store
            .asset_insert(&AssetInfo {
                id,
                name: "logo.png".into(),
                media_type: "image/png".into(),
                size: bytes.len() as u64,
                created_at: Utc::now(),
            })
            .unwrap();
        a.state.orchestrator.update_space(work.id, None, None, Some(SpaceLogo::Image { asset_id: id })).await.unwrap();
        form(&a, &b);
        // Untouched preexisting image: bootstrap alone must import its birth/hash pair at the same clock.
        let w = wire(&a, &b);
        b.state.network.peers.register(w.b.clone());
        sync(&a.state, &w.a, true).await;
        let fields = parsed(&b.state).unwrap();
        let hash = fields.iter().find_map(|(_, f)| f.value.get("hash").and_then(Value::as_str)).unwrap().to_string();
        super::super::harness::eventually(
            "receiver fetches a pushed initial logo without its own sync tick",
            std::time::Duration::from_secs(3),
            || b.state.store.space_logo_get(&hash).unwrap().is_some(),
        )
        .await;
        let c = Node::new("space-logo-c");
        a.m().add(c.m().self_descriptor(&c.info()), JoinVia::Auto).unwrap();
        b.m().apply_ops(a.m().all_ops()).unwrap();
        c.m().join(a.m().all_ops()).unwrap();
        // A is not linked: C gets both the signed reference and bytes from B.
        let wc = wire(&b, &c);
        c.state.network.peers.register(wc.b.clone());
        sync(&b.state, &wc.a, false).await;
        sync(&c.state, &wc.b, false).await;
        assert!(c.state.store.space_logo_get(&hash).unwrap().is_some());
        let logo = c.spaces().into_iter().find(|s| s.id == work.id).unwrap().logo;
        let SpaceLogo::Image { asset_id } = logo else { panic!("image logo lost") };
        assert!(c.state.paths.assets.join(asset_id.to_string()).exists());
        assert!(c.state.store.asset_get(asset_id).unwrap().is_some());
    }
    #[tokio::test]
    async fn older_peer_method_not_found_preserves_its_local_rail_and_new_peers_import_it_later() {
        let a = Node::new("space-new");
        let b = Node::new("space-old");
        b.create("Old local work").await;
        form(&a, &b);
        let before = b.spaces();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let al = PeerLink::new(b.m().machine_id(), Direction::Dialed, None, vec![Scope::MachinePeer], Arc::new(Sink(tx)));
        let answer_link = al.clone();
        let old = tokio::spawn(async move {
            while let Some(raw) = rx.recv().await {
                let value: Value = serde_json::from_str(&raw).unwrap();
                let response = rpc::RpcResponse::err(
                    serde_json::from_value(value["id"].clone()).unwrap(),
                    RpcError::method_not_found("peer.spaces.sync"),
                );
                answer_link.deliver(response);
            }
        });
        sync(&a.state, &al, true).await;
        old.abort();
        al.close();
        assert_eq!(b.spaces(), before);
        assert!(b.state.store.space_replica_fields().unwrap().is_empty());
        exchange(&a, &b, true).await;
        assert!(a.spaces().iter().any(|s| s.name == "Old local work"));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn socket_harness_pushes_live_changes_and_reconnects_offline_placements() {
        use super::super::harness::*;
        let Some(cluster) = Cluster::new(&[NodeSpec::owner("spaces-a"), NodeSpec::owner("spaces-b")]) else {
            return;
        };
        let a = cluster.start("spaces-a", true).await;
        let b = cluster.start("spaces-b", true).await;
        cluster.form(&a, &[&b], JoinVia::Auto).await;
        eventually("links", WAIT, || linked(&a, &b)).await;
        let client =
            kybern_client::Client::connect(&kybern_client::Endpoint { url: a.ws_url(), token: a.device_token(&Scope::ALL) }).await.unwrap();
        let work = client.call::<SpacesCreate>(SpacesCreateParams { name: "Work".into(), color: None, logo: None }).await.unwrap();
        eventually("live Space push", WAIT, || b.state.store.space_get(work.id).unwrap().is_some()).await;
        b.set_network_enabled(false);
        eventually("b offline", WAIT, || a.state.network.peers.link(&b.id()).is_none()).await;
        client
            .call::<SpacesUpdate>(SpacesUpdateParams { space_id: work.id, name: Some("Offline rename".into()), color: None, logo: None })
            .await
            .unwrap();
        b.set_network_enabled(true);
        eventually("offline field caught up", WAIT, || {
            b.state.store.space_get(work.id).unwrap().is_some_and(|s| s.name == "Offline rename")
        })
        .await;
        let scoped = kybern_client::Client::connect(&kybern_client::Endpoint {
            url: a.ws_url(),
            token: a.device_token(&[Scope::OrchestrationRead]),
        })
        .await
        .unwrap();
        assert!(
            scoped.call::<SpacesDelete>(SpacesDeleteParams { space_id: work.id }).await.unwrap_err().to_string().contains("orchestration")
        );
    }
    #[tokio::test]
    async fn a_paired_creation_logo_applies_in_both_op_id_orders() {
        let a = Node::new("space-logo-order");
        let b = Node::new("space-logo-order-peer");
        form(&a, &b);
        let space = a.spaces()[0].clone();
        let hash = "a".repeat(64);
        // The projection trusts the verified blob store; peer tests above verify actual PNG bytes and their hash.
        a.state.store.space_logo_put(&hash, b"verified-projection-fixture").unwrap();
        let birth = seal(a.m(), IMPORT, space_entity(space.id), "birth", birth_value(&space).unwrap()).unwrap();
        let logo = seal(a.m(), IMPORT, space_entity(space.id), "logo", json!({"hash":hash})).unwrap();
        let default = seal(a.m(), IMPORT, "network".into(), "default", json!(space.id)).unwrap();
        // Projection uses verified ids only as ordering keys. Control those keys here to cover both branches deterministically;
        // the untouched-image peer test separately exercises actual hashes, signatures, download and asset installation.
        for (birth_id, logo_op_id) in [("0", "f"), ("f", "0")] {
            let mut birth = birth.clone();
            birth.id = birth_id.into();
            let mut logo = logo.clone();
            logo.id = logo_op_id.into();
            let fields = [birth, logo, default.clone()]
                .into_iter()
                .map(|e| {
                    let f = serde_json::from_str(&e.body).unwrap();
                    (e, f)
                })
                .collect();
            let view = projection(&a.state, &fields).unwrap();
            assert_eq!(view.spaces[0].logo, SpaceLogo::Image { asset_id: logo_id(&hash).unwrap() });
        }
    }
    #[tokio::test]
    async fn clone_and_identity_refresh_preserve_the_original_placement_authority() {
        let mut nodes = [Node::new("space-authority-1"), Node::new("space-authority-2"), Node::new("space-authority-3")];
        nodes.sort_by_key(|n| n.m().machine_id());
        let [a, b, c] = &nodes;
        let x = a.create("X").await;
        let y = a.create("Y").await;
        let pa = a.project("original", &["r"], None, a.spaces()[0].id);
        form(a, b);
        a.m().add(c.m().self_descriptor(&c.info()), JoinVia::Auto).unwrap();
        b.m().apply_ops(a.m().all_ops()).unwrap();
        c.m().join(a.m().all_ops()).unwrap();
        exchange(a, b, true).await;
        exchange(a, c, false).await;
        let project = reference(&a.m().machine_id(), &pa);
        let ax = seal(a.m(), 5, project_entity(&project), "placement", json!({"project":project,"space_id":x.id})).unwrap();
        let by = seal(b.m(), 5, project_entity(&project), "placement", json!({"project":project,"space_id":y.id})).unwrap();
        a.state.store.space_replica_keep(&[ax]).unwrap();
        b.state.store.space_replica_keep(std::slice::from_ref(&by)).unwrap();
        // C learns only A's edit, then adds a clone and refreshes its identity before it can see B's competing edit.
        let clone = c.project("clone", &["r"], None, c.spaces().iter().find(|s| s.is_default).unwrap().id);
        exchange(a, c, false).await;
        reconcile(&c.state).await;
        assert_eq!(c.state.store.project_get(clone.id).unwrap().unwrap().space_id, Some(x.id));
        assert!(
            parsed(&c.state).unwrap().iter().all(|(e, f)| f.field != "placement" || e.signer != c.m().machine_id()),
            "automatic inheritance must not sign a new placement"
        );
        let identity = ProjectRepoIdentity {
            repo: Some(RepoIdentity { root_commit: Some("r".into()), remote: Some("host/refreshed".into()), ..Default::default() }),
            repos: vec![],
        };
        c.state.store.project_set_repo_identity(clone.id, Some(&identity)).unwrap();
        reconcile(&c.state).await;
        exchange(b, c, false).await;
        assert_eq!(
            c.state.store.project_get(clone.id).unwrap().unwrap().space_id,
            Some(y.id),
            "B>A decides the explicit conflict even though C>B"
        );
        let resolved = list(&c.state).unwrap().placements.into_iter().find(|p| p.project.project_id == clone.id).unwrap();
        assert_eq!((resolved.lamport, resolved.signer, resolved.op_id), (5, b.m().machine_id(), by.id));
    }
}
