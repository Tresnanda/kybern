//! Live round trip with a real Calculator, through the backend trait only.
//!
//! ```sh
//! cargo test -p kybern-daemon computer::agent_desktop::live -- --ignored --nocapture
//! ```
//!
//! macOS drives Calculator, Windows `calc.exe`, Linux `gnome-calculator`. The
//! pinned agent-desktop is installed into a scratch data directory first
//! (set `KYBERN_AGENT_DESKTOP_BIN` to use a build you already have). The test
//! skips with a message when permissions are missing, so it never prompts.

use std::time::Duration;

use kybern_protocol::methods::ComputerPermission;

use super::super::Mode;
use super::super::backend::{Act, Button, ComputerBackend, Os, ReadOptions, Target};
use super::AgentDesktopBackend;
use super::runner::Cmd;

/// Button names per platform: the first match wins.
const SEVEN: &[&str] = &["7", "seven"];
const PLUS: &[&str] = &["+", "add", "plus"];
const FIVE: &[&str] = &["5", "five"];
const EQUALS: &[&str] = &["=", "equals"];

fn launch_target() -> (&'static str, Option<&'static str>) {
    match Os::current() {
        Os::Mac => ("Calculator", Some("com.apple.calculator")),
        Os::Windows => ("Calculator", Some("calc.exe")),
        Os::Linux | Os::Other => ("Calculator", Some("gnome-calculator")),
    }
}

fn find_button(snapshot: &super::super::digest::Snapshot, names: &[&str]) -> Option<String> {
    snapshot.elements.iter().find_map(|(_, element)| {
        let label = element.label.to_lowercase();
        (element.role == "button" && names.contains(&label.as_str())).then(|| element.token.clone()).flatten()
    })
}

#[tokio::test]
#[ignore = "drives a real Calculator; needs agent-desktop permissions"]
async fn calculator_round_trip() {
    let data_dir = std::env::temp_dir().join(format!("kybern-ad-live-{}", uuid::Uuid::new_v4().simple()));
    let backend = AgentDesktopBackend::new(&data_dir);
    if !backend.installed() {
        match backend.install().await {
            Ok(()) => {}
            Err(error) => {
                println!("SKIP: agent-desktop could not be installed here: {error:#}");
                let _ = std::fs::remove_dir_all(&data_dir);
                return;
            }
        }
    }
    let status = backend.status().await;
    println!(
        "status: ready={} version={:?} verified={} holder={:?} session={:?}",
        status.ready, status.version, status.verified, status.permission_holder, status.session
    );
    for check in &status.checks {
        println!("  [{}] {}: {}", if check.ok { "ok" } else { "!!" }, check.name, check.message);
    }
    if status.accessibility != ComputerPermission::Granted || !status.ready {
        println!(
            "SKIP: agent-desktop is not ready here (accessibility {:?}). Grant it as the doctor lines above say, then run this test again.",
            status.accessibility
        );
        let _ = std::fs::remove_dir_all(&data_dir);
        return;
    }

    let (name, app_id) = launch_target();
    let launched = backend.launch(name, app_id).await.expect("launch Calculator");
    println!("launched {} pid {:?} with {} window(s)", launched.name, launched.pid, launched.windows.len());
    let window = launched.windows.first().expect("Calculator opened a window");
    let target = Target { window_id: window.window_id, pid: window.pid };
    tokio::time::sleep(Duration::from_millis(800)).await;

    let read = backend.read(target, ReadOptions { tree: true, image_edge: None, query: None }, "live").await.expect("read Calculator");
    println!("read {} controls, {} text rows", read.snapshot.elements.len(), read.snapshot.texts.len());
    for names in [SEVEN, PLUS, FIVE, EQUALS] {
        let snapshot = backend
            .read(target, ReadOptions { tree: true, image_edge: None, query: None }, "live")
            .await
            .expect("read before a press")
            .snapshot;
        let token = find_button(&snapshot, names).unwrap_or_else(|| panic!("no button named any of {names:?}"));
        let outcome =
            backend.act(target, &Act::Press { token, button: Button::Left, count: 1 }, Mode::Background, "live").await.expect("press");
        println!("press {:?} -> {:?} ({:?})", names[0], outcome.effect, outcome.note);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let result =
        backend.read(target, ReadOptions { tree: true, image_edge: Some(800), query: None }, "live").await.expect("read the result");
    println!("texts: {:?}", result.snapshot.texts.iter().map(|(_, element)| (&element.label, &element.value)).collect::<Vec<_>>());
    assert!(result.snapshot.contains_label("12"), "7 + 5 should show 12");
    match result.image {
        Some(image) => println!("screenshot {}x{} {}", image.width, image.height, image.mime),
        None => println!("no screenshot: {:?}", backend.capture_paused()),
    }

    let _ = backend.run(Cmd::new("close-app").positional(launched.name.clone())).await;
    backend.release().await;
    let _ = std::fs::remove_dir_all(&data_dir);
}
