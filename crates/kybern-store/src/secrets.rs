//! The encrypted secret store's rows (design §9.3).
//!
//! The store only keeps bytes. Encrypting, decrypting and naming rules are the daemon's job
//! (`secret_store.rs`); nothing here ever sees a plaintext value, and `Debug` of a row shows no
//! ciphertext.

use anyhow::Result;
use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};

use crate::{Store, parse_time};

/// One secret as stored: the sealed value and what to know about it.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretRow {
    pub name: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub key_version: u32,
    /// `local` or `pushed:<machine_id>`.
    pub source: String,
    pub updated_at: DateTime<Utc>,
}

impl std::fmt::Debug for SecretRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretRow")
            .field("name", &self.name)
            .field("key_version", &self.key_version)
            .field("source", &self.source)
            .field("updated_at", &self.updated_at)
            .finish_non_exhaustive()
    }
}

/// A secret without its value, for listings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretMeta {
    pub name: String,
    pub source: String,
    pub updated_at: DateTime<Utc>,
}

impl Store {
    /// Insert or replace a secret by name.
    pub fn secret_put(&self, row: &SecretRow) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO secrets(name, ciphertext, nonce, key_version, source, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
                   key_version = excluded.key_version, source = excluded.source, updated_at = excluded.updated_at",
                params![row.name, row.ciphertext, row.nonce, row.key_version, row.source, row.updated_at.to_rfc3339()],
            )?;
            Ok(())
        })
    }

    pub fn secret_get(&self, name: &str) -> Result<Option<SecretRow>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT name, ciphertext, nonce, key_version, source, updated_at FROM secrets WHERE name = ?1",
                params![name],
                |r| {
                    Ok(SecretRow {
                        name: r.get(0)?,
                        ciphertext: r.get(1)?,
                        nonce: r.get(2)?,
                        key_version: r.get(3)?,
                        source: r.get(4)?,
                        updated_at: parse_time(r.get::<_, String>(5)?)?,
                    })
                },
            )
            .optional()?)
        })
    }

    /// Every secret's name, source and time, ordered by name. Never the value.
    pub fn secret_list(&self) -> Result<Vec<SecretMeta>> {
        self.with(|c| {
            let mut statement = c.prepare("SELECT name, source, updated_at FROM secrets ORDER BY name")?;
            let rows = statement.query_map([], |r| {
                Ok(SecretMeta { name: r.get(0)?, source: r.get(1)?, updated_at: parse_time(r.get::<_, String>(2)?)? })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Delete a secret. Returns whether it existed.
    pub fn secret_delete(&self, name: &str) -> Result<bool> {
        self.with(|c| Ok(c.execute("DELETE FROM secrets WHERE name = ?1", params![name])? > 0))
    }

    /// Delete a secret only when its source is `source`. Returns whether a row went away.
    pub fn secret_delete_from(&self, name: &str, source: &str) -> Result<bool> {
        self.with(|c| Ok(c.execute("DELETE FROM secrets WHERE name = ?1 AND source = ?2", params![name, source])? > 0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, byte: u8, source: &str) -> SecretRow {
        SecretRow {
            name: name.into(),
            ciphertext: vec![byte; 20],
            nonce: vec![byte; 24],
            key_version: 1,
            source: source.into(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn secrets_round_trip_and_replace_by_name() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.secret_get("a").unwrap(), None);
        let first = row("a", 1, "local");
        store.secret_put(&first).unwrap();
        store.secret_put(&row("b", 2, "pushed:m1")).unwrap();
        let read = store.secret_get("a").unwrap().unwrap();
        assert_eq!(
            (read.ciphertext, read.nonce, read.key_version, read.source),
            (first.ciphertext.clone(), first.nonce.clone(), 1, "local".into())
        );
        // A second put replaces the value and the source.
        store.secret_put(&row("a", 9, "pushed:m2")).unwrap();
        let replaced = store.secret_get("a").unwrap().unwrap();
        assert_eq!((replaced.ciphertext[0], replaced.source.as_str()), (9, "pushed:m2"));
        let listed: Vec<_> = store.secret_list().unwrap().into_iter().map(|m| (m.name, m.source)).collect();
        assert_eq!(listed, vec![("a".to_string(), "pushed:m2".to_string()), ("b".to_string(), "pushed:m1".to_string())]);
        assert!(store.secret_delete("a").unwrap());
        assert!(!store.secret_delete("a").unwrap());
        assert!(!store.secret_delete_from("b", "local").unwrap(), "another source keeps the row");
        assert!(store.secret_delete_from("b", "pushed:m1").unwrap());
        assert!(store.secret_list().unwrap().is_empty());
    }

    #[test]
    fn debug_of_a_row_shows_no_ciphertext() {
        let text = format!("{:?}", row("a", 0xab, "local"));
        assert!(text.contains("\"a\"") && !text.contains("171") && !text.to_lowercase().contains("ciphertext"), "{text}");
    }

    #[test]
    fn the_migration_adds_the_secrets_table_to_an_existing_database() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::schema::migrate_to(&conn, 32).unwrap();
        assert!(conn.prepare("SELECT 1 FROM secrets").is_err(), "v32 has no secrets table");
        crate::schema::migrate(&conn).unwrap();
        conn.query_row("SELECT COUNT(*) FROM secrets", [], |r| r.get::<_, i64>(0)).unwrap();
        assert!(crate::schema::migration_count() >= 33);
        crate::schema::migrate(&conn).unwrap();
    }
}
