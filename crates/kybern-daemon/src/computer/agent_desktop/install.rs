//! The pinned download of agent-desktop (design §5, "Install (no npm)").
//!
//! The release archive for this OS and CPU is fetched over HTTPS, its sha256
//! is checked against a pin in this file before anything reads it, its
//! entries are listed with the system `tar` and refused unless every one is an
//! expected plain file name, and the extracted binaries are checked against
//! their own pins. The same pins are checked again on every start.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail, ensure};
use kybern_protocol::process::NoWindow;
use sha2::{Digest, Sha256};
use tokio::process::Command;

pub(crate) const VERSION: &str = "1.0.2";
const RELEASE_URL: &str = "https://github.com/vercel-labs/agent-desktop/releases/download";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_ARCHIVE_BYTES: u64 = 40 * 1024 * 1024;

/// One release target: the archive hash and the hash of each file in it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Pin {
    pub target: &'static str,
    pub archive_sha256: &'static str,
    /// `(file name, sha256)`; the first file is the CLI itself.
    pub files: &'static [(&'static str, &'static str)],
}

impl Pin {
    pub(crate) fn binary_name(&self) -> &'static str {
        self.files[0].0
    }
}

/// Archive hashes: the release's `checksums.txt` and GitHub's asset digests,
/// which agree. File hashes: computed from the extracted v1.0.2 archives.
pub(crate) const PINS: &[Pin] = &[
    Pin {
        target: "aarch64-apple-darwin",
        archive_sha256: "7bee385196d7b478de80cf05ca4304aaa38f0eba593b3406ad3c247c1773be19",
        files: &[
            ("agent-desktop", "bf0a3c9256512f2f57288d37ccd17d7f03665fccc53c2f74011a49b98e61ba59"),
            ("agent-desktop-macos-helper", "522829116cb006b5770c6a82b361f466a4775f794d6af4083e75231a2d6bb551"),
        ],
    },
    Pin {
        target: "x86_64-apple-darwin",
        archive_sha256: "8edda6df17eafc042395502a823dbb8415bc8ac14835a6731e4d8becc9cb4121",
        files: &[
            ("agent-desktop", "9684916bb4b5486c02cef8b2d480e55a551639b08358284f90a87cef43b2da8b"),
            ("agent-desktop-macos-helper", "ce52467818ac601ae1145a0b9ecaa14aaf04d2e72d24cf6d29d26757340f9c6b"),
        ],
    },
    Pin {
        target: "x86_64-pc-windows-msvc",
        archive_sha256: "2186c76e7df197c0e67365e45d36d869f74714c56bb8a73817e2a66f3e18e222",
        files: &[("agent-desktop.exe", "409e58cbdd6aed47e29771ffa60bc122a9843505a227af488cded85215943988")],
    },
    Pin {
        target: "aarch64-pc-windows-msvc",
        archive_sha256: "a0ecd6e17e60a0bcfbb45533a72f2d3a7a73508769588273ef08b0477d2b9687",
        files: &[("agent-desktop.exe", "5877fbca41fb85806353d0aaf67c23cfdf06a58a77c5d9cba005727a2891034e")],
    },
    Pin {
        target: "x86_64-unknown-linux-gnu",
        archive_sha256: "ad661b7a3fd8f990a769243f4889a240ca0e2c8dab3ef5bddd6019086c71e0b4",
        files: &[
            ("agent-desktop", "05427281a6746489bc0e15c16698a70a86322125c76c7a9e2f4c2d7a12bf7c5b"),
            ("agent-desktop-linux-clipboard-owner", "bf17de139902724e86b3616970b7b7f16f5f1fb4143910b532a38dd2182720fa"),
        ],
    },
    Pin {
        target: "aarch64-unknown-linux-gnu",
        archive_sha256: "864cb782e0afc8bf0df19622016b24bdbd1a83fc7749f784ee82aa49a7f845eb",
        files: &[
            ("agent-desktop", "529ae49006278f778bcda6b68d7460a55148e2cefb1cb69a23485381d9dbdec0"),
            ("agent-desktop-linux-clipboard-owner", "dcd6f2ce9a0e92e42f4d2ee9161ea1b9f2b11c0e4b1878119a19c0a2db3630a6"),
        ],
    },
];

/// The release target for an OS and CPU as `std::env::consts` names them.
pub(crate) fn target_for(os: &str, arch: &str) -> Option<&'static str> {
    Some(match (os, arch) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        _ => return None,
    })
}

pub(crate) fn pin_for(target: &str) -> Option<&'static Pin> {
    PINS.iter().find(|pin| pin.target == target)
}

pub(crate) fn current_pin() -> Option<&'static Pin> {
    target_for(std::env::consts::OS, std::env::consts::ARCH).and_then(pin_for)
}

pub(crate) fn archive_url(target: &str) -> String {
    format!("{RELEASE_URL}/v{VERSION}/agent-desktop-v{VERSION}-{target}.tar.gz")
}

/// `<data dir>/tools/agent-desktop`.
pub(crate) fn tools_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("tools").join("agent-desktop")
}

/// `<data dir>/tools/agent-desktop/<version>`.
pub(crate) fn install_dir(data_dir: &Path) -> PathBuf {
    tools_dir(data_dir).join(VERSION)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_file(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Remembers which files already passed, by path, modification time and size,
/// so a start costs a `stat` instead of a hash.
#[derive(Default)]
pub(crate) struct VerifyCache {
    seen: Mutex<HashMap<PathBuf, (SystemTime, u64, String)>>,
}

impl VerifyCache {
    /// Does the file at `path` hash to `expected`?
    pub(crate) fn matches(&self, path: &Path, expected: &str) -> Result<bool> {
        let meta = std::fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
        let key = (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len());
        if let Some((modified, len, hash)) = self.seen.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(path)
            && (*modified, *len) == key
        {
            return Ok(hash == expected);
        }
        let hash = sha256_file(path)?;
        let matched = hash == expected;
        self.seen.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(path.to_path_buf(), (key.0, key.1, hash));
        Ok(matched)
    }
}

/// Check every pinned file of an installation directory.
pub(crate) fn verify_dir(cache: &VerifyCache, dir: &Path, pin: &Pin) -> Result<()> {
    for (name, expected) in pin.files {
        let path = dir.join(name);
        ensure!(path.is_file(), "{} is missing from {}", name, dir.display());
        ensure!(cache.matches(&path, expected)?, "{} does not match the pinned agent-desktop {VERSION} build", path.display());
    }
    Ok(())
}

/// The system `tar`, by absolute path: a `tar` earlier on `PATH` is not trusted.
pub(crate) fn system_tar() -> PathBuf {
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("windir")).unwrap_or_else(|| r"C:\Windows".into());
        PathBuf::from(root).join("System32").join("tar.exe")
    } else {
        PathBuf::from("/usr/bin/tar")
    }
}

/// Refuse an archive listing with an absolute path, a `..` component, a
/// nested path or any file the pin does not name.
pub(crate) fn check_listing(listing: &str, pin: &Pin) -> Result<()> {
    let mut seen = Vec::new();
    for line in listing.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let name = line.strip_prefix("./").unwrap_or(line);
        ensure!(!line.starts_with('/') && !line.starts_with('\\') && !line.contains(':'), "the archive has an absolute path: {line}");
        ensure!(!line.split(['/', '\\']).any(|part| part == ".."), "the archive has a '..' path: {line}");
        ensure!(!name.contains('/') && !name.contains('\\'), "the archive has an unexpected nested path: {line}");
        ensure!(pin.files.iter().any(|(expected, _)| *expected == name), "the archive has an unexpected file: {line}");
        seen.push(name.to_owned());
    }
    for (expected, _) in pin.files {
        ensure!(seen.iter().any(|name| name == expected), "the archive lacks {expected}");
    }
    Ok(())
}

async fn run_tar(args: &[&std::ffi::OsStr]) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(120),
        Command::new(system_tar()).no_window().args(args).stdin(std::process::Stdio::null()).kill_on_drop(true).output(),
    )
    .await
    .context("tar timed out")?
    .context("start the system tar")?;
    ensure!(output.status.success(), "tar failed: {}", String::from_utf8_lossy(&output.stderr).trim());
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Install an archive that is already on disk: hash, list, extract, verify
/// the files, rename into place. Split from the download so tests can drive it.
pub(crate) async fn install_archive(archive: &Path, staging: &Path, final_dir: &Path, pin: &Pin) -> Result<()> {
    let bytes = tokio::fs::read(archive).await.with_context(|| format!("read {}", archive.display()))?;
    ensure!(
        sha256_hex(&bytes) == pin.archive_sha256,
        "the downloaded agent-desktop archive does not match the pinned checksum; it was not installed"
    );
    drop(bytes);
    let listing = run_tar(&["-tzf".as_ref(), archive.as_os_str()]).await?;
    check_listing(&listing, pin)?;
    let unpacked = staging.join("unpacked");
    tokio::fs::create_dir_all(&unpacked).await?;
    run_tar(&["-xzf".as_ref(), archive.as_os_str(), "-C".as_ref(), unpacked.as_os_str()]).await?;
    let cache = VerifyCache::default();
    verify_dir(&cache, &unpacked, pin).context("the extracted files are not the pinned build")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for (name, _) in pin.files {
            tokio::fs::set_permissions(unpacked.join(name), std::fs::Permissions::from_mode(0o755)).await?;
        }
    }
    if let Some(parent) = final_dir.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if final_dir.exists() {
        tokio::fs::remove_dir_all(final_dir).await.with_context(|| format!("replace {}", final_dir.display()))?;
    }
    tokio::fs::rename(&unpacked, final_dir).await.with_context(|| format!("move the build into {}", final_dir.display()))?;
    Ok(())
}

/// Download and install the pinned release for this machine.
pub(crate) async fn install(data_dir: &Path) -> Result<()> {
    let Some(pin) = current_pin() else {
        bail!("agent-desktop {VERSION} has no build for {} {}", std::env::consts::OS, std::env::consts::ARCH);
    };
    let tools = tools_dir(data_dir);
    tokio::fs::create_dir_all(&tools).await?;
    let staging = tools.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    tokio::fs::create_dir_all(&staging).await?;
    let result = async {
        let archive = staging.join("agent-desktop.tar.gz");
        download(&archive_url(pin.target), &archive).await?;
        install_archive(&archive, &staging, &install_dir(data_dir), pin).await
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&staging).await;
    result
}

async fn download(url: &str, to: &Path) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let client = reqwest::Client::builder().timeout(DOWNLOAD_TIMEOUT).user_agent("kybern").build()?;
    let mut response = client.get(url).send().await.with_context(|| format!("download {url}"))?.error_for_status()?;
    ensure!(response.content_length().is_none_or(|length| length <= MAX_ARCHIVE_BYTES), "the agent-desktop archive is unexpectedly large");
    let mut file = tokio::fs::File::create(to).await?;
    let mut written = 0u64;
    while let Some(chunk) = response.chunk().await? {
        written += chunk.len() as u64;
        ensure!(written <= MAX_ARCHIVE_BYTES, "the agent-desktop archive is unexpectedly large");
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kybern-ad-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A pin for tiny fixture files; the production pins are exercised by the
    /// shape tests below.
    fn fixture_pin(archive_sha256: &str, hash: &str) -> Pin {
        // Leak: tests only, a few bytes.
        let hash: &'static str = Box::leak(hash.to_owned().into_boxed_str());
        let archive: &'static str = Box::leak(archive_sha256.to_owned().into_boxed_str());
        let files: &'static [(&'static str, &'static str)] = Box::leak(vec![("agent-desktop", hash)].into_boxed_slice());
        Pin { target: "test", archive_sha256: archive, files }
    }

    fn tar_gz(dir: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let source = dir.join(format!("{name}-src"));
        std::fs::create_dir_all(&source).unwrap();
        for (file, content) in files {
            let path = source.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        let archive = dir.join(format!("{name}.tar.gz"));
        let names: Vec<&str> = files.iter().map(|(file, _)| *file).collect();
        let status =
            std::process::Command::new(system_tar()).arg("-czf").arg(&archive).arg("-C").arg(&source).args(&names).status().unwrap();
        assert!(status.success());
        archive
    }

    #[test]
    fn every_release_target_has_a_pin_with_real_looking_hashes() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("windows", "x86_64"),
            ("windows", "aarch64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
        ] {
            let target = target_for(os, arch).unwrap();
            let pin = pin_for(target).unwrap_or_else(|| panic!("no pin for {target}"));
            assert_eq!(pin.archive_sha256.len(), 64);
            assert!(pin.files.iter().all(|(_, hash)| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())));
            assert_eq!(pin.binary_name(), if os == "windows" { "agent-desktop.exe" } else { "agent-desktop" });
        }
        assert!(target_for("freebsd", "x86_64").is_none());
        assert_eq!(
            archive_url("x86_64-pc-windows-msvc"),
            "https://github.com/vercel-labs/agent-desktop/releases/download/v1.0.2/agent-desktop-v1.0.2-x86_64-pc-windows-msvc.tar.gz"
        );
    }

    #[test]
    fn listings_with_absolute_dotdot_nested_or_extra_entries_are_refused() {
        let pin = pin_for("x86_64-unknown-linux-gnu").unwrap();
        let ok = "agent-desktop\nagent-desktop-linux-clipboard-owner\n";
        check_listing(ok, pin).unwrap();
        check_listing("./agent-desktop\n./agent-desktop-linux-clipboard-owner\n", pin).unwrap();
        for (bad, why) in [
            ("/etc/passwd\nagent-desktop\nagent-desktop-linux-clipboard-owner\n", "absolute"),
            ("../agent-desktop\nagent-desktop-linux-clipboard-owner\n", "dotdot"),
            ("agent-desktop\nagent-desktop-linux-clipboard-owner\nsub/../../x\n", "dotdot nested"),
            ("C:\\x\nagent-desktop\nagent-desktop-linux-clipboard-owner\n", "drive"),
            ("agent-desktop\nagent-desktop-linux-clipboard-owner\nextra\n", "unexpected"),
            ("agent-desktop\nagent-desktop-linux-clipboard-owner\nbin/agent-desktop\n", "nested"),
            ("agent-desktop\n", "missing helper"),
        ] {
            assert!(check_listing(bad, pin).is_err(), "{why}");
        }
    }

    #[tokio::test]
    async fn a_good_archive_installs_executable_files() {
        let dir = scratch("good");
        let archive = tar_gz(&dir, "good", &[("agent-desktop", "binary bytes")]);
        let pin = fixture_pin(&sha256_hex(&std::fs::read(&archive).unwrap()), &sha256_hex(b"binary bytes"));
        let final_dir = dir.join("tools").join("1.0.2");
        install_archive(&archive, &dir.join("staging"), &final_dir, &pin).await.unwrap();
        assert_eq!(std::fs::read(final_dir.join("agent-desktop")).unwrap(), b"binary bytes");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(final_dir.join("agent-desktop")).unwrap().permissions().mode() & 0o777, 0o755);
        }
        verify_dir(&VerifyCache::default(), &final_dir, &pin).unwrap();
        // Installing again replaces the directory.
        install_archive(&archive, &dir.join("staging2"), &final_dir, &pin).await.unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_wrong_archive_checksum_installs_nothing() {
        let dir = scratch("badsha");
        let archive = tar_gz(&dir, "bad", &[("agent-desktop", "binary bytes")]);
        let pin = fixture_pin(&"0".repeat(64), &sha256_hex(b"binary bytes"));
        let final_dir = dir.join("final");
        let error = install_archive(&archive, &dir.join("staging"), &final_dir, &pin).await.unwrap_err();
        assert!(error.to_string().contains("pinned checksum"), "{error}");
        assert!(!final_dir.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn an_unexpected_entry_is_refused_before_extraction() {
        let dir = scratch("extra");
        let archive = tar_gz(&dir, "extra", &[("agent-desktop", "binary bytes"), ("evil.sh", "rm -rf")]);
        let pin = fixture_pin(&sha256_hex(&std::fs::read(&archive).unwrap()), &sha256_hex(b"binary bytes"));
        let error = install_archive(&archive, &dir.join("staging"), &dir.join("final"), &pin).await.unwrap_err();
        assert!(error.to_string().contains("unexpected file"), "{error}");
        assert!(!dir.join("staging").join("unpacked").exists(), "nothing is extracted");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_dotdot_entry_is_refused() {
        let dir = scratch("dotdot");
        let source = dir.join("src");
        std::fs::create_dir_all(source.join("inner")).unwrap();
        std::fs::write(source.join("agent-desktop"), "binary bytes").unwrap();
        std::fs::write(dir.join("outside"), "x").unwrap();
        // bsdtar and GNU tar both keep a '..' member name when asked with -P or a path that spells it.
        let archive = dir.join("dotdot.tar.gz");
        let status = std::process::Command::new(system_tar())
            .arg("-czPf")
            .arg(&archive)
            .arg("-C")
            .arg(source.join("inner"))
            .arg("../agent-desktop")
            .status()
            .unwrap();
        assert!(status.success());
        let pin = fixture_pin(&sha256_hex(&std::fs::read(&archive).unwrap()), &sha256_hex(b"binary bytes"));
        let error = install_archive(&archive, &dir.join("staging"), &dir.join("final"), &pin).await.unwrap_err();
        assert!(error.to_string().contains("'..'") || error.to_string().contains("unexpected"), "{error}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn extracted_files_must_match_their_pins_too() {
        let dir = scratch("filehash");
        let archive = tar_gz(&dir, "tampered", &[("agent-desktop", "different bytes")]);
        let pin = fixture_pin(&sha256_hex(&std::fs::read(&archive).unwrap()), &sha256_hex(b"binary bytes"));
        let error = install_archive(&archive, &dir.join("staging"), &dir.join("final"), &pin).await.unwrap_err();
        assert!(format!("{error:#}").contains("pinned build"), "{error:#}");
        assert!(!dir.join("final").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_verify_cache_rehashes_a_changed_file() {
        let dir = scratch("cache");
        let path = dir.join("agent-desktop");
        std::fs::write(&path, "one").unwrap();
        let cache = VerifyCache::default();
        assert!(cache.matches(&path, &sha256_hex(b"one")).unwrap());
        assert!(cache.matches(&path, &sha256_hex(b"one")).unwrap());
        std::fs::write(&path, "twelve bytes").unwrap();
        assert!(!cache.matches(&path, &sha256_hex(b"one")).unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
