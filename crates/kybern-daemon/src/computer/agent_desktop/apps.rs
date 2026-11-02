//! Finding an app that is not running: Spotlight-free `.app` bundle scan on
//! macOS, `App Paths` and the system directories on Windows, `.desktop`
//! entries on Linux. Each returns the display name and the app id.

use std::path::{Path, PathBuf};

use super::super::backend::Os;

// ---- Linux: desktop entries ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DesktopEntry {
    /// File name without `.desktop`.
    pub id: String,
    pub name: String,
    /// Basename of the first word of `Exec=`.
    pub executable: Option<String>,
}

/// Parse the `[Desktop Entry]` group; entries that are hidden, not
/// applications or terminal-only are skipped (they cannot be launched).
pub(crate) fn parse_desktop_entry(id: &str, content: &str) -> Option<DesktopEntry> {
    let mut in_entry = false;
    let (mut name, mut exec, mut kind) = (None, None, None);
    let (mut hidden, mut terminal) = (false, false);
    for line in content.lines().map(str::trim) {
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        match key.trim() {
            "Name" => name = Some(value.trim().to_owned()),
            "Exec" => exec = Some(value.trim().to_owned()),
            "Type" => kind = Some(value.trim().to_owned()),
            "Hidden" | "NoDisplay" => hidden |= value.trim().eq_ignore_ascii_case("true"),
            "Terminal" => terminal = value.trim().eq_ignore_ascii_case("true"),
            _ => {}
        }
    }
    if hidden || terminal || kind.as_deref().is_some_and(|kind| kind != "Application") {
        return None;
    }
    let executable = exec
        .as_deref()
        .and_then(|exec| exec.split_whitespace().next())
        .map(|word| word.trim_matches('"'))
        .and_then(|word| word.rsplit('/').next())
        .map(str::to_owned);
    Some(DesktopEntry { id: id.to_owned(), name: name.filter(|name| !name.is_empty())?, executable })
}

/// The applications directories, XDG order: user first.
pub(crate) fn applications_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    dirs.extend(home);
    let data_dirs =
        std::env::var("XDG_DATA_DIRS").ok().filter(|value| !value.is_empty()).unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    dirs.extend(data_dirs.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from));
    dirs.into_iter().map(|dir| dir.join("applications")).collect()
}

/// All launchable entries under `dirs`; earlier directories win for a repeated id.
pub(crate) fn desktop_entries(dirs: &[PathBuf]) -> Vec<DesktopEntry> {
    let mut entries: Vec<DesktopEntry> = Vec::new();
    for dir in dirs {
        let Ok(read) = std::fs::read_dir(dir) else { continue };
        let mut files: Vec<_> = read
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "desktop"))
            .collect();
        files.sort();
        for path in files {
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else { continue };
            if entries.iter().any(|entry| entry.id == id) {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            if let Some(entry) = parse_desktop_entry(id, &content) {
                entries.push(entry);
            }
        }
    }
    entries
}

/// Match a request against entries: exact `Name`, then id, then executable
/// name, then a unique `Name` prefix. Case-insensitive.
pub(crate) fn match_entry<'a>(entries: &'a [DesktopEntry], requested: &str) -> Option<&'a DesktopEntry> {
    let wanted = requested.trim().to_lowercase();
    let wanted = wanted.strip_suffix(".desktop").unwrap_or(&wanted);
    if wanted.is_empty() {
        return None;
    }
    entries
        .iter()
        .find(|entry| entry.name.to_lowercase() == wanted)
        .or_else(|| entries.iter().find(|entry| entry.id.to_lowercase() == wanted))
        .or_else(|| entries.iter().find(|entry| entry.executable.as_deref().is_some_and(|exec| exec.to_lowercase() == wanted)))
        .or_else(|| {
            let mut prefixed = entries.iter().filter(|entry| entry.name.to_lowercase().starts_with(wanted));
            let first = prefixed.next()?;
            prefixed.next().is_none().then_some(first)
        })
}

// ---- Windows ----

/// A program `launch` can start: a bare image name, or an absolute path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsExe {
    /// Lowercase image name, e.g. `notepad.exe`.
    pub image: String,
    pub path: Option<PathBuf>,
}

impl WindowsExe {
    /// What to give `launch`: the absolute path when known.
    pub(crate) fn launch_arg(&self) -> String {
        self.path.as_ref().map(|path| path.display().to_string()).unwrap_or_else(|| self.image.clone())
    }
}

/// The image names to try for a request: `Notepad`, `notepad.exe`,
/// `Visual Studio Code` → `visualstudiocode.exe`, `code.exe`.
pub(crate) fn windows_image_names(requested: &str) -> Vec<String> {
    let requested = requested.trim().trim_matches('"');
    let file = requested.rsplit(['\\', '/']).next().unwrap_or(requested).to_lowercase();
    if file.is_empty() {
        return Vec::new();
    }
    let base = file.strip_suffix(".exe").unwrap_or(&file).to_owned();
    let mut names = vec![format!("{base}.exe")];
    let squashed: String = base.chars().filter(|character| !character.is_whitespace()).collect();
    if squashed != base {
        names.push(format!("{squashed}.exe"));
    }
    names
}

/// Resolve a request without the registry: an absolute path that exists, or
/// an image under `System32` or the Windows directory (where `launch`
/// itself looks for bare names).
pub(crate) fn resolve_windows_files(requested: &str, system_root: &Path) -> Option<WindowsExe> {
    let trimmed = requested.trim().trim_matches('"');
    let as_path = Path::new(trimmed);
    if as_path.is_absolute() && as_path.is_file() {
        let image = as_path.file_name()?.to_string_lossy().to_lowercase();
        return Some(WindowsExe { image, path: Some(as_path.to_path_buf()) });
    }
    for image in windows_image_names(trimmed) {
        for dir in [system_root.join("System32"), system_root.to_path_buf()] {
            if dir.join(&image).is_file() {
                return Some(WindowsExe { image, path: None });
            }
        }
    }
    None
}

pub(crate) fn resolve_windows(requested: &str) -> Option<WindowsExe> {
    let system_root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    if let Some(found) = resolve_windows_files(requested, &system_root) {
        return Some(found);
    }
    windows_names_through_registry(requested)
}

#[cfg(windows)]
fn windows_names_through_registry(requested: &str) -> Option<WindowsExe> {
    for image in windows_image_names(requested) {
        if let Some(path) = registry::app_path(&image) {
            return Some(WindowsExe { image, path: Some(path) });
        }
    }
    None
}

#[cfg(not(windows))]
fn windows_names_through_registry(_requested: &str) -> Option<WindowsExe> {
    None
}

/// Expand `%NAME%` references with the process environment.
#[cfg(any(windows, test))]
pub(crate) fn expand_percent(value: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => match std::env::var(&after[..end]) {
                Ok(expanded) => {
                    out.push_str(&expanded);
                    rest = &after[end + 1..];
                }
                Err(_) => {
                    out.push('%');
                    rest = after;
                }
            },
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(windows)]
mod registry {
    use std::path::PathBuf;

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_EXPAND_SZ, REG_SZ, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
    };

    const APP_PATHS: &str = r"Software\Microsoft\Windows\CurrentVersion\App Paths";

    /// The default value of `App Paths\<image>` in HKLM, then HKCU.
    pub(super) fn app_path(image: &str) -> Option<PathBuf> {
        let subkey: Vec<u16> = format!(r"{APP_PATHS}\{image}").encode_utf16().chain(std::iter::once(0)).collect();
        [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER]
            .into_iter()
            .find_map(|root| default_value(root, &subkey))
            .map(|value| {
                let expanded = super::expand_percent(value.trim().trim_matches('"'));
                PathBuf::from(expanded)
            })
            .filter(|path| path.is_absolute() && path.is_file())
    }

    fn default_value(root: HKEY, subkey: &[u16]) -> Option<String> {
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: `subkey` is NUL-terminated and `key` receives the opened handle.
        if unsafe { RegOpenKeyExW(root, subkey.as_ptr(), 0, KEY_READ, &mut key) } != ERROR_SUCCESS {
            return None;
        }
        let mut kind = 0u32;
        let mut size = 0u32;
        // SAFETY: a null data pointer asks only for the size.
        let sized = unsafe { RegQueryValueExW(key, std::ptr::null(), std::ptr::null(), &mut kind, std::ptr::null_mut(), &mut size) };
        let value = if sized == ERROR_SUCCESS && (kind == REG_SZ || kind == REG_EXPAND_SZ) && (2..32_768).contains(&size) {
            let mut buffer = vec![0u16; (size as usize).div_ceil(2) + 1];
            let mut bytes = size;
            // SAFETY: `buffer` holds at least `size` bytes.
            let read =
                unsafe { RegQueryValueExW(key, std::ptr::null(), std::ptr::null(), &mut kind, buffer.as_mut_ptr().cast(), &mut bytes) };
            (read == ERROR_SUCCESS).then(|| {
                let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
                String::from_utf16_lossy(&buffer[..end])
            })
        } else {
            None
        };
        // SAFETY: `key` was opened above.
        unsafe { RegCloseKey(key) };
        value.filter(|value| !value.trim().is_empty())
    }
}

// ---- macOS ----

/// `<requested>.app` in the usual folders, compared case-insensitively.
pub(crate) fn find_mac_bundle(requested: &str, folders: &[PathBuf]) -> Option<PathBuf> {
    let wanted = requested.trim().trim_end_matches(".app").to_lowercase();
    if wanted.is_empty() || wanted.contains('/') {
        return None;
    }
    folders.iter().find_map(|folder| {
        std::fs::read_dir(folder).ok()?.filter_map(Result::ok).map(|entry| entry.path()).find(|path| {
            path.extension().is_some_and(|extension| extension == "app")
                && path.file_stem().is_some_and(|stem| stem.to_string_lossy().to_lowercase() == wanted)
        })
    })
}

pub(crate) fn mac_folders() -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities"]
        .into_iter()
        .map(PathBuf::from)
        .collect();
    if let Some(home) = std::env::var_os("HOME") {
        folders.push(PathBuf::from(home).join("Applications"));
    }
    folders
}

async fn mac_bundle_id(bundle: &Path) -> Option<String> {
    let output = tokio::process::Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(bundle.join("Contents/Info.plist"))
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    let id = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (output.status.success() && !id.is_empty()).then_some(id)
}

/// Find an app that is not in the running list. Returns its display name and
/// app id.
pub(crate) async fn find_app(os: Os, requested: &str) -> Option<(String, String)> {
    match os {
        Os::Mac => {
            let bundle = find_mac_bundle(requested, &mac_folders())?;
            let name = bundle.file_stem()?.to_string_lossy().into_owned();
            let id = mac_bundle_id(&bundle).await?;
            Some((name, id))
        }
        Os::Windows => {
            let exe = resolve_windows(requested)?;
            let name = exe.image.trim_end_matches(".exe").to_owned();
            Some((name, exe.image))
        }
        Os::Linux | Os::Other => {
            let entries = desktop_entries(&applications_dirs());
            let entry = match_entry(&entries, requested)?;
            Some((entry.name.clone(), entry.id.clone()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALCULATOR: &str = "[Desktop Entry]\nName=Calculator\nName[de]=Rechner\nExec=gnome-calculator\nType=Application\nTerminal=false\n\n[Desktop Action new]\nName=New window\nExec=other\n";

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kybern-ad-apps-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn desktop_entries_parse_the_main_group_only() {
        let entry = parse_desktop_entry("org.gnome.Calculator", CALCULATOR).unwrap();
        assert_eq!(
            entry,
            DesktopEntry { id: "org.gnome.Calculator".into(), name: "Calculator".into(), executable: Some("gnome-calculator".into()) }
        );
        assert!(parse_desktop_entry("x", "[Desktop Entry]\nName=Hidden\nNoDisplay=true\nExec=x\n").is_none());
        assert!(parse_desktop_entry("x", "[Desktop Entry]\nName=Shell\nExec=bash\nTerminal=true\n").is_none());
        assert!(parse_desktop_entry("x", "[Desktop Entry]\nName=Link\nType=Link\nURL=https://x\n").is_none());
        let quoted = parse_desktop_entry("x", "[Desktop Entry]\nName=Q\nExec=\"/usr/lib/foo/bar\" --flag %U\n").unwrap();
        assert_eq!(quoted.executable.as_deref(), Some("bar"));
    }

    #[test]
    fn requests_match_by_name_then_id_then_executable() {
        let dir = scratch();
        std::fs::write(dir.join("org.gnome.Calculator.desktop"), CALCULATOR).unwrap();
        std::fs::write(dir.join("org.gnome.TextEditor.desktop"), "[Desktop Entry]\nName=Text Editor\nExec=gnome-text-editor %U\n").unwrap();
        std::fs::write(dir.join("org.gnome.Terminal.desktop"), "[Desktop Entry]\nName=Terminal\nExec=gnome-terminal\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap();
        let entries = desktop_entries(&[dir.clone(), dir.join("missing")]);
        assert_eq!(entries.len(), 3);
        assert_eq!(match_entry(&entries, "calculator").unwrap().id, "org.gnome.Calculator");
        assert_eq!(match_entry(&entries, "org.gnome.Calculator.desktop").unwrap().id, "org.gnome.Calculator");
        assert_eq!(match_entry(&entries, "gnome-text-editor").unwrap().id, "org.gnome.TextEditor");
        assert_eq!(match_entry(&entries, "Text").unwrap().id, "org.gnome.TextEditor");
        // "Te" prefixes two names: ambiguous, so no guess.
        assert!(match_entry(&entries, "Te").is_none());
        assert!(match_entry(&entries, "").is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_earlier_directory_wins_for_a_repeated_id() {
        let (user, system) = (scratch(), scratch());
        std::fs::write(user.join("a.desktop"), "[Desktop Entry]\nName=Mine\nExec=a\n").unwrap();
        std::fs::write(system.join("a.desktop"), "[Desktop Entry]\nName=Theirs\nExec=a\n").unwrap();
        let entries = desktop_entries(&[user.clone(), system.clone()]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "Mine");
        std::fs::remove_dir_all(&user).unwrap();
        std::fs::remove_dir_all(&system).unwrap();
    }

    #[test]
    fn windows_names_resolve_through_the_system_directories() {
        assert_eq!(windows_image_names("Notepad"), ["notepad.exe"]);
        assert_eq!(windows_image_names("Code.EXE"), ["code.exe"]);
        assert_eq!(windows_image_names(r#""C:\Program Files\App\App.exe""#), ["app.exe"]);
        assert_eq!(windows_image_names("Paint 3D"), ["paint 3d.exe", "paint3d.exe"]);
        assert!(windows_image_names("").is_empty());

        let root = scratch();
        std::fs::create_dir_all(root.join("System32")).unwrap();
        std::fs::write(root.join("System32").join("calc.exe"), "").unwrap();
        std::fs::write(root.join("notepad.exe"), "").unwrap();
        let calc = resolve_windows_files("Calc", &root).unwrap();
        assert_eq!((calc.image.as_str(), calc.path.is_none(), calc.launch_arg()), ("calc.exe", true, "calc.exe".to_owned()));
        assert_eq!(resolve_windows_files("notepad.exe", &root).unwrap().image, "notepad.exe");
        assert!(resolve_windows_files("nonexistent", &root).is_none());
        // An absolute path that exists is launched by path.
        let tool = root.join("tool.exe");
        std::fs::write(&tool, "").unwrap();
        let found = resolve_windows_files(&tool.display().to_string(), &root).unwrap();
        assert_eq!(found.image, "tool.exe");
        assert_eq!(found.launch_arg(), tool.display().to_string());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn percent_variables_expand_and_unknown_ones_stay() {
        // SAFETY of the test environment: PATH always exists; the other name does not.
        let path = std::env::var("PATH").unwrap();
        assert_eq!(expand_percent("%PATH%\\x"), format!("{path}\\x"));
        assert_eq!(expand_percent("%KYBERN_NO_SUCH_VAR_7%\\x"), "%KYBERN_NO_SUCH_VAR_7%\\x");
        assert_eq!(expand_percent("100%"), "100%");
        assert_eq!(expand_percent("a%%b"), "a%%b");
    }

    #[test]
    fn mac_bundles_match_case_insensitively() {
        let folder = scratch();
        std::fs::create_dir_all(folder.join("Calculator.app")).unwrap();
        std::fs::create_dir_all(folder.join("Notes.app")).unwrap();
        std::fs::write(folder.join("Calculator.txt"), "").unwrap();
        let folders = vec![folder.join("missing"), folder.clone()];
        assert_eq!(find_mac_bundle("calculator", &folders).unwrap(), folder.join("Calculator.app"));
        assert_eq!(find_mac_bundle("Notes.app", &folders).unwrap(), folder.join("Notes.app"));
        assert!(find_mac_bundle("../etc", &folders).is_none());
        assert!(find_mac_bundle("Safari", &folders).is_none());
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
