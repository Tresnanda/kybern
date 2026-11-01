//! The agent-desktop backend (design §5): vercel-labs' accessibility CLI on
//! macOS, Windows and Linux, behind [`ComputerBackend`].
//!
//! One process runs per call (`runner`), its JSON envelope becomes windows,
//! snapshots, pictures and [`Outcome`]s, and the platform differences in the
//! design's per-OS table live in `act` (what is delivered how) and
//! `capabilities` (what the tools may ask for). Real envelopes recorded from
//! the 1.0.2 binary on macOS, Windows 11 and GNOME 46 Wayland are in
//! `fixtures/`.

mod act;
mod apps;
mod capture;
mod envelope;
mod ids;
mod install;
#[cfg(test)]
mod live;
mod runner;
mod status;
#[cfg(test)]
mod tests;
mod tree;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use self::capture::{Captures, Geometry, Pause};
use self::envelope::{Envelope, note};
use self::ids::WindowIds;
use self::runner::{Cmd, Runner};
use super::Mode;
use super::backend::{
    Act, AppInfo, BackendKind, BackendStatus, Capabilities, ComputerBackend, Image, Launched, Os, Outcome, ReadOptions, Region, Target,
    WindowInfo, WindowRead,
};

/// Seen windows: what a window number needs to be acted on.
#[derive(Debug, Clone)]
struct Known {
    app: String,
    bounds: Option<capture::Rect>,
}

/// Which display server a Linux session uses (agent-desktop prefers Wayland
/// when its socket answers; the environment is the best Kybern can read).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Display {
    X11,
    Wayland,
    /// Not Linux, or no display variables at all.
    None,
}

impl Display {
    pub(crate) fn detect(os: Os) -> Self {
        if os != Os::Linux {
            return Display::None;
        }
        let set = |name: &str| std::env::var(name).is_ok_and(|value| !value.is_empty());
        let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
        if set("WAYLAND_DISPLAY") || session == "wayland" {
            Display::Wayland
        } else if set("DISPLAY") || session == "x11" {
            Display::X11
        } else {
            Display::None
        }
    }
}

pub(crate) struct AgentDesktopBackend {
    os: Os,
    display: Display,
    data_dir: std::path::PathBuf,
    runner: Runner,
    ids: Mutex<WindowIds>,
    windows: Mutex<HashMap<u64, Known>>,
    captures: Captures,
    pause: Pause,
    chromium: Mutex<HashSet<i64>>,
}

/// Chromium and Electron apps need a long first read before their tree settles.
const SNAPSHOT_MS: u64 = 4_000;
const CHROMIUM_SNAPSHOT_MS: u64 = 15_000;
const LIST_MS: u64 = 5_000;
const ACTION_MS: u64 = 8_000;

impl AgentDesktopBackend {
    pub(crate) fn new(data_dir: &Path) -> Self {
        let override_bin =
            std::env::var_os("KYBERN_AGENT_DESKTOP_BIN").map(std::path::PathBuf::from).filter(|path| !path.as_os_str().is_empty());
        Self::build(data_dir, override_bin, Os::current(), Display::detect(Os::current()))
    }

    /// For tests: a given binary, OS and display, whatever the environment says.
    #[cfg(test)]
    pub(crate) fn with(data_dir: &Path, binary: Option<std::path::PathBuf>, os: Os, display: Display) -> Self {
        Self::build(data_dir, binary, os, display)
    }

    fn build(data_dir: &Path, override_bin: Option<std::path::PathBuf>, os: Os, display: Display) -> Self {
        Self {
            os,
            display,
            data_dir: data_dir.to_path_buf(),
            runner: Runner::new(data_dir, override_bin),
            ids: Mutex::new(WindowIds::default()),
            windows: Mutex::new(HashMap::new()),
            captures: Captures::default(),
            pause: Pause::default(),
            chromium: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) fn wayland(&self) -> bool {
        self.display == Display::Wayland
    }

    fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn native_of(&self, window_id: u64) -> String {
        Self::lock(&self.ids).native(window_id)
    }

    fn known(&self, window_id: u64) -> Option<Known> {
        Self::lock(&self.windows).get(&window_id).cloned()
    }

    fn is_chromium(&self, pid: i64, app: &str) -> bool {
        if Self::lock(&self.chromium).contains(&pid) {
            return true;
        }
        let app = app.to_lowercase();
        let stem = app.trim_end_matches(".exe");
        app.contains("chrom")
            || app.contains("electron")
            || ["msedge", "brave", "vivaldi", "opera", "code", "slack", "discord", "obsidian", "notion", "teams"].contains(&stem)
    }

    async fn run(&self, cmd: Cmd) -> Result<Envelope> {
        self.runner.run(&cmd).await
    }

    /// `list-windows`, parsed and remembered.
    async fn list_windows(&self) -> Result<Vec<WindowInfo>> {
        let data = self.run(Cmd::new("list-windows").timeout_ms(LIST_MS)).await?.into_data()?;
        Ok(self.remember_windows(&data))
    }

    fn remember_windows(&self, data: &Value) -> Vec<WindowInfo> {
        let rows = data.as_array().cloned().or_else(|| data.get("windows").and_then(Value::as_array).cloned()).unwrap_or_default();
        let mut listed = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            let Some(native) = row.get("id").and_then(Value::as_str) else { continue };
            let window_id = Self::lock(&self.ids).number(native);
            let pid = row.get("pid").and_then(Value::as_i64).unwrap_or(0);
            let app = row.get("app_name").and_then(Value::as_str).unwrap_or_default().to_owned();
            let title = row.get("title").and_then(Value::as_str).unwrap_or_default().to_owned();
            let bounds = tree::bounds(row.get("bounds"));
            let visible = row.get("visible").and_then(Value::as_bool).unwrap_or(true);
            let minimized = row.get("minimized").and_then(Value::as_bool).unwrap_or(false);
            Self::lock(&self.windows).insert(window_id, Known { app: app.clone(), bounds });
            listed.push(WindowInfo {
                window_id,
                pid,
                app,
                title,
                on_screen: visible && !minimized,
                elsewhere: false,
                z_index: Some(index as i64),
            });
        }
        listed
    }

    fn snapshot_ms(&self, pid: i64, app: &str) -> u64 {
        if self.is_chromium(pid, app) { CHROMIUM_SNAPSHOT_MS } else { SNAPSHOT_MS }
    }
}

#[async_trait]
impl ComputerBackend for AgentDesktopBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::AgentDesktop
    }

    fn capabilities(&self) -> Capabilities {
        capabilities(self.os, self.display)
    }

    fn installed(&self) -> bool {
        self.runner.binary().is_some()
    }

    async fn status(&self) -> BackendStatus {
        self.pause.clear();
        status::status(self).await
    }

    async fn install(&self) -> Result<()> {
        install::install(&self.data_dir).await
    }

    async fn grant(&self) -> Result<()> {
        if self.os != Os::Mac {
            return Ok(());
        }
        let envelope = self.run(Cmd::new("permissions").switch("--guide")).await?;
        envelope.into_data().map(|_| ())
    }

    async fn warm(&self) -> Result<()> {
        if self.runner.binary().is_none() {
            return Err(anyhow!(
                "agent-desktop is not installed. Install it from Settings → Computer use, or run `kybern computer install`."
            ));
        }
        let binary = self.runner.binary();
        if binary.is_some_and(|binary| !binary.overridden) && !self.runner.verified() {
            return Err(anyhow!(
                "agent-desktop does not match the pinned {} build. Reinstall it from Settings → Computer use.",
                install::VERSION
            ));
        }
        Ok(())
    }

    async fn release(&self) {
        if self.runner.binary().is_none() {
            return;
        }
        let cmd = Cmd::new("session").sub("gc").switch("--ended");
        let _ = tokio::time::timeout(Duration::from_secs(5), self.runner.run(&cmd)).await;
    }

    async fn windows(&self, pid: Option<i64>) -> Result<Vec<WindowInfo>> {
        let all = self.list_windows().await?;
        Ok(match pid {
            Some(pid) => all.into_iter().filter(|window| window.pid == pid).collect(),
            None => all,
        })
    }

    async fn apps(&self) -> Result<Vec<AppInfo>> {
        let data = self.run(Cmd::new("list-apps").timeout_ms(LIST_MS)).await?.into_data()?;
        let mut apps: Vec<AppInfo> = data
            .get("apps")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let name = row.get("name").and_then(Value::as_str)?.to_owned();
                        let bundle = row.get("bundle_id").and_then(Value::as_str);
                        let presentation = row.get("presentation").and_then(Value::as_str);
                        Some(AppInfo {
                            app_id: ids::app_id(self.os, &name, bundle),
                            pid: row.get("pid").and_then(Value::as_i64),
                            regular: match (self.os, presentation) {
                                (_, Some(presentation)) => presentation == "foreground",
                                (Os::Mac, None) => false,
                                (_, None) => true,
                            },
                            name,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Apps with windows that list-apps misses (a hosted Windows app such as
        // Calculator runs as CalculatorApp.exe) are found through their windows.
        if let Ok(windows) = self.list_windows().await {
            for window in windows {
                if window.pid != 0 && !window.app.is_empty() && !apps.iter().any(|app| app.pid == Some(window.pid)) {
                    apps.push(AppInfo {
                        app_id: ids::app_id(self.os, &window.app, None),
                        name: window.app,
                        pid: Some(window.pid),
                        regular: true,
                    });
                }
            }
        }
        Ok(apps)
    }

    async fn app_id_of(&self, pid: i64) -> Option<String> {
        let apps = self.apps().await.ok()?;
        apps.into_iter().find(|app| app.pid == Some(pid) && app.regular).and_then(|app| app.app_id)
    }

    async fn find_app(&self, requested: &str) -> Option<(String, String)> {
        apps::find_app(self.os, requested).await
    }

    async fn launch(&self, app: &str, app_id: Option<&str>) -> Result<Launched> {
        let before: HashSet<u64> =
            self.list_windows().await.map(|windows| windows.into_iter().map(|window| window.window_id).collect()).unwrap_or_default();
        let arg = act::launch_arg(self.os, app, app_id);
        let data = self.run(Cmd::new("launch").launch_timeout_ms(15_000).positional(arg)).await?.into_data()?;
        let pid = data.get("pid").and_then(Value::as_i64);
        if let Some(pid) = pid
            && data.get("renderer").and_then(Value::as_str) == Some("chromium")
        {
            Self::lock(&self.chromium).insert(pid);
        }
        let name = data.get("app").and_then(Value::as_str).unwrap_or(app).to_owned();
        // A launched app's window can belong to another process (calc.exe starts
        // CalculatorApp.exe), so a new window or a name match counts, not the pid alone.
        let mut windows = Vec::new();
        for attempt in 0..8 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
            let listed = self.list_windows().await.unwrap_or_default();
            windows = listed
                .into_iter()
                .filter(|window| !before.contains(&window.window_id) || Some(window.pid) == pid || act::same_app(&window.app, &name))
                .collect();
            if !windows.is_empty() {
                break;
            }
        }
        let app_id = app_id
            .map(str::to_owned)
            .or_else(|| windows.first().and_then(|window| ids::app_id(self.os, &window.app, None)))
            .or_else(|| ids::app_id(self.os, &name, None));
        Ok(Launched { name, app_id, pid: windows.first().map(|window| window.pid).or(pid), windows })
    }

    async fn read(&self, target: Target, options: ReadOptions<'_>, session: &str) -> Result<WindowRead> {
        let native = self.native_of(target.window_id);
        let known = self.known(target.window_id);
        let app = known.as_ref().map(|known| known.app.as_str()).unwrap_or("");
        let mut parsed = None;
        if options.tree {
            let cmd = Cmd::new("snapshot")
                .flag("--window-id", &native)
                .switch("--compact")
                .switch("--include-bounds")
                .session(session)
                .timeout_ms(self.snapshot_ms(target.pid, app));
            let data = self.run(cmd).await?.into_data()?;
            let tree = tree::parse_snapshot(&data);
            if let Some(bounds) = tree.window_bounds {
                if let Some(known) = Self::lock(&self.windows).get_mut(&target.window_id) {
                    known.bounds = Some(bounds);
                }
                self.captures.update_window(session, target.window_id, bounds);
            }
            parsed = Some(tree.snapshot);
        }
        let mut snapshot = parsed.unwrap_or_else(|| super::digest::Snapshot::new(Vec::new(), Vec::new(), false, None, None, None));
        let image = match options.image_edge {
            Some(edge) => match self.capture_window(target, edge, session).await {
                Ok(image) => image,
                // A read with a tree still answers; the picture's absence is said in the digest.
                Err(error) if options.tree => {
                    snapshot.degraded.get_or_insert_with(|| format!("No screenshot: {error}"));
                    None
                }
                Err(error) => return Err(error),
            },
            None => None,
        };
        Ok(WindowRead { snapshot, image })
    }

    async fn zoom(&self, target: Target, region: Region, edge: u32, session: &str) -> Result<Image> {
        if let Some(reason) = self.pause.get() {
            return Err(anyhow!("{reason}"));
        }
        if self.captures.png(session, target.window_id).is_none() {
            self.capture_window(target, 1280, session).await?;
        }
        let (png, geometry) =
            self.captures.png(session, target.window_id).ok_or_else(|| anyhow!("There is no picture of this window to zoom into."))?;
        let (image, zoom) = capture::crop(&png, geometry.width, geometry.height, region, edge)?;
        self.captures.remember_zoom(session, target.window_id, zoom);
        Ok(image)
    }

    async fn act(&self, target: Target, action: &Act, mode: Mode, session: &str) -> Result<Outcome> {
        self.perform(target, action, mode, session).await
    }

    fn capture_paused(&self) -> Option<String> {
        self.pause.get()
    }

    fn resume_capture(&self) {
        self.pause.clear();
    }
}

impl AgentDesktopBackend {
    /// A picture of one window (the whole display on Wayland), scaled for the
    /// tools, with its geometry kept for `click_at` and `zoom`. `None` while
    /// pictures are paused.
    async fn capture_window(&self, target: Target, edge: u32, session: &str) -> Result<Option<Image>> {
        if self.pause.get().is_some() {
            return Ok(None);
        }
        let native = self.native_of(target.window_id);
        let mut cmd = Cmd::new("screenshot").session(session);
        if self.capabilities().window_capture {
            cmd = cmd.flag("--window-id", &native);
        }
        let envelope = match self.run(cmd).await {
            Ok(envelope) => envelope,
            Err(error) if self.wayland() => {
                // The runner stopped a capture that waited for the consent dialog.
                self.pause.set(format!("Screenshots are off: the desktop's screenshot permission was not answered ({error})"));
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        if let Some(error) = &envelope.error {
            if let Some(reason) = capture::pause_reason(error, self.wayland()) {
                self.pause.set(reason);
            }
            return Err(anyhow!("{}", error.note()));
        }
        let png = extract_picture(&envelope.data).ok_or_else(|| anyhow!("{}", note("INTERNAL", "agent-desktop returned no picture")))?;
        // Window bounds for click_at: the latest listing, refreshed when the read had no tree.
        let mut bounds = self.known(target.window_id).and_then(|known| known.bounds);
        if self.capabilities().pixels
            && let Ok(listed) = self.list_windows().await
            && listed.iter().any(|window| window.window_id == target.window_id)
        {
            bounds = self.known(target.window_id).and_then(|known| known.bounds).or(bounds);
        }
        let image = capture::scaled(&png, edge)?;
        let geometry =
            Geometry { width: image.width, height: image.height, window: if self.capabilities().window_capture { bounds } else { None } };
        self.captures.remember(session, target.window_id, png, geometry);
        Ok(Some(image))
    }
}

/// The picture in a `screenshot` envelope. The skill says the PNG is base64
/// "in `data`", without naming a key, so the data may be the string itself or
/// an object whose longest string is the image; a `data:` prefix is dropped.
fn extract_picture(data: &Value) -> Option<Vec<u8>> {
    fn decode(text: &str) -> Option<Vec<u8>> {
        let payload = text.strip_prefix("data:image/png;base64,").or_else(|| text.strip_prefix("data:image/jpeg;base64,")).unwrap_or(text);
        let bytes = STANDARD.decode(payload.trim()).ok()?;
        let is_png = bytes.starts_with(&[0x89, b'P', b'N', b'G']);
        let is_jpeg = bytes.starts_with(&[0xFF, 0xD8]);
        (is_png || is_jpeg).then_some(bytes)
    }
    match data {
        Value::String(text) => decode(text),
        Value::Object(map) => {
            map.values().filter_map(Value::as_str).filter(|text| text.len() > 64).max_by_key(|text| text.len()).and_then(decode)
        }
        _ => None,
    }
}

/// What the tools may ask for here (design §5, "Per OS").
pub(crate) fn capabilities(os: Os, display: Display) -> Capabilities {
    match os {
        Os::Mac => Capabilities {
            menu_bar: true,
            background_pixels: false,
            pixels: true,
            background_typing: true,
            background_keys: true,
            background_scroll: true,
            window_capture: true,
            zoom: true,
        },
        Os::Windows => Capabilities {
            menu_bar: true,
            background_pixels: false,
            pixels: true,
            background_typing: false,
            background_keys: false,
            background_scroll: true,
            window_capture: true,
            zoom: true,
        },
        Os::Linux | Os::Other => Capabilities {
            menu_bar: false,
            background_pixels: false,
            pixels: display != Display::Wayland,
            background_typing: true,
            background_keys: true,
            background_scroll: false,
            window_capture: display != Display::Wayland,
            zoom: true,
        },
    }
}
