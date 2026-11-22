//! Where a harness's newest published version is announced, chosen by how the binary on PATH was installed.
//!
//! Pure parts only: classifying an installation from its resolved path, the feed URLs for it, parsing a feed's
//! answer, and comparing versions. The daemon fetches (`harness_updates`), behind its own seam, so tests never
//! reach the network. Nothing here sends anything about the user: each feed is a plain GET of a public document.
use kybern_protocol::{HarnessInstall, ProviderKind};
use std::path::{Path, PathBuf};

/// How the binary was installed and, when it has one, the feed that names its newest version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Install {
    pub method: HarnessInstall,
    pub source: Option<Source>,
}

impl Install {
    fn new(method: HarnessInstall, source: Option<Source>) -> Self {
        Self { method, source }
    }
}

/// A feed that names the newest version of one installation.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Source {
    /// `downloads.claude.ai`, on the user's `autoUpdatesChannel` (`latest` or `stable`).
    ClaudeNative { channel: String },
    /// Codex's release channel, with GitHub's latest release as a fallback.
    CodexStandalone,
    /// Antigravity's updater manifest for one platform (`linux_amd64`, `darwin_arm64`, `windows_amd64`).
    Antigravity { platform: String },
    /// Grok Build's channel file (`stable`, `alpha` or `enterprise`).
    Grok { channel: String },
    /// pi's managed installer.
    PiManaged,
    /// Oh My Pi's script installer for one target (`linux-x86_64`, `macos-arm64`, `windows-x86_64`).
    OmpScript { target: String },
    /// OpenCode 1.x from its script installer: npm's `opencode-ai`, 1.x only.
    OpencodeV1,
    /// OpenCode 2 from its script installer.
    OpencodeV2,
    /// A global npm package.
    Npm { package: String },
    /// A Homebrew formula or cask.
    Homebrew { package: String, cask: bool },
    /// Cursor publishes no feed; its install script names the version it installs.
    CursorInstallPage { windows: bool },
}

impl Source {
    /// The URLs to ask, in order: the first that answers with a version wins.
    pub fn urls(&self) -> Vec<String> {
        match self {
            Source::ClaudeNative { channel } => vec![format!("https://downloads.claude.ai/claude-code-releases/{channel}")],
            Source::CodexStandalone => vec![
                "https://releases.openai.com/codex/channels/latest".into(),
                "https://api.github.com/repos/openai/codex/releases/latest".into(),
            ],
            Source::Antigravity { platform } => {
                vec![format!("https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{platform}.json")]
            }
            Source::Grok { channel } => vec![
                format!("https://x.ai/cli/{channel}"),
                format!("https://storage.googleapis.com/grok-build-public-artifacts/cli/{channel}"),
            ],
            Source::PiManaged => vec!["https://pi.dev/api/installer/releases/latest".into()],
            Source::OmpScript { target } => vec![format!("https://build.stencil.so/api/products/omp/latest/{target}?channel=stable")],
            Source::OpencodeV1 => vec!["https://registry.npmjs.org/opencode-ai/latest".into()],
            Source::OpencodeV2 => vec!["https://opencode.ai/update/api/latest/cli/npm".into()],
            Source::Npm { package } => vec![format!("https://registry.npmjs.org/{package}/latest")],
            Source::Homebrew { package, cask: false } => vec![format!("https://formulae.brew.sh/api/formula/{package}.json")],
            Source::Homebrew { package, cask: true } => vec![format!("https://formulae.brew.sh/api/cask/{package}.json")],
            Source::CursorInstallPage { windows: false } => vec!["https://cursor.com/install".into()],
            Source::CursorInstallPage { windows: true } => vec!["https://cursor.com/install?win32=true".into()],
        }
    }

    /// The version a feed's answer names, or `None` when the body is not what this feed sends.
    pub fn parse(&self, body: &str) -> Option<String> {
        let json = || serde_json::from_str::<serde_json::Value>(body).ok();
        let field = |value: &serde_json::Value, path: &[&str]| -> Option<String> {
            path.iter().try_fold(value, |value, key| value.get(key)).and_then(|value| value.as_str()).map(str::to_string)
        };
        let version = match self {
            Source::ClaudeNative { .. } | Source::Grok { .. } => Some(body.trim().to_string()),
            Source::CodexStandalone => field(&json()?, &["tag_name"]),
            Source::Antigravity { .. } | Source::PiManaged | Source::OpencodeV1 | Source::OpencodeV2 | Source::Npm { .. } => {
                field(&json()?, &["version"])
            }
            Source::OmpScript { .. } => field(&json()?, &["build", "version"]),
            Source::Homebrew { cask: false, .. } => field(&json()?, &["versions", "stable"]),
            // A cask version can carry a build after a comma (`1.2.3,abcdef`).
            Source::Homebrew { cask: true, .. } => {
                field(&json()?, &["version"]).map(|v| v.split(',').next().unwrap_or_default().to_string())
            }
            Source::CursorInstallPage { .. } => cursor_install_version(body),
        }?;
        let version = strip_prefix(version.trim()).to_string();
        let accepted = match self {
            Source::OpencodeV1 => major(&version) == Some(1),
            _ => true,
        };
        (looks_like_version(&version) && accepted).then_some(version)
    }
}

/// `downloads.cursor.com/lab/<version>/` in the shell script, `$version = '<version>'` in the PowerShell one.
fn cursor_install_version(body: &str) -> Option<String> {
    let after = |marker: &str, end: char| body.split_once(marker).and_then(|(_, rest)| rest.split_once(end)).map(|(v, _)| v.to_string());
    after("downloads.cursor.com/lab/", '/')
        .filter(|v| looks_like_version(v))
        .or_else(|| after("$version = '", '\'').filter(|v| looks_like_version(v)))
}

fn strip_prefix(version: &str) -> &str {
    let version = version.strip_prefix("rust-v").unwrap_or(version);
    version.strip_prefix('v').filter(|rest| rest.starts_with(|c: char| c.is_ascii_digit())).unwrap_or(version)
}

fn looks_like_version(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text.starts_with(|c: char| c.is_ascii_digit())
        && text.contains('.')
        && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
}

/// The version in a CLI's `--version` line: `2.1.300 (Claude Code)`, `codex-cli 0.50.0`, `rust-v0.50.0`,
/// `2026.11.17-f532c45`.
pub fn version_token(line: &str) -> Option<String> {
    line.split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | ',' | '"' | '\''))
        .map(strip_prefix)
        .find(|token| looks_like_version(token))
        .map(str::to_string)
}

fn major(version: &str) -> Option<u64> {
    version.split(['.', '-', '+']).next()?.parse().ok()
}

/// A version as numbers and what follows them: `2.1.3-beta.1` is `([2, 1, 3], Some("beta.1"))`.
fn split(version: &str) -> (Vec<u64>, Option<&str>) {
    let (core, suffix) = match version.find(['-', '+']) {
        Some(index) => (&version[..index], Some(&version[index + 1..])),
        None => (version, None),
    };
    (core.split('.').map_while(|part| part.parse().ok()).collect(), suffix.filter(|s| !s.is_empty()))
}

fn is_hash(text: &str) -> bool {
    text.len() >= 6 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Whether `latest` is a newer version than `installed`. Both may be raw `--version` lines or feed values.
/// Numbers compare first; at equal numbers a release beats a prerelease, and two builds that differ only in
/// their commit hash (Cursor's `2026.11.17-f532c45`) count as different. Anything unreadable is not newer.
pub fn is_newer(latest: &str, installed: &str) -> bool {
    let (Some(latest), Some(installed)) = (version_token(latest), version_token(installed)) else { return false };
    let ((mut a, a_suffix), (mut b, b_suffix)) = (split(&latest), split(&installed));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let width = a.len().max(b.len());
    a.resize(width, 0);
    b.resize(width, 0);
    match a.cmp(&b) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => match (a_suffix, b_suffix) {
            (None, Some(pre)) => !is_hash(pre),
            (Some(a), Some(b)) if is_hash(a) && is_hash(b) => a != b,
            (Some(a), Some(b)) => prerelease_newer(a, b),
            _ => false,
        },
    }
}

/// Semver's prerelease order: dot-separated parts, numbers numerically, below words.
fn prerelease_newer(a: &str, b: &str) -> bool {
    let (mut a_parts, mut b_parts) = (a.split('.'), b.split('.'));
    loop {
        match (a_parts.next(), b_parts.next()) {
            (Some(x), Some(y)) => {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => std::cmp::Ordering::Less,
                    (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if order.is_ne() {
                    return order.is_gt();
                }
            }
            (Some(_), None) => return true,
            _ => return false,
        }
    }
}

/// Whether the version check should offer `latest` for `kind`. OpenCode 2 is a separate product line: a 1.x
/// install is never told about 2.x, nor the other way round.
pub fn update_available(kind: ProviderKind, latest: &str, installed: &str) -> bool {
    if kind == ProviderKind::Opencode {
        let majors = (version_token(latest).as_deref().and_then(major), version_token(installed).as_deref().and_then(major));
        if majors.0 != majors.1 {
            return false;
        }
    }
    is_newer(latest, installed)
}

const VERSION_MANAGERS: [&str; 4] = ["/nix/store/", "/.local/share/mise/", "/.asdf/", "/.local/share/rtx/"];

/// The global npm package of each harness.
pub fn npm_package(kind: ProviderKind) -> Option<&'static str> {
    Some(match kind {
        ProviderKind::ClaudeCode => "@anthropic-ai/claude-code",
        ProviderKind::Codex => "@openai/codex",
        ProviderKind::Opencode => "opencode-ai",
        ProviderKind::Pi => "@earendil-works/pi-coding-agent",
        ProviderKind::Omp => "@oh-my-pi/pi-coding-agent",
        // Its `latest` is the stable channel `grok update` installs (T3 Code, 3e2dff4206).
        ProviderKind::GrokBuild => "@xai-official/grok",
        _ => return None,
    })
}

/// Where the daemon looks for the user's own files.
#[derive(Debug, Clone, Default)]
pub struct Places {
    pub home: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    /// The `GROK_HOME` variable, as set.
    pub grok_home: Option<String>,
    /// `std::env::consts::OS` and `ARCH`, or a fixture's.
    pub os: &'static str,
    pub arch: &'static str,
}

impl Places {
    pub fn current() -> Self {
        Self {
            home: std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from),
            local_app_data: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
            grok_home: std::env::var("GROK_HOME").ok(),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        }
    }
}

fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Whether a resolved path lies inside `dir`, as written or with its own symlinks resolved (macOS `/var` is
/// `/private/var`).
fn within(resolved: &str, dir: &Path) -> bool {
    let inside = |dir: &Path| {
        let dir = slashes(dir);
        let dir = dir.trim_end_matches('/');
        resolved.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
    };
    inside(dir) || std::fs::canonicalize(dir).is_ok_and(|real| inside(&real))
}

/// How the binary on PATH was installed, and its feed. Follows symlinks first: the `agent` command of Cursor
/// and of Grok Build share a name, and only the resolved path tells them apart.
pub fn detect(kind: ProviderKind, binary: &Path, places: &Places) -> Install {
    let canonical = std::fs::canonicalize(binary).unwrap_or_else(|_| binary.to_path_buf());
    let (shown, resolved) = (slashes(binary), slashes(&canonical));
    let both = format!("{shown} {resolved}");
    if VERSION_MANAGERS.iter().any(|part| both.contains(part)) {
        return Install::new(HarnessInstall::VersionManager, None);
    }
    if let Some((_, package, cask)) = crate::update::brew_package(kind, &canonical) {
        return Install::new(HarnessInstall::Homebrew, Some(Source::Homebrew { package, cask }));
    }
    if let Some(package) = npm_package(kind) {
        // A symlink into `node_modules/<package>`, or a Windows `.cmd` shim beside its `node_modules`.
        let beside = binary.parent().is_some_and(|dir| dir.join("node_modules").join(package).is_dir());
        if resolved.contains(&format!("/node_modules/{package}/")) || beside {
            let source = if kind == ProviderKind::Opencode { Source::OpencodeV1 } else { Source::Npm { package: package.into() } };
            return Install::new(HarnessInstall::Npm, Some(source));
        }
    }
    let home = places.home.as_deref();
    let under_home = |relative: &str| home.is_some_and(|home| within(&resolved, &home.join(relative)));
    let windows = places.os == "windows";
    let source = match kind {
        ProviderKind::ClaudeCode if under_home(".local/share/claude/versions/") => {
            return Install::new(HarnessInstall::Native, Some(Source::ClaudeNative { channel: claude_channel(home) }));
        }
        ProviderKind::Codex if resolved.contains("/.codex/packages/standalone/") => {
            return Install::new(HarnessInstall::Standalone, Some(Source::CodexStandalone));
        }
        ProviderKind::Antigravity => {
            let script = crate::binary::antigravity_candidates(home, places.local_app_data.as_deref())
                .iter()
                .any(|candidate| slashes(candidate) == shown || slashes(candidate) == resolved);
            script.then(|| Source::Antigravity { platform: antigravity_platform(places.os, places.arch) })
        }
        ProviderKind::GrokBuild => {
            let grok = crate::binary::grok_home(home, places.grok_home.as_deref());
            let script = resolved.contains("/.grok/") || grok.as_deref().is_some_and(|grok| within(&resolved, grok));
            script.then(|| Source::Grok { channel: grok_channel(grok.as_deref()) })
        }
        ProviderKind::Pi => {
            let managed = home.is_some_and(|home| home.join(".pi/agent/install/managed-install.json").is_file());
            managed.then_some(Source::PiManaged)
        }
        ProviderKind::Omp => {
            let script = home.is_some_and(|home| slashes(&home.join(".local/bin/omp")) == shown)
                || places.local_app_data.as_deref().is_some_and(|local| within(&resolved, &local.join("omp")));
            script.then(|| Source::OmpScript { target: omp_target(places.os, places.arch) })
        }
        ProviderKind::Opencode if resolved.contains("/.opencode/") => {
            let shim = [binary.parent(), canonical.parent()].into_iter().flatten().any(|dir| dir.join("opencode2").exists());
            Some(if shim || resolved.ends_with("/opencode2") { Source::OpencodeV2 } else { Source::OpencodeV1 })
        }
        // Grok Build installs an `agent` command too; only Cursor's own layout counts.
        ProviderKind::Cursor if resolved.contains("cursor-agent") && !resolved.contains("/.grok/") => {
            Some(Source::CursorInstallPage { windows })
        }
        _ => None,
    };
    match source {
        Some(source) => Install::new(HarnessInstall::Script, Some(source)),
        None => Install::new(HarnessInstall::Other, None),
    }
}

/// Claude Code's `autoUpdatesChannel` from `~/.claude/settings.json`: `latest` (its default) or `stable`.
fn claude_channel(home: Option<&Path>) -> String {
    let channel = home
        .and_then(|home| std::fs::read_to_string(home.join(".claude/settings.json")).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|settings| settings.get("autoUpdatesChannel").and_then(|v| v.as_str()).map(str::to_string));
    match channel.as_deref() {
        Some("stable") => "stable".into(),
        _ => "latest".into(),
    }
}

/// Grok Build's `channel` from `config.toml` in its folder (`$GROK_HOME`, else `~/.grok`): `stable` (its
/// default), `alpha` or `enterprise`.
fn grok_channel(grok_home: Option<&Path>) -> String {
    let text = grok_home.and_then(|grok| std::fs::read_to_string(grok.join("config.toml")).ok()).unwrap_or_default();
    let channel = text.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        (key.trim() == "channel").then(|| value.trim().trim_matches(['"', '\'']).to_string())
    });
    match channel.as_deref() {
        Some(channel @ ("alpha" | "enterprise")) => channel.into(),
        _ => "stable".into(),
    }
}

fn antigravity_platform(os: &str, arch: &str) -> String {
    let os = match os {
        "macos" => "darwin",
        other => other,
    };
    let arch = match arch {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    };
    format!("{os}_{arch}")
}

fn omp_target(os: &str, arch: &str) -> String {
    let arch = match arch {
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// The vendor's install script, which also updates, for an installation whose CLI has no updater of its own.
/// `None` where the vendor publishes none for this platform.
pub fn install_script(kind: ProviderKind, windows: bool) -> Option<&'static str> {
    Some(match (kind, windows) {
        (ProviderKind::Antigravity, false) => "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        (ProviderKind::Antigravity, true) => "irm https://antigravity.google/cli/install.ps1 | iex",
        (ProviderKind::GrokBuild, false) => "curl -fsSL https://x.ai/cli/install.sh | bash",
        (ProviderKind::Cursor, false) => "curl https://cursor.com/install -fsS | bash",
        (ProviderKind::Cursor, true) => "irm 'https://cursor.com/install?win32=true' | iex",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn places(home: &Path) -> Places {
        Places { home: Some(home.to_path_buf()), local_app_data: None, grok_home: None, os: "linux", arch: "x86_64" }
    }

    fn file(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    #[cfg(unix)]
    fn link(target: &Path, at: &Path) {
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(target, at).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn each_install_layout_is_recognised_through_its_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let bin = home.join(".local/bin");
        let at = |kind, name: &str| detect(kind, &bin.join(name), &places(&home));

        // Claude Code's native installer, on the channel its settings name.
        let claude = home.join(".local/share/claude/versions/2.1.327");
        file(&claude);
        link(&claude, &bin.join("claude"));
        assert_eq!(
            at(ProviderKind::ClaudeCode, "claude"),
            Install::new(HarnessInstall::Native, Some(Source::ClaudeNative { channel: "latest".into() }))
        );
        file(&home.join(".claude/settings.json"));
        std::fs::write(home.join(".claude/settings.json"), r#"{"autoUpdatesChannel":"stable"}"#).unwrap();
        assert_eq!(at(ProviderKind::ClaudeCode, "claude").source, Some(Source::ClaudeNative { channel: "stable".into() }));

        // Codex's standalone package.
        let codex = home.join(".codex/packages/standalone/releases/0.167.0-x86_64-unknown-linux-musl/bin/codex");
        file(&codex);
        link(&codex, &bin.join("codex"));
        assert_eq!(at(ProviderKind::Codex, "codex"), Install::new(HarnessInstall::Standalone, Some(Source::CodexStandalone)));

        // Antigravity's script puts `agy` straight into ~/.local/bin.
        file(&bin.join("agy"));
        assert_eq!(at(ProviderKind::Antigravity, "agy").source, Some(Source::Antigravity { platform: "linux_amd64".into() }));

        // Grok Build: ~/.grok/bin → ~/.grok/downloads, on its configured channel.
        let grok = home.join(".grok/downloads/1.4.0/grok");
        file(&grok);
        link(&grok, &home.join(".grok/bin/grok"));
        std::fs::write(home.join(".grok/config.toml"), "[update]\nchannel = \"alpha\"\n").unwrap();
        let found = detect(ProviderKind::GrokBuild, &home.join(".grok/bin/grok"), &places(&home));
        assert_eq!(found, Install::new(HarnessInstall::Script, Some(Source::Grok { channel: "alpha".into() })));
        // One installed under a custom GROK_HOME reads its channel there.
        let custom = home.join("xai/downloads/1.5.0/grok");
        file(&custom);
        link(&custom, &home.join("xai/bin/grok"));
        std::fs::write(home.join("xai/config.toml"), "channel = \"enterprise\"\n").unwrap();
        let grok_home = Places { grok_home: Some("~/xai".into()), ..places(&home) };
        let found = detect(ProviderKind::GrokBuild, &home.join("xai/bin/grok"), &grok_home);
        assert_eq!(found, Install::new(HarnessInstall::Script, Some(Source::Grok { channel: "enterprise".into() })));
        // Grok's npm package.
        let npm = home.join(".npm-global/lib/node_modules/@xai-official/grok/bin/grok");
        file(&npm);
        link(&npm, &bin.join("grok"));
        assert_eq!(
            at(ProviderKind::GrokBuild, "grok"),
            Install::new(HarnessInstall::Npm, Some(Source::Npm { package: "@xai-official/grok".into() }))
        );

        // Grok's `agent` is not Cursor's; Cursor's own layout is.
        link(&grok, &bin.join("agent"));
        assert_eq!(at(ProviderKind::Cursor, "agent"), Install::new(HarnessInstall::Other, None));
        std::fs::remove_file(bin.join("agent")).unwrap();
        let cursor = home.join(".local/share/cursor-agent/versions/2026.11.17-f532c45/cursor-agent");
        file(&cursor);
        link(&cursor, &bin.join("agent"));
        assert_eq!(at(ProviderKind::Cursor, "agent").source, Some(Source::CursorInstallPage { windows: false }));

        // pi's managed installer leaves its marker.
        file(&bin.join("pi"));
        assert_eq!(at(ProviderKind::Pi, "pi"), Install::new(HarnessInstall::Other, None));
        file(&home.join(".pi/agent/install/managed-install.json"));
        assert_eq!(at(ProviderKind::Pi, "pi").source, Some(Source::PiManaged));

        // Oh My Pi's script.
        file(&bin.join("omp"));
        assert_eq!(at(ProviderKind::Omp, "omp").source, Some(Source::OmpScript { target: "linux-x86_64".into() }));

        // OpenCode's script: 1.x, or 2 with its `opencode2` shim beside it.
        file(&home.join(".opencode/bin/opencode"));
        let opencode = |home: &Path| detect(ProviderKind::Opencode, &home.join(".opencode/bin/opencode"), &places(home));
        assert_eq!(opencode(&home).source, Some(Source::OpencodeV1));
        file(&home.join(".opencode/bin/opencode2"));
        assert_eq!(opencode(&home).source, Some(Source::OpencodeV2));

        // A global npm package, through the bin symlink.
        let npm = root.path().join("prefix/lib/node_modules/@openai/codex/bin/codex.js");
        file(&npm);
        link(&npm, &root.path().join("prefix/bin/codex"));
        let found = detect(ProviderKind::Codex, &root.path().join("prefix/bin/codex"), &places(&home));
        assert_eq!(found, Install::new(HarnessInstall::Npm, Some(Source::Npm { package: "@openai/codex".into() })));
        let npm = root.path().join("prefix/lib/node_modules/opencode-ai/bin/opencode");
        file(&npm);
        link(&npm, &root.path().join("prefix/bin/opencode"));
        assert_eq!(
            detect(ProviderKind::Opencode, &root.path().join("prefix/bin/opencode"), &places(&home)).source,
            Some(Source::OpencodeV1)
        );

        // Homebrew, and a version manager, which Kybern leaves alone.
        let cask = root.path().join("opt/homebrew/Caskroom/claude-code/2.1.300/claude");
        file(&cask);
        link(&cask, &root.path().join("opt/homebrew/bin/claude"));
        let found = detect(ProviderKind::ClaudeCode, &root.path().join("opt/homebrew/bin/claude"), &places(&home));
        assert_eq!(found, Install::new(HarnessInstall::Homebrew, Some(Source::Homebrew { package: "claude-code".into(), cask: true })));
        let mise = home.join(".local/share/mise/installs/node/22/bin/claude");
        file(&mise);
        assert_eq!(detect(ProviderKind::ClaudeCode, &mise, &places(&home)), Install::new(HarnessInstall::VersionManager, None));

        // Anything else has no feed.
        file(&root.path().join("custom/claude"));
        assert_eq!(
            detect(ProviderKind::ClaudeCode, &root.path().join("custom/claude"), &places(&home)),
            Install::new(HarnessInstall::Other, None)
        );
    }

    #[test]
    fn windows_script_installs_and_npm_shims_are_recognised() {
        let root = tempfile::tempdir().unwrap();
        let local = root.path().join("AppData/Local");
        let windows = Places {
            home: Some(root.path().join("me")),
            local_app_data: Some(local.clone()),
            grok_home: None,
            os: "windows",
            arch: "x86_64",
        };
        file(&local.join("agy/bin/agy.exe"));
        assert_eq!(
            detect(ProviderKind::Antigravity, &local.join("agy/bin/agy.exe"), &windows).source,
            Some(Source::Antigravity { platform: "windows_amd64".into() })
        );
        file(&local.join("omp/bin/omp.exe"));
        assert_eq!(
            detect(ProviderKind::Omp, &local.join("omp/bin/omp.exe"), &windows).source,
            Some(Source::OmpScript { target: "windows-x86_64".into() })
        );
        let npm = root.path().join("AppData/Roaming/npm");
        file(&npm.join("claude.cmd"));
        std::fs::create_dir_all(npm.join("node_modules/@anthropic-ai/claude-code")).unwrap();
        assert_eq!(detect(ProviderKind::ClaudeCode, &npm.join("claude.cmd"), &windows).method, HarnessInstall::Npm);
        assert_eq!(antigravity_platform("macos", "aarch64"), "darwin_arm64");
        assert_eq!(omp_target("macos", "aarch64"), "macos-arm64");
    }

    #[test]
    fn feeds_parse_their_recorded_answers() {
        let parse = |source: Source, body: &str| source.parse(body);
        assert_eq!(parse(Source::ClaudeNative { channel: "latest".into() }, "2.1.330\n").as_deref(), Some("2.1.330"));
        assert_eq!(parse(Source::ClaudeNative { channel: "latest".into() }, "<html>Not found</html>"), None);
        let codex = r#"{"url":"https://api.github.com/repos/openai/codex/releases/1","tag_name":"rust-v0.170.0","name":"0.170.0","prerelease":false}"#;
        assert_eq!(parse(Source::CodexStandalone, codex).as_deref(), Some("0.170.0"));
        assert_eq!(
            parse(
                Source::Antigravity { platform: "linux_amd64".into() },
                r#"{"version":"1.0.12","url":"https://x/agy.tar.gz","sha256":"ab"}"#
            )
            .as_deref(),
            Some("1.0.12")
        );
        assert_eq!(parse(Source::Grok { channel: "stable".into() }, "0.1.207").as_deref(), Some("0.1.207"));
        assert_eq!(parse(Source::PiManaged, r#"{"version":"0.70.2","assets":[]}"#).as_deref(), Some("0.70.2"));
        assert_eq!(
            parse(
                Source::OmpScript { target: "linux-x86_64".into() },
                r#"{"product":"omp","build":{"version":"13.2.1","url":"https://b"}}"#
            )
            .as_deref(),
            Some("13.2.1")
        );
        assert_eq!(parse(Source::OpencodeV1, r#"{"name":"opencode-ai","version":"1.14.3"}"#).as_deref(), Some("1.14.3"));
        assert_eq!(parse(Source::OpencodeV1, r#"{"name":"opencode-ai","version":"2.0.1"}"#), None, "a 1.x install is not offered 2.x");
        assert_eq!(parse(Source::OpencodeV2, r#"{"version":"2.0.4"}"#).as_deref(), Some("2.0.4"));
        assert_eq!(
            parse(
                Source::Npm { package: "@anthropic-ai/claude-code".into() },
                r#"{"name":"@anthropic-ai/claude-code","version":"2.1.330","bin":{}}"#
            )
            .as_deref(),
            Some("2.1.330")
        );
        assert_eq!(
            parse(
                Source::Homebrew { package: "codex".into(), cask: false },
                r#"{"name":"codex","versions":{"stable":"0.170.0","head":null}}"#
            )
            .as_deref(),
            Some("0.170.0")
        );
        assert_eq!(
            parse(Source::Homebrew { package: "claude-code".into(), cask: true }, r#"{"token":"claude-code","version":"2.1.330,abc123"}"#)
                .as_deref(),
            Some("2.1.330")
        );
        let sh = "#!/usr/bin/env bash\nDOWNLOAD_URL=\"https://downloads.cursor.com/lab/2026.11.17-f532c45/${OS}/${ARCH}/agent-cli-package.tar.gz\"\n";
        assert_eq!(parse(Source::CursorInstallPage { windows: false }, sh).as_deref(), Some("2026.11.17-f532c45"));
        let ps = "$ErrorActionPreference = 'Stop'\n$version = '2026.11.17-f532c45'\n";
        assert_eq!(parse(Source::CursorInstallPage { windows: true }, ps).as_deref(), Some("2026.11.17-f532c45"));
        assert_eq!(parse(Source::CursorInstallPage { windows: false }, "echo nothing to see"), None);
    }

    #[test]
    fn versions_compare_across_every_harness_format() {
        assert!(is_newer("2.1.330", "2.1.327 (Claude Code)"));
        assert!(!is_newer("2.1.327", "2.1.327 (Claude Code)"));
        assert!(!is_newer("2.1.300", "2.1.327 (Claude Code)"));
        assert!(is_newer("rust-v0.170.0", "codex-cli 0.167.0"));
        assert!(!is_newer("rust-v0.167.0", "codex-cli 0.167.0"));
        assert!(is_newer("v1.10.0", "1.9.9"), "numbers, not text");
        assert!(!is_newer("1.2.0", "1.2"), "a missing part is zero");
        assert!(is_newer("1.2.1", "1.2"));
        assert!(!is_newer("1.2", "1.2.0"));
        assert!(is_newer("1.2.0", "1.2.0-beta.3"), "a release is newer than its prerelease");
        assert!(is_newer("1.2.0-beta.10", "1.2.0-beta.9"));
        assert!(!is_newer("1.2.0-beta.3", "1.2.0"));
        // Cursor: a date and a build hash.
        assert!(is_newer("2026.11.17-f532c45", "2026.10.30-0a1b2c3"));
        assert!(is_newer("2026.11.17-f532c45", "2026.11.17-0a1b2c3"), "same day, another build");
        assert!(!is_newer("2026.11.17-f532c45", "2026.11.17-f532c45"));
        assert!(!is_newer("2026.10.30-0a1b2c3", "2026.11.17-f532c45"));
        assert!(!is_newer("garbage", "1.0.0"));
        assert!(!is_newer("1.0.0", "unknown"));
        assert_eq!(version_token("codex-cli 0.167.0").as_deref(), Some("0.167.0"));
        assert_eq!(version_token("2.1.327 (Claude Code)").as_deref(), Some("2.1.327"));
        assert_eq!(version_token("SDK 1.0.13").as_deref(), Some("1.0.13"));
        assert!(update_available(ProviderKind::Opencode, "1.14.3", "1.14.0"));
        assert!(!update_available(ProviderKind::Opencode, "2.0.1", "1.14.0"), "OpenCode 2 is another line");
        assert!(update_available(ProviderKind::Codex, "0.170.0", "codex-cli 0.167.0"));
    }

    /// Every feed against its live endpoint: `cargo test -p kybern-drivers latest::tests::live -- --ignored --nocapture`.
    /// Read-only GETs; nothing about the user is sent.
    #[ignore]
    #[tokio::test]
    async fn live_feeds_name_a_version() {
        let client = reqwest::Client::builder().user_agent("kybernd").timeout(std::time::Duration::from_secs(20)).build().unwrap();
        let sources = [
            Source::ClaudeNative { channel: "latest".into() },
            Source::ClaudeNative { channel: "stable".into() },
            Source::CodexStandalone,
            Source::Antigravity { platform: "linux_amd64".into() },
            Source::Grok { channel: "stable".into() },
            Source::PiManaged,
            Source::OmpScript { target: "linux-x86_64".into() },
            Source::OpencodeV2,
            Source::Npm { package: "@anthropic-ai/claude-code".into() },
            Source::Homebrew { package: "opencode".into(), cask: false },
            Source::Homebrew { package: "codex".into(), cask: true },
            Source::Homebrew { package: "claude-code".into(), cask: true },
            Source::CursorInstallPage { windows: false },
            Source::CursorInstallPage { windows: true },
        ];
        let mut missing = Vec::new();
        for source in sources {
            let mut found = None;
            for url in source.urls() {
                let Ok(response) = client.get(&url).send().await else { continue };
                let Ok(body) = response.text().await else { continue };
                found = source.parse(&body);
                if found.is_some() {
                    break;
                }
            }
            println!("{source:?}: {found:?}");
            if found.is_none() {
                missing.push(source);
            }
        }
        // OpenCode 1.x reads npm, which may have moved to 2.x: `None` there is the 1.x rule, not a failure.
        println!(
            "OpencodeV1: {:?}",
            Source::OpencodeV1.parse(&client.get(&Source::OpencodeV1.urls()[0]).send().await.unwrap().text().await.unwrap())
        );
        assert!(missing.is_empty(), "no version from {missing:?}");
    }

    #[test]
    fn scripts_exist_only_where_the_vendor_publishes_one() {
        assert!(install_script(ProviderKind::GrokBuild, false).is_some());
        assert!(install_script(ProviderKind::GrokBuild, true).is_none());
        assert!(install_script(ProviderKind::ClaudeCode, false).is_none(), "Claude Code updates itself");
        assert!(install_script(ProviderKind::Cursor, true).unwrap().contains("win32=true"));
    }
}
