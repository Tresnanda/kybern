//! Machine keys (design §2.1).
//!
//! Each machine holds two long-lived key pairs: an Ed25519 signing key (membership operations,
//! handshake challenges, well-known proofs) and an X25519 sealing key (secrets and borrowed tokens
//! are sealed to it). Both private halves live in one file, `<data dir>/network/machine.key`:
//!
//! | OS | The file holds |
//! | --- | --- |
//! | macOS, Linux | the key JSON in the clear, mode 0600 in a 0700 directory (the same trust level as `daemon.token`; a headless daemon cannot answer Keychain or Secret Service prompts) |
//! | Windows | the key JSON wrapped with DPAPI (`CryptProtectData`, user scope) and an ACL that admits only the user |
//!
//! The [`Protector`] trait is that seam, so a Keychain protector can be added later without touching
//! the callers. A key file that exists but cannot be read is an error, never a reason to make a new
//! key: a new key is a new identity, and only [`create`] (Rejoin) does that.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as SealingPublicKey, StaticSecret};

/// The directory under the data directory that holds the network's private state.
pub const NETWORK_DIR: &str = "network";
/// The private key file inside [`NETWORK_DIR`].
pub const KEY_FILE: &str = "machine.key";

const KEY_FILE_VERSION: u32 = 1;

/// Why a signature or a public key was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyError {
    #[error("not a valid Ed25519 public key")]
    BadPublicKey,
    #[error("not a valid Ed25519 signature")]
    BadSignature,
    #[error("the signature does not match")]
    Mismatch,
}

/// A machine's two key pairs. The private halves never leave this struct except through
/// [`MachineKeys::sealing_secret`], which the sealed-box code of M5 uses.
pub struct MachineKeys {
    signing: SigningKey,
    sealing: StaticSecret,
}

impl std::fmt::Debug for MachineKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MachineKeys").field("fingerprint", &self.fingerprint()).finish_non_exhaustive()
    }
}

impl MachineKeys {
    /// Two fresh key pairs from the operating system's random source.
    pub fn generate() -> Self {
        let mut signing = [0u8; 32];
        let mut sealing = [0u8; 32];
        rand::rng().fill(&mut signing);
        rand::rng().fill(&mut sealing);
        Self::from_seeds(signing, sealing)
    }

    fn from_seeds(signing: [u8; 32], sealing: [u8; 32]) -> Self {
        Self { signing: SigningKey::from_bytes(&signing), sealing: StaticSecret::from(sealing) }
    }

    pub fn signing_public(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    /// The signing public key as standard base64, the form `MachineDescriptor.signing_key` uses.
    pub fn signing_public_b64(&self) -> String {
        B64.encode(self.signing_public())
    }

    pub fn sealing_public(&self) -> [u8; 32] {
        SealingPublicKey::from(&self.sealing).to_bytes()
    }

    /// The sealing public key as standard base64, the form `MachineDescriptor.sealing_key` uses.
    pub fn sealing_public_b64(&self) -> String {
        B64.encode(self.sealing_public())
    }

    /// The first 16 hex characters of the SHA-256 of the signing public key.
    pub fn fingerprint(&self) -> String {
        fingerprint_of(&self.signing_public())
    }

    /// An Ed25519 signature over `message`, 64 bytes.
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.signing.sign(message).to_bytes().to_vec()
    }

    /// The X25519 secret, for opening what was sealed to this machine.
    pub fn sealing_secret(&self) -> &StaticSecret {
        &self.sealing
    }
}

/// The first 16 hex characters of the SHA-256 of a signing public key.
pub fn fingerprint_of(signing_public: &[u8]) -> String {
    let digest = Sha256::digest(signing_public);
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// Verify an Ed25519 signature against a public key given as standard base64. Verification is
/// strict: it refuses small-order keys and non-canonical signatures.
pub fn verify_signature(signing_public_b64: &str, message: &[u8], signature: &[u8]) -> Result<(), KeyError> {
    let bytes: [u8; 32] = B64.decode(signing_public_b64).ok().and_then(|raw| raw.try_into().ok()).ok_or(KeyError::BadPublicKey)?;
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| KeyError::BadPublicKey)?;
    let signature = Signature::from_slice(signature).map_err(|_| KeyError::BadSignature)?;
    key.verify_strict(message, &signature).map_err(|_| KeyError::Mismatch)
}

// ---- protecting the file at rest ----

/// How the key file's contents are protected at rest.
pub trait Protector: Send + Sync {
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>>;
    fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>>;
}

/// Contents in the clear; the file mode (0600 in a 0700 directory) is the protection.
pub struct Plain;

impl Protector for Plain {
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>> {
        Ok(plain.to_vec())
    }

    fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>> {
        Ok(protected.to_vec())
    }
}

/// The protector the platform uses: DPAPI on Windows, plain files elsewhere.
pub fn platform_protector() -> &'static dyn Protector {
    #[cfg(windows)]
    {
        &dpapi::Dpapi
    }
    #[cfg(not(windows))]
    {
        &Plain
    }
}

#[cfg(windows)]
pub(crate) mod dpapi {
    use std::ptr::{null, null_mut};

    use anyhow::{Result, bail};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData};

    use super::Protector;

    /// Mixed into every wrap so a blob made for another purpose of the same user does not open here.
    const ENTROPY: &[u8] = b"kybern-machine-key-v1";

    /// `CryptProtectData` in the user's scope: only this Windows user, on this machine, can unwrap it.
    pub struct Dpapi;

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    /// Copy a DPAPI-allocated output blob and free it.
    ///
    /// # Safety
    /// `out` must hold the result of a successful `CryptProtectData`/`CryptUnprotectData` call.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        unsafe { LocalFree(out.pbData as _) };
        bytes
    }

    impl Protector for Dpapi {
        fn protect(&self, plain: &[u8]) -> Result<Vec<u8>> {
            let input = blob(plain);
            let entropy = blob(ENTROPY);
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
            // SAFETY: the blobs borrow `plain` and `ENTROPY` for the call, `out` is written by the API.
            let ok = unsafe { CryptProtectData(&input, null(), &entropy, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
            if ok == 0 {
                bail!("CryptProtectData failed: {}", std::io::Error::last_os_error());
            }
            // SAFETY: the call succeeded.
            Ok(unsafe { take(out) })
        }

        fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>> {
            let input = blob(protected);
            let entropy = blob(ENTROPY);
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
            // SAFETY: as in `protect`.
            let ok = unsafe { CryptUnprotectData(&input, null_mut(), &entropy, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
            if ok == 0 {
                bail!("CryptUnprotectData failed: {}", std::io::Error::last_os_error());
            }
            // SAFETY: the call succeeded.
            Ok(unsafe { take(out) })
        }
    }
}

// ---- the key file ----

#[derive(Serialize, Deserialize)]
struct KeyFile {
    v: u32,
    /// Ed25519 seed, standard base64.
    signing: String,
    /// X25519 secret, standard base64.
    sealing: String,
}

fn decode_secret(label: &str, text: &str) -> Result<[u8; 32]> {
    B64.decode(text)
        .ok()
        .and_then(|raw| raw.try_into().ok())
        .with_context(|| format!("the {label} key in machine.key is not 32 bytes of base64"))
}

/// Where the private key file is, for a network directory.
pub fn key_path(network_dir: &Path) -> PathBuf {
    network_dir.join(KEY_FILE)
}

/// The keys in `network_dir`, or `None` when there is no key file. An unreadable or corrupt file
/// is an error.
pub fn load(network_dir: &Path) -> Result<Option<MachineKeys>> {
    load_with(network_dir, platform_protector())
}

pub fn load_with(network_dir: &Path, protector: &dyn Protector) -> Result<Option<MachineKeys>> {
    let path = key_path(network_dir);
    let stored = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    let plain = protector.unprotect(&stored).with_context(|| format!("unwrapping {}", path.display()))?;
    let file: KeyFile = serde_json::from_slice(&plain).with_context(|| format!("{} is not a machine key file", path.display()))?;
    if file.v != KEY_FILE_VERSION {
        bail!("{} has key file version {}, this build reads version {KEY_FILE_VERSION}", path.display(), file.v);
    }
    Ok(Some(MachineKeys::from_seeds(decode_secret("signing", &file.signing)?, decode_secret("sealing", &file.sealing)?)))
}

/// Make new keys and write them, replacing any file. This is a new identity: only the first start
/// and Rejoin call it.
pub fn create(network_dir: &Path) -> Result<MachineKeys> {
    create_with(network_dir, platform_protector())
}

pub fn create_with(network_dir: &Path, protector: &dyn Protector) -> Result<MachineKeys> {
    let keys = MachineKeys::generate();
    let file = KeyFile { v: KEY_FILE_VERSION, signing: B64.encode(keys.signing.to_bytes()), sealing: B64.encode(keys.sealing.to_bytes()) };
    let plain = serde_json::to_vec(&file)?;
    let stored = protector.protect(&plain)?;
    write_private(network_dir, &stored)?;
    Ok(keys)
}

/// The keys in `network_dir`, made first if there is no key file.
pub fn load_or_create(network_dir: &Path) -> Result<MachineKeys> {
    match load(network_dir)? {
        Some(keys) => Ok(keys),
        None => create(network_dir),
    }
}

/// Delete the key file. A missing file is fine.
pub fn remove(network_dir: &Path) -> Result<()> {
    match std::fs::remove_file(key_path(network_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("removing machine.key"),
    }
}

/// Write `bytes` as `machine.key` through a private temporary file, so the key is never readable
/// by another user, not even for a moment, and a crash never leaves half a key.
fn write_private(network_dir: &Path, bytes: &[u8]) -> Result<()> {
    write_private_file(network_dir, KEY_FILE, bytes)
}

/// [`write_private`] for any private file in the network directory (the secret store's `data.key`
/// uses it): 0600 in a 0700 directory, an owner-only ACL on Windows, atomic by rename.
pub(crate) fn write_private_file(network_dir: &Path, file_name: &str, bytes: &[u8]) -> Result<()> {
    std::fs::create_dir_all(network_dir).with_context(|| format!("creating {}", network_dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(network_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let target = network_dir.join(file_name);
    let temp = network_dir.join(format!("{file_name}.tmp"));
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).with_context(|| format!("creating {}", temp.display()))?;
        #[cfg(unix)]
        {
            // `mode` only applies when the file is created; a leftover temp file keeps its old mode.
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    #[cfg(windows)]
    restrict_key_to_current_user(&temp);
    std::fs::rename(&temp, &target).with_context(|| format!("writing {}", target.display()))?;
    Ok(())
}

/// Replace the file's inherited ACL with one that admits only the current user. DPAPI already keeps
/// other users from unwrapping the contents, so a failure here is logged and not fatal.
#[cfg(windows)]
fn restrict_key_to_current_user(path: &Path) {
    if let Err(error) = restrict_to_current_user(path) {
        tracing::warn!(target: "kybern::network", %error, "machine.key keeps its inherited ACL");
    }
}

/// Replace the file's inherited ACL with one that admits only the current user.
#[cfg(windows)]
pub(crate) fn restrict_to_current_user(path: &Path) -> std::io::Result<()> {
    use kybern_protocol::process::NoWindow;

    let user = std::env::var("USERNAME").map_err(|_| std::io::Error::other("USERNAME is not set"))?;
    let account = match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.is_empty() => format!("{domain}\\{user}"),
        _ => user,
    };
    let output = std::process::Command::new("icacls")
        .no_window()
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("{account}:F"))
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("icacls refused to restrict the file ({})", output.status)))
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::TempDir;
    use super::*;

    /// Stands in for DPAPI on any OS: reversible, and different from the plain JSON.
    struct Scramble;

    impl Protector for Scramble {
        fn protect(&self, plain: &[u8]) -> Result<Vec<u8>> {
            Ok(plain.iter().rev().map(|b| b ^ 0x5a).collect())
        }

        fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>> {
            Ok(protected.iter().rev().map(|b| b ^ 0x5a).collect())
        }
    }

    fn temp() -> TempDir {
        TempDir::new("keys")
    }

    #[test]
    fn keys_round_trip_through_the_file() {
        let dir = temp();
        let net = dir.path().join(NETWORK_DIR);
        assert!(load(&net).unwrap().is_none());
        let made = create(&net).unwrap();
        let again = load(&net).unwrap().expect("the key file was written");
        assert_eq!(made.signing_public(), again.signing_public());
        assert_eq!(made.sealing_public(), again.sealing_public());
        assert_eq!(made.fingerprint(), again.fingerprint());
        // The same private halves: what one signs, the other's public key verifies, and the other's
        // sealing secret agrees with the first's public key.
        let signature = made.sign(b"hello");
        verify_signature(&again.signing_public_b64(), b"hello", &signature).unwrap();
        let theirs = SealingPublicKey::from(&StaticSecret::from([7u8; 32]));
        assert_eq!(made.sealing_secret().diffie_hellman(&theirs).to_bytes(), again.sealing_secret().diffie_hellman(&theirs).to_bytes());
    }

    #[test]
    fn load_or_create_keeps_the_identity_and_create_replaces_it() {
        let dir = temp();
        let net = dir.path().join(NETWORK_DIR);
        let first = load_or_create(&net).unwrap();
        let second = load_or_create(&net).unwrap();
        assert_eq!(first.signing_public(), second.signing_public());
        let replaced = create(&net).unwrap();
        assert_ne!(first.signing_public(), replaced.signing_public(), "Rejoin makes a new identity");
        assert_eq!(load(&net).unwrap().unwrap().signing_public(), replaced.signing_public());
        remove(&net).unwrap();
        remove(&net).unwrap();
        assert!(load(&net).unwrap().is_none());
    }

    #[test]
    fn a_protector_wraps_the_file_and_round_trips() {
        let dir = temp();
        let net = dir.path().join(NETWORK_DIR);
        let made = create_with(&net, &Scramble).unwrap();
        let on_disk = std::fs::read(key_path(&net)).unwrap();
        assert!(serde_json::from_slice::<serde_json::Value>(&on_disk).is_err(), "the file is not plain JSON");
        assert!(!String::from_utf8_lossy(&on_disk).contains("signing"));
        let loaded = load_with(&net, &Scramble).unwrap().unwrap();
        assert_eq!(made.signing_public(), loaded.signing_public());
        // The wrong protector does not produce a key.
        assert!(load_with(&net, &Plain).is_err());
    }

    #[test]
    fn a_damaged_key_file_is_an_error_not_a_new_identity() {
        let dir = temp();
        let net = dir.path().join(NETWORK_DIR);
        let made = create(&net).unwrap();
        let path = key_path(&net);
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(load(&net).is_err());
        assert!(load_or_create(&net).is_err(), "load_or_create must not paper over a damaged key");
        std::fs::write(&path, br#"{"v":1,"signing":"AAAA","sealing":"AAAA"}"#).unwrap();
        assert!(load(&net).is_err(), "short secrets are refused");
        std::fs::write(&path, br#"{"v":9,"signing":"AAAA","sealing":"AAAA"}"#).unwrap();
        assert!(load(&net).unwrap_err().to_string().contains("version 9"));
        // Nothing replaced it.
        assert_eq!(std::fs::read(&path).unwrap(), br#"{"v":9,"signing":"AAAA","sealing":"AAAA"}"#);
        let _ = made;
    }

    #[cfg(unix)]
    #[test]
    fn the_key_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp();
        let net = dir.path().join(NETWORK_DIR);
        create(&net).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&key_path(&net)), 0o600);
        assert_eq!(mode(&net), 0o700);
        // A leftover world-readable temp file does not leak the next key.
        let temp_file = net.join(format!("{KEY_FILE}.tmp"));
        std::fs::write(&temp_file, b"old").unwrap();
        std::fs::set_permissions(&temp_file, std::fs::Permissions::from_mode(0o644)).unwrap();
        create(&net).unwrap();
        assert_eq!(mode(&key_path(&net)), 0o600);
        assert!(!temp_file.exists(), "the temp file was renamed over the key");
    }

    #[test]
    fn signatures_are_checked_strictly() {
        let keys = MachineKeys::generate();
        let other = MachineKeys::generate();
        let signature = keys.sign(b"message");
        assert_eq!(signature.len(), 64);
        verify_signature(&keys.signing_public_b64(), b"message", &signature).unwrap();
        assert_eq!(verify_signature(&keys.signing_public_b64(), b"other", &signature), Err(KeyError::Mismatch));
        assert_eq!(verify_signature(&other.signing_public_b64(), b"message", &signature), Err(KeyError::Mismatch));
        assert_eq!(verify_signature(&keys.signing_public_b64(), b"message", &signature[..63]), Err(KeyError::BadSignature));
        assert_eq!(verify_signature("not base64!", b"message", &signature), Err(KeyError::BadPublicKey));
        assert_eq!(verify_signature(&B64.encode([1u8; 7]), b"message", &signature), Err(KeyError::BadPublicKey));
        // The identity point is a small-order key: strict verification refuses it.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert!(verify_signature(&B64.encode(identity), b"message", &[0u8; 64]).is_err());
    }

    #[test]
    fn the_fingerprint_is_sixteen_hex_characters_of_the_key_hash() {
        let keys = MachineKeys::generate();
        let fingerprint = keys.fingerprint();
        assert_eq!(fingerprint.len(), 16);
        assert!(fingerprint.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        let full: String = Sha256::digest(keys.signing_public()).iter().map(|b| format!("{b:02x}")).collect();
        assert!(full.starts_with(&fingerprint));
        assert_ne!(fingerprint, MachineKeys::generate().fingerprint());
        assert!(!format!("{keys:?}").contains(&keys.signing_public_b64()), "Debug never prints key material");
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_wraps_and_unwraps_the_key_file() {
        let dir = temp();
        let net = dir.path().join(NETWORK_DIR);
        let made = create_with(&net, &dpapi::Dpapi).unwrap();
        let on_disk = std::fs::read(key_path(&net)).unwrap();
        assert!(!String::from_utf8_lossy(&on_disk).contains("signing"), "the key JSON is wrapped");
        let loaded = load_with(&net, &dpapi::Dpapi).unwrap().unwrap();
        assert_eq!(made.signing_public(), loaded.signing_public());
        assert_eq!(made.sealing_public(), loaded.sealing_public());
        // The platform path is DPAPI too.
        assert_eq!(load(&net).unwrap().unwrap().signing_public(), made.signing_public());
        assert!(load_with(&net, &Plain).is_err(), "the wrapped file is not readable as plain JSON");
    }
}
