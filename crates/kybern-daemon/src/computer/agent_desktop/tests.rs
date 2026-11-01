//! The backend end to end against a fake `agent-desktop`: a shell script that
//! answers each command from a recorded envelope in its own directory and logs
//! the command lines it received. Unix only (the script is `sh`); the
//! envelopes are the real ones in `fixtures/`.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use super::super::Mode;
use super::super::backend::{Act, Button, ComputerBackend, Direction, Effect, Escalation, Os, ReadOptions, Target};
use super::{AgentDesktopBackend, Display};

const FAKE: &str = r#"#!/bin/sh
dir="$(cd "$(dirname "$0")" && pwd)"
echo "$*" >> "$dir/calls.log"
cmd="$1"
n=0
[ -f "$dir/$cmd.count" ] && n=$(cat "$dir/$cmd.count")
n=$((n+1))
echo "$n" > "$dir/$cmd.count"
if [ -f "$dir/$cmd.$n.json" ]; then cat "$dir/$cmd.$n.json"; exit 0; fi
if [ -f "$dir/$cmd.json" ]; then cat "$dir/$cmd.json"; exit 0; fi
printf '{"ok":false,"error":{"code":"INTERNAL","message":"no recording for %s","disposition":{"delivery":"not_delivered","retry":"safe"}}}' "$cmd"
exit 1
"#;

const OK: &str = r#"{"ok":true,"data":{}}"#;

struct Fake {
    dir: PathBuf,
    backend: AgentDesktopBackend,
}

impl Fake {
    fn new(os: Os, display: Display, recordings: &[(&str, &str)]) -> Self {
        let dir = std::env::temp_dir().join(format!("kybern-ad-fake-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let script = dir.join("bin").join("agent-desktop");
        std::fs::write(&script, FAKE).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        for (name, content) in recordings {
            std::fs::write(dir.join("bin").join(format!("{name}.json")), content).unwrap();
        }
        let backend = AgentDesktopBackend::with(&dir.join("data"), Some(script), os, display);
        Self { dir, backend }
    }

    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.join("bin").join("calls.log"))
            .map(|log| log.lines().map(str::to_owned).collect())
            .unwrap_or_default()
    }

    fn commands(&self) -> Vec<String> {
        self.calls().iter().map(|call| call.split(' ').next().unwrap_or("").to_owned()).collect()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const WIN_WINDOWS: &str = include_str!("fixtures/windows/calcwin.json");
const WIN_SNAPSHOT: &str = include_str!("fixtures/windows/snapfull.json");
const CALC: Target = Target { window_id: 4590050, pid: 10984 };

fn png_envelope(width: u32, height: u32) -> String {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(width, height, image::Rgb([20, 120, 220])))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    format!(r#"{{"ok":true,"data":{{"format":"png","base64":"{}"}}}}"#, STANDARD.encode(bytes.into_inner()))
}

#[tokio::test]
async fn windows_are_listed_with_their_native_ids_and_state() {
    let fake = Fake::new(Os::Windows, Display::None, &[("list-windows", WIN_WINDOWS)]);
    let windows = fake.backend.windows(None).await.unwrap();
    assert_eq!(windows.len(), 1);
    let window = &windows[0];
    assert_eq!(
        (window.window_id, window.pid, window.app.as_str(), window.title.as_str()),
        (4590050, 10984, "CalculatorApp.exe", "Calculator")
    );
    assert!(window.on_screen && !window.elsewhere);
    assert!(fake.backend.windows(Some(1)).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_windows_read_returns_controls_text_and_the_call_line_is_exact() {
    let fake = Fake::new(Os::Windows, Display::None, &[("list-windows", WIN_WINDOWS), ("snapshot", WIN_SNAPSHOT)]);
    fake.backend.windows(None).await.unwrap();
    let read = fake.backend.read(CALC, ReadOptions { tree: true, image_edge: None, query: None }, "thread-1").await.unwrap();
    assert!(read.image.is_none());
    assert!(read.snapshot.elements.iter().any(|(_, element)| element.label == "Plus" && element.token.is_some()));
    assert!(read.snapshot.texts.iter().any(|(_, element)| element.label == "Display is 0"));
    assert_eq!(
        fake.calls().last().unwrap(),
        "snapshot --window-id w-4590050 --compact --include-bounds --session kybern-thread-1 --timeout-ms 4000"
    );
}

#[tokio::test]
async fn a_failed_picture_does_not_fail_a_read_that_has_a_tree() {
    let shot = include_str!("fixtures/linux/shot.json");
    let fake = Fake::new(Os::Linux, Display::Wayland, &[("snapshot", include_str!("fixtures/linux/snapfull.json")), ("screenshot", shot)]);
    let read = fake.backend.read(CALC, ReadOptions { tree: true, image_edge: Some(800), query: None }, "t").await.unwrap();
    assert!(read.image.is_none());
    assert!(read.snapshot.degraded.as_deref().unwrap().starts_with("No screenshot: PERM_DENIED:"));
    assert!(!read.snapshot.elements.is_empty());
    assert!(fake.backend.capture_paused().is_some());
}

#[tokio::test]
async fn a_failed_read_carries_the_code_and_message() {
    let denied = include_str!("fixtures/macos/error_perm_denied.json");
    let fake = Fake::new(Os::Mac, Display::None, &[("list-windows", WIN_WINDOWS), ("snapshot", denied)]);
    fake.backend.windows(None).await.unwrap();
    let error = fake.backend.read(CALC, ReadOptions { tree: true, ..ReadOptions::default() }, "t").await.err().unwrap();
    assert_eq!(error.to_string(), "PERM_DENIED: Accessibility permission not granted");
}

#[tokio::test]
async fn a_background_press_is_headless_and_a_foreground_press_is_headed() {
    let click = include_str!("fixtures/linux/click7.json");
    let fake = Fake::new(Os::Windows, Display::None, &[("click", click)]);
    let press = Act::Press { token: "@s1:e3".into(), button: Button::Left, count: 1 };
    let outcome = fake.backend.act(CALC, &press, Mode::Background, "t").await.unwrap();
    assert_eq!((outcome.effect, outcome.physical), (Effect::Unverifiable, false));
    let outcome = fake.backend.act(CALC, &press, Mode::Foreground, "t").await.unwrap();
    assert!(outcome.physical);
    assert_eq!(
        fake.calls(),
        ["click --session kybern-t --timeout-ms 8000 -- @s1:e3", "click --session kybern-t --headed --timeout-ms 8000 -- @s1:e3"]
    );
    // Double clicks are physical: refused in the background without sending anything.
    let double = Act::Press { token: "@s1:e3".into(), button: Button::Left, count: 2 };
    let refused = fake.backend.act(CALC, &double, Mode::Background, "t").await.unwrap();
    assert_eq!((refused.effect, refused.escalation), (Effect::Refused, Some(Escalation::Foreground)));
    assert_eq!(fake.calls().len(), 2);
}

#[tokio::test]
async fn windows_keys_wait_for_the_foreground() {
    let fake = Fake::new(
        Os::Windows,
        Display::None,
        &[("focus-window", OK), ("press", r#"{"ok":true,"data":{"disposition":{"delivery":"delivered_unverified","retry":"unsafe"}}}"#)],
    );
    let keys = Act::Key { keys: vec!["ctrl".into(), "c".into()], on: None };
    let refused = fake.backend.act(CALC, &keys, Mode::Background, "t").await.unwrap();
    assert_eq!((refused.effect, refused.escalation), (Effect::Refused, Some(Escalation::Foreground)));
    assert!(fake.calls().is_empty(), "nothing is sent for a refused key");
    let sent = fake.backend.act(CALC, &keys, Mode::Foreground, "t").await.unwrap();
    assert_eq!((sent.effect, sent.physical), (Effect::Unverifiable, true));
    // The window comes forward, then the key goes to the foreground (a scoped press is APP_NOT_FOUND on Windows).
    assert_eq!(
        fake.calls(),
        ["focus-window --window-id w-4590050 --session kybern-t --headed", "press --session kybern-t --headed -- ctrl+c"]
    );
}

#[tokio::test]
async fn windows_typing_into_a_field_sets_the_old_text_plus_the_new() {
    let fake = Fake::new(
        Os::Windows,
        Display::None,
        &[("get", r#"{"ok":true,"data":{"value":"12*34"}}"#), ("set-value", include_str!("fixtures/linux/setvalue.json"))],
    );
    let outcome =
        fake.backend.act(CALC, &Act::Type { text: "+1".into(), into: Some("@s1:e2".into()) }, Mode::Background, "t").await.unwrap();
    assert_eq!(outcome.effect, Effect::Confirmed);
    assert_eq!(outcome.note.as_deref(), Some("set the field (typing needs foreground on Windows)"));
    assert!(!outcome.physical);
    assert_eq!(fake.calls().last().unwrap(), "set-value --session kybern-t --timeout-ms 8000 -- @s1:e2 12*34+1");
    // Plain typing with no field is a foreground matter.
    let plain = fake.backend.act(CALC, &Act::Type { text: "x".into(), into: None }, Mode::Background, "t").await.unwrap();
    assert_eq!((plain.effect, plain.escalation), (Effect::Refused, Some(Escalation::Foreground)));
}

#[tokio::test]
async fn gnome_typing_is_headless_and_read_back() {
    let fake = Fake::new(Os::Linux, Display::Wayland, &[("type", include_str!("fixtures/linux/type.json"))]);
    let outcome =
        fake.backend.act(CALC, &Act::Type { text: "+1".into(), into: Some("@s1:e2".into()) }, Mode::Background, "t").await.unwrap();
    assert_eq!(outcome.effect, Effect::Confirmed);
    assert_eq!(fake.calls(), ["type --session kybern-t --timeout-ms 5060 -- @s1:e2 +1"]);
}

#[tokio::test]
async fn a_linux_key_to_an_unfocused_window_asks_for_the_foreground_not_a_retry() {
    let fake = Fake::new(Os::Linux, Display::Wayland, &[("press", include_str!("fixtures/linux/press8.json"))]);
    let keys = Act::Key { keys: vec!["8".into()], on: None };
    let outcome = fake.backend.act(Target { window_id: 7, pid: 1 }, &keys, Mode::Background, "t").await.unwrap();
    assert!(!outcome.stale);
    assert_eq!((outcome.effect, outcome.escalation), (Effect::Refused, Some(Escalation::Foreground)));
    assert_eq!(fake.calls(), ["press --window-id w-7 --session kybern-t -- 8"]);
}

#[tokio::test]
async fn linux_scroll_and_menu_are_refused_with_the_right_words() {
    let wayland = Fake::new(Os::Linux, Display::Wayland, &[]);
    let scroll = Act::Scroll { direction: Direction::Down, amount: 3, on: Some("@s1:e1".into()) };
    let refused = wayland.backend.act(CALC, &scroll, Mode::Foreground, "t").await.unwrap();
    assert_eq!((refused.effect, refused.escalation), (Effect::Refused, None));
    assert!(refused.note.unwrap().contains("Wayland"));
    let x11 = Fake::new(Os::Linux, Display::X11, &[]);
    let refused = x11.backend.act(CALC, &scroll, Mode::Background, "t").await.unwrap();
    assert_eq!(refused.escalation, Some(Escalation::Foreground));
    let menu = x11.backend.act(CALC, &Act::Menu { path: vec!["File".into()] }, Mode::Background, "t").await.unwrap();
    assert_eq!(menu.note.as_deref(), Some("Menu steps are not available on Linux. Press the menu's items instead: observe lists them."));
    assert!(wayland.calls().is_empty() && x11.calls().is_empty());
}

#[tokio::test]
async fn a_scroll_on_x11_is_headed_and_names_the_direction() {
    let fake = Fake::new(
        Os::Linux,
        Display::X11,
        &[("scroll", r#"{"ok":true,"data":{"disposition":{"delivery":"delivered_unverified","retry":"unsafe"}}}"#)],
    );
    let scroll = Act::Scroll { direction: Direction::Up, amount: 2, on: Some("@s1:e9".into()) };
    let outcome = fake.backend.act(CALC, &scroll, Mode::Foreground, "t").await.unwrap();
    assert_eq!((outcome.effect, outcome.physical), (Effect::Unverifiable, true));
    assert_eq!(fake.calls(), ["scroll --direction up --amount 2 --session kybern-t --headed --timeout-ms 8000 -- @s1:e9"]);
}

#[tokio::test]
async fn the_menu_walk_goes_menubar_item_then_menu_item() {
    let found = r#"{"ok":true,"data":{"match":{"ref_id":"@s2:e5","role":"menuitem","name":"File"},"snapshot_id":"s2"}}"#;
    let clicked = r#"{"ok":true,"data":{"disposition":{"delivery":"delivered_unverified","retry":"unsafe"}}}"#;
    let fake = Fake::new(Os::Mac, Display::None, &[("list-windows", WIN_WINDOWS), ("find", found), ("click", clicked), ("wait", OK)]);
    fake.backend.windows(None).await.unwrap();
    let menu = Act::Menu { path: vec!["File".into(), "Export…".into()] };
    let outcome = fake.backend.act(CALC, &menu, Mode::Background, "t").await.unwrap();
    assert_eq!(outcome.effect, Effect::Unverifiable);
    assert_eq!(fake.commands(), ["list-windows", "find", "click", "wait", "find", "click"]);
    let calls = fake.calls();
    assert!(calls[1].starts_with("find --app CalculatorApp.exe --surface menubar --name File --exact --first"), "{}", calls[1]);
    assert!(calls[4].contains("--surface menu --name Export… --exact --first"), "{}", calls[4]);
}

#[tokio::test]
async fn a_windows_app_without_a_menu_bar_says_so() {
    let missing = r#"{"ok":false,"error":{"code":"ELEMENT_NOT_FOUND","message":"nothing matched","disposition":{"delivery":"not_delivered","retry":"safe"}}}"#;
    let fake = Fake::new(Os::Windows, Display::None, &[("find", missing)]);
    let outcome = fake.backend.act(CALC, &Act::Menu { path: vec!["File".into()] }, Mode::Background, "t").await.unwrap();
    assert_eq!(
        (outcome.effect, outcome.note.as_deref()),
        (Effect::Refused, Some("This app has no menu bar. Press its menu button instead."))
    );
}

#[tokio::test]
async fn a_stale_ref_is_reported_as_stale_before_delivery() {
    let stale = r#"{"ok":false,"error":{"code":"STALE_REF","message":"gone","disposition":{"delivery":"not_delivered","retry":"safe"}}}"#;
    let fake = Fake::new(Os::Mac, Display::None, &[("click", stale)]);
    let outcome = fake
        .backend
        .act(CALC, &Act::Press { token: "@old:e1".into(), button: Button::Left, count: 1 }, Mode::Background, "t")
        .await
        .unwrap();
    assert!(outcome.stale);
}

#[tokio::test]
async fn a_picture_is_scaled_and_click_at_maps_it_to_the_screen() {
    // Window at (1048, 89), 500 x 914 points; a retina picture of 1000 x 1828 pixels.
    let fake = Fake::new(
        Os::Windows,
        Display::None,
        &[("list-windows", WIN_WINDOWS), ("screenshot", &png_envelope(1000, 1828)), ("focus-window", OK), ("mouse-click", OK)],
    );
    fake.backend.windows(None).await.unwrap();
    let read = fake.backend.read(CALC, ReadOptions { tree: false, image_edge: Some(1000), query: None }, "t").await.unwrap();
    let image = read.image.unwrap();
    assert_eq!((image.width, image.height), (547, 1000), "fitted inside the requested edge");
    // The agent clicks the middle of the picture it saw.
    let click = Act::ClickAt { x: 273.5, y: 500.0, button: Button::Left, count: 1, from_zoom: false };
    let background = fake.backend.act(CALC, &click, Mode::Background, "t").await.unwrap();
    assert_eq!((background.effect, background.escalation), (Effect::Refused, Some(Escalation::Foreground)));
    let outcome = fake.backend.act(CALC, &click, Mode::Foreground, "t").await.unwrap();
    assert!(outcome.physical);
    let calls = fake.calls();
    assert!(calls.iter().any(|call| call == "mouse-click --xy=1298,546 --button left --count 1 --session kybern-t --headed"), "{calls:?}");
    assert!(calls.iter().any(|call| call.starts_with("screenshot --window-id w-4590050")), "{calls:?}");
}

#[tokio::test]
async fn zoom_crops_the_latest_capture_and_click_at_maps_it_back() {
    let fake = Fake::new(
        Os::Windows,
        Display::None,
        &[("list-windows", WIN_WINDOWS), ("screenshot", &png_envelope(1000, 1828)), ("focus-window", OK), ("mouse-click", OK)],
    );
    fake.backend.windows(None).await.unwrap();
    // No capture yet: zoom takes one (long edge 1280) and crops it.
    let zoomed = fake.backend.zoom(CALC, [0.0, 0.0, 320.0, 585.0], 400, "t").await.unwrap();
    assert!(zoomed.width.max(zoomed.height) <= 400);
    // The centre of the zoom is the centre of the region: (160, 292.5) of a 700 x 1280 picture.
    let center =
        Act::ClickAt { x: zoomed.width as f64 / 2.0, y: zoomed.height as f64 / 2.0, button: Button::Left, count: 1, from_zoom: true };
    fake.backend.act(CALC, &center, Mode::Foreground, "t").await.unwrap();
    let click = fake.calls().into_iter().find(|call| call.starts_with("mouse-click")).unwrap();
    // 160 / 700 of 500 points and 292.5 / 1280 of 914 points, from the window origin.
    let (x, y): (f64, f64) = (1048.0 + 160.0 * 500.0 / 700.0, 89.0 + 292.5 * 914.0 / 1280.0);
    assert!(click.contains(&format!("--xy={},{}", x.round() as i64, y.round() as i64)), "{click} vs {x},{y}");
}

#[tokio::test]
async fn a_wayland_capture_failure_pauses_pictures_until_resumed() {
    let fake =
        Fake::new(Os::Linux, Display::Wayland, &[("list-windows", WIN_WINDOWS), ("screenshot", include_str!("fixtures/linux/shot.json"))]);
    fake.backend.windows(None).await.unwrap();
    assert!(!fake.backend.capabilities().window_capture && !fake.backend.capabilities().pixels);
    let options = || ReadOptions { tree: false, image_edge: Some(800), query: None };
    let first = fake.backend.read(CALC, options(), "t").await.err().unwrap();
    assert!(first.to_string().starts_with("PERM_DENIED: The desktop portal ended the screenshot request"), "{first}");
    let reason = fake.backend.capture_paused().unwrap();
    assert!(reason.contains("PERM_DENIED"), "{reason}");
    // While paused no picture is requested and the read still answers.
    let paused = fake.backend.read(CALC, options(), "t").await.unwrap();
    assert!(paused.image.is_none());
    assert_eq!(fake.commands().iter().filter(|command| command.as_str() == "screenshot").count(), 1);
    // The display is captured whole: no window id.
    assert!(fake.calls().iter().any(|call| call == "screenshot --session kybern-t"));
    // After resume the next capture tries once.
    fake.backend.resume_capture();
    assert!(fake.backend.capture_paused().is_none());
    let _ = fake.backend.read(CALC, options(), "t").await;
    assert_eq!(fake.commands().iter().filter(|command| command.as_str() == "screenshot").count(), 2);
    // A status refresh (Settings opened) also clears a pause.
    assert!(fake.backend.capture_paused().is_some());
    let _ = fake.backend.status().await;
    assert!(fake.backend.capture_paused().is_none());
}

#[tokio::test]
async fn launching_finds_the_new_window_even_when_it_belongs_to_another_process() {
    // calc.exe (pid 23820) hands off to CalculatorApp.exe (pid 10984).
    let fake = Fake::new(
        Os::Windows,
        Display::None,
        &[
            ("list-windows.1", r#"{"ok":true,"data":[]}"#),
            ("list-windows", WIN_WINDOWS),
            ("launch", include_str!("fixtures/windows/launch.json")),
        ],
    );
    // `list-windows.1` is the first answer (nothing open yet), `list-windows` every later one.
    let launched = fake.backend.launch("Calculator", Some("calc.exe")).await.unwrap();
    assert_eq!(launched.name, "calc.exe");
    assert_eq!(launched.app_id.as_deref(), Some("calc.exe"));
    assert_eq!(launched.pid, Some(10984));
    assert_eq!(launched.windows.len(), 1);
    assert_eq!(launched.windows[0].app, "CalculatorApp.exe");
    assert!(fake.calls().iter().any(|call| call == "launch --timeout 15000 -- calc.exe"), "{:?}", fake.calls());
}

#[tokio::test]
async fn a_macos_launch_finds_its_window_through_the_listing() {
    // The launch answer carries a window of zero size that is not yet visible; the listing has the real one.
    let fake = Fake::new(
        Os::Mac,
        Display::None,
        &[
            ("list-windows.1", r#"{"ok":true,"data":[]}"#),
            ("list-windows", include_str!("fixtures/macos/list_windows_calculator.json")),
            ("launch", include_str!("fixtures/macos/launch_calculator.json")),
        ],
    );
    let launched = fake.backend.launch("Calculator", Some("com.apple.calculator")).await.unwrap();
    assert_eq!(
        (launched.name.as_str(), launched.app_id.as_deref(), launched.pid),
        ("Calculator", Some("com.apple.calculator"), Some(7737))
    );
    assert_eq!(launched.windows.len(), 1);
    assert_eq!(launched.windows[0].window_id, 37219);
    assert!(launched.windows[0].on_screen);
    assert!(fake.calls().iter().any(|call| call == "launch --timeout 15000 -- com.apple.calculator"));
}

#[tokio::test]
async fn apps_carry_app_ids_and_find_the_ones_list_apps_misses() {
    let mac = Fake::new(
        Os::Mac,
        Display::None,
        &[("list-apps", include_str!("fixtures/macos/list_apps.json")), ("list-windows", r#"{"ok":true,"data":[]}"#)],
    );
    let apps = mac.backend.apps().await.unwrap();
    let finder = apps.iter().find(|app| app.name == "Finder").unwrap();
    assert_eq!((finder.app_id.as_deref(), finder.regular), (Some("com.apple.finder"), true));
    let dock = apps.iter().find(|app| app.name == "Dock").unwrap();
    assert!(!dock.regular);
    let helper = apps.iter().find(|app| app.name == "ChromeRemoteDesktopHost").unwrap();
    assert_eq!((helper.app_id.clone(), helper.regular), (None, false));
    assert_eq!(mac.backend.app_id_of(103).await.as_deref(), Some("com.apple.finder"));

    let windows =
        Fake::new(Os::Windows, Display::None, &[("list-apps", include_str!("fixtures/windows/apps.json")), ("list-windows", WIN_WINDOWS)]);
    let apps = windows.backend.apps().await.unwrap();
    let terminal = apps.iter().find(|app| app.name == "WindowsTerminal.exe").unwrap();
    assert_eq!((terminal.app_id.as_deref(), terminal.regular), (Some("windowsterminal.exe"), true));
    // list-apps does not list the hosted Calculator; its window does.
    let calc = apps.iter().find(|app| app.name == "CalculatorApp.exe").unwrap();
    assert_eq!((calc.app_id.as_deref(), calc.pid), (Some("calculatorapp.exe"), Some(10984)));
}

#[tokio::test]
async fn status_reads_permissions_in_one_call() {
    let fake = Fake::new(Os::Windows, Display::None, &[("status", include_str!("fixtures/windows/status.json"))]);
    let status = fake.backend.status().await;
    assert!(status.installed && !status.verified);
    assert_eq!(status.version.as_deref(), Some("1.0.2"));
    assert_eq!(status.accessibility, kybern_protocol::methods::ComputerPermission::Granted);
    assert!(status.ready, "an override is allowed to run");
    let verified = status.checks.iter().find(|check| check.name == "verified").unwrap();
    assert!(!verified.ok && verified.message.starts_with("unverified (override)"), "{}", verified.message);
    assert!(status.checks.iter().any(|check| check.name == "session"));
    assert_eq!(fake.commands(), ["status"]);

    let mac = Fake::new(Os::Mac, Display::None, &[("status", include_str!("fixtures/macos/status_denied.json"))]);
    let status = mac.backend.status().await;
    assert!(!status.ready);
    assert_eq!(status.accessibility, kybern_protocol::methods::ComputerPermission::Missing);
    assert!(status.permission_holder.is_some());
    assert!(status.checks.iter().any(|check| check.name == "accessibility" && !check.ok));
}

#[tokio::test]
async fn a_missing_install_says_so_without_running_anything() {
    let dir = std::env::temp_dir().join(format!("kybern-ad-none-{}", uuid::Uuid::new_v4().simple()));
    let backend = AgentDesktopBackend::with(&dir, None, Os::current(), Display::None);
    assert!(!backend.installed());
    let status = backend.status().await;
    assert!(!status.installed && !status.ready);
    assert_eq!(status.checks[0].name, "installed");
    assert!(backend.windows(None).await.is_err());
    assert!(backend.warm().await.is_err());
}

#[test]
fn capabilities_follow_the_per_os_table() {
    let mac = super::capabilities(Os::Mac, Display::None);
    assert!(mac.menu_bar && mac.pixels && !mac.background_keys && mac.background_typing && !mac.background_pixels);
    let windows = super::capabilities(Os::Windows, Display::None);
    assert!(windows.menu_bar && windows.pixels && !windows.background_typing && !windows.background_keys && windows.background_scroll);
    let x11 = super::capabilities(Os::Linux, Display::X11);
    assert!(!x11.menu_bar && x11.pixels && x11.window_capture && !x11.background_scroll && x11.background_typing);
    let wayland = super::capabilities(Os::Linux, Display::Wayland);
    assert!(!wayland.pixels && !wayland.window_capture && wayland.zoom && wayland.background_keys);
}
