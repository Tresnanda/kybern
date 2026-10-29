//! The machine network's rows: the membership operation set, the cache of peer
//! descriptors and presence, a project's repository identity, and the device
//! a token was issued to.
//!
//! The store only keeps bytes and indexes. Verifying signatures and folding
//! operations into members is the daemon's job (`network/ops.rs`).

use anyhow::Result;
use chrono::{DateTime, Utc};
use kybern_protocol::{MachineDescriptor, PeerPresence, ProjectId, ProjectRepoIdentity};
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use crate::{Store, parse_time};

/// One membership operation as stored: the exact signed bytes plus the fields worth indexing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkOpRecord {
    /// `sha256(body)` as lowercase hex.
    pub id: String,
    /// The exact signed JSON text; never re-serialized.
    pub body: Vec<u8>,
    pub signer: String,
    pub signature: Vec<u8>,
    /// `genesis`, `add`, `remove`, `set`, `merge`, or a kind this build does not know.
    pub kind: String,
    pub lamport: u64,
    pub received_at: DateTime<Utc>,
}

/// A peer as `network_machines` caches it.
#[derive(Debug, Clone, PartialEq)]
pub struct NetworkMachineRecord {
    pub machine_id: String,
    pub descriptor: MachineDescriptor,
    pub presence: Option<PeerPresence>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

const OP_SELECT: &str = "SELECT id, body, signer, signature, kind, lamport, received_at FROM network_ops";

fn row_to_op(r: &rusqlite::Row<'_>) -> rusqlite::Result<NetworkOpRecord> {
    Ok(NetworkOpRecord {
        id: r.get(0)?,
        body: r.get(1)?,
        signer: r.get(2)?,
        signature: r.get(3)?,
        kind: r.get(4)?,
        lamport: r.get::<_, i64>(5)? as u64,
        received_at: parse_time(r.get::<_, String>(6)?)?,
    })
}

fn json_column<T: serde::de::DeserializeOwned>(r: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<T>> {
    r.get::<_, Option<String>>(index)?
        .map(|json| serde_json::from_str(&json))
        .transpose()
        .map_err(|error| rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(error)))
}

fn row_to_machine(r: &rusqlite::Row<'_>) -> rusqlite::Result<NetworkMachineRecord> {
    Ok(NetworkMachineRecord {
        machine_id: r.get(0)?,
        descriptor: json_column(r, 1)?.ok_or(rusqlite::Error::InvalidColumnType(1, "descriptor".into(), rusqlite::types::Type::Null))?,
        presence: json_column(r, 2)?,
        last_seen_at: r.get::<_, Option<String>>(3)?.map(parse_time).transpose()?,
    })
}

const MACHINE_SELECT: &str = "SELECT machine_id, descriptor, presence, last_seen_at FROM network_machines";

impl Store {
    // ---- membership operations ----

    /// Keep an operation. Returns whether it was new; a repeat of a known id changes nothing.
    pub fn network_op_insert(&self, op: &NetworkOpRecord) -> Result<bool> {
        self.with(|c| {
            Ok(c.execute(
                "INSERT OR IGNORE INTO network_ops(id, body, signer, signature, kind, lamport, received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![op.id, op.body, op.signer, op.signature, op.kind, op.lamport as i64, op.received_at.to_rfc3339()],
            )? > 0)
        })
    }

    pub fn network_op_get(&self, id: &str) -> Result<Option<NetworkOpRecord>> {
        self.with(|c| Ok(c.query_row(&format!("{OP_SELECT} WHERE id = ?1"), [id], row_to_op).optional()?))
    }

    /// Every operation, oldest first: by `lamport`, then arrival, then id.
    pub fn network_ops_list(&self) -> Result<Vec<NetworkOpRecord>> {
        self.with(|c| {
            let mut st = c.prepare(&format!("{OP_SELECT} ORDER BY lamport, received_at, id"))?;
            let rows = st.query_map([], row_to_op)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// The ids of all operations, sorted: what the sync digest hashes.
    pub fn network_op_ids(&self) -> Result<Vec<String>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT id FROM network_ops ORDER BY id")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// The operations whose ids are not in `known`, in the same order as [`Store::network_ops_list`].
    pub fn network_ops_missing_from(&self, known: &[String]) -> Result<Vec<NetworkOpRecord>> {
        let known: std::collections::HashSet<&str> = known.iter().map(String::as_str).collect();
        Ok(self.network_ops_list()?.into_iter().filter(|op| !known.contains(op.id.as_str())).collect())
    }

    /// The highest `lamport` held, or 0 with no operations. A new operation uses this plus one.
    pub fn network_max_lamport(&self) -> Result<u64> {
        self.with(|c| Ok(c.query_row("SELECT COALESCE(MAX(lamport), 0) FROM network_ops", [], |r| r.get::<_, i64>(0))? as u64))
    }

    /// Forget the whole membership set and the machine cache.
    /// Used when a removed machine leaves its network and becomes a lone machine again.
    pub fn network_clear(&self) -> Result<()> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            tx.execute("DELETE FROM network_ops", [])?;
            tx.execute("DELETE FROM network_machines", [])?;
            tx.commit()?;
            Ok(())
        })
    }

    // ---- machine cache ----

    /// Create or replace a peer's descriptor, keeping its presence and last-seen time.
    pub fn network_machine_upsert(&self, descriptor: &MachineDescriptor) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO network_machines(machine_id, descriptor) VALUES (?1, ?2)
                 ON CONFLICT(machine_id) DO UPDATE SET descriptor = excluded.descriptor",
                params![descriptor.machine_id, serde_json::to_string(descriptor)?],
            )?;
            Ok(())
        })
    }

    /// Store a peer's latest presence and mark it seen. Returns false when the machine is not cached.
    pub fn network_machine_set_presence(&self, machine_id: &str, presence: &PeerPresence, seen_at: DateTime<Utc>) -> Result<bool> {
        self.with(|c| {
            Ok(c.execute(
                "UPDATE network_machines SET presence = ?2, last_seen_at = ?3 WHERE machine_id = ?1",
                params![machine_id, serde_json::to_string(presence)?, seen_at.to_rfc3339()],
            )? > 0)
        })
    }

    /// Mark a peer seen without new presence. Returns false when the machine is not cached.
    pub fn network_machine_touch(&self, machine_id: &str, seen_at: DateTime<Utc>) -> Result<bool> {
        self.with(|c| {
            Ok(c.execute("UPDATE network_machines SET last_seen_at = ?2 WHERE machine_id = ?1", params![machine_id, seen_at.to_rfc3339()])?
                > 0)
        })
    }

    pub fn network_machine_get(&self, machine_id: &str) -> Result<Option<NetworkMachineRecord>> {
        self.with(|c| Ok(c.query_row(&format!("{MACHINE_SELECT} WHERE machine_id = ?1"), [machine_id], row_to_machine).optional()?))
    }

    pub fn network_machines_list(&self) -> Result<Vec<NetworkMachineRecord>> {
        self.with(|c| {
            let mut st = c.prepare(&format!("{MACHINE_SELECT} ORDER BY machine_id"))?;
            let rows = st.query_map([], row_to_machine)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    pub fn network_machine_delete(&self, machine_id: &str) -> Result<bool> {
        self.with(|c| Ok(c.execute("DELETE FROM network_machines WHERE machine_id = ?1", [machine_id])? > 0))
    }

    // ---- repository identity ----

    /// Cache a project's repository identity. `None` clears it. Returns whether the project exists
    /// and the stored value changed; an identical refresh stays quiet and leaves `updated_at` alone.
    pub fn project_set_repo_identity(&self, id: ProjectId, identity: Option<&ProjectRepoIdentity>) -> Result<bool> {
        let json = identity.map(serde_json::to_string).transpose()?;
        self.with(|c| {
            Ok(c.execute(
                "UPDATE projects SET repo_identity = ?2 WHERE id = ?1 AND repo_identity IS NOT ?2",
                params![id.to_string(), json],
            )? > 0)
        })
    }

    // ---- device tokens ----

    /// Tie a token to the client device it was issued to and, for a token another machine asked
    /// for, to that machine.
    pub fn token_set_device(&self, token_id: Uuid, device_id: &str, issued_via: Option<&str>) -> Result<bool> {
        self.with(|c| {
            Ok(c.execute(
                "UPDATE tokens SET device_id = ?2, issued_via = ?3 WHERE id = ?1",
                params![token_id.to_string(), device_id, issued_via],
            )? > 0)
        })
    }

    /// Revoke every token another machine asked this one to issue for a client (`issued_via`).
    /// Returns the ids that were still active. A removed machine's tokens die with it (§2.5).
    pub fn tokens_revoke_issued_via(&self, machine_id: &str) -> Result<Vec<Uuid>> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let ids = {
                let mut st = tx.prepare("SELECT id FROM tokens WHERE issued_via = ?1 AND revoked = 0 ORDER BY created_at, id")?;
                let rows = st.query_map([machine_id], |r| r.get::<_, String>(0))?;
                rows.map(|id| Ok(id?.parse()?)).collect::<Result<Vec<Uuid>>>()?
            };
            tx.execute("UPDATE tokens SET revoked = 1 WHERE issued_via = ?1 AND revoked = 0", [machine_id])?;
            tx.commit()?;
            Ok(ids)
        })
    }

    /// Revoke every token any machine asked this one to issue. A machine that left its network
    /// forgets the clients it served for the network's members (§2.5).
    pub fn tokens_revoke_all_issued_via(&self) -> Result<Vec<Uuid>> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let ids = {
                let mut st = tx.prepare("SELECT id FROM tokens WHERE issued_via IS NOT NULL AND revoked = 0 ORDER BY created_at, id")?;
                let rows = st.query_map([], |r| r.get::<_, String>(0))?;
                rows.map(|id| Ok(id?.parse()?)).collect::<Result<Vec<Uuid>>>()?
            };
            tx.execute("UPDATE tokens SET revoked = 1 WHERE issued_via IS NOT NULL AND revoked = 0", [])?;
            tx.commit()?;
            Ok(ids)
        })
    }

    /// Revoke the tokens one machine issued to one device, so a client that asks again gets a
    /// single fresh token. Returns the ids that were still active.
    pub fn tokens_revoke_device_via(&self, device_id: &str, issued_via: &str) -> Result<Vec<Uuid>> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let ids = {
                let mut st =
                    tx.prepare("SELECT id FROM tokens WHERE device_id = ?1 AND issued_via = ?2 AND revoked = 0 ORDER BY created_at, id")?;
                let rows = st.query_map(params![device_id, issued_via], |r| r.get::<_, String>(0))?;
                rows.map(|id| Ok(id?.parse()?)).collect::<Result<Vec<Uuid>>>()?
            };
            tx.execute(
                "UPDATE tokens SET revoked = 1 WHERE device_id = ?1 AND issued_via = ?2 AND revoked = 0",
                params![device_id, issued_via],
            )?;
            tx.commit()?;
            Ok(ids)
        })
    }

    /// The device a token was issued to, if it has one.
    pub fn token_device(&self, token_id: Uuid) -> Result<Option<String>> {
        self.with(|c| {
            Ok(c.query_row("SELECT device_id FROM tokens WHERE id = ?1", [token_id.to_string()], |r| r.get::<_, Option<String>>(0))
                .optional()?
                .flatten())
        })
    }

    /// Give every active token that lacks `scope` that scope, for the tokens `keep` accepts (by
    /// label). Used when an upgrade adds a scope that paired clients should already hold. Returns
    /// how many tokens changed.
    pub fn tokens_add_scope(&self, scope: kybern_protocol::Scope, keep: impl Fn(&str) -> bool) -> Result<usize> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let rows: Vec<(String, String, String)> = {
                let mut st = tx.prepare("SELECT id, label, scopes FROM tokens WHERE revoked = 0")?;
                let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
                rows.collect::<Result<_, _>>()?
            };
            let mut changed = 0;
            for (id, label, scopes) in rows {
                let mut parsed: Vec<kybern_protocol::Scope> = serde_json::from_str(&scopes)?;
                if parsed.contains(&scope) || !keep(&label) {
                    continue;
                }
                parsed.push(scope);
                tx.execute("UPDATE tokens SET scopes = ?2 WHERE id = ?1", params![id, serde_json::to_string(&parsed)?])?;
                changed += 1;
            }
            tx.commit()?;
            Ok(changed)
        })
    }

    /// The ids of the tokens issued to a device, revoked or not.
    pub fn tokens_for_device(&self, device_id: &str) -> Result<Vec<Uuid>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT id FROM tokens WHERE device_id = ?1 ORDER BY created_at, id")?;
            let rows = st.query_map([device_id], |r| r.get::<_, String>(0))?;
            rows.map(|id| Ok(id?.parse()?)).collect()
        })
    }

    /// Revoke every token issued to a device. Returns the ids that were still active.
    pub fn tokens_revoke_device(&self, device_id: &str) -> Result<Vec<Uuid>> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let ids = {
                let mut st = tx.prepare("SELECT id FROM tokens WHERE device_id = ?1 AND revoked = 0 ORDER BY created_at, id")?;
                let rows = st.query_map([device_id], |r| r.get::<_, String>(0))?;
                rows.map(|id| Ok(id?.parse()?)).collect::<Result<Vec<Uuid>>>()?
            };
            tx.execute("UPDATE tokens SET revoked = 1 WHERE device_id = ?1 AND revoked = 0", [device_id])?;
            tx.commit()?;
            Ok(ids)
        })
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use kybern_protocol::{HarnessSummary, ProviderKind, RepoIdentity, Scope};
    use rusqlite::Connection;

    use super::*;
    use crate::schema;

    fn op(id: &str, kind: &str, lamport: u64) -> NetworkOpRecord {
        NetworkOpRecord {
            id: id.into(),
            body: format!("{{\"v\":1,\"kind\":\"{kind}\"}}").into_bytes(),
            signer: "m1".into(),
            signature: vec![1, 2, 3],
            kind: kind.into(),
            lamport,
            received_at: Utc.with_ymd_and_hms(2026, 10, 28, 10, 0, lamport as u32).unwrap(),
        }
    }

    fn descriptor(id: &str, name: &str) -> MachineDescriptor {
        MachineDescriptor {
            machine_id: id.into(),
            name: name.into(),
            os: "linux".into(),
            signing_key: "sig".into(),
            sealing_key: "seal".into(),
            ts_node_id: Some("nABC".into()),
            ts_name: Some(format!("{name}.tail.ts.net")),
            port: Some(4174),
        }
    }

    fn presence() -> PeerPresence {
        PeerPresence {
            version: "0.19.0".into(),
            network_protocol: 1,
            features: vec!["network.v1".into()],
            harnesses: vec![HarnessSummary { kind: ProviderKind::ClaudeCode, available: true, signed_in: Some(false), version: None }],
            load: Some(0.5),
            battery: None,
            at: Utc::now(),
        }
    }

    #[test]
    fn ops_are_kept_once_byte_for_byte_and_listed_in_order() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.network_max_lamport().unwrap(), 0);
        assert!(store.network_ops_list().unwrap().is_empty());

        let genesis = op("bb", "genesis", 1);
        let add = op("aa", "add", 2);
        assert!(store.network_op_insert(&add).unwrap());
        assert!(store.network_op_insert(&genesis).unwrap());
        // A repeat is ignored, even with different bytes: the id is the content hash.
        let mut again = genesis.clone();
        again.body = b"other".to_vec();
        assert!(!store.network_op_insert(&again).unwrap());

        assert_eq!(store.network_op_get("bb").unwrap().unwrap(), genesis);
        assert_eq!(store.network_op_get("nope").unwrap(), None);
        assert_eq!(store.network_ops_list().unwrap(), vec![genesis.clone(), add.clone()]);
        assert_eq!(store.network_op_ids().unwrap(), vec!["aa".to_string(), "bb".to_string()]);
        assert_eq!(store.network_max_lamport().unwrap(), 2);
        assert_eq!(store.network_ops_missing_from(&["bb".to_string()]).unwrap(), vec![add]);
        assert!(store.network_ops_missing_from(&["aa".to_string(), "bb".to_string(), "zz".to_string()]).unwrap().is_empty());

        store.network_clear().unwrap();
        assert!(store.network_ops_list().unwrap().is_empty());
    }

    #[test]
    fn machines_roundtrip_and_keep_presence_across_a_descriptor_update() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.network_machine_get("m2").unwrap().is_none());
        // Presence for an unknown machine is not invented.
        assert!(!store.network_machine_set_presence("m2", &presence(), Utc::now()).unwrap());
        assert!(!store.network_machine_touch("m2", Utc::now()).unwrap());

        store.network_machine_upsert(&descriptor("m2", "satyamas")).unwrap();
        store.network_machine_upsert(&descriptor("m1", "mac")).unwrap();
        let stored = store.network_machine_get("m2").unwrap().unwrap();
        assert_eq!(stored.descriptor, descriptor("m2", "satyamas"));
        assert_eq!((stored.presence.clone(), stored.last_seen_at), (None, None));

        let seen = Utc.with_ymd_and_hms(2026, 10, 28, 11, 0, 0).unwrap();
        let live = presence();
        assert!(store.network_machine_set_presence("m2", &live, seen).unwrap());
        let touched = Utc.with_ymd_and_hms(2026, 10, 28, 11, 5, 0).unwrap();
        assert!(store.network_machine_touch("m2", touched).unwrap());

        let renamed = descriptor("m2", "satyamas-pc");
        store.network_machine_upsert(&renamed).unwrap();
        let stored = store.network_machine_get("m2").unwrap().unwrap();
        assert_eq!(stored.descriptor, renamed);
        assert_eq!(stored.presence, Some(live));
        assert_eq!(stored.last_seen_at, Some(touched));

        let ids: Vec<_> = store.network_machines_list().unwrap().into_iter().map(|m| m.machine_id).collect();
        assert_eq!(ids, vec!["m1", "m2"]);
        assert!(store.network_machine_delete("m2").unwrap());
        assert!(!store.network_machine_delete("m2").unwrap());
        assert_eq!(store.network_machines_list().unwrap().len(), 1);
    }

    fn project(store: &Store) -> kybern_protocol::Project {
        let now = Utc::now();
        let project = kybern_protocol::Project {
            repo: None,
            repos: Vec::new(),
            id: Uuid::now_v7(),
            name: "demo".into(),
            path: format!("/tmp/demo-{}", Uuid::now_v7()),
            is_git: true,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            kind: Default::default(),
            members: Vec::new(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
            created_at: now,
            updated_at: now,
        };
        store.project_insert(&project).unwrap();
        project
    }

    #[test]
    fn project_repo_identity_is_cached_and_read_back_on_the_project() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store);
        assert_eq!(store.project_get(project.id).unwrap().unwrap().repo, None);

        let identity = ProjectRepoIdentity {
            repo: Some(RepoIdentity {
                root_commit: Some("abc".into()),
                remote: Some("github.com/tresnanda/ade".into()),
                ..Default::default()
            }),
            repos: vec![RepoIdentity { root_commit: Some("abc".into()), ..Default::default() }],
        };
        assert!(store.project_set_repo_identity(project.id, Some(&identity)).unwrap());
        assert!(!store.project_set_repo_identity(project.id, Some(&identity)).unwrap(), "an identical refresh is quiet");
        let read = store.project_get(project.id).unwrap().unwrap();
        assert_eq!((read.repo.clone(), read.repos.clone()), (identity.repo.clone(), identity.repos.clone()));
        assert_eq!(store.projects_list().unwrap()[0].repo, identity.repo);

        // Editing the project elsewhere does not drop the cached identity.
        store.project_update(&kybern_protocol::Project { name: "renamed".into(), ..read }).unwrap();
        assert_eq!(store.project_get(project.id).unwrap().unwrap().repo, identity.repo);

        assert!(store.project_set_repo_identity(project.id, None).unwrap());
        assert_eq!(store.project_get(project.id).unwrap().unwrap().repo, None);
        assert!(!store.project_set_repo_identity(Uuid::now_v7(), Some(&identity)).unwrap());
    }

    #[test]
    fn tokens_issued_through_a_machine_die_with_it_and_scopes_can_be_added() {
        let store = Store::open_in_memory().unwrap();
        let (a, b, c, d) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        for (id, label) in [(a, "Phone (via m1)"), (b, "Phone (via m1)"), (c, "Phone (via m2)"), (d, "Desktop")] {
            store.token_insert(id, &format!("hash-{id}"), label, &Scope::CLIENT).unwrap();
        }
        store.token_set_device(a, "dev-1", Some("m1")).unwrap();
        store.token_set_device(b, "dev-2", Some("m1")).unwrap();
        store.token_set_device(c, "dev-1", Some("m2")).unwrap();
        assert_eq!(store.token_device(a).unwrap().as_deref(), Some("dev-1"));
        assert_eq!(store.token_device(d).unwrap(), None);

        // A client that asks again gets one fresh token: the older one from the same machine goes.
        assert_eq!(store.tokens_revoke_device_via("dev-1", "m1").unwrap(), vec![a]);
        assert!(store.token_is_active(c).unwrap(), "another machine's token for the device stays");
        assert!(store.tokens_revoke_device_via("dev-1", "m1").unwrap().is_empty());

        assert_eq!(store.tokens_revoke_issued_via("m1").unwrap(), vec![b]);
        assert!(!store.token_is_active(b).unwrap() && store.token_is_active(c).unwrap() && store.token_is_active(d).unwrap());

        let changed = store.tokens_add_scope(Scope::NetworkAdmin, |label| label != "Desktop").unwrap();
        assert_eq!(changed, 1, "only the active token that matches and lacks the scope changes");
        assert_eq!(store.tokens_add_scope(Scope::NetworkAdmin, |_| true).unwrap(), 1, "the one left out is changed now");
        assert_eq!(store.tokens_add_scope(Scope::NetworkAdmin, |_| true).unwrap(), 0, "and it is idempotent");
        let admin =
            store.tokens_list().unwrap().into_iter().filter(|token| !token.revoked && token.scopes.contains(&Scope::NetworkAdmin)).count();
        assert_eq!(admin, 2);

        // A machine that left its network drops everything other machines issued for it.
        assert_eq!(store.tokens_revoke_all_issued_via().unwrap(), vec![c]);
        assert!(store.tokens_revoke_all_issued_via().unwrap().is_empty());
        assert!(store.token_is_active(d).unwrap());
    }

    #[test]
    fn tokens_are_tied_to_a_device_and_revoked_with_it() {
        let store = Store::open_in_memory().unwrap();
        let (a, b, other) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        store.token_insert(a, "hash-a", "Phone (via Mac)", &Scope::CLIENT).unwrap();
        store.token_insert(b, "hash-b", "Phone", &Scope::CLIENT).unwrap();
        store.token_insert(other, "hash-c", "iPad", &Scope::CLIENT).unwrap();
        assert!(store.token_set_device(a, "dev-1", Some("m1")).unwrap());
        assert!(store.token_set_device(b, "dev-1", None).unwrap());
        assert!(store.token_set_device(other, "dev-2", None).unwrap());
        assert!(!store.token_set_device(Uuid::now_v7(), "dev-1", None).unwrap());

        assert_eq!(store.tokens_for_device("dev-1").unwrap(), vec![a, b]);
        assert!(store.tokens_for_device("dev-3").unwrap().is_empty());
        assert_eq!(store.tokens_revoke_device("dev-1").unwrap(), vec![a, b]);
        assert!(!store.token_is_active(a).unwrap() && !store.token_is_active(b).unwrap());
        assert!(store.token_is_active(other).unwrap());
        assert!(store.tokens_revoke_device("dev-1").unwrap().is_empty(), "already revoked");
    }

    #[test]
    fn migration_32_upgrades_an_existing_database_in_place() {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate_to(&conn, 31).unwrap();
        conn.execute("INSERT INTO projects(id, name, path, is_git, created_at, updated_at) VALUES ('p', 'n', '/x', 1, 'a', 'a')", [])
            .unwrap();
        conn.execute("INSERT INTO tokens(id, hash, label, scopes, created_at, revoked) VALUES ('t', 'h', 'l', '[]', 'a', 0)", []).unwrap();
        schema::migrate(&conn).unwrap();

        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), schema::migration_count() as i64);
        assert!(schema::migration_count() >= 32);
        // Existing rows survive with the new columns empty.
        let repo: Option<String> = conn.query_row("SELECT repo_identity FROM projects WHERE id = 'p'", [], |r| r.get(0)).unwrap();
        assert_eq!(repo, None);
        let device: (Option<String>, Option<String>) =
            conn.query_row("SELECT device_id, issued_via FROM tokens WHERE id = 't'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(device, (None, None));
        conn.query_row("SELECT COUNT(*) FROM network_ops", [], |r| r.get::<_, i64>(0)).unwrap();
        conn.query_row("SELECT COUNT(*) FROM network_machines", [], |r| r.get::<_, i64>(0)).unwrap();
        // Running it again is a no-op.
        schema::migrate(&conn).unwrap();
    }
}
