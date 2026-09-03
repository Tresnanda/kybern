//! Bearer tokens. The raw token lives only in the client's hands and the
//! bootstrap file; the store keeps SHA-256 hashes.

use anyhow::Result;
use base64::Engine;
use kybern_protocol::Scope;
use kybern_store::Store;
use rand::RngExt;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub fn hash(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn generate() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    format!("kyb_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// Ensure a bootstrap token exists on disk and in the store. Returns the raw token.
pub fn ensure_bootstrap(store: &Store, path: &std::path::Path) -> Result<String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty()
            && let Some(rec) = store.token_lookup(&hash(&existing))?
            && !rec.revoked
        {
            return Ok(existing);
        }
    }
    let token = generate();
    store.token_insert(Uuid::now_v7(), &hash(&token), "bootstrap", &Scope::ALL)?;
    write_private(path, &token)?;
    tracing::info!(path = %path.display(), "wrote new bootstrap token");
    Ok(token)
}

fn write_private(path: &std::path::Path, contents: &str) -> Result<()> {
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Principal {
    pub token_id: Uuid,
    pub label: String,
    pub scopes: Vec<Scope>,
}

impl Principal {
    pub fn has(&self, scope: Scope) -> bool {
        self.scopes.contains(&scope)
    }
}

pub fn authenticate(store: &Store, raw: &str) -> Result<Option<Principal>> {
    let Some(rec) = store.token_lookup(&hash(raw))? else { return Ok(None) };
    if rec.revoked {
        return Ok(None);
    }
    let _ = store.token_touch(rec.id);
    Ok(Some(Principal { token_id: rec.id, label: rec.label, scopes: rec.scopes }))
}
