//! The encrypted secret store (S3, design §9.3).
//!
//! Provider `env` values used to sit in `settings.json` in the clear. They are now *references*,
//! `"OPENAI_API_KEY": "kybern-secret:provider.opencode.OPENAI_API_KEY"`, and the value lives in the
//! `secrets` table (store migration 33), sealed with XChaCha20-Poly1305 under a 32-byte per-machine
//! **data key**. The data key is `<data dir>/network/data.key`, wrapped by the platform
//! [`Protector`](crate::network::keys::Protector) (DPAPI on Windows, a 0600 file elsewhere). A
//! macOS Keychain or Linux Secret Service protector is a later `Protector`, not a change here.
//!
//! Rules this module keeps:
//!
//! - A value only ever exists as a [`SecretValue`] (no `Debug`/`Display` of the text) or inside a
//!   spawned provider's environment. Nothing here logs, traces or returns one; listings carry names.
//! - Each row is bound to its name (AEAD associated data), so rows cannot be swapped.
//! - [`resolve_env`] replaces references in a provider environment right before spawn.
//!   [`externalize`] moves a plaintext credential a client just saved into the store.
//!   [`SecretStore::migrate_settings_file`] does the same for an existing `settings.json`, once,
//!   keeping an **encrypted** backup of the old file (a plaintext backup would keep the keys the
//!   migration exists to remove).
//! - Pushing a secret to another machine seals it to that machine's X25519 sealing key
//!   ([`seal`] / [`open`]): a one-shot ephemeral key, a hash-derived XChaCha20-Poly1305 key and the
//!   name, sender and receiver in the associated data. The transport call is N3's.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use chrono::Utc;
use kybern_protocol::{ProviderKind, Settings};
use kybern_store::{SecretRow, Store};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as SealingPublicKey, StaticSecret};
use zeroize::Zeroize;

use crate::network::keys::{self, MachineKeys, Protector};

/// What an env value looks like when it points into the store.
pub const REFERENCE_PREFIX: &str = "kybern-secret:";
/// The data key file inside the network directory.
pub const DATA_KEY_FILE: &str = "data.key";
/// The data key generation rows are sealed with; `key_version` in the table.
pub const KEY_VERSION: u32 = 1;
/// Where the pre-migration `settings.json` is kept, encrypted, next to it.
pub const SETTINGS_BACKUP_FILE: &str = "settings.json.pre-secrets";

const MAX_NAME_LEN: usize = 200;
const MAX_VALUE_LEN: usize = 64 * 1024;
const NONCE_LEN: usize = 24;
const SEALED_VERSION: u8 = 1;
const STORE_AAD: &[u8] = b"kybern-secret-store-v1\0";
const BACKUP_AAD: &[u8] = b"kybern-settings-backup-v1";

// ---- values and names ----

/// A secret's text. Not `Display`, and `Debug` prints nothing of the value.
pub struct SecretValue(String);

impl SecretValue {
    /// The text, for the one place that needs it (a provider's environment).
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretValue(<redacted>)")
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// The reference text for a stored name.
pub fn reference(name: &str) -> String {
    format!("{REFERENCE_PREFIX}{name}")
}

/// The name a reference points at, or `None` for any other text.
pub fn parse_reference(value: &str) -> Option<&str> {
    value.strip_prefix(REFERENCE_PREFIX).filter(|name| !name.is_empty())
}

/// `provider.<kind>.<ENV_NAME>`, the name of a provider credential in the store.
pub fn provider_secret_name(kind: ProviderKind, env_name: &str) -> String {
    format!("provider.{}.{env_name}", kind.as_str())
}

fn validate_name(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty() && name.len() <= MAX_NAME_LEN && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')),
        "A secret name uses letters, digits, '.', '_' and '-', up to {MAX_NAME_LEN} characters."
    );
    Ok(())
}

/// Where a stored secret came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretSource {
    /// Entered or migrated on this machine.
    Local,
    /// Pushed here by another member (design §9.3 "Push").
    Pushed(String),
}

impl SecretSource {
    fn column(&self) -> String {
        match self {
            SecretSource::Local => "local".into(),
            SecretSource::Pushed(machine) => format!("pushed:{machine}"),
        }
    }

    fn parse(column: &str) -> Self {
        match column.strip_prefix("pushed:") {
            Some(machine) => SecretSource::Pushed(machine.into()),
            None => SecretSource::Local,
        }
    }
}

/// A listing row: everything about a secret except its value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretInfo {
    pub name: String,
    pub source: SecretSource,
    pub updated_at: chrono::DateTime<Utc>,
}

// ---- the data key ----

struct DataKey([u8; 32]);

impl Drop for DataKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
struct DataKeyFile {
    v: u32,
    /// The 32 key bytes, standard base64.
    key: String,
}

impl DataKeyFile {
    fn encode(key: &DataKey) -> Result<Vec<u8>> {
        Ok(serde_json::to_vec(&DataKeyFile { v: KEY_VERSION, key: B64.encode(key.0) })?)
    }
}

fn data_key_path(network_dir: &Path) -> PathBuf {
    network_dir.join(DATA_KEY_FILE)
}

/// The data key in `network_dir`, made first when there is no file. A file that exists but cannot
/// be read is an error, never a reason for a new key: a new key would orphan every stored secret.
fn load_or_create_data_key(network_dir: &Path, protector: &dyn Protector) -> Result<DataKey> {
    let path = data_key_path(network_dir);
    match std::fs::read(&path) {
        Ok(stored) => {
            let plain = protector.unprotect(&stored).with_context(|| format!("unwrapping {}", path.display()))?;
            let file: DataKeyFile =
                serde_json::from_slice(&plain).with_context(|| format!("{} is not a secret store data key", path.display()))?;
            ensure!(file.v == KEY_VERSION, "{} has data key version {}, this build reads version {KEY_VERSION}", path.display(), file.v);
            let bytes: [u8; 32] = B64
                .decode(&file.key)
                .ok()
                .and_then(|raw| raw.try_into().ok())
                .with_context(|| format!("the key in {} is not 32 bytes of base64", path.display()))?;
            Ok(DataKey(bytes))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut bytes = [0u8; 32];
            rand::rng().fill(&mut bytes);
            let key = DataKey(bytes);
            let mut plain = DataKeyFile::encode(&key)?;
            let stored = protector.protect(&plain);
            plain.zeroize();
            keys::write_private_file(network_dir, DATA_KEY_FILE, &stored?)?;
            Ok(key)
        }
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

// ---- AEAD helpers ----

/// Decrypted bytes as a [`SecretValue`]; bytes that are not UTF-8 are wiped before the error.
fn secret_text(plain: Vec<u8>) -> Result<SecretValue> {
    match String::from_utf8(plain) {
        Ok(text) => Ok(SecretValue(text)),
        Err(error) => {
            let mut bytes = error.into_bytes();
            bytes.zeroize();
            bail!("not valid UTF-8")
        }
    }
}

fn cipher(key: &[u8]) -> Result<XChaCha20Poly1305> {
    XChaCha20Poly1305::new_from_slice(key).map_err(|_| anyhow::anyhow!("the encryption key is not 32 bytes"))
}

fn random_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    rand::rng().fill(&mut nonce);
    nonce
}

fn encrypt(key: &[u8], nonce: &[u8; NONCE_LEN], aad: &[u8], plain: &[u8]) -> Result<Vec<u8>> {
    cipher(key)?.encrypt(&XNonce::from(*nonce), Payload { msg: plain, aad }).map_err(|_| anyhow::anyhow!("encryption failed"))
}

fn decrypt(key: &[u8], nonce: &[u8], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| anyhow::anyhow!("the stored nonce is not {NONCE_LEN} bytes"))?;
    cipher(key)?
        .decrypt(&XNonce::from(nonce), Payload { msg: sealed, aad })
        .map_err(|_| anyhow::anyhow!("the secret could not be decrypted (wrong key, or the row was changed)"))
}

fn store_aad(name: &str) -> Vec<u8> {
    [STORE_AAD, name.as_bytes()].concat()
}

// ---- sealed boxes for pushing a secret to another machine ----

/// What travels to another machine (and sits in the outbox while it is offline): the name and the
/// sealed value. The value is readable only with the target's sealing key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedSecret {
    pub name: String,
    /// Standard base64 of `version(1) || ephemeral public(32) || nonce(24) || ciphertext`.
    pub sealed: String,
}

/// Who a sealed value is from and for. Part of the associated data, so a blob replayed under another
/// name, from another sender or to another machine does not open.
fn seal_context(name: &str, from_machine: &str, to_machine: &str) -> Vec<u8> {
    format!("kybern-secret-push-v1\0{name}\0{from_machine}\0{to_machine}").into_bytes()
}

fn seal_key(ephemeral_public: &[u8; 32], recipient_public: &[u8; 32], shared: &[u8; 32]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"kybern-sealed-box-v1");
    hash.update(ephemeral_public);
    hash.update(recipient_public);
    hash.update(shared);
    hash.finalize().into()
}

/// Seal `plain` to a machine's X25519 sealing public key. A fresh ephemeral key makes each box
/// unique, and the box cannot be opened by its sender afterwards.
pub fn seal(recipient_public: &[u8; 32], context: &[u8], plain: &[u8]) -> Result<Vec<u8>> {
    let mut seed = [0u8; 32];
    rand::rng().fill(&mut seed);
    let ephemeral = StaticSecret::from(seed);
    seed.zeroize();
    let ephemeral_public = SealingPublicKey::from(&ephemeral).to_bytes();
    let shared = ephemeral.diffie_hellman(&SealingPublicKey::from(*recipient_public));
    ensure!(shared.was_contributory(), "the recipient's sealing key is not a valid public key");
    let mut key = seal_key(&ephemeral_public, recipient_public, shared.as_bytes());
    let nonce = random_nonce();
    let ciphertext = encrypt(&key, &nonce, context, plain);
    key.zeroize();
    let mut out = Vec::with_capacity(1 + 32 + NONCE_LEN + plain.len() + 16);
    out.push(SEALED_VERSION);
    out.extend_from_slice(&ephemeral_public);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext?);
    Ok(out)
}

/// Open what [`seal`] made, with this machine's sealing secret.
pub fn open(keys: &MachineKeys, context: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    ensure!(sealed.len() > 1 + 32 + NONCE_LEN && sealed[0] == SEALED_VERSION, "not a sealed secret this build can open");
    let ephemeral_public: [u8; 32] = sealed[1..33].try_into().expect("length checked");
    let nonce = &sealed[33..33 + NONCE_LEN];
    let shared = keys.sealing_secret().diffie_hellman(&SealingPublicKey::from(ephemeral_public));
    ensure!(shared.was_contributory(), "not a sealed secret this build can open");
    let mut key = seal_key(&ephemeral_public, &keys.sealing_public(), shared.as_bytes());
    let plain = decrypt(&key, nonce, context, &sealed[33 + NONCE_LEN..]);
    key.zeroize();
    plain.map_err(|_| anyhow::anyhow!("the sealed secret was not made for this machine, or was changed"))
}

// ---- the store ----

/// What the one-time settings migration did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    /// Credentials moved into the store, as `(provider, env name)`. No values.
    pub moved: Vec<(String, String)>,
    /// The encrypted copy of the old file, when this run made one.
    pub backup: Option<PathBuf>,
}

#[derive(Clone)]
pub struct SecretStore {
    store: Store,
    key: Arc<DataKey>,
}

impl std::fmt::Debug for SecretStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretStore").finish_non_exhaustive()
    }
}

impl SecretStore {
    /// Open the store over the daemon's database, loading (or making) the data key in
    /// `network_dir` with the platform protector.
    pub fn open(store: Store, network_dir: &Path) -> Result<Self> {
        Self::open_with(store, network_dir, keys::platform_protector())
    }

    pub fn open_with(store: Store, network_dir: &Path, protector: &dyn Protector) -> Result<Self> {
        Ok(Self { store, key: Arc::new(load_or_create_data_key(network_dir, protector)?) })
    }

    /// Store `value` under `name`, replacing any earlier value.
    pub fn put(&self, name: &str, value: &str, source: &SecretSource) -> Result<()> {
        validate_name(name)?;
        ensure!(!value.is_empty(), "A secret cannot be empty. Delete it instead.");
        ensure!(value.len() <= MAX_VALUE_LEN, "A secret can be at most {} KiB.", MAX_VALUE_LEN / 1024);
        let nonce = random_nonce();
        let ciphertext = encrypt(&self.key.0, &nonce, &store_aad(name), value.as_bytes())?;
        self.store.secret_put(&SecretRow {
            name: name.into(),
            ciphertext,
            nonce: nonce.to_vec(),
            key_version: KEY_VERSION,
            source: source.column(),
            updated_at: Utc::now(),
        })?;
        tracing::debug!(target: "kybern::secrets", name, source = %source.column(), "stored a secret");
        Ok(())
    }

    /// The value stored under `name`.
    pub fn get(&self, name: &str) -> Result<Option<SecretValue>> {
        let Some(row) = self.store.secret_get(name)? else {
            return Ok(None);
        };
        ensure!(
            row.key_version == KEY_VERSION,
            "secret '{name}' was sealed with data key version {}, this build reads version {KEY_VERSION}",
            row.key_version
        );
        let plain =
            decrypt(&self.key.0, &row.nonce, &store_aad(name), &row.ciphertext).with_context(|| format!("reading secret '{name}'"))?;
        secret_text(plain).map(Some).with_context(|| format!("secret '{name}' is not text"))
    }

    /// Whether `name` is stored, without decrypting it.
    pub fn contains(&self, name: &str) -> Result<bool> {
        Ok(self.store.secret_get(name)?.is_some())
    }

    /// Names, sources and times, ordered by name. Never values.
    pub fn list(&self) -> Result<Vec<SecretInfo>> {
        Ok(self
            .store
            .secret_list()?
            .into_iter()
            .map(|meta| SecretInfo { name: meta.name, source: SecretSource::parse(&meta.source), updated_at: meta.updated_at })
            .collect())
    }

    /// Delete `name`. Returns whether it was stored.
    pub fn delete(&self, name: &str) -> Result<bool> {
        let removed = self.store.secret_delete(name)?;
        if removed {
            tracing::debug!(target: "kybern::secrets", name, "deleted a secret");
        }
        Ok(removed)
    }

    // ---- provider environments ----

    /// Replace every reference in `env` with its value. A reference whose secret is missing or
    /// unreadable is removed from `env` (a provider is better off with the variable unset than
    /// with the literal reference) and its variable name is returned.
    pub fn resolve_env(&self, env: &mut BTreeMap<String, String>) -> Vec<String> {
        let mut unresolved = vec![];
        for (variable, value) in env.iter_mut() {
            let Some(name) = parse_reference(value) else {
                continue;
            };
            match self.get(name) {
                Ok(Some(secret)) => *value = secret.expose().to_string(),
                Ok(None) => {
                    tracing::warn!(target: "kybern::secrets", variable = %variable, name, "an env reference points at a secret that is not stored");
                    unresolved.push(variable.clone());
                }
                Err(error) => {
                    tracing::warn!(target: "kybern::secrets", variable = %variable, name, %error, "an env reference could not be read");
                    unresolved.push(variable.clone());
                }
            }
        }
        for variable in &unresolved {
            env.remove(variable);
        }
        unresolved
    }

    /// Move one credential into the store. Returns the reference to write in its place, or `None`
    /// when the variable is not a credential of `kind`, is empty, or already is a reference.
    fn externalize_value(&self, kind: ProviderKind, variable: &str, value: &str) -> Result<Option<String>> {
        if value.is_empty() || parse_reference(value).is_some() || !crate::provider_accounts::credential_keys(kind).contains(&variable) {
            return Ok(None);
        }
        let name = provider_secret_name(kind, variable);
        self.put(&name, value, &SecretSource::Local)?;
        Ok(Some(reference(&name)))
    }

    /// Move the plaintext credentials of every provider in `settings` into the store, leaving
    /// references. Returns how many moved.
    pub fn externalize_settings(&self, settings: &mut Settings) -> Result<usize> {
        let mut moved = 0;
        for (kind, provider) in settings.providers.iter_mut() {
            for (variable, value) in provider.env.iter_mut() {
                if let Some(reference) = self.externalize_value(*kind, variable, value)? {
                    *value = reference;
                    moved += 1;
                }
            }
        }
        Ok(moved)
    }

    /// Delete the local `provider.*` secrets no env in `settings` points at any more (the user
    /// cleared a key). Pushed secrets and other names stay until someone deletes them.
    pub fn collect_unreferenced_provider_secrets(&self, settings: &Settings) -> Result<usize> {
        let referenced: BTreeSet<&str> =
            settings.providers.values().flat_map(|p| p.env.values()).filter_map(|v| parse_reference(v)).collect();
        let mut removed = 0;
        for info in self.list()? {
            if info.name.starts_with("provider.") && info.source == SecretSource::Local && !referenced.contains(info.name.as_str()) {
                self.delete(&info.name)?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    // ---- settings.json migration ----

    /// Move the plaintext credentials of an existing `settings.json` into the store and rewrite the
    /// file with references. Safe to run on every start: a file with nothing to move is not touched.
    ///
    /// Order, so a crash at any point loses nothing and the next run finishes the job: (1) put each
    /// value in the store, (2) write the encrypted backup of the old file if there is none yet,
    /// (3) replace `settings.json` atomically. The backup is the file as it was before the first
    /// migration, sealed with the data key; [`SecretStore::read_settings_backup`] opens it.
    pub fn migrate_settings_file(&self, settings_path: &Path) -> Result<MigrationReport> {
        let original = match std::fs::read(settings_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(MigrationReport::default()),
            Err(error) => return Err(error).with_context(|| format!("reading {}", settings_path.display())),
        };
        let mut document: serde_json::Value = serde_json::from_slice(&original)
            .with_context(|| format!("{} is not valid JSON; leaving it alone", settings_path.display()))?;
        let mut moved = vec![];
        if let Some(providers) = document.get_mut("providers").and_then(|v| v.as_object_mut()) {
            for (kind_name, provider) in providers.iter_mut() {
                let Ok(kind) = serde_json::from_value::<ProviderKind>(serde_json::Value::String(kind_name.clone())) else {
                    continue;
                };
                let Some(env) = provider.get_mut("env").and_then(|v| v.as_object_mut()) else {
                    continue;
                };
                for (variable, value) in env.iter_mut() {
                    let Some(text) = value.as_str() else {
                        continue;
                    };
                    if let Some(reference) = self.externalize_value(kind, variable, text)? {
                        *value = serde_json::Value::String(reference);
                        moved.push((kind.as_str().to_string(), variable.clone()));
                    }
                }
            }
        }
        if moved.is_empty() {
            return Ok(MigrationReport::default());
        }
        let backup_path = settings_path.with_file_name(SETTINGS_BACKUP_FILE);
        let backup = if backup_path.exists() {
            None
        } else {
            let nonce = random_nonce();
            let mut blob = nonce.to_vec();
            blob.extend(encrypt(&self.key.0, &nonce, BACKUP_AAD, &original)?);
            write_private_beside(&backup_path, &blob)?;
            Some(backup_path)
        };
        let temp = settings_path.with_extension("json.tmp");
        std::fs::write(&temp, serde_json::to_string_pretty(&document)?)?;
        std::fs::rename(&temp, settings_path)?;
        tracing::info!(target: "kybern::secrets", count = moved.len(), "moved provider credentials out of settings.json");
        Ok(MigrationReport { moved, backup })
    }

    /// The old `settings.json` text out of the encrypted backup the migration made.
    pub fn read_settings_backup(&self, backup_path: &Path) -> Result<String> {
        let blob = std::fs::read(backup_path).with_context(|| format!("reading {}", backup_path.display()))?;
        ensure!(blob.len() > NONCE_LEN, "{} is not a settings backup", backup_path.display());
        let plain = decrypt(&self.key.0, &blob[..NONCE_LEN], BACKUP_AAD, &blob[NONCE_LEN..])?;
        String::from_utf8(plain).context("the settings backup is not text")
    }

    // ---- pushing to another machine ----

    /// Seal the secret `name` to another member for `peer.secrets.put`: the value never leaves this
    /// function in the clear, and the result is also what the outbox stores for an offline target.
    ///
    /// TODO(S3/N3): the transport. N3's sessions carry a `peer.secrets.put { name, sealed }` call
    /// (and R1's outbox row `secrets_put` for offline targets); this function and
    /// [`SecretStore::put_sealed`] are the two ends.
    pub fn seal_for_machine(
        &self,
        name: &str,
        recipient_sealing_public_b64: &str,
        from_machine: &str,
        to_machine: &str,
    ) -> Result<SealedSecret> {
        let recipient: [u8; 32] = B64
            .decode(recipient_sealing_public_b64)
            .ok()
            .and_then(|raw| raw.try_into().ok())
            .context("the target's sealing key is not 32 bytes of base64")?;
        let value = self.get(name)?.with_context(|| format!("secret '{name}' is not stored"))?;
        let sealed = seal(&recipient, &seal_context(name, from_machine, to_machine), value.expose().as_bytes())?;
        Ok(SealedSecret { name: name.into(), sealed: B64.encode(sealed) })
    }

    /// Store a secret another member pushed, with `source = pushed:<from_machine>`. Returns its
    /// name. `keys` are this machine's keys and `this_machine` its id; both are checked through the
    /// associated data, so a push meant for another machine or another name does not open.
    pub fn put_sealed(&self, keys: &MachineKeys, sealed: &SealedSecret, from_machine: &str, this_machine: &str) -> Result<String> {
        validate_name(&sealed.name)?;
        let blob = B64.decode(&sealed.sealed).context("the sealed secret is not base64")?;
        let plain = open(keys, &seal_context(&sealed.name, from_machine, this_machine), &blob)?;
        let value = secret_text(plain).context("the pushed secret is not text")?;
        self.put(&sealed.name, value.expose(), &SecretSource::Pushed(from_machine.into()))?;
        Ok(sealed.name.clone())
    }
}

/// Write `bytes` to `path` with mode 0600 (and an owner-only ACL on Windows) through a temp file.
fn write_private_beside(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path.file_name().and_then(|n| n.to_str()).context("backup path has no file name")?;
    keys::write_private_file(dir, name, bytes)
}

// ---- the daemon's one store ----

/// The store the running daemon resolves references through. A process runs one daemon, so a
/// process-wide handle keeps `provider_accounts::environment` (called from some twenty places with a
/// settings snapshot and no daemon state) free of a new parameter. Tests that start several daemons
/// in one process see the last one installed; they hold no references, so they are unaffected.
static CURRENT: RwLock<Option<SecretStore>> = RwLock::new(None);

fn current() -> Option<SecretStore> {
    CURRENT.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

/// Make `store` the one [`resolve_env`] and [`externalize`] use.
pub fn install(store: SecretStore) {
    *CURRENT.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(store);
}

/// Resolve the references in a provider environment right before it is used. With no store
/// installed (it failed to open), references are dropped rather than passed on as text.
pub fn resolve_env(env: &mut BTreeMap<String, String>) {
    if !env.values().any(|v| parse_reference(v).is_some()) {
        return;
    }
    match current() {
        Some(store) => {
            store.resolve_env(env);
        }
        None => env.retain(|_, value| parse_reference(value).is_none()),
    }
}

/// Move plaintext credentials in settings a client just saved into the store. A no-op when no
/// store is installed or there is nothing to move.
pub fn externalize(settings: &mut Settings) -> Result<()> {
    if let Some(store) = current() {
        store.externalize_settings(settings)?;
    }
    Ok(())
}

/// After settings were saved: delete the local provider secrets nothing references any more.
pub fn collect_garbage(settings: &Settings) {
    if let Some(store) = current()
        && let Err(error) = store.collect_unreferenced_provider_secrets(settings)
    {
        tracing::warn!(target: "kybern::secrets", %error, "could not remove unreferenced provider secrets");
    }
}

/// Start the secret store at daemon startup, before `settings.json` is loaded: open it, run the
/// settings migration and install it. A failure is logged and the daemon starts without the store
/// (references then resolve to nothing); the files are left as they were.
pub fn start(root: &Path, settings_path: &Path, store: &Store) -> Option<SecretStore> {
    let opened = SecretStore::open(store.clone(), &root.join(keys::NETWORK_DIR));
    let secrets = match opened {
        Ok(secrets) => secrets,
        Err(error) => {
            tracing::error!(target: "kybern::secrets", error = %format!("{error:#}"), "the secret store could not start; provider keys stored as references are unavailable");
            return None;
        }
    };
    if let Err(error) = secrets.migrate_settings_file(settings_path) {
        tracing::error!(target: "kybern::secrets", error = %format!("{error:#}"), "could not move provider keys out of settings.json; they stay where they are");
    }
    install(secrets.clone());
    Some(secrets)
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::Mutex;

    use kybern_protocol::ProviderSettings;

    use super::*;
    use crate::network::testutil::TempDir;

    const SENTINEL: &str = "sentinel-value-7Zq9Xk2LmN4pR8tV";
    const OTHER: &str = "second-value-A1b2C3d4E5f6G7h8";

    fn open_store(dir: &TempDir) -> SecretStore {
        SecretStore::open(Store::open_in_memory().unwrap(), &dir.path().join("network")).unwrap()
    }

    /// Records everything tracing emits at any level while a closure runs.
    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn captured<T>(f: impl FnOnce() -> T) -> (T, String) {
        let capture = Capture::default();
        let writer = capture.clone();
        let subscriber =
            tracing_subscriber::fmt().with_max_level(tracing::Level::TRACE).with_ansi(false).with_writer(move || writer.clone()).finish();
        let out = tracing::subscriber::with_default(subscriber, f);
        let text = String::from_utf8_lossy(&capture.0.lock().unwrap()).into_owned();
        (out, text)
    }

    fn settings_with(kind: ProviderKind, env: &[(&str, &str)]) -> Settings {
        let mut settings = Settings::default();
        let provider = settings.providers.entry(kind).or_insert_with(ProviderSettings::default);
        for (k, v) in env {
            provider.env.insert((*k).into(), (*v).into());
        }
        settings
    }

    #[test]
    fn put_get_list_delete() {
        let dir = TempDir::new("secrets-crud");
        let secrets = open_store(&dir);
        assert!(secrets.get("a.b").unwrap().is_none());
        secrets.put("a.b", SENTINEL, &SecretSource::Local).unwrap();
        secrets.put("c", OTHER, &SecretSource::Pushed("m1".into())).unwrap();
        assert_eq!(secrets.get("a.b").unwrap().unwrap().expose(), SENTINEL);
        assert!(secrets.contains("c").unwrap());
        let listed = secrets.list().unwrap();
        assert_eq!(listed.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["a.b", "c"]);
        assert_eq!(listed[1].source, SecretSource::Pushed("m1".into()));
        secrets.put("a.b", OTHER, &SecretSource::Local).unwrap();
        assert_eq!(secrets.get("a.b").unwrap().unwrap().expose(), OTHER, "put replaces");
        assert!(secrets.delete("a.b").unwrap());
        assert!(!secrets.delete("a.b").unwrap());
        assert!(secrets.get("a.b").unwrap().is_none());
    }

    #[test]
    fn names_and_values_are_validated() {
        let dir = TempDir::new("secrets-validate");
        let secrets = open_store(&dir);
        for bad in ["", "has space", "slash/name", "colon:name", &"x".repeat(MAX_NAME_LEN + 1)] {
            assert!(secrets.put(bad, "v", &SecretSource::Local).is_err(), "{bad:?}");
        }
        assert!(secrets.put("ok-name_1.2", "v", &SecretSource::Local).is_ok());
        assert!(secrets.put("empty", "", &SecretSource::Local).is_err());
        assert!(secrets.put("big", &"x".repeat(MAX_VALUE_LEN + 1), &SecretSource::Local).is_err());
    }

    #[test]
    fn the_database_holds_no_plaintext_and_rows_are_bound_to_their_name() {
        let dir = TempDir::new("secrets-at-rest");
        let db = dir.path().join("state.sqlite");
        let store = Store::open(&db).unwrap();
        let secrets = SecretStore::open(store.clone(), &dir.path().join("network")).unwrap();
        secrets.put("one", SENTINEL, &SecretSource::Local).unwrap();
        secrets.put("two", OTHER, &SecretSource::Local).unwrap();
        let row = store.secret_get("one").unwrap().unwrap();
        assert!(!row.ciphertext.windows(SENTINEL.len()).any(|w| w == SENTINEL.as_bytes()));
        assert_eq!(row.nonce.len(), NONCE_LEN);
        assert_eq!(row.key_version, KEY_VERSION);
        // The same value stored twice gets different nonces and ciphertexts.
        secrets.put("three", SENTINEL, &SecretSource::Local).unwrap();
        let again = store.secret_get("three").unwrap().unwrap();
        assert_ne!((row.nonce.clone(), row.ciphertext.clone()), (again.nonce, again.ciphertext));
        // The file on disk (WAL included) does not contain the value either.
        drop(secrets);
        drop(store);
        for entry in std::fs::read_dir(dir.path()).unwrap().flatten() {
            if entry.path().is_file() {
                let bytes = std::fs::read(entry.path()).unwrap();
                assert!(!bytes.windows(SENTINEL.len()).any(|w| w == SENTINEL.as_bytes()), "{}", entry.path().display());
            }
        }
        // Moving a row's bytes under another name makes it unreadable: the name is authenticated.
        let store = Store::open(&db).unwrap();
        let secrets = SecretStore::open(store.clone(), &dir.path().join("network")).unwrap();
        let mut moved = store.secret_get("one").unwrap().unwrap();
        moved.name = "two".into();
        store.secret_put(&moved).unwrap();
        let error = format!("{:#}", secrets.get("two").unwrap_err());
        assert!(error.contains("could not be decrypted") && !error.contains(SENTINEL), "{error}");
        // A flipped bit is caught.
        let mut tampered = store.secret_get("three").unwrap().unwrap();
        tampered.ciphertext[0] ^= 1;
        store.secret_put(&tampered).unwrap();
        assert!(secrets.get("three").is_err());
    }

    #[test]
    fn the_data_key_persists_is_private_and_is_never_replaced() {
        let dir = TempDir::new("secrets-datakey");
        let net = dir.path().join("network");
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let first = SecretStore::open(store.clone(), &net).unwrap();
        first.put("n", SENTINEL, &SecretSource::Local).unwrap();
        // A second open (a restart) reads the same key and the same secret.
        let second = SecretStore::open(store.clone(), &net).unwrap();
        assert_eq!(second.get("n").unwrap().unwrap().expose(), SENTINEL);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(data_key_path(&net)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // A damaged key file is an error, not a new key (which would orphan every secret).
        std::fs::write(data_key_path(&net), b"{ not json").unwrap();
        assert!(SecretStore::open(store.clone(), &net).is_err());
        std::fs::write(data_key_path(&net), br#"{"v":9,"key":"AAAA"}"#).unwrap();
        assert!(format!("{:#}", SecretStore::open(store.clone(), &net).unwrap_err()).contains("version 9"));
        // A different key cannot read the old rows.
        std::fs::remove_file(data_key_path(&net)).unwrap();
        let stranger = SecretStore::open(store, &net).unwrap();
        assert!(stranger.get("n").is_err());
    }

    #[test]
    fn a_protector_wraps_the_data_key_file() {
        struct Scramble;
        impl Protector for Scramble {
            fn protect(&self, plain: &[u8]) -> Result<Vec<u8>> {
                Ok(plain.iter().rev().map(|b| b ^ 0x5a).collect())
            }

            fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>> {
                Ok(protected.iter().rev().map(|b| b ^ 0x5a).collect())
            }
        }
        let dir = TempDir::new("secrets-protector");
        let net = dir.path().join("network");
        let store = Store::open_in_memory().unwrap();
        let secrets = SecretStore::open_with(store.clone(), &net, &Scramble).unwrap();
        secrets.put("n", SENTINEL, &SecretSource::Local).unwrap();
        let on_disk = std::fs::read(data_key_path(&net)).unwrap();
        assert!(serde_json::from_slice::<serde_json::Value>(&on_disk).is_err(), "not plain JSON");
        assert_eq!(SecretStore::open_with(store.clone(), &net, &Scramble).unwrap().get("n").unwrap().unwrap().expose(), SENTINEL);
        assert!(SecretStore::open_with(store, &net, &keys::Plain).is_err(), "the wrong protector does not produce a key");
    }

    #[test]
    fn references_parse_and_resolve_into_a_provider_environment() {
        assert_eq!(parse_reference("kybern-secret:provider.codex.OPENAI_API_KEY"), Some("provider.codex.OPENAI_API_KEY"));
        assert_eq!(parse_reference("kybern-secret:"), None);
        assert_eq!(parse_reference("sk-plain"), None);
        let dir = TempDir::new("secrets-resolve");
        let secrets = open_store(&dir);
        secrets.put("provider.codex.OPENAI_API_KEY", SENTINEL, &SecretSource::Local).unwrap();
        let mut env = BTreeMap::from([
            ("OPENAI_API_KEY".to_string(), reference("provider.codex.OPENAI_API_KEY")),
            ("MISSING_KEY".to_string(), reference("provider.codex.MISSING_KEY")),
            ("HTTPS_PROXY".to_string(), "http://proxy:8080".to_string()),
        ]);
        let unresolved = secrets.resolve_env(&mut env);
        assert_eq!(unresolved, ["MISSING_KEY"]);
        assert_eq!(env["OPENAI_API_KEY"], SENTINEL);
        assert_eq!(env["HTTPS_PROXY"], "http://proxy:8080");
        assert!(!env.contains_key("MISSING_KEY"), "a dangling reference is unset, not passed on as text");
    }

    #[test]
    fn externalize_moves_only_credential_variables_and_is_stable() {
        let dir = TempDir::new("secrets-externalize");
        let secrets = open_store(&dir);
        let mut settings = settings_with(
            ProviderKind::Opencode,
            &[
                ("OPENAI_API_KEY", SENTINEL),
                ("GROQ_API_KEY", ""),
                ("HTTPS_PROXY", "http://proxy"),
                ("OPENROUTER_API_KEY", "kybern-secret:custom.name"),
            ],
        );
        assert_eq!(secrets.externalize_settings(&mut settings).unwrap(), 1);
        let env = &settings.providers[&ProviderKind::Opencode].env;
        assert_eq!(env["OPENAI_API_KEY"], "kybern-secret:provider.opencode.OPENAI_API_KEY");
        assert_eq!(env["GROQ_API_KEY"], "", "an empty value is left alone");
        assert_eq!(env["HTTPS_PROXY"], "http://proxy", "not a credential name");
        assert_eq!(env["OPENROUTER_API_KEY"], "kybern-secret:custom.name", "an existing reference is kept");
        assert_eq!(secrets.get("provider.opencode.OPENAI_API_KEY").unwrap().unwrap().expose(), SENTINEL);
        assert_eq!(secrets.externalize_settings(&mut settings).unwrap(), 0, "a second pass moves nothing");
        // Another kind with the same variable name gets its own entry.
        let mut codex = settings_with(ProviderKind::Codex, &[("OPENAI_API_KEY", OTHER)]);
        secrets.externalize_settings(&mut codex).unwrap();
        assert_eq!(secrets.get("provider.codex.OPENAI_API_KEY").unwrap().unwrap().expose(), OTHER);
    }

    #[test]
    fn clearing_a_key_removes_its_local_secret_but_not_pushed_ones() {
        let dir = TempDir::new("secrets-gc");
        let secrets = open_store(&dir);
        let mut settings = settings_with(ProviderKind::Cursor, &[("CURSOR_API_KEY", SENTINEL)]);
        secrets.externalize_settings(&mut settings).unwrap();
        secrets.put("provider.pi.GROQ_API_KEY", OTHER, &SecretSource::Pushed("m1".into())).unwrap();
        secrets.put("unrelated", OTHER, &SecretSource::Local).unwrap();
        assert_eq!(secrets.collect_unreferenced_provider_secrets(&settings).unwrap(), 0, "referenced stays");
        settings.providers.get_mut(&ProviderKind::Cursor).unwrap().env.clear();
        assert_eq!(secrets.collect_unreferenced_provider_secrets(&settings).unwrap(), 1);
        assert!(!secrets.contains("provider.cursor.CURSOR_API_KEY").unwrap());
        assert!(secrets.contains("provider.pi.GROQ_API_KEY").unwrap(), "pushed secrets stay until deleted");
        assert!(secrets.contains("unrelated").unwrap());
    }

    fn write_settings(dir: &TempDir, env: serde_json::Value) -> PathBuf {
        let path = dir.path().join("settings.json");
        let document = serde_json::json!({
            "default_provider": "codex",
            "worktrees_default": true,
            "providers": {
                "opencode": { "env": env, "model": "gpt-x" },
                "claude-code": { "binary": "/usr/bin/claude" },
                "someday-new-harness": { "env": { "OPENAI_API_KEY": "left-alone-unknown-kind" } }
            },
            "notifications": true
        });
        std::fs::write(&path, serde_json::to_string_pretty(&document).unwrap()).unwrap();
        path
    }

    #[test]
    fn the_settings_migration_moves_plaintext_keys_once_and_keeps_an_encrypted_backup() {
        let dir = TempDir::new("secrets-migrate");
        let secrets = open_store(&dir);
        let path = write_settings(
            &dir,
            serde_json::json!({ "OPENAI_API_KEY": SENTINEL, "GROQ_API_KEY": OTHER, "HTTPS_PROXY": "http://proxy", "XAI_API_KEY": "" }),
        );
        let before = std::fs::read(&path).unwrap();
        let (report, logs) = captured(|| secrets.migrate_settings_file(&path).unwrap());
        let mut moved = report.moved.clone();
        moved.sort();
        assert_eq!(moved, [("opencode".to_string(), "GROQ_API_KEY".to_string()), ("opencode".to_string(), "OPENAI_API_KEY".to_string())]);
        assert!(!logs.contains(SENTINEL) && !logs.contains(OTHER), "{logs}");

        // The file now has references, everything else intact, and neither value.
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(SENTINEL) && !text.contains(OTHER));
        let document: serde_json::Value = serde_json::from_str(&text).unwrap();
        let env = &document["providers"]["opencode"]["env"];
        assert_eq!(env["OPENAI_API_KEY"], "kybern-secret:provider.opencode.OPENAI_API_KEY");
        assert_eq!(env["GROQ_API_KEY"], "kybern-secret:provider.opencode.GROQ_API_KEY");
        assert_eq!(env["HTTPS_PROXY"], "http://proxy");
        assert_eq!(env["XAI_API_KEY"], "");
        assert_eq!(document["providers"]["opencode"]["model"], "gpt-x");
        assert_eq!(document["providers"]["claude-code"]["binary"], "/usr/bin/claude");
        assert_eq!(document["providers"]["someday-new-harness"]["env"]["OPENAI_API_KEY"], "left-alone-unknown-kind");
        assert_eq!(document["notifications"], true);
        // It still loads as typed Settings.
        let mut known = document.clone();
        known["providers"].as_object_mut().unwrap().remove("someday-new-harness");
        let typed: Settings = serde_json::from_value(known).unwrap();
        assert_eq!(typed.providers[&ProviderKind::Opencode].env["HTTPS_PROXY"], "http://proxy");
        // The values are in the store.
        assert_eq!(secrets.get("provider.opencode.OPENAI_API_KEY").unwrap().unwrap().expose(), SENTINEL);
        assert_eq!(secrets.get("provider.opencode.GROQ_API_KEY").unwrap().unwrap().expose(), OTHER);

        // The backup is the old file, readable only through the store, and not plaintext on disk.
        let backup = report.backup.clone().expect("the first migration made a backup");
        assert_eq!(backup.file_name().unwrap(), SETTINGS_BACKUP_FILE);
        let raw = std::fs::read(&backup).unwrap();
        assert!(!raw.windows(SENTINEL.len()).any(|w| w == SENTINEL.as_bytes()));
        assert_eq!(secrets.read_settings_backup(&backup).unwrap().as_bytes(), before.as_slice());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // Idempotent: a second run changes nothing, not even the file.
        let after = std::fs::read(&path).unwrap();
        let again = secrets.migrate_settings_file(&path).unwrap();
        assert_eq!(again, MigrationReport::default());
        assert_eq!(std::fs::read(&path).unwrap(), after);
        assert_eq!(std::fs::read(&backup).unwrap(), raw, "the backup is the file before the first migration");
    }

    #[test]
    fn a_later_migration_keeps_the_first_backup() {
        let dir = TempDir::new("secrets-migrate-twice");
        let secrets = open_store(&dir);
        let path = write_settings(&dir, serde_json::json!({ "OPENAI_API_KEY": SENTINEL }));
        let first = secrets.migrate_settings_file(&path).unwrap();
        let backup = first.backup.unwrap();
        let original_backup = std::fs::read(&backup).unwrap();
        // The user pastes a new plaintext key into the file by hand; the next start moves it too.
        let mut document: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        document["providers"]["opencode"]["env"]["GROQ_API_KEY"] = OTHER.into();
        std::fs::write(&path, serde_json::to_string_pretty(&document).unwrap()).unwrap();
        let second = secrets.migrate_settings_file(&path).unwrap();
        assert_eq!(second.moved, [("opencode".to_string(), "GROQ_API_KEY".to_string())]);
        assert_eq!(second.backup, None, "the first backup is kept, not overwritten");
        assert_eq!(std::fs::read(&backup).unwrap(), original_backup);
        assert!(!std::fs::read_to_string(&path).unwrap().contains(OTHER));
    }

    #[test]
    fn the_migration_leaves_a_missing_or_broken_file_alone() {
        let dir = TempDir::new("secrets-migrate-edge");
        let secrets = open_store(&dir);
        assert_eq!(secrets.migrate_settings_file(&dir.path().join("settings.json")).unwrap(), MigrationReport::default());
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(secrets.migrate_settings_file(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ not json");
        std::fs::write(&path, br#"{"providers": []}"#).unwrap();
        assert_eq!(secrets.migrate_settings_file(&path).unwrap(), MigrationReport::default());
    }

    #[test]
    fn a_crash_between_the_store_write_and_the_file_rewrite_is_finished_by_the_next_run() {
        let dir = TempDir::new("secrets-migrate-crash");
        let secrets = open_store(&dir);
        let path = write_settings(&dir, serde_json::json!({ "OPENAI_API_KEY": SENTINEL }));
        // Step 1 happened (the value is in the store); the file still has the plaintext.
        secrets.put("provider.opencode.OPENAI_API_KEY", SENTINEL, &SecretSource::Local).unwrap();
        let report = secrets.migrate_settings_file(&path).unwrap();
        assert_eq!(report.moved.len(), 1);
        assert!(!std::fs::read_to_string(&path).unwrap().contains(SENTINEL));
        assert_eq!(secrets.get("provider.opencode.OPENAI_API_KEY").unwrap().unwrap().expose(), SENTINEL);
    }

    #[test]
    fn sealed_boxes_open_only_for_the_right_machine_name_and_sender() {
        let alice = MachineKeys::generate();
        let bob = MachineKeys::generate();
        let sealed = seal(&bob.sealing_public(), b"ctx", SENTINEL.as_bytes()).unwrap();
        assert!(!sealed.windows(SENTINEL.len()).any(|w| w == SENTINEL.as_bytes()));
        assert_eq!(open(&bob, b"ctx", &sealed).unwrap(), SENTINEL.as_bytes());
        assert!(open(&alice, b"ctx", &sealed).is_err(), "another machine cannot open it");
        assert!(open(&bob, b"other", &sealed).is_err(), "the context is authenticated");
        let mut flipped = sealed.clone();
        *flipped.last_mut().unwrap() ^= 1;
        assert!(open(&bob, b"ctx", &flipped).is_err());
        assert!(open(&bob, b"ctx", &sealed[..40]).is_err());
        let mut wrong_version = sealed.clone();
        wrong_version[0] = 9;
        assert!(open(&bob, b"ctx", &wrong_version).is_err());
        // Two boxes of the same text differ; a low-order recipient key is refused.
        assert_ne!(seal(&bob.sealing_public(), b"ctx", SENTINEL.as_bytes()).unwrap(), sealed);
        assert!(seal(&[0u8; 32], b"ctx", b"x").is_err());
    }

    #[test]
    fn a_secret_pushes_sealed_end_to_end_between_two_stores() {
        let a_dir = TempDir::new("secrets-push-a");
        let b_dir = TempDir::new("secrets-push-b");
        let a = open_store(&a_dir);
        let b = open_store(&b_dir);
        let b_keys = MachineKeys::generate();
        let c_keys = MachineKeys::generate();
        a.put("provider.cursor.CURSOR_API_KEY", SENTINEL, &SecretSource::Local).unwrap();

        // A seals to B's published sealing key. This is all that would sit in the outbox.
        let sealed = a.seal_for_machine("provider.cursor.CURSOR_API_KEY", &b_keys.sealing_public_b64(), "machine-a", "machine-b").unwrap();
        let wire = serde_json::to_string(&sealed).unwrap();
        assert!(!wire.contains(SENTINEL));
        let received: SealedSecret = serde_json::from_str(&wire).unwrap();

        // B stores it with source pushed:machine-a, and it resolves into B's provider env.
        let name = b.put_sealed(&b_keys, &received, "machine-a", "machine-b").unwrap();
        assert_eq!(name, "provider.cursor.CURSOR_API_KEY");
        assert_eq!(b.get(&name).unwrap().unwrap().expose(), SENTINEL);
        assert_eq!(b.list().unwrap()[0].source, SecretSource::Pushed("machine-a".into()));
        let mut env = BTreeMap::from([("CURSOR_API_KEY".to_string(), reference(&name))]);
        b.resolve_env(&mut env);
        assert_eq!(env["CURSOR_API_KEY"], SENTINEL);

        // The wrong machine, a claimed sender that is not the sender, a renamed secret and a
        // push addressed to someone else all fail and store nothing.
        let c_dir = TempDir::new("secrets-push-c");
        let c = open_store(&c_dir);
        assert!(c.put_sealed(&c_keys, &received, "machine-a", "machine-c").is_err());
        assert!(c.put_sealed(&b_keys, &received, "machine-x", "machine-b").is_err());
        assert!(c.put_sealed(&b_keys, &received, "machine-a", "machine-c").is_err());
        let renamed = SealedSecret { name: "provider.cursor.OTHER".into(), sealed: received.sealed.clone() };
        assert!(c.put_sealed(&b_keys, &renamed, "machine-a", "machine-b").is_err());
        assert!(c.list().unwrap().is_empty());
        // A missing secret, or a bad key, is a plain error.
        assert!(a.seal_for_machine("nope", &b_keys.sealing_public_b64(), "machine-a", "machine-b").is_err());
        assert!(a.seal_for_machine("provider.cursor.CURSOR_API_KEY", "not base64", "machine-a", "machine-b").is_err());
    }

    #[test]
    fn values_never_reach_logs_debug_output_or_errors() {
        let dir = TempDir::new("secrets-logs");
        let ((), logs) = captured(|| {
            let secrets = open_store(&dir);
            let keys = MachineKeys::generate();
            secrets.put("provider.opencode.OPENAI_API_KEY", SENTINEL, &SecretSource::Local).unwrap();
            let value = secrets.get("provider.opencode.OPENAI_API_KEY").unwrap().unwrap();
            assert_eq!(value.expose(), SENTINEL);
            // Debug of everything a caller can hold.
            let debug = format!(
                "{value:?} {secrets:?} {:?} {:?}",
                secrets.list().unwrap(),
                secrets.store.secret_get("provider.opencode.OPENAI_API_KEY").unwrap()
            );
            assert!(!debug.contains(SENTINEL), "{debug}");
            // Resolution, including a dangling and an unreadable reference.
            let mut env = BTreeMap::from([
                ("OPENAI_API_KEY".to_string(), reference("provider.opencode.OPENAI_API_KEY")),
                ("GROQ_API_KEY".to_string(), reference("provider.opencode.GROQ_API_KEY")),
            ]);
            secrets.resolve_env(&mut env);
            // Externalize, migration, push, open and every failure.
            let mut settings = settings_with(ProviderKind::Codex, &[("OPENAI_API_KEY", OTHER)]);
            secrets.externalize_settings(&mut settings).unwrap();
            let settings_debug = format!("{settings:?}");
            assert!(!settings_debug.contains(OTHER), "{settings_debug}");
            let path = write_settings(&dir, serde_json::json!({ "OPENAI_API_KEY": SENTINEL }));
            secrets.migrate_settings_file(&path).unwrap();
            let sealed = secrets.seal_for_machine("provider.opencode.OPENAI_API_KEY", &keys.sealing_public_b64(), "a", "b").unwrap();
            let target = open_store(&TempDir::new("secrets-logs-target"));
            target.put_sealed(&keys, &sealed, "a", "b").unwrap();
            let mut errors = vec![
                format!("{:#}", target.put_sealed(&keys, &sealed, "a", "wrong").unwrap_err()),
                format!("{:#}", secrets.put("bad name", SENTINEL, &SecretSource::Local).unwrap_err()),
                format!("{:#}", secrets.seal_for_machine("provider.opencode.OPENAI_API_KEY", "not base64", "a", "b").unwrap_err()),
            ];
            let store = &secrets.store;
            let mut tampered = store.secret_get("provider.opencode.OPENAI_API_KEY").unwrap().unwrap();
            tampered.ciphertext[0] ^= 1;
            store.secret_put(&tampered).unwrap();
            errors.push(format!("{:#}", secrets.get("provider.opencode.OPENAI_API_KEY").unwrap_err()));
            for error in errors {
                assert!(!error.contains(SENTINEL) && !error.contains(OTHER), "{error}");
            }
            secrets.delete("provider.opencode.OPENAI_API_KEY").unwrap();
        });
        assert!(!logs.is_empty(), "the test captured nothing, so it proves nothing");
        assert!(logs.contains("stored a secret"), "{logs}");
        assert!(!logs.contains(SENTINEL) && !logs.contains(OTHER), "a secret value reached the logs:\n{logs}");
        // The reference names and variables are fine to log; only values are not.
        assert!(logs.contains("provider.opencode.OPENAI_API_KEY"));
    }

    #[test]
    fn the_installed_store_resolves_and_externalizes_for_the_daemon() {
        let dir = TempDir::new("secrets-global");
        let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
        let settings_path = dir.path().join("settings.json");
        let document = serde_json::json!({ "providers": { "pi": { "env": { "GROQ_API_KEY": SENTINEL } } } });
        std::fs::write(&settings_path, serde_json::to_string_pretty(&document).unwrap()).unwrap();
        let installed = start(dir.path(), &settings_path, &store).expect("the store starts");
        assert!(!std::fs::read_to_string(&settings_path).unwrap().contains(SENTINEL));

        // provider_accounts::environment resolves the reference the migration left.
        let typed: Settings = serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
        let provider = typed.providers[&ProviderKind::Pi].clone();
        let env = crate::provider_accounts::environment(&provider, ProviderKind::Pi, "default").unwrap();
        assert_eq!(env["GROQ_API_KEY"], SENTINEL);
        // ... and the reference, not the value, is what settings hold.
        assert_eq!(provider.env["GROQ_API_KEY"], "kybern-secret:provider.pi.GROQ_API_KEY");

        // A client saving a new plaintext key through SettingsStore::set ends up with a reference.
        let settings_store = crate::settings::SettingsStore::load(&settings_path).unwrap();
        let mut edited = settings_store.get();
        edited.providers.entry(ProviderKind::Cursor).or_default().env.insert("CURSOR_API_KEY".into(), OTHER.into());
        let saved = settings_store.set(edited).unwrap();
        assert_eq!(saved.providers[&ProviderKind::Cursor].env["CURSOR_API_KEY"], "kybern-secret:provider.cursor.CURSOR_API_KEY");
        assert!(!std::fs::read_to_string(&settings_path).unwrap().contains(OTHER));
        assert_eq!(installed.get("provider.cursor.CURSOR_API_KEY").unwrap().unwrap().expose(), OTHER);
        // Clearing it deletes the local secret.
        let mut cleared = settings_store.get();
        cleared.providers.get_mut(&ProviderKind::Cursor).unwrap().env.clear();
        settings_store.set(cleared).unwrap();
        assert!(!installed.contains("provider.cursor.CURSOR_API_KEY").unwrap());

        // With no store installed, references are dropped rather than passed on as text.
        *CURRENT.write().unwrap() = None;
        let mut env = BTreeMap::from([("A".to_string(), reference("x")), ("B".to_string(), "plain".to_string())]);
        resolve_env(&mut env);
        assert_eq!(env, BTreeMap::from([("B".to_string(), "plain".to_string())]));
    }
}
