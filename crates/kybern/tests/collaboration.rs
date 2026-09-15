//! Public transport and restart checks. These never start a real harness and
//! keep all data outside the user's normal Kybern directory.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use kybern_client::{Client, Endpoint};
use serde_json::{Value, json};
use uuid::Uuid;

struct ScratchDaemon {
    root: PathBuf,
    process: Option<Child>,
}

impl ScratchDaemon {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("kybern-collaboration-test-{}", Uuid::new_v4()));
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

    fn cli(&self, args: &[&str]) -> Value {
        let output = Command::new(env!("CARGO_BIN_EXE_kybern"))
            .arg("--data-dir")
            .arg(self.root.join("data"))
            .arg("--json")
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
async fn coordinator_harness_switch_is_persisted_across_rpc_reads_and_restart() {
    let mut daemon = ScratchDaemon::new();
    let client = daemon.start().await;
    let project = call(&client, "projects.add", json!({ "path": daemon.root.join("project"), "name": "Switch test" })).await;
    let coordinator = call(
        &client,
        "collaboration.coordinator.get_or_create",
        json!({
            "operation_id": Uuid::new_v4(), "project_id": project["id"],
            "provider": { "kind": "claude-code", "instance": "default" },
            "initial_goal": "Keep the project context while changing harnesses",
        }),
    )
    .await;
    let switched = call(
        &client,
        "collaboration.coordinator.switch_harness",
        json!({
            "operation_id": Uuid::new_v4(), "project_id": project["id"],
            "provider": { "kind": "codex", "instance": "default" },
            "model": "gpt-5.6-luna", "effort": "max",
        }),
    )
    .await;
    let thread_id = coordinator["thread"]["id"].clone();
    assert_eq!(switched["thread"]["id"], thread_id);
    assert_eq!(switched["group"]["id"], coordinator["group"]["id"]);
    // The accepted response must agree with the persisted record used by the
    // next send. A returned candidate alone previously hid a failed DB update.
    let stored = call(&client, "threads.get", json!({ "thread_id": thread_id })).await;
    assert_eq!(stored["thread"]["provider"], switched["thread"]["provider"]);
    assert_eq!(stored["thread"]["provider"]["kind"], "codex");
    drop(client);
    daemon.stop();

    let client = daemon.start().await;
    let restored = call(&client, "collaboration.coordinator.get", json!({ "project_id": project["id"] })).await;
    assert_eq!(restored["thread"]["id"], thread_id);
    assert_eq!(restored["thread"]["provider"]["kind"], "codex");
    assert_eq!(restored["thread"]["model"], "gpt-5.6-luna");
    assert_eq!(restored["thread"]["effort"], "max");
    assert_eq!(restored["thread"]["status"], "idle");
    assert_eq!(restored["group"]["id"], coordinator["group"]["id"]);
    assert_eq!(restored["group"]["coordinator_mode"], "ordinary");
    assert_eq!(restored["group"]["objective"], coordinator["group"]["objective"]);
    let knowledge = call(&client, "collaboration.context.list", json!({ "group_id": restored["group"]["id"] })).await;
    assert!(knowledge["entries"].as_array().unwrap().iter().any(|entry| {
        entry["key"] == "project.brief" && entry["body"] == coordinator["group"]["objective"] && entry["user_authored"] == true
    }));
}

#[tokio::test]
async fn collaboration_survives_restart_without_duplicate_work_or_lost_user_corrections() {
    let mut daemon = ScratchDaemon::new();
    let client = daemon.start().await;
    let project = call(&client, "projects.add", json!({ "path": daemon.root.join("project"), "name": "Collaboration test" })).await;
    let mut threads = Vec::new();
    for title in ["Coordinator", "Worker"] {
        threads.push(
            call(
                &client,
                "threads.create",
                json!({
                    "project_id": project["id"], "provider": { "kind": "codex", "instance": "default" }, "title": title,
                    "use_worktree": false,
                }),
            )
            .await,
        );
    }
    let create = json!({
        "operation_id": Uuid::new_v4(), "project_id": project["id"],
        "coordinator_thread_id": threads[0]["id"], "objective": "Verify durable collaboration",
        "success_criteria": ["User corrections survive a daemon restart"],
        "policy": { "max_pending_messages": 1024 },
    });
    let group = call(&client, "collaboration.groups.create", create.clone()).await;
    assert_eq!(call(&client, "collaboration.groups.create", create.clone()).await["id"], group["id"]);
    let mut conflict = create.clone();
    conflict["objective"] = json!("A different operation");
    assert!(client.call_raw("collaboration.groups.create", conflict).await.is_err(), "a changed retry must conflict");

    call(&client, "collaboration.groups.control", json!({ "operation_id": Uuid::new_v4(), "group_id": group["id"], "action": "pause" }))
        .await;
    call(
        &client,
        "collaboration.members.attach",
        json!({
            "operation_id": Uuid::new_v4(), "group_id": group["id"], "thread_id": threads[1]["id"], "role": "worker",
        }),
    )
    .await;

    let context = json!({
        "operation_id": Uuid::new_v4(), "group_id": group["id"], "key": "test-instructions", "kind": "instruction",
        "body": "Run the old test command", "user_authored": true,
    });
    let first = call(&client, "collaboration.context.put", context.clone()).await;
    let corrected = call(
        &client,
        "collaboration.context.put",
        json!({
            "operation_id": Uuid::new_v4(), "group_id": group["id"], "entry_id": first["id"], "key": first["key"],
            "kind": "instruction", "body": "Run the corrected test command", "user_authored": true,
            "expected_revision": first["revision"], "source_refs": ["user correction"],
        }),
    )
    .await;
    let stale = json!({
        "operation_id": Uuid::new_v4(), "group_id": group["id"], "entry_id": first["id"], "key": first["key"],
        "kind": "instruction", "body": "Overwrite the correction", "expected_revision": first["revision"], "user_authored": true,
    });
    assert!(client.call_raw("collaboration.context.put", stale).await.is_err());
    assert_eq!(call(&client, "collaboration.context.put", context).await, first, "retry should return its original receipt");

    let assignment_request = json!({
        "operation_id": Uuid::new_v4(), "group_id": group["id"], "owner_thread_id": threads[1]["id"],
        "title": "Wait for explicit resume", "instructions": "Do not start while the group is paused", "kind": "research",
    });
    let assignment = call(&client, "collaboration.assignments.create", assignment_request.clone()).await;
    assert_eq!(assignment["status"], "pending");
    let message_request = json!({
        "operation_id": Uuid::new_v4(), "group_id": group["id"], "assignment_id": assignment["id"],
        "to_thread_id": threads[1]["id"], "purpose": "question", "body": "What will you check after resuming?",
    });
    let message = call(&client, "collaboration.messages.send", message_request.clone()).await;
    assert!(matches!(message["state"].as_str(), Some("persisted" | "queued")));

    // More changes than one wait page, followed by another category of change.
    // Advancing to the newest category must not skip earlier message pages.
    let mut expected_messages = std::collections::HashSet::new();
    expected_messages.insert(message["id"].as_str().unwrap().to_owned());
    for index in 0..205 {
        let progress = call(
            &client,
            "collaboration.messages.send",
            json!({
                "operation_id": Uuid::new_v4(), "group_id": group["id"],
                "to_thread_id": threads[1]["id"], "purpose": "progress", "body": format!("Recorded finding {index}"),
            }),
        )
        .await;
        expected_messages.insert(progress["id"].as_str().unwrap().to_owned());
    }
    call(&client, "collaboration.context.put", json!({
        "operation_id": Uuid::new_v4(), "group_id": group["id"], "key": "research", "kind": "research", "body": "A later context change",
    })).await;
    let mut cursor = Value::Null;
    let mut seen_messages = std::collections::HashSet::new();
    for page in 0..20 {
        let updates = call(&client, "collaboration.wait", json!({ "group_id": group["id"], "cursor": cursor, "timeout_ms": 0 })).await;
        for item in updates["messages"].as_array().unwrap() {
            seen_messages.insert(item["id"].as_str().unwrap().to_owned());
        }
        cursor = updates["cursor"].clone();
        if updates["timed_out"] == true {
            break;
        }
        assert!(page < 19, "wait pages did not reach the current head");
    }
    assert_eq!(seen_messages, expected_messages);

    call(&client, "collaboration.context.put", json!({
        "operation_id": Uuid::new_v4(), "group_id": group["id"], "key": "unrelated", "kind": "research", "body": "Outside the selected assignment",
    })).await;
    let filtered = call(
        &client,
        "collaboration.wait",
        json!({
            "group_id": group["id"], "cursor": cursor, "assignment_ids": [assignment["id"]], "timeout_ms": 0,
        }),
    )
    .await;
    assert_eq!(filtered["timed_out"], true, "unrelated context must not satisfy an assignment wait");
    assert!(filtered["context_entries"].as_array().unwrap().is_empty());

    // All waiters receive a result; they do not compete with the scheduler for
    // one Notify permit. The group remains paused throughout this test.
    let wait_params = json!({
        "group_id": group["id"], "cursor": filtered["cursor"], "assignment_ids": [assignment["id"]], "timeout_ms": 1000,
    });
    let trigger = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        call(
            &client,
            "collaboration.messages.send",
            json!({
                "operation_id": Uuid::new_v4(), "group_id": group["id"], "assignment_id": assignment["id"],
                "to_thread_id": threads[1]["id"], "purpose": "progress", "body": "A related update for both waiters",
            }),
        )
        .await
    };
    let (waiter_one, waiter_two, notification) =
        tokio::join!(call(&client, "collaboration.wait", wait_params.clone()), call(&client, "collaboration.wait", wait_params), trigger,);
    for result in [waiter_one, waiter_two] {
        assert_eq!(result["timed_out"], false);
        assert!(result["messages"].as_array().unwrap().iter().any(|message| message["id"] == notification["id"]));
    }

    let group_id = group["id"].as_str().unwrap();
    let cli_group = daemon.cli(&["collaboration", "groups", "get", group_id]);
    assert_eq!(cli_group["group"]["status"], "paused");
    drop(client);
    daemon.stop();
    let client = daemon.start().await;

    let restored = call(&client, "collaboration.groups.get", json!({ "group_id": group["id"] })).await;
    assert_eq!(restored["group"]["status"], "paused");
    assert_eq!(call(&client, "collaboration.groups.create", create).await["id"], group["id"]);
    assert_eq!(call(&client, "collaboration.assignments.create", assignment_request).await["id"], assignment["id"]);
    assert_eq!(call(&client, "collaboration.messages.send", message_request).await["id"], message["id"]);
    let assignments = call(&client, "collaboration.assignments.list", json!({ "group_id": group["id"], "include_finished": true })).await;
    assert_eq!(assignments["assignments"].as_array().unwrap().len(), 1);
    assert_eq!(assignments["assignments"][0]["status"], "pending");
    let knowledge = call(&client, "collaboration.context.list", json!({ "group_id": group["id"], "keys": ["test-instructions"] })).await;
    assert_eq!(knowledge["entries"][0]["body"], corrected["body"]);
    assert_eq!(knowledge["entries"][0]["revision"], corrected["revision"]);
    let history = call(&client, "collaboration.context.history", json!({ "entry_id": first["id"] })).await;
    assert_eq!(history["revisions"].as_array().unwrap().len(), 2);
    let worker = call(&client, "threads.get", json!({ "thread_id": threads[1]["id"] })).await;
    assert_eq!(worker["thread"]["status"], "idle", "paused work must never start a harness during recovery");

    call(&client, "collaboration.groups.control", json!({ "operation_id": Uuid::new_v4(), "group_id": group["id"], "action": "stop" }))
        .await;
    let cancelled = call(&client, "collaboration.assignments.get", json!({ "assignment_id": assignment["id"] })).await;
    assert_eq!(cancelled["status"], "cancelled");
}

#[tokio::test]
async fn collaboration_public_api_preserves_authority_and_concurrent_revision_checks() {
    let mut daemon = ScratchDaemon::new();
    let client = daemon.start().await;
    let project = call(&client, "projects.add", json!({ "path": daemon.root.join("project") })).await;
    let coordinator = call(
        &client,
        "threads.create",
        json!({
            "project_id": project["id"], "provider": { "kind": "codex", "instance": "default" },
            "title": "Authority test", "use_worktree": false,
        }),
    )
    .await;
    let create = json!({
        "operation_id": Uuid::new_v4(), "project_id": project["id"], "coordinator_thread_id": coordinator["id"],
        "objective": "Verify public authority boundaries",
    });
    let (first, duplicate) =
        tokio::join!(call(&client, "collaboration.groups.create", create.clone()), call(&client, "collaboration.groups.create", create),);
    assert_eq!(first, duplicate, "simultaneous retries must return one committed receipt");
    let group_id = first["id"].clone();
    let progress = call(
        &client,
        "collaboration.messages.send",
        json!({
            "operation_id": Uuid::new_v4(), "group_id": group_id, "to_thread_id": coordinator["id"],
            "purpose": "progress", "body": "This persisted update must not start inference",
        }),
    )
    .await;
    assert_eq!(progress["state"], "persisted");
    assert_eq!(progress["wakeup_count"], 0);
    let queue = call(&client, "queue.list", json!({ "thread_id": coordinator["id"] })).await;
    assert!(queue["messages"].as_array().unwrap().is_empty());
    let thread = call(&client, "threads.get", json!({ "thread_id": coordinator["id"] })).await;
    assert_eq!(thread["thread"]["status"], "idle");

    for invalid in
        [json!({"from_thread_id": coordinator["id"]}), json!({"assignment_id": Uuid::new_v4()}), json!({"reply_to": Uuid::new_v4()})]
    {
        let mut request = json!({
            "operation_id": Uuid::new_v4(), "group_id": group_id, "to_thread_id": coordinator["id"],
            "purpose": "progress", "body": "Invalid attribution or reference",
        });
        request.as_object_mut().unwrap().extend(invalid.as_object().unwrap().clone());
        assert!(client.call_raw("collaboration.messages.send", request).await.is_err());
    }

    let context = call(
        &client,
        "collaboration.context.put",
        json!({
            "operation_id": Uuid::new_v4(), "group_id": group_id, "key": "authoritative", "kind": "instruction",
            "body": "Initial user instruction", "user_authored": true,
        }),
    )
    .await;
    let correction = |body: &str| {
        json!({
            "operation_id": Uuid::new_v4(), "group_id": group_id, "entry_id": context["id"], "key": "authoritative",
            "kind": "instruction", "body": body, "user_authored": true, "expected_revision": context["revision"],
        })
    };
    let (one, two) = tokio::join!(
        client.call_raw("collaboration.context.put", correction("First competing correction")),
        client.call_raw("collaboration.context.put", correction("Second competing correction")),
    );
    assert_ne!(one.is_ok(), two.is_ok(), "exactly one concurrent revision may win");
    let history = call(&client, "collaboration.context.history", json!({ "entry_id": context["id"] })).await;
    assert_eq!(history["revisions"].as_array().unwrap().len(), 2);
    let complete = call(
        &client,
        "collaboration.groups.control",
        json!({
            "operation_id": Uuid::new_v4(), "group_id": group_id, "action": "complete",
        }),
    )
    .await;
    assert_eq!(complete["status"], "completed");
    assert!(
        client
            .call_raw(
                "collaboration.groups.control",
                json!({
                    "operation_id": Uuid::new_v4(), "group_id": group_id, "action": "resume",
                })
            )
            .await
            .is_err(),
        "completion must remain final"
    );
}

#[tokio::test]
async fn coordinator_delete_and_recreate_survive_public_transport_restart() {
    let mut daemon = ScratchDaemon::new();
    let client = daemon.start().await;
    let project = call(&client, "projects.add", json!({ "path": daemon.root.join("project") })).await;
    let create = json!({
        "operation_id": Uuid::new_v4(), "project_id": project["id"],
        "provider": { "kind": "codex", "instance": "default" }, "initial_goal": "Inspect the project before implementing",
    });
    let original = call(&client, "collaboration.coordinator.get_or_create", create.clone()).await;
    let group = call(&client, "collaboration.groups.get", json!({ "group_id": original["group"]["id"] })).await;
    assert_eq!(group["coordinator_setup_complete"], false);
    assert!(client.call_raw("threads.archive", json!({ "thread_id": original["thread"]["id"] })).await.is_err());
    let delete = json!({ "operation_id": Uuid::new_v4(), "project_id": project["id"], "thread_id": original["thread"]["id"] });
    let (first, duplicate) = tokio::join!(
        call(&client, "collaboration.coordinator.delete", delete.clone()),
        call(&client, "collaboration.coordinator.delete", delete.clone()),
    );
    assert_eq!(first, duplicate);
    assert_eq!(first["status"], "archived");
    assert!(first["coordinator_project_id"].is_null());
    drop(client);
    daemon.stop();
    let client = daemon.start().await;
    assert!(call(&client, "collaboration.coordinator.get", json!({ "project_id": project["id"] })).await.is_null());
    let mut next = create.clone();
    next["operation_id"] = json!(Uuid::new_v4());
    let fresh = call(&client, "collaboration.coordinator.get_or_create", next).await;
    assert_ne!(fresh["thread"]["id"], original["thread"]["id"]);
    assert_ne!(fresh["group"]["id"], original["group"]["id"]);
    assert_eq!(call(&client, "collaboration.coordinator.delete", delete.clone()).await["id"], original["thread"]["id"]);
    let current = call(&client, "collaboration.coordinator.get", json!({ "project_id": project["id"] })).await;
    assert_eq!(current["thread"]["id"], fresh["thread"]["id"]);
    assert!(client.call_raw("collaboration.coordinator.get_or_create", create).await.is_err());
    let history = call(&client, "threads.get", json!({ "thread_id": original["thread"]["id"] })).await;
    assert_eq!(history["thread"]["status"], "archived");
    let knowledge = call(&client, "collaboration.context.list", json!({ "group_id": original["group"]["id"] })).await;
    assert_eq!(knowledge["entries"][0]["body"], "Inspect the project before implementing");
    let input = daemon.root.join("coordinator-delete.json");
    std::fs::write(&input, serde_json::to_vec(&delete).unwrap()).unwrap();
    assert_eq!(daemon.cli(&["collaboration", "coordinator", "delete", "--input", input.to_str().unwrap()])["id"], original["thread"]["id"]);
}
