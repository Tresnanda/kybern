//! The `kybern` command ships inside the app beside `kybernd`. Installing it
//! puts that copy on the user's PATH the way each platform expects, so every
//! app update carries the command along:
//!
//! - macOS and portable Linux builds: a symlink into the app, placed in
//!   `~/.local/bin` when that is already on PATH, otherwise `/usr/local/bin`
//!   (macOS asks for an administrator password there).
//! - AppImage: a copy in `~/.local/bin`, because the image mounts at a new
//!   path on every launch. Startup refreshes the copy after an update.
//! - deb/rpm: the package already installs it in `/usr/bin`.
//! - Windows: the install folder is added to the user's Path.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

const NAME: &str = if cfg!(windows) { "kybern.exe" } else { "kybern" };
const MARKER: &str = "cli-copy-installed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CliMethod {
    Link,
    Copy,
    Path,
    Package,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
pub struct CliStatus {
    method: CliMethod,
    /// The command inside this app.
    bundled: Option<String>,
    /// Where Kybern puts it: the link or copy, or the folder added to Path.
    target: Option<String>,
    installed: bool,
    /// Installing writes outside the home folder and asks for a password.
    needs_admin: bool,
    /// `target` is in a folder the user's shell searches.
    target_on_path: bool,
    /// What a new terminal runs for `kybern`.
    resolved: Option<String>,
    resolved_version: Option<String>,
    /// A different `kybern` comes before Kybern's on PATH.
    shadowed: bool,
    /// Why installing is not possible from this copy of the app.
    problem: Option<String>,
    /// For showing paths under it as `~/…`.
    home: Option<String>,
}

fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(NAME)).filter(|path| path.is_file())
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Compare folders the way the platform does: case-insensitively on Windows,
/// ignoring a trailing separator.
fn same_dir(a: &Path, b: &Path) -> bool {
    let normalize = |path: &Path| {
        let text = path.to_string_lossy();
        let text = text.trim_end_matches(['/', '\\']);
        if cfg!(windows) { text.to_lowercase() } else { text.to_string() }
    };
    normalize(a) == normalize(b)
}

/// The folders a new terminal searches, in order.
fn search_path() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let machine = powershell("[Environment]::GetEnvironmentVariable('Path', 'Machine')", &[]).unwrap_or_default();
        let user = powershell("[Environment]::GetEnvironmentVariable('Path', 'User')", &[]).unwrap_or_default();
        format!("{machine};{user}").split(';').map(str::trim).filter(|dir| !dir.is_empty()).map(PathBuf::from).collect()
    }
    #[cfg(not(windows))]
    {
        let path = crate::login_shell_path().or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
        path.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from).collect()
    }
}

fn resolve(dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().map(|dir| dir.join(NAME)).find(|path| path.is_file())
}

/// `kybern --version` prints `kybern X.Y.Z`. Anything else is not our CLI.
fn cli_version(path: &Path) -> Option<String> {
    let mut command = std::process::Command::new(path);
    command.arg("--version").stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    hide_console(&mut command);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(command.output());
    });
    let output = rx.recv_timeout(Duration::from_secs(3)).ok()?.ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.trim().strip_prefix("kybern ").map(|version| version.trim().to_string())
}

fn hide_console(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".kybern-write-test-{}", std::process::id()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn is_appimage() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some()
}

/// A path inside a read-only or temporary copy of the app, which a link
/// would outlive.
fn unstable_location(bundled: &Path) -> Option<String> {
    let text = bundled.to_string_lossy();
    if cfg!(target_os = "macos") && (text.contains("/AppTranslocation/") || text.starts_with("/Volumes/")) {
        return Some("Move Kybern to your Applications folder and open it from there, then install the command.".into());
    }
    None
}

fn link_target(dirs: &[PathBuf], bundled: &Path) -> Option<PathBuf> {
    let home_bin = home()?.join(".local/bin");
    let system_bin = PathBuf::from("/usr/local/bin");
    let candidates = [home_bin.join(NAME), system_bin.join(NAME)];
    if let Some(existing) = candidates.iter().find(|candidate| same_file(candidate, bundled)) {
        return Some(existing.clone());
    }
    if dirs.iter().any(|dir| same_dir(dir, &home_bin)) || !cfg!(target_os = "macos") {
        Some(home_bin.join(NAME))
    } else {
        Some(system_bin.join(NAME))
    }
}

fn needs_admin(target: &Path) -> bool {
    let Some(dir) = target.parent() else { return false };
    if dir.is_dir() {
        return !writable(dir);
    }
    // ~/.local/bin is created on demand; /usr/local/bin needs a password.
    !home().is_some_and(|home| dir.starts_with(home))
}

fn marker<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(MARKER))
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> CliStatus {
    let dirs = search_path();
    let resolved = resolve(&dirs);
    let resolved_version = resolved.as_deref().and_then(cli_version);
    let mut status = CliStatus {
        method: CliMethod::Unavailable,
        bundled: None,
        target: None,
        installed: false,
        needs_admin: false,
        target_on_path: false,
        resolved: resolved.as_ref().map(|path| path.display().to_string()),
        resolved_version,
        shadowed: false,
        problem: None,
        home: home().map(|home| home.display().to_string()),
    };
    let Some(bundled) = bundled() else {
        status.problem = Some("This build of Kybern doesn’t include the kybern command.".into());
        return status;
    };
    status.bundled = Some(bundled.display().to_string());
    let bundled_dir = bundled.parent().map(Path::to_path_buf).unwrap_or_default();
    let target = if cfg!(windows) {
        status.method = CliMethod::Path;
        status.installed = user_path_contains(&bundled_dir);
        bundled.clone()
    } else if is_appimage() {
        status.method = CliMethod::Copy;
        let target = home().unwrap_or_default().join(".local/bin").join(NAME);
        status.installed = marker(app).is_some_and(|marker| marker.is_file()) && target.is_file();
        target
    } else if cfg!(target_os = "linux") && dirs.iter().any(|dir| same_dir(dir, &bundled_dir)) {
        status.method = CliMethod::Package;
        status.installed = true;
        bundled.clone()
    } else {
        status.method = CliMethod::Link;
        status.problem = unstable_location(&bundled);
        let Some(target) = link_target(&dirs, &bundled) else {
            status.problem = Some("Kybern couldn’t find your home folder.".into());
            return status;
        };
        status.installed = same_file(&target, &bundled);
        status.needs_admin = !status.installed && needs_admin(&target);
        target
    };
    let target_dir = target.parent().map(Path::to_path_buf).unwrap_or_default();
    status.target_on_path = dirs.iter().any(|dir| same_dir(dir, &target_dir));
    status.shadowed =
        status.installed && resolved.as_ref().is_some_and(|resolved| !same_file(resolved, &target) && !same_file(resolved, &bundled));
    status.target = Some(if cfg!(windows) { target_dir } else { target }.display().to_string());
    status
}

pub fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let bundled = bundled().ok_or("This build of Kybern doesn’t include the kybern command.")?;
    if cfg!(windows) {
        let dir = bundled.parent().ok_or("Kybern’s install folder is missing.")?;
        return edit_user_path(dir, true);
    }
    if is_appimage() {
        let target = home().ok_or("Kybern couldn’t find your home folder.")?.join(".local/bin").join(NAME);
        check_replaceable(&target, &bundled)?;
        copy_cli(&bundled, &target)?;
        if let Some(marker) = marker(app) {
            let _ = std::fs::create_dir_all(marker.parent().unwrap_or(Path::new(".")));
            std::fs::write(marker, target.display().to_string()).map_err(|e| format!("Unable to record the install: {e}"))?;
        }
        return Ok(());
    }
    if let Some(problem) = unstable_location(&bundled) {
        return Err(problem);
    }
    let target = link_target(&search_path(), &bundled).ok_or("Kybern couldn’t find your home folder.")?;
    if same_file(&target, &bundled) {
        return Ok(());
    }
    check_replaceable(&target, &bundled)?;
    if needs_admin(&target) {
        return admin_link(&bundled, &target);
    }
    link(&bundled, &target)
}

pub fn uninstall<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let bundled = bundled().ok_or("This build of Kybern doesn’t include the kybern command.")?;
    if cfg!(windows) {
        let dir = bundled.parent().ok_or("Kybern’s install folder is missing.")?;
        return edit_user_path(dir, false);
    }
    if is_appimage() {
        let target = home().ok_or("Kybern couldn’t find your home folder.")?.join(".local/bin").join(NAME);
        if cli_version(&target).is_some() {
            std::fs::remove_file(&target).map_err(|e| format!("Unable to remove {}: {e}", target.display()))?;
        }
        if let Some(marker) = marker(app) {
            let _ = std::fs::remove_file(marker);
        }
        return Ok(());
    }
    let target = link_target(&search_path(), &bundled).ok_or("Kybern couldn’t find your home folder.")?;
    if !same_file(&target, &bundled) {
        return Ok(());
    }
    if target.parent().is_some_and(|dir| !writable(dir)) {
        return admin_run(
            &format!("/bin/rm -f {}", shell_quote(&target)),
            &format!("Kybern wants to remove the kybern command from {}.", parent(&target)),
        );
    }
    std::fs::remove_file(&target).map_err(|e| format!("Unable to remove {}: {e}", target.display()))
}

/// Remove an older `kybern` that comes first on PATH, such as one installed
/// with cargo or the standalone installer. Only ever a Kybern CLI.
pub fn remove_other<R: Runtime>(app: &AppHandle<R>, path: String) -> Result<(), String> {
    let current = status(app);
    let path = PathBuf::from(path);
    if !current.shadowed || current.resolved.as_deref().map(Path::new) != Some(path.as_path()) {
        return Err("That command is no longer first on your PATH. Reopen Settings to check again.".into());
    }
    if cli_version(&path).is_none() {
        return Err(format!("{} isn’t a Kybern command, so Kybern left it in place.", path.display()));
    }
    std::fs::remove_file(&path).map_err(|e| format!("Unable to remove {}: {e}. Remove it from a terminal instead.", path.display()))
}

/// After an AppImage update, bring the installed copy up to date.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    if !is_appimage() || !marker(app).is_some_and(|marker| marker.is_file()) {
        return;
    }
    let (Some(bundled), Some(home)) = (bundled(), home()) else { return };
    let target = home.join(".local/bin").join(NAME);
    if cli_version(&target).is_some() && cli_version(&target) != cli_version(&bundled) {
        let _ = copy_cli(&bundled, &target);
    }
}

fn parent(path: &Path) -> String {
    path.parent().map(|dir| dir.display().to_string()).unwrap_or_default()
}

/// Refuse to overwrite a file that is not a Kybern CLI or a link to one.
fn check_replaceable(target: &Path, bundled: &Path) -> Result<(), String> {
    let Ok(metadata) = std::fs::symlink_metadata(target) else { return Ok(()) };
    if same_file(target, bundled) || cli_version(target).is_some() {
        return Ok(());
    }
    // A link left behind by a moved or deleted copy of the app.
    if metadata.file_type().is_symlink() && !target.exists() {
        let destination = std::fs::read_link(target).unwrap_or_default();
        if destination.file_name().is_some_and(|name| name == NAME) {
            return Ok(());
        }
    }
    Err(format!("{} already exists and isn’t Kybern’s command. Rename or remove it, then try again.", target.display()))
}

#[cfg(unix)]
fn link(bundled: &Path, target: &Path) -> Result<(), String> {
    let dir = target.parent().ok_or("Invalid install location.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Unable to create {}: {e}", dir.display()))?;
    // Link beside the target, then rename over it, so no moment exists
    // where `kybern` is missing or half-written.
    let staging = dir.join(format!(".kybern-{}", std::process::id()));
    let _ = std::fs::remove_file(&staging);
    std::os::unix::fs::symlink(bundled, &staging).map_err(|e| format!("Unable to link {}: {e}", target.display()))?;
    std::fs::rename(&staging, target).map_err(|e| {
        let _ = std::fs::remove_file(&staging);
        format!("Unable to install {}: {e}", target.display())
    })
}

#[cfg(not(unix))]
fn link(_bundled: &Path, _target: &Path) -> Result<(), String> {
    Err("Links aren’t used on this platform.".into())
}

fn copy_cli(bundled: &Path, target: &Path) -> Result<(), String> {
    let dir = target.parent().ok_or("Invalid install location.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Unable to create {}: {e}", dir.display()))?;
    let staging = dir.join(format!(".kybern-{}", std::process::id()));
    std::fs::copy(bundled, &staging).map_err(|e| format!("Unable to copy the kybern command: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755));
    }
    std::fs::rename(&staging, target).map_err(|e| {
        let _ = std::fs::remove_file(&staging);
        format!("Unable to install {}: {e}", target.display())
    })
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

fn admin_link(bundled: &Path, target: &Path) -> Result<(), String> {
    let script = format!(
        "/bin/mkdir -p {} && /bin/ln -sfn {} {}",
        shell_quote(Path::new(&parent(target))),
        shell_quote(bundled),
        shell_quote(target)
    );
    admin_run(&script, &format!("Kybern wants to add the kybern command to {}.", parent(target)))
}

/// Run a shell command as an administrator through the standard macOS
/// password prompt.
#[cfg(target_os = "macos")]
fn admin_run(script: &str, prompt: &str) -> Result<(), String> {
    let quote = |text: &str| format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""));
    let apple_script = format!("do shell script {} with prompt {} with administrator privileges", quote(script), quote(prompt));
    let output = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &apple_script])
        .output()
        .map_err(|e| format!("Unable to ask for an administrator password: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let error = String::from_utf8_lossy(&output.stderr);
    if error.contains("-128") {
        return Err("canceled".into());
    }
    Err(format!("Unable to install the command: {}", error.trim()))
}

#[cfg(not(target_os = "macos"))]
fn admin_run(_script: &str, _prompt: &str) -> Result<(), String> {
    Err("Kybern can’t write there without administrator access. Add ~/.local/bin to your PATH, then try again.".into())
}

#[cfg(windows)]
fn powershell(script: &str, env: &[(&str, &str)]) -> Option<String> {
    let mut command = std::process::Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]).envs(env.iter().copied());
    hide_console(&mut command);
    let output = command.output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(windows)]
fn user_path_contains(dir: &Path) -> bool {
    let path = powershell(USER_PATH_READ, &[]).unwrap_or_default();
    path.split(';').any(|entry| same_dir(Path::new(entry.trim()), dir))
}

#[cfg(not(windows))]
fn user_path_contains(_dir: &Path) -> bool {
    false
}

/// The user's Path exactly as stored, with `%VARIABLES%` unexpanded.
#[cfg(windows)]
const USER_PATH_READ: &str = "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); \
    if ($key) { $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }";

/// Add or remove one folder in the user's Path, keeping every other entry
/// as stored, then tell Explorer so new terminals see the change.
#[cfg(windows)]
const USER_PATH_EDIT: &str = "$dir = $env:KYBERN_CLI_DIR.TrimEnd('\\'); \
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); \
    $path = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); \
    $parts = @($path -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ne $dir) }); \
    if ($env:KYBERN_CLI_ADD -eq '1') { $parts += $dir }; \
    $key.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString); \
    $key.Close(); \
    [Environment]::SetEnvironmentVariable('KYBERN_PATH_CHANGED', '1', 'User'); \
    [Environment]::SetEnvironmentVariable('KYBERN_PATH_CHANGED', $null, 'User'); \
    'ok'";

#[cfg(windows)]
fn edit_user_path(dir: &Path, add: bool) -> Result<(), String> {
    let dir = dir.display().to_string();
    match powershell(USER_PATH_EDIT, &[("KYBERN_CLI_DIR", dir.as_str()), ("KYBERN_CLI_ADD", if add { "1" } else { "0" })]) {
        Some(result) if result.ends_with("ok") => Ok(()),
        _ => Err("Unable to update your Path. Add Kybern’s install folder to Path in System Settings instead.".into()),
    }
}

#[cfg(not(windows))]
fn edit_user_path(_dir: &Path, _add: bool) -> Result<(), String> {
    Err("Path editing is only used on Windows.".into())
}

#[tauri::command]
pub async fn cli_status<R: Runtime>(app: AppHandle<R>) -> CliStatus {
    tauri::async_runtime::spawn_blocking(move || status(&app)).await.unwrap_or_else(|_| CliStatus {
        method: CliMethod::Unavailable,
        bundled: None,
        target: None,
        installed: false,
        needs_admin: false,
        target_on_path: false,
        resolved: None,
        resolved_version: None,
        shadowed: false,
        problem: Some("Unable to check the kybern command. Try again.".into()),
        home: None,
    })
}

#[tauri::command]
pub async fn cli_install<R: Runtime>(app: AppHandle<R>) -> Result<CliStatus, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app).map(|()| status(&app))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cli_uninstall<R: Runtime>(app: AppHandle<R>) -> Result<CliStatus, String> {
    tauri::async_runtime::spawn_blocking(move || uninstall(&app).map(|()| status(&app))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cli_remove_other<R: Runtime>(app: AppHandle<R>, path: String) -> Result<CliStatus, String> {
    tauri::async_runtime::spawn_blocking(move || remove_other(&app, path).map(|()| status(&app))).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_folders_without_trailing_separators() {
        assert!(same_dir(Path::new("/usr/local/bin/"), Path::new("/usr/local/bin")));
        assert!(!same_dir(Path::new("/usr/local/bin"), Path::new("/usr/bin")));
    }

    #[test]
    fn quotes_paths_for_the_shell() {
        assert_eq!(shell_quote(Path::new("/Applications/it's.app")), r"'/Applications/it'\''s.app'");
    }

    #[cfg(unix)]
    #[test]
    fn replaces_only_kybern_commands_and_dangling_links() {
        let root = tempfile_dir();
        let bundled = root.join("bundle").join(NAME);
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, "").unwrap();
        let missing = root.join("missing");
        assert!(check_replaceable(&missing, &bundled).is_ok());
        let other = root.join("other");
        std::fs::write(&other, "#!/bin/sh\necho something\n").unwrap();
        assert!(check_replaceable(&other, &bundled).is_err());
        let dangling = root.join("dangling");
        std::os::unix::fs::symlink(root.join("gone.app").join(NAME), &dangling).unwrap();
        assert!(check_replaceable(&dangling, &bundled).is_ok());
        let linked = root.join("linked");
        link(&bundled, &linked).unwrap();
        assert!(same_file(&linked, &bundled));
        assert!(check_replaceable(&linked, &bundled).is_ok());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    fn tempfile_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kybern-cli-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
