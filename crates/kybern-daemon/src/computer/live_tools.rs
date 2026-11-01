//! Live round trip through the six tools with the agent-desktop driver, on
//! macOS, Windows and Linux. Run it in the desktop session of the user:
//!
//! ```sh
//! cargo test -p kybern-daemon computer::live_tools -- --ignored --nocapture
//! ```
//!
//! It drives the OS calculator only (macOS Calculator, Windows Calculator,
//! GNOME Calculator), installs the pinned agent-desktop into a scratch data
//! directory (or uses `KYBERN_AGENT_DESKTOP_BIN`), and skips with the doctor's
//! lines when the driver is not ready, so it never prompts.

use std::time::Instant;

use futures::future::BoxFuture;
use serde_json::{Value, json};

use super::backend::Os;
use super::{CallContext, ComputerUse, ConsentAnswer, ConsentGate, ConsentRequest, content_blocks};
use crate::settings::SettingsStore;

struct AllowAll;

impl ConsentGate for AllowAll {
    fn ask(&self, _request: ConsentRequest) -> BoxFuture<'_, anyhow::Result<ConsentAnswer>> {
        Box::pin(async { Ok(ConsentAnswer::Turn) })
    }

    fn cancelled(&self) -> BoxFuture<'_, bool> {
        Box::pin(async { false })
    }
}

fn text(value: &Value) -> String {
    content_blocks(value).iter().filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n")
}

/// `@12` for the first listed control whose quoted label is one of `labels`.
fn reference(observed: &str, labels: &[&str]) -> Option<String> {
    observed.lines().find_map(|line| {
        let line = line.trim();
        let (reference, rest) = line.split_once(' ')?;
        if !reference.starts_with('@') || !rest.starts_with("button ") {
            return None;
        }
        let label = rest.split('"').nth(1)?;
        labels.iter().any(|wanted| wanted.eq_ignore_ascii_case(label)).then(|| reference.to_owned())
    })
}

#[tokio::test]
#[ignore = "drives the real calculator through agent-desktop"]
async fn calculator_through_the_tools() {
    let root = std::env::temp_dir().join(format!("kybern-computer-tools-live-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&root).unwrap();
    let settings = SettingsStore::load(&root.join("settings.json")).unwrap();
    let mut current = settings.get();
    current.computer_use.enabled = true;
    current.computer_use.driver = Some(kybern_protocol::ComputerDriver::AgentDesktop);
    settings.set(current).unwrap();
    let computer = ComputerUse::new(settings);

    let mut status = super::status(&computer).await;
    if !status.installed {
        let started = Instant::now();
        match super::setup(&computer, kybern_protocol::methods::ComputerSetupAction::Install).await {
            Ok(next) => status = next,
            Err(error) => {
                println!("SKIP: agent-desktop could not be installed: {error:#}");
                let _ = std::fs::remove_dir_all(&root);
                return;
            }
        }
        println!("install: {} ms", started.elapsed().as_millis());
    }
    println!(
        "status: driver={:?} platform={:?} ready={} version={:?} session={:?}",
        status.driver, status.platform, status.ready, status.version, status.session
    );
    for check in &status.checks {
        println!("  [{}] {}: {}", if check.ok { "ok" } else { "!!" }, check.name, check.message);
    }
    if !status.ready {
        println!("SKIP: agent-desktop is not ready here; fix the checks above and run again.");
        let _ = std::fs::remove_dir_all(&root);
        return;
    }

    let gate = AllowAll;
    let thread_id = uuid::Uuid::now_v7();
    let ctx = || CallContext {
        thread_id,
        permission_mode: kybern_protocol::PermissionMode::Supervised,
        session_instance_id: uuid::Uuid::nil(),
        turn_id: uuid::Uuid::nil(),
        consent: &gate,
        ready_elsewhere: Vec::new(),
    };
    let timed = |label: &str, started: Instant| println!("{label}: {} ms", started.elapsed().as_millis());

    let app = match Os::current() {
        Os::Mac => "Calculator",
        Os::Windows => "calc",
        Os::Linux | Os::Other => "gnome-calculator",
    };
    let started = Instant::now();
    let launched = text(&computer.execute(ctx(), "kybern_computer_apps", json!({ "launch": app })).await.unwrap());
    timed("launch", started);
    println!("{launched}");
    let window = launched.lines().find_map(|line| {
        line.split_whitespace().next().filter(|word| word.starts_with('w') && word[1..].parse::<u64>().is_ok()).map(str::to_owned)
    });
    let window = match window {
        Some(window) => window,
        None => {
            // The window can appear a moment after the launch returns.
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let listed = text(&computer.execute(ctx(), "kybern_computer_apps", json!({ "query": "calc" })).await.unwrap());
            println!("{listed}");
            listed
                .lines()
                .find_map(|line| {
                    line.split_whitespace()
                        .next()
                        .filter(|word| word.starts_with('w') && word[1..].parse::<u64>().is_ok())
                        .map(str::to_owned)
                })
                .expect("a calculator window")
        }
    };

    let started = Instant::now();
    let observed = text(&computer.execute(ctx(), "kybern_computer_observe", json!({ "window": window })).await.unwrap());
    timed("observe", started);
    println!("{observed}\n({} chars)", observed.len());

    let labels: [&[&str]; 5] =
        [&["Clear", "All Clear", "C", "Clear all", "AC"], &["7", "Seven"], &["+", "Add", "Plus"], &["5", "Five"], &["=", "Equals"]];
    let mut steps = Vec::new();
    for (index, names) in labels.iter().enumerate() {
        match reference(&observed, names) {
            Some(reference) => steps.push(json!({ "press": reference })),
            None if index == 0 => {}
            None => panic!("no button named any of {names:?}"),
        }
    }
    let started = Instant::now();
    let acted = text(&computer.execute(ctx(), "kybern_computer_act", json!({ "window": window, "steps": steps })).await.unwrap());
    timed("act", started);
    println!("{acted}");

    let started = Instant::now();
    let read =
        text(&computer.execute(ctx(), "kybern_computer_observe", json!({ "window": window, "text": true, "query": "12" })).await.unwrap());
    timed("verify", started);
    println!("{read}");
    assert!(read.contains("12") || acted.contains("12"), "the calculator should show 12");

    let started = Instant::now();
    let shot = computer.execute(ctx(), "kybern_computer_screenshot", json!({ "window": window })).await;
    timed("screenshot", started);
    match shot {
        Ok(shot) => {
            let blocks = content_blocks(&shot);
            let image = blocks.iter().find(|block| block["type"] == "image");
            println!(
                "{} · image: {}",
                text(&shot),
                image.map_or("none".into(), |image| format!("{} base64 bytes", image["data"].as_str().unwrap_or("").len()))
            );
        }
        Err(error) => println!("screenshot failed: {error:#}"),
    }

    // A key step reports what this OS allows in the background.
    let key = text(
        &computer
            .execute(ctx(), "kybern_computer_act", json!({ "window": window, "steps": [{ "key": "escape" }], "observe": "none" }))
            .await
            .unwrap(),
    );
    println!("{key}");
    // A menu step is refused where there is no menu bar contract.
    let menu = text(
        &computer
            .execute(ctx(), "kybern_computer_act", json!({ "window": window, "steps": [{ "menu": ["View", "Basic"] }], "observe": "none" }))
            .await
            .unwrap(),
    );
    println!("{menu}");

    computer.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
