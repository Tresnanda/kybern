//! One-click install of Kybern GPUIX, the native macOS app that ships beside
//! this one. The release feed (`latest.json`, the same endpoint the updater
//! plugin reads) carries a `darwin-aarch64-gpuix` entry pointing at
//! `kybern-gpuix_<version>_aarch64.app.tar.gz` with its minisign signature, and
//! a `darwin-x86_64-gpuix` entry for the Intel build.
//!
//! The archive is downloaded, verified against the updater public key in
//! `tauri.conf.json`, unpacked into a staging folder beside its destination,
//! checked for the GPUIX bundle id, and only then swapped into place, so a
//! failed or tampered download never touches an installed copy. This mirrors
//! `scripts/install-mac-gpuix.sh` and `apps/gpuix/src/platform/update.ts`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

const BUNDLE_ID: &str = "dev.kybern.gpuix";
const APP_NAME: &str = "Kybern GPUIX.app";
const PROGRESS_EVENT: &str = "gpuix-install-progress";
const MANUAL_COMMAND: &str = "curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-mac-install.sh | sh";
/// The archive is a few tens of MB; refuse anything absurd before it fills the disk.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Downloading,
    Verifying,
    Installing,
    Done,
}

#[derive(Debug, Clone, Serialize)]
struct Progress {
    phase: Phase,
    /// 0–1 while downloading when the size is known.
    progress: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GpuixStatus {
    /// This Mac can run GPUIX (macOS on Apple Silicon or Intel).
    supported: bool,
    installed: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct Entry {
    url: String,
    signature: String,
}

fn supported() -> bool {
    cfg!(all(target_os = "macos", any(target_arch = "aarch64", target_arch = "x86_64")))
}

/// The feed key of this Mac's GPUIX build. An Intel build of this app running
/// under Rosetta is on Apple Silicon, so it installs the native arm64 GPUIX.
fn platform_key() -> &'static str {
    if cfg!(target_arch = "x86_64") && !translated() { "darwin-x86_64-gpuix" } else { "darwin-aarch64-gpuix" }
}

fn translated() -> bool {
    Command::new("/usr/sbin/sysctl").args(["-n", "sysctl.proc_translated"]).output().is_ok_and(|output| output.stdout.trim_ascii() == b"1")
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(Path::new(&home).join("Applications"));
    }
    dirs
}

fn installed_in(dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().map(|dir| dir.join(APP_NAME)).find(|path| path.is_dir())
}

/// Whether Kybern GPUIX is installed in `/Applications` or `~/Applications`.
#[tauri::command]
pub fn gpuix_installed() -> bool {
    supported() && installed_in(&candidate_dirs()).is_some()
}

#[tauri::command]
pub fn gpuix_status() -> GpuixStatus {
    GpuixStatus { supported: supported(), installed: gpuix_installed() }
}

/// Open the installed Kybern GPUIX.
#[tauri::command]
pub fn open_gpuix() -> Result<(), String> {
    let app = installed_in(&candidate_dirs())
        .ok_or_else(|| format!("Kybern GPUIX is not installed. Install it first, or run: {MANUAL_COMMAND}"))?;
    open_app(&app)
}

fn open_app(app: &Path) -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .arg(app)
        .status()
        .map_err(|error| format!("Could not open Kybern GPUIX ({error}). Open it from Applications."))?;
    if status.success() { Ok(()) } else { Err("Could not open Kybern GPUIX. Open it from Applications.".into()) }
}

/// Download, verify and install Kybern GPUIX, then open it. Progress arrives as
/// `gpuix-install-progress` events; errors say what to do next.
#[tauri::command]
pub async fn install_gpuix<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if !supported() {
        return Err("Kybern GPUIX needs a Mac. This computer can keep using the current app.".into());
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("Kybern GPUIX is already installing.".into());
    }
    let result = install_and_open(&app).await;
    INSTALLING.store(false, Ordering::SeqCst);
    result.map_err(with_manual_hint)
}

fn with_manual_hint(error: String) -> String {
    format!("{error} To install it yourself, run this in Terminal: {MANUAL_COMMAND}")
}

async fn install_and_open<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let updater = app.config().plugins.0.get("updater").cloned().ok_or("This build has no update feed configured.")?;
    let pubkey = updater.get("pubkey").and_then(|value| value.as_str()).ok_or("This build has no update key configured.")?.to_string();
    let endpoints: Vec<String> = updater
        .get("endpoints")
        .and_then(|value| value.as_array())
        .map(|list| list.iter().filter_map(|value| value.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let dest = writable_install_dir()?;
    let emit = |phase: Phase, progress: Option<f64>| {
        let _ = app.emit(PROGRESS_EVENT, Progress { phase, progress });
    };
    let installed = run_install(&endpoints, &pubkey, &dest, &emit).await?;
    emit(Phase::Done, None);
    open_app(&installed)
}

/// `/Applications` when the user can write there, otherwise `~/Applications`.
fn writable_install_dir() -> Result<PathBuf, String> {
    let system = PathBuf::from("/Applications");
    if is_writable(&system) {
        return Ok(system);
    }
    let home = std::env::var_os("HOME").ok_or("Could not find your home folder.")?;
    let user = Path::new(&home).join("Applications");
    std::fs::create_dir_all(&user).map_err(|error| format!("Could not create {} ({error}).", user.display()))?;
    Ok(user)
}

fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".kybern-write-probe-{}", uuid::Uuid::new_v4()));
    let ok = std::fs::create_dir(&probe).is_ok();
    let _ = std::fs::remove_dir(&probe);
    ok
}

fn parse_manifest(json: &str, key: &str) -> Result<Entry, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "The release feed is not valid. Try again in a few minutes.".to_string())?;
    let entry = value
        .get("platforms")
        .and_then(|platforms| platforms.get(key))
        .ok_or("This release does not include Kybern GPUIX yet. Try again in a few minutes.")?;
    let url = entry.get("url").and_then(|value| value.as_str()).filter(|url| !url.is_empty());
    let signature = entry.get("signature").and_then(|value| value.as_str()).filter(|signature| !signature.is_empty());
    let (Some(url), Some(signature)) = (url, signature) else {
        return Err("The Kybern GPUIX entry in the release feed is incomplete. Try again in a few minutes.".into());
    };
    let loopback = url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost");
    if !url.starts_with("https://") && !loopback {
        return Err("The Kybern GPUIX download is not served over HTTPS, so it was not installed.".into());
    }
    Ok(Entry { url: url.to_string(), signature: signature.to_string() })
}

/// Check `data` against a Tauri updater signature (base64 of the `.sig` file)
/// and public key (base64 of the `.pub` file).
fn verify_signature(data: &[u8], signature: &str, pubkey: &str) -> Result<(), String> {
    let text = |value: &str| -> Result<String, String> {
        let bytes = STANDARD.decode(value.trim()).map_err(|_| "unreadable".to_string())?;
        String::from_utf8(bytes).map_err(|_| "unreadable".to_string())
    };
    let bad_key = || "The update key in this app could not be read. Reinstall Kybern from the website.".to_string();
    let public_key =
        text(pubkey).and_then(|text| minisign_verify::PublicKey::decode(&text).map_err(|_| String::new())).map_err(|_| bad_key())?;
    let signature = text(signature)
        .and_then(|text| minisign_verify::Signature::decode(&text).map_err(|_| String::new()))
        .map_err(|_| "The Kybern GPUIX signature could not be read, so it was not installed.".to_string())?;
    public_key
        .verify(data, &signature, true)
        .map_err(|_| "The Kybern GPUIX download did not match its signature, so it was not installed.".to_string())
}

/// `CFBundleIdentifier` of an `Info.plist`, XML or binary.
fn read_bundle_id(plist: &Path) -> Result<String, String> {
    let bytes = std::fs::read(plist).map_err(|_| "The download is not a Kybern GPUIX app.".to_string())?;
    if bytes.starts_with(b"bplist") {
        let output = Command::new("/usr/bin/plutil")
            .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-", "--"])
            .arg(plist)
            .output()
            .map_err(|_| "The download is not a Kybern GPUIX app.".to_string())?;
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let text = String::from_utf8_lossy(&bytes);
    let after_key = text.split("<key>CFBundleIdentifier</key>").nth(1).ok_or("The download is not a Kybern GPUIX app.")?;
    let value = after_key
        .split("<string>")
        .nth(1)
        .and_then(|rest| rest.split("</string>").next())
        .ok_or("The download is not a Kybern GPUIX app.")?;
    Ok(value.trim().to_string())
}

fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    let output = Command::new("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(into)
        .output()
        .map_err(|error| format!("Could not unpack Kybern GPUIX ({error})."))?;
    if output.status.success() { Ok(()) } else { Err("Could not unpack the Kybern GPUIX download.".into()) }
}

/// Unpack `archive` into a staging folder inside `dest_dir` (same volume, so the
/// final rename is atomic), check the bundle id, and swap it in. An existing
/// bundle is replaced only once the new one is complete, and restored if the
/// swap fails.
fn install_archive(archive: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let stage = dest_dir.join(format!(".kybern-gpuix-stage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&stage).map_err(|error| format!("Could not write to {} ({error}).", dest_dir.display()))?;
    let result = place_bundle(archive, dest_dir, &stage);
    let _ = std::fs::remove_dir_all(&stage);
    result
}

fn place_bundle(archive: &Path, dest_dir: &Path, stage: &Path) -> Result<PathBuf, String> {
    let unpacked = stage.join("new");
    std::fs::create_dir(&unpacked).map_err(|error| format!("Could not unpack Kybern GPUIX ({error})."))?;
    extract(archive, &unpacked)?;
    let fresh = unpacked.join(APP_NAME);
    if !fresh.is_dir() {
        return Err("The download did not contain Kybern GPUIX.".into());
    }
    if read_bundle_id(&fresh.join("Contents/Info.plist"))? != BUNDLE_ID {
        return Err("The download is not Kybern GPUIX, so it was not installed.".into());
    }
    // Nothing here is quarantined; this guards against an archive that carries the flag.
    let _ = Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine"]).arg(&fresh).output();

    let target = dest_dir.join(APP_NAME);
    let previous = stage.join("previous");
    let had_previous = target.exists();
    if had_previous {
        std::fs::rename(&target, &previous)
            .map_err(|error| format!("Could not replace the installed Kybern GPUIX ({error}). Quit it and try again."))?;
    }
    if let Err(error) = std::fs::rename(&fresh, &target) {
        if had_previous {
            let _ = std::fs::rename(&previous, &target);
        }
        return Err(format!("Could not install Kybern GPUIX ({error})."));
    }
    Ok(target)
}

async fn fetch_manifest(client: &reqwest::Client, endpoints: &[String]) -> Result<String, String> {
    let mut last = "The release feed is unavailable right now. Check your connection or try again in a few minutes.".to_string();
    for endpoint in endpoints {
        match client.get(endpoint).header("Accept", "application/json").send().await {
            Ok(response) if response.status().is_success() => match response.text().await {
                Ok(text) => return Ok(text),
                Err(_) => continue,
            },
            Ok(response) => last = format!("The release feed answered {}. Try again in a few minutes.", response.status().as_u16()),
            Err(_) => continue,
        }
    }
    Err(last)
}

async fn download(client: &reqwest::Client, url: &str, into: &Path, emit: &(dyn Fn(Phase, Option<f64>) + Sync)) -> Result<(), String> {
    use std::io::Write;
    let unavailable = |_| "The Kybern GPUIX download failed. Check your connection and try again.".to_string();
    let mut response = client.get(url).send().await.map_err(unavailable)?;
    if !response.status().is_success() {
        return Err(format!("The Kybern GPUIX download answered {}. Try again in a few minutes.", response.status().as_u16()));
    }
    let total = response.content_length().filter(|total| *total > 0);
    if total.is_some_and(|total| total > MAX_ARCHIVE_BYTES) {
        return Err("The Kybern GPUIX download is larger than expected, so it was not installed.".into());
    }
    let mut file = std::fs::File::create(into).map_err(|error| format!("Could not save the download ({error})."))?;
    let mut received = 0u64;
    emit(Phase::Downloading, total.map(|_| 0.0));
    while let Some(chunk) = response.chunk().await.map_err(unavailable)? {
        received += chunk.len() as u64;
        if received > MAX_ARCHIVE_BYTES {
            return Err("The Kybern GPUIX download is larger than expected, so it was not installed.".into());
        }
        file.write_all(&chunk).map_err(|error| format!("Could not save the download ({error})."))?;
        emit(Phase::Downloading, total.map(|total| (received as f64 / total as f64).min(1.0)));
    }
    Ok(())
}

/// Fetch the feed, download the GPUIX archive, verify it and install it into
/// `dest_dir`. Returns the installed bundle path.
async fn run_install(
    endpoints: &[String],
    pubkey: &str,
    dest_dir: &Path,
    emit: &(dyn Fn(Phase, Option<f64>) + Sync),
) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .user_agent("kybern-desktop")
        .build()
        .map_err(|error| error.to_string())?;
    let entry = parse_manifest(&fetch_manifest(&client, endpoints).await?, platform_key())?;
    let work = std::env::temp_dir().join(format!("kybern-gpuix-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).map_err(|error| format!("Could not create a temporary folder ({error})."))?;
    let result = async {
        let archive = work.join("kybern-gpuix.app.tar.gz");
        download(&client, &entry.url, &archive, emit).await?;
        emit(Phase::Verifying, None);
        let bytes = std::fs::read(&archive).map_err(|error| format!("Could not read the download ({error})."))?;
        verify_signature(&bytes, &entry.signature, pubkey)?;
        emit(Phase::Installing, None);
        install_archive(&archive, dest_dir)
    }
    .await;
    let _ = std::fs::remove_dir_all(&work);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    // Throwaway key and archives made by `tests/fixtures/gpuix/make-fixtures.sh`.
    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/gpuix");

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(Path::new(FIXTURES).join(name)).unwrap()
    }
    fn fixture_text(name: &str) -> String {
        String::from_utf8(fixture(name)).unwrap().trim().to_string()
    }
    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kybern-gpuix-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn manifest_picks_the_gpuix_entry() {
        let json = r#"{"version":"0.10.0","platforms":{"darwin-aarch64":{"url":"https://x/desktop.tar.gz","signature":"a"},
            "darwin-aarch64-gpuix":{"url":"https://x/kybern-gpuix_0.10.0_aarch64.app.tar.gz","signature":"sig"},
            "darwin-x86_64-gpuix":{"url":"https://x/kybern-gpuix_0.10.0_x86_64.app.tar.gz","signature":"intel"}}}"#;
        assert_eq!(
            parse_manifest(json, "darwin-aarch64-gpuix").unwrap(),
            Entry { url: "https://x/kybern-gpuix_0.10.0_aarch64.app.tar.gz".into(), signature: "sig".into() }
        );
        assert_eq!(
            parse_manifest(json, "darwin-x86_64-gpuix").unwrap(),
            Entry { url: "https://x/kybern-gpuix_0.10.0_x86_64.app.tar.gz".into(), signature: "intel".into() }
        );
    }

    #[test]
    fn manifest_without_a_usable_gpuix_entry_is_refused() {
        let key = "darwin-aarch64-gpuix";
        assert!(parse_manifest("not json", key).unwrap_err().contains("not valid"));
        assert!(
            parse_manifest(r#"{"platforms":{"darwin-aarch64":{"url":"https://x","signature":"a"}}}"#, key)
                .unwrap_err()
                .contains("does not include")
        );
        let incomplete = r#"{"platforms":{"darwin-aarch64-gpuix":{"url":"https://x/a.tar.gz"}}}"#;
        assert!(parse_manifest(incomplete, key).unwrap_err().contains("incomplete"));
        let insecure = r#"{"platforms":{"darwin-aarch64-gpuix":{"url":"http://example.com/a.tar.gz","signature":"s"}}}"#;
        assert!(parse_manifest(insecure, key).unwrap_err().contains("HTTPS"));
        // An Intel Mac never installs the Apple Silicon build.
        let arm_only = r#"{"platforms":{"darwin-aarch64-gpuix":{"url":"https://x/a.tar.gz","signature":"s"}}}"#;
        assert!(parse_manifest(arm_only, "darwin-x86_64-gpuix").unwrap_err().contains("does not include"));
    }

    #[test]
    fn signature_verifies_only_the_signed_archive_under_the_right_key() {
        let archive = fixture("good.app.tar.gz");
        let signature = fixture_text("good.app.tar.gz.sig");
        let pubkey = fixture_text("updater.key.pub");
        verify_signature(&archive, &signature, &pubkey).unwrap();

        let mut tampered = archive.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(verify_signature(&tampered, &signature, &pubkey).unwrap_err().contains("did not match"));
        assert!(verify_signature(&archive, &signature, &fixture_text("other.key.pub")).unwrap_err().contains("did not match"));
        // The signature of a different archive does not vouch for this one.
        assert!(verify_signature(&archive, &fixture_text("wrongid.app.tar.gz.sig"), &pubkey).is_err());
        assert!(verify_signature(&archive, "###", &pubkey).unwrap_err().contains("could not be read"));
        assert!(verify_signature(&archive, &signature, "###").unwrap_err().contains("update key"));
    }

    #[test]
    fn install_places_the_bundle_and_leaves_no_staging_folder() {
        let dest = scratch();
        let installed = install_archive(&Path::new(FIXTURES).join("good.app.tar.gz"), &dest).unwrap();
        assert_eq!(installed, dest.join(APP_NAME));
        assert_eq!(read_bundle_id(&installed.join("Contents/Info.plist")).unwrap(), BUNDLE_ID);
        let leftovers: Vec<_> = std::fs::read_dir(&dest).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from(APP_NAME)]);
        std::fs::remove_dir_all(dest).unwrap();
    }

    #[test]
    fn install_refuses_a_bundle_with_another_id_and_keeps_the_installed_copy() {
        let dest = scratch();
        let existing = dest.join(APP_NAME);
        std::fs::create_dir_all(existing.join("Contents")).unwrap();
        std::fs::write(existing.join("Contents/marker"), "old").unwrap();

        let error = install_archive(&Path::new(FIXTURES).join("wrongid.app.tar.gz"), &dest).unwrap_err();
        assert!(error.contains("not Kybern GPUIX"), "{error}");
        assert_eq!(std::fs::read_to_string(existing.join("Contents/marker")).unwrap(), "old");
        assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 1);
        std::fs::remove_dir_all(dest).unwrap();
    }

    #[test]
    fn install_replaces_an_existing_bundle_only_after_the_new_one_is_ready() {
        let dest = scratch();
        let existing = dest.join(APP_NAME);
        std::fs::create_dir_all(existing.join("Contents")).unwrap();
        std::fs::write(existing.join("Contents/marker"), "old").unwrap();

        // An archive that is not a gzip tarball fails before anything is moved.
        let broken = dest.join("broken.tar.gz");
        std::fs::write(&broken, "not an archive").unwrap();
        assert!(install_archive(&broken, &dest).is_err());
        assert_eq!(std::fs::read_to_string(existing.join("Contents/marker")).unwrap(), "old");

        install_archive(&Path::new(FIXTURES).join("good.app.tar.gz"), &dest).unwrap();
        assert!(!existing.join("Contents/marker").exists());
        assert_eq!(read_bundle_id(&existing.join("Contents/Info.plist")).unwrap(), BUNDLE_ID);
        std::fs::remove_dir_all(dest).unwrap();
    }

    #[test]
    fn installed_lookup_checks_each_applications_folder() {
        let (first, second) = (scratch(), scratch());
        assert_eq!(installed_in(&[first.clone(), second.clone()]), None);
        std::fs::create_dir_all(second.join(APP_NAME)).unwrap();
        assert_eq!(installed_in(&[first.clone(), second.clone()]), Some(second.join(APP_NAME)));
        std::fs::remove_dir_all(first).unwrap();
        std::fs::remove_dir_all(second).unwrap();
    }

    /// Serve fixed responses on loopback; each connection answers one request.
    fn serve(routes: Vec<(&'static str, Vec<u8>)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buffer = [0u8; 2048];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let head = String::from_utf8_lossy(&buffer[..read]).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) = routes
                    .iter()
                    .find(|(route, _)| *route == path)
                    .map(|(_, body)| ("200 OK", body.clone()))
                    .unwrap_or(("404 Not Found", Vec::new()));
                let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = stream.write_all(&body);
            }
        });
        base
    }

    /// Both arch entries name the fixture, so the install path runs on either kind of Mac.
    fn manifest(base: &str, signature: &str) -> Vec<u8> {
        let entry = format!(r#"{{"url":"{base}/gpuix.tar.gz","signature":"{signature}"}}"#);
        format!(r#"{{"version":"0.10.0","platforms":{{"darwin-aarch64-gpuix":{entry},"darwin-x86_64-gpuix":{entry}}}}}"#).into_bytes()
    }

    #[tokio::test]
    async fn run_install_downloads_verifies_and_installs_from_a_local_feed() {
        let archive = fixture("good.app.tar.gz");
        let base = serve(vec![("/gpuix.tar.gz", archive.clone())]);
        let feed = serve(vec![("/latest.json", manifest(&base, &fixture_text("good.app.tar.gz.sig")))]);
        let dest = scratch();
        let phases = std::sync::Mutex::new(Vec::new());
        let emit = |phase: Phase, _: Option<f64>| phases.lock().unwrap().push(phase);
        let installed = run_install(&[format!("{feed}/latest.json")], &fixture_text("updater.key.pub"), &dest, &emit).await.unwrap();
        assert_eq!(installed, dest.join(APP_NAME));
        let phases = phases.lock().unwrap();
        assert_eq!(phases.first(), Some(&Phase::Downloading));
        assert!(phases.contains(&Phase::Verifying) && phases.ends_with(&[Phase::Installing]));
        std::fs::remove_dir_all(dest).unwrap();
    }

    #[tokio::test]
    async fn run_install_refuses_a_bad_signature_without_touching_the_destination() {
        let base = serve(vec![("/gpuix.tar.gz", fixture("good.app.tar.gz"))]);
        // A valid signature, but for a different archive.
        let feed = serve(vec![("/latest.json", manifest(&base, &fixture_text("wrongid.app.tar.gz.sig")))]);
        let dest = scratch();
        let error = run_install(&[format!("{feed}/latest.json")], &fixture_text("updater.key.pub"), &dest, &|_, _| {}).await.unwrap_err();
        assert!(error.contains("did not match"), "{error}");
        assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 0);
        std::fs::remove_dir_all(dest).unwrap();
    }

    #[tokio::test]
    async fn run_install_reports_an_unreachable_feed() {
        let feed = serve(vec![]);
        let dest = scratch();
        let error = run_install(&[format!("{feed}/latest.json")], &fixture_text("updater.key.pub"), &dest, &|_, _| {}).await.unwrap_err();
        assert!(error.contains("404"), "{error}");
        assert!(with_manual_hint(error).contains("kybern-gpuix-mac-install.sh"));
        std::fs::remove_dir_all(dest).unwrap();
    }
}
