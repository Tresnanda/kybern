//! The seam between Kybern's six `kybern_computer_*` tools and the program
//! that reads and drives apps (design: `docs/design/ade-83-computer-backends.md`).
//!
//! The tools (`mod.rs`) own everything an agent sees: window ids (`w123`),
//! stable `@N` references, steps, consent, policy, the ✓ ~ ? ✗ report and the
//! diff. A backend owns everything the OS or the driver decides: how windows
//! and apps are listed, how an element is read and targeted, how an action is
//! delivered and how its effect is judged. A backend never formats text for
//! the agent and never asks the user anything.
//!
//! Two backends implement it: `CuaDriverBackend` (macOS, CuaDriver over MCP
//! stdio) and `AgentDesktopBackend` (macOS, Windows and Linux, the
//! agent-desktop CLI). Roles reach the tools already mapped to the neutral
//! vocabulary below, so the digest reads the same on every OS.

use anyhow::Result;
use async_trait::async_trait;
use kybern_protocol::methods::{ComputerCheck, ComputerPermission};

use super::Mode;
use super::digest::Snapshot;

/// Which program backs the tools on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum BackendKind {
    CuaDriver,
    AgentDesktop,
}

impl BackendKind {
    pub(crate) fn display_name(self) -> &'static str {
        match self {
            BackendKind::CuaDriver => "CuaDriver",
            BackendKind::AgentDesktop => "agent-desktop",
        }
    }
}

/// The operating system the daemon runs on, as the tools describe it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Os {
    Mac,
    Windows,
    Linux,
    Other,
}

impl Os {
    pub(crate) const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "linux") {
            Os::Linux
        } else {
            Os::Other
        }
    }

    /// "this Mac", "this PC", "this computer": the words copy uses for the
    /// machine the tools act on.
    pub(crate) const fn this_machine(self) -> &'static str {
        match self {
            Os::Mac => "this Mac",
            Os::Windows => "this PC",
            Os::Linux | Os::Other => "this computer",
        }
    }

    pub(crate) const fn name(self) -> &'static str {
        match self {
            Os::Mac => "macOS",
            Os::Windows => "Windows",
            Os::Linux => "Linux",
            Os::Other => "this OS",
        }
    }
}

/// What a backend can do here. The tools refuse a step it cannot do with a
/// clear sentence instead of sending it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Capabilities {
    /// `menu` steps: the app menu bar can be walked by path.
    pub menu_bar: bool,
    /// `click_at` in background mode (no real cursor).
    pub background_pixels: bool,
    /// `click_at` at all (Wayland has no pointer for agents).
    pub pixels: bool,
    /// `type` without the real keyboard. Where false, `type` into a field
    /// becomes `set` of the field's new value, and plain `type` needs
    /// foreground mode.
    pub background_typing: bool,
    /// `key` without bringing the window to the front.
    pub background_keys: bool,
    /// `scroll` without the real wheel.
    pub background_scroll: bool,
    /// Screenshots show the one window (false on Wayland: the whole display).
    pub window_capture: bool,
    /// `screenshot` with `region`.
    pub zoom: bool,
}

/// One top-level window. `window_id` is Kybern's number for it: the native
/// id when that is a number, otherwise a number the backend assigns and
/// keeps for the life of the daemon (Linux ids are long opaque strings).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WindowInfo {
    pub window_id: u64,
    pub pid: i64,
    pub app: String,
    pub title: String,
    /// Shown on some display (not minimized or hidden).
    pub on_screen: bool,
    /// On another Space or virtual desktop.
    pub elsewhere: bool,
    pub z_index: Option<i64>,
}

/// One app, running or installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppInfo {
    pub name: String,
    /// See [`app_id`](crate::computer) rules: bundle id on macOS, lowercase
    /// exe basename on Windows, desktop-entry id (or executable) on Linux.
    pub app_id: Option<String>,
    /// `None` when installed but not running.
    pub pid: Option<i64>,
    /// A regular app with windows, not a helper, agent or overlay.
    pub regular: bool,
}

/// A window the tools act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct Target {
    pub window_id: u64,
    pub pid: i64,
}

/// The result of `launch`.
#[derive(Debug, Clone)]
pub(crate) struct Launched {
    pub name: String,
    pub app_id: Option<String>,
    pub pid: Option<i64>,
    pub windows: Vec<WindowInfo>,
}

/// What `read` should fetch.
#[derive(Debug, Clone, Default)]
pub(crate) struct ReadOptions<'a> {
    /// Include the element tree. False for a capture-only read.
    pub tree: bool,
    /// Attach a picture with this long edge, in pixels.
    pub image_edge: Option<u32>,
    /// Narrow the walk to elements matching this text, where the backend can.
    pub query: Option<&'a str>,
}

/// One read of a window.
#[derive(Debug, Clone)]
pub(crate) struct WindowRead {
    /// Parsed elements with neutral roles. `Element::token` is the backend's
    /// handle for acting on that element (a CuaDriver element token, an
    /// agent-desktop qualified ref).
    pub snapshot: Snapshot,
    pub image: Option<Image>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Image {
    pub mime: String,
    /// Base64.
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// A rectangle in a capture's pixels: left, top, right, bottom.
pub(crate) type Region = [f64; 4];

/// One action, already checked against policy. References are resolved to
/// backend tokens by the tools; `None` means the window itself.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Act {
    Press {
        token: String,
        button: Button,
        count: u32,
    },
    /// Pixels in the latest capture of this window; `from_zoom` when that
    /// capture was a zoomed region.
    ClickAt {
        x: f64,
        y: f64,
        button: Button,
        count: u32,
        from_zoom: bool,
    },
    Type {
        text: String,
        into: Option<String>,
    },
    Set {
        token: String,
        value: String,
    },
    /// Normalized chord parts (`policy::chord`), modifiers first, already
    /// mapped for this OS: `cmd` only on macOS, `win` for the logo key.
    Key {
        keys: Vec<String>,
        on: Option<String>,
    },
    Scroll {
        direction: Direction,
        amount: u32,
        on: Option<String>,
    },
    /// Menu bar path, e.g. `["File", "Export…"]`.
    Menu {
        path: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Button {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Direction {
    Up,
    Down,
    Left,
    Right,
}

/// How a backend judged one delivered (or refused) action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Effect {
    /// The effect was observed.
    Confirmed,
    /// Delivered; the effect could not be observed.
    Unverifiable,
    /// Part of it landed, or it landed but the result differs.
    Partial,
    /// Delivered with no visible effect.
    SuspectedNoop,
    Timeout,
    /// Not delivered. `Outcome::note` says why.
    Refused,
}

/// What would get a refused or unconfirmed step through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Escalation {
    /// Retry with `mode: "foreground"` (the user approves it).
    Foreground,
    /// Use `click_at` on a screenshot.
    Pixel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Outcome {
    pub effect: Effect,
    /// The action used the real cursor or keyboard.
    pub physical: bool,
    pub escalation: Option<Escalation>,
    /// The backend's reason, one line, at most 600 characters.
    pub note: Option<String>,
    /// The target no longer matches the element read (stale token or ref).
    /// Nothing was delivered; the tools read the window again and retry once.
    pub stale: bool,
}

impl Outcome {
    pub(crate) fn of(effect: Effect) -> Self {
        Self { effect, physical: false, escalation: None, note: None, stale: false }
    }

    pub(crate) fn refused(note: impl Into<String>, escalation: Option<Escalation>) -> Self {
        Self { effect: Effect::Refused, physical: false, escalation, note: Some(note.into()), stale: false }
    }

    pub(crate) fn stale(note: impl Into<String>) -> Self {
        Self { stale: true, ..Self::refused(note, None) }
    }
}

/// Install and permission state for Settings, `computer.status` and
/// `kybern computer doctor`. The tools fill the shared fields (enabled,
/// platform) themselves.
#[derive(Debug, Clone)]
pub(crate) struct BackendStatus {
    pub installed: bool,
    /// Where the program is, e.g. `/Applications/CuaDriver.app`.
    pub path: Option<String>,
    pub version: Option<String>,
    /// The version Kybern installs.
    pub required_version: String,
    /// Signature or pinned checksum verified.
    pub verified: bool,
    pub accessibility: ComputerPermission,
    pub screen_recording: ComputerPermission,
    /// macOS: the app or binary System Settings lists for the grants.
    pub permission_holder: Option<String>,
    /// Linux: `x11` or `wayland`, plus the desktop when known (`GNOME`).
    pub session: Option<String>,
    /// Ready for agents: installed, verified, and allowed to read apps.
    pub ready: bool,
    pub checks: Vec<ComputerCheck>,
}

/// One computer-use backend. Every method is bounded: calls answer within
/// [`super::CALL_BUDGET`] or fail.
#[async_trait]
pub(crate) trait ComputerBackend: Send + Sync {
    fn kind(&self) -> BackendKind;
    fn capabilities(&self) -> Capabilities;

    /// Installed with a supported version. Cheap: no process is started.
    fn installed(&self) -> bool;
    /// Full status; may start the program to ask it about permissions.
    async fn status(&self) -> BackendStatus;
    /// Download and install the pinned release.
    async fn install(&self) -> Result<()>;
    /// Start the OS's permission flow (macOS); returns before the user answers.
    async fn grant(&self) -> Result<()>;

    /// Start whatever must run before the first call; the tools call it at
    /// most once per daemon run, again only after `release`.
    async fn warm(&self) -> Result<()>;
    /// Stop helper processes Kybern started (idle, shutdown, driver switch).
    async fn release(&self);

    /// Top-level windows, of one process or all.
    async fn windows(&self, pid: Option<i64>) -> Result<Vec<WindowInfo>>;
    /// Running and (where the OS can list them cheaply) installed apps.
    async fn apps(&self) -> Result<Vec<AppInfo>>;
    /// The app id of a running process, when it is a regular app.
    async fn app_id_of(&self, pid: i64) -> Option<String>;
    /// Find an app the list missed, by name or path (Spotlight, App Paths,
    /// desktop entries). Returns its display name and app id.
    async fn find_app(&self, requested: &str) -> Option<(String, String)>;
    /// Open an app without bringing it to the front where the OS allows.
    async fn launch(&self, app: &str, app_id: Option<&str>) -> Result<Launched>;

    /// Read a window. `session` is the tools' per-thread label.
    async fn read(&self, target: Target, options: ReadOptions<'_>, session: &str) -> Result<WindowRead>;
    /// A zoomed capture of `region` of the latest capture.
    async fn zoom(&self, target: Target, region: Region, edge: u32, session: &str) -> Result<Image>;
    /// Deliver one action. A refusal is an `Outcome`, not an error; an error
    /// means the backend failed (crashed, timed out, could not start).
    async fn act(&self, target: Target, act: &Act, mode: Mode, session: &str) -> Result<Outcome>;

    /// Why pictures are off for this daemon run (Wayland screenshot consent
    /// declined or unanswered). The live view shows it instead of frames.
    fn capture_paused(&self) -> Option<String> {
        None
    }
    /// Try pictures again; Settings → Computer use calls it on open.
    fn resume_capture(&self) {}
}

/// The neutral role vocabulary the digest shows. Raw roles from AX
/// (`AXButton`), UIA (`Button`, `Edit`) and AT-SPI (`push button`) map here;
/// an unknown role passes through lowercased with spaces and `AX` removed.
pub(crate) fn neutral_role(raw: &str) -> String {
    let key = raw.trim().strip_prefix("AX").unwrap_or(raw.trim()).to_ascii_lowercase().replace([' ', '_', '-'], "");
    let mapped = match key.as_str() {
        "button" | "pushbutton" | "togglebutton" | "splitbutton" | "colorwell" | "colorchooser" => "button",
        "checkbox" | "checkmenuitem" => "checkbox",
        "radiobutton" | "radio" | "radiomenuitem" => "radio",
        "switch" | "toggle" => "switch",
        "popupbutton" | "combobox" | "dropdown" | "listbox" => "combobox",
        "menubutton" => "menubutton",
        "textfield" | "textarea" | "searchfield" | "edit" | "entry" | "textbox" | "editbar" | "terminal" => "textfield",
        "securetextfield" | "passwordtext" | "password" => "password",
        "datefield" | "datetime" | "dateeditor" | "timefield" | "calendar" => "datefield",
        "link" | "hyperlink" => "link",
        "menuitem" | "tearoffmenuitem" => "menuitem",
        "menubaritem" => "menubaritem",
        "menubar" => "menubar",
        "menu" | "popupmenu" | "contextmenu" => "menu",
        "tab" | "tabitem" | "pagetab" | "radiotab" => "tab",
        "tabgroup" | "tablist" | "pagetablist" | "segmentedcontrol" => "tablist",
        "slider" => "slider",
        "incrementor" | "stepper" | "spinbutton" | "spinner" => "stepper",
        "disclosuretriangle" | "disclosure" | "expander" => "disclosure",
        "row" | "outlinerow" | "listitem" | "dataitem" | "treeitem" | "tablerow" => "row",
        "cell" | "tablecell" | "gridcell" => "cell",
        "list" | "listview" | "grid" => "list",
        "table" | "treetable" | "datagrid" => "table",
        "outline" | "tree" | "treeview" => "tree",
        "window" | "frame" => "window",
        "sheet" => "sheet",
        "dialog" | "filechooser" => "dialog",
        "alert" => "alert",
        "popover" | "tooltip" => "popover",
        "toolbar" => "toolbar",
        "statusbar" => "statusbar",
        "scrollarea" | "scrollpane" | "scrollview" | "viewport" => "scrollarea",
        "scrollbar" => "scrollbar",
        "webarea" | "documentweb" | "document" | "documentframe" | "htmlcontainer" => "webarea",
        "statictext" | "text" | "label" | "caption" | "textleaf" | "paragraph" | "section" => "text",
        "heading" | "header" => "heading",
        "image" | "icon" | "graphic" => "image",
        "progressindicator" | "progressbar" | "levelindicator" | "valueindicator" | "busyindicator" => "progress",
        "group" | "panel" | "pane" | "filler" | "splitgroup" | "layoutarea" | "custom" | "unknown" => "group",
        "application" => "application",
        _ => return key,
    };
    mapped.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_from_every_platform_share_one_vocabulary() {
        for (raw, neutral) in [
            ("AXButton", "button"),
            ("Button", "button"),
            ("push button", "button"),
            ("AXTextField", "textfield"),
            ("Edit", "textfield"),
            ("entry", "textfield"),
            ("AXSecureTextField", "password"),
            ("password text", "password"),
            ("AXPopUpButton", "combobox"),
            ("ComboBox", "combobox"),
            ("AXMenuItem", "menuitem"),
            ("MenuItem", "menuitem"),
            ("menu item", "menuitem"),
            ("AXOutlineRow", "row"),
            ("TreeItem", "row"),
            ("list item", "row"),
            ("AXStaticText", "text"),
            ("Text", "text"),
            ("label", "text"),
            ("AXDisclosureTriangle", "disclosure"),
            ("AXCheckBox", "checkbox"),
            ("check box", "checkbox"),
            ("AXRadioButton", "radio"),
            ("TabItem", "tab"),
            ("page tab", "tab"),
            ("Hyperlink", "link"),
            ("AXWebArea", "webarea"),
            ("AXSomethingNew", "somethingnew"),
        ] {
            assert_eq!(neutral_role(raw), neutral, "{raw}");
        }
    }

    #[test]
    fn copy_names_the_machine() {
        assert_eq!(Os::Mac.this_machine(), "this Mac");
        assert_eq!(Os::Windows.this_machine(), "this PC");
        assert_eq!(Os::Linux.this_machine(), "this computer");
    }
}
