//! Persistence and atomic projection for the signed Spaces replica. Verification lives in the daemon.
use crate::Store;
use anyhow::Result;
use kybern_protocol::{OpEnvelope, ProjectId, Space, SpaceId};
use rusqlite::{OptionalExtension, params};

impl Store {
    pub fn space_replica_fields(&self) -> Result<Vec<OpEnvelope>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT envelope FROM network_space_fields ORDER BY id")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
        })
    }
    pub fn space_replica_keep(&self, fields: &[OpEnvelope]) -> Result<()> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            for field in fields {
                let body: kybern_protocol::SpaceField = serde_json::from_str(&field.body)?;
                tx.execute(
                    "INSERT OR IGNORE INTO network_space_fields(id, network_id, envelope) VALUES (?1, ?2, ?3)",
                    params![field.id, body.network_id, serde_json::to_string(field)?],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }
    /// Retain the visible rail and placements when leaving; discard replication history and tombstones.
    pub fn space_replica_clear(&self) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM network_space_fields", [])?;
            c.execute("DELETE FROM meta WHERE key LIKE 'spaces.replica.%'", [])?;
            Ok(())
        })
    }
    pub fn space_logo_put(&self, hash: &str, bytes: &[u8]) -> Result<()> {
        self.with(|c| {
            c.execute("INSERT OR IGNORE INTO network_space_logos(hash, bytes) VALUES (?1, ?2)", params![hash, bytes])?;
            Ok(())
        })
    }
    pub fn space_logo_get(&self, hash: &str) -> Result<Option<Vec<u8>>> {
        self.with(|c| Ok(c.query_row("SELECT bytes FROM network_space_logos WHERE hash = ?1", [hash], |r| r.get(0)).optional()?))
    }
    /// Replace the local projection in one transaction. Replica history retains deleted/aliased ids.
    pub fn space_replica_project(&self, spaces: &[Space], placements: &[(ProjectId, SpaceId)]) -> Result<()> {
        if spaces.is_empty() {
            anyhow::bail!("a Spaces replica must have a default");
        }
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            tx.execute("UPDATE spaces SET is_default = 0", [])?;
            for s in spaces {
                tx.execute(
                    "INSERT INTO spaces(id,name,color,logo,position,created_at,updated_at,is_default)
                    VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,color=excluded.color,logo=excluded.logo,position=excluded.position,
                    updated_at=excluded.updated_at,is_default=excluded.is_default",
                    params![
                        s.id.to_string(),
                        s.name,
                        s.color.as_str(),
                        serde_json::to_string(&s.logo)?,
                        s.position,
                        s.created_at.to_rfc3339(),
                        s.updated_at.to_rfc3339(),
                        s.is_default
                    ],
                )?;
            }
            for (project, space) in placements {
                tx.execute(
                    "UPDATE projects SET space_id=?2 WHERE id=?1 AND space_id IS NOT ?2",
                    params![project.to_string(), space.to_string()],
                )?;
            }
            let default = spaces.iter().find(|s| s.is_default).ok_or_else(|| anyhow::anyhow!("no default"))?;
            let mut st = tx.prepare("SELECT id FROM spaces")?;
            let old: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            drop(st);
            for id in old {
                if !spaces.iter().any(|s| s.id.to_string() == id) {
                    tx.execute("UPDATE projects SET space_id=?2 WHERE space_id=?1", params![id, default.id.to_string()])?;
                    tx.execute("DELETE FROM spaces WHERE id=?1", [id])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
    }
}
