//! Public transport and restart checks for the project Coordinator. These never
//! start a real harness and keep all data outside the user's normal Kybern directory.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use kybern_client::{Client, Endpoint};
use serde_json::{Value, json};

struct ScratchDaemon {
    root: PathBuf,
    process: Option<Child>,
}

impl ScratchDaemon {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("kybern-coordinator-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("project")).unwrap();
        Self { root, process: None }
    }

    async fn start(&mut self) -> Client {
        let data = self.root.join("data");
        let _ = std::fs::remove_file(data.join("daemon.port"));
        let log = std::fs::File::create(self.root.join("daemon.log")).unwrap();
        let process = Command::new(env!("CARGO_BIN_EXE_kybernd"))
            .arg("--data-dir")
            .arg(&data)
            .args(["--port", "0", "--bind", "127.0.0.1"])
            .env_remove("KYBERN_URL")
            .env_remove("KYBERN_TOKEN")
            .env_remove("KYBERN_ADVERTISE_URL")
            .stdin(Stdio::null())
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap();
        self.process = Some(process);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = self.process.as_mut().unwrap().try_wait().unwrap() {
                panic!("scratch daemon exited {status}: {}", std::fs::read_to_string(self.root.join("daemon.log")).unwrap_or_default());
            }
            if let (Ok(port), Ok(token)) =
                (std::fs::read_to_string(data.join("daemon.port")), std::fs::read_to_string(data.join("daemon.token")))
            {
                let endpoint = Endpoint { url: format!("ws://127.0.0.1:{}/ws", port.trim()), token: token.trim().to_owned() };
                if let Ok(client) = Client::connect(&endpoint).await {
                    return client;
                }
            }
            assert!(tokio::time::Instant::now() < deadline, "scratch daemon did not become ready");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }

    /// Run a `kybern` subcommand against this daemon and parse its JSON output.
    fn cli(&self, args: &[&str]) -> Value {
        let output = Command::new(env!("CARGO_BIN_EXE_kybern"))
            .arg("--data-dir")
            .arg(self.root.join("data"))
            .args(args)
            .env_remove("KYBERN_URL")
            .env_remove("KYBERN_TOKEN")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success(), "CLI failed: {}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

impl Drop for ScratchDaemon {
    fn drop(&mut self) {
        self.stop();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn call(client: &Client, method: &str, params: Value) -> Value {
    tokio::time::timeout(Duration::from_secs(15), client.call_raw(method, params))
        .await
        .unwrap_or_else(|_| panic!("{method} timed out"))
        .unwrap_or_else(|error| panic!("{method}: {error}"))
}

#[tokio::test]
async fn the_coordinator_its_brief_and_a_harness_switch_survive_a_daemon_restart() {
    let mut daemon = ScratchDaemon::new();
    let client = daemon.start().await;
    let project = call(&client, "projects.add", json!({ "path": daemon.root.join("project"), "name": "Lead test" })).await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    assert_eq!(project["brief_in_all_threads"], false);

    // The user's brief exists first, so opening starts no setup interview (and no real harness).
    call(
        &client,
        "notes.create",
        json!({ "scope": "project", "project_id": project_id, "body": "Keep the project context", "project_role": "brief" }),
    )
    .await;

    // Open through the CLI: created once, then returned as it is.
    let opened = daemon.cli(&["coordinator", "open", &project_id, "--provider", "claude-code"]);
    assert_eq!(opened["created"], true);
    let thread_id = opened["thread"]["id"].as_str().unwrap().to_owned();
    assert_eq!(opened["thread"]["coordinator_project_id"], project_id.as_str());
    assert!(opened["thread"].get("collaboration_group_id").is_none(), "the group marker is gone");
    let again = daemon.cli(&["coordinator", "open", &project_id, "--provider", "codex"]);
    assert_eq!((again["created"].as_bool(), again["thread"]["id"].as_str()), (Some(false), Some(thread_id.as_str())));
    assert_eq!(again["thread"]["provider"]["kind"], "claude-code", "open does not move an existing Coordinator");

    let notes = call(&client, "notes.list", json!({})).await;
    let brief = notes["notes"].as_array().unwrap().iter().find(|note| note["project_role"] == "brief").expect("the brief note");
    assert_eq!((brief["pinned"].as_bool(), brief["project_id"].as_str()), (Some(true), Some(project_id.as_str())));

    let switched = daemon.cli(&["coordinator", "switch-harness", &project_id, "--provider", "codex"]);
    assert_eq!((switched["id"].as_str(), switched["provider"]["kind"].as_str()), (Some(thread_id.as_str()), Some("codex")));

    // A restart keeps the Coordinator, its harness and the brief.
    daemon.stop();
    let client = daemon.start().await;
    let restored = call(&client, "coordinator.get", json!({ "project_id": project_id })).await;
    assert_eq!((restored["id"].as_str(), restored["provider"]["kind"].as_str()), (Some(thread_id.as_str()), Some("codex")));
    let notes = call(&client, "notes.list", json!({})).await;
    assert_eq!(notes["notes"].as_array().unwrap().iter().filter(|note| note["project_role"] == "brief").count(), 1);

    // The old collaboration surface is gone; history search and read stay.
    let error = client.call_raw("collaboration.groups.list", json!({})).await.unwrap_err().to_string();
    assert!(error.to_lowercase().contains("method"), "{error}");
    let found = daemon.cli(&["history", "search", "--project", &project_id, "--query", "coordinator"]);
    assert!(found["threads"].as_array().unwrap().iter().any(|hit| hit["thread"]["id"] == thread_id.as_str()), "{found}");
    let read = daemon.cli(&["history", "read", &thread_id]);
    assert_eq!(read["thread"]["id"], thread_id.as_str());
}
