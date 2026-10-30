// `machine: "all"` on the agent tools (ADE-86 M5 / S2, design §9.2). Included into `orchestrator::tests`
// after `inbound_tests.rs`, so it shares the two-daemon `Pair`: the agent runs on machine a and reads the
// notes and tasks of a and b. They skip on a computer without the `127.x.0.n` loopback aliases.

mod federated_fixtures {
    use kybern_protocol::methods::{Note, NoteScope, NotesCreateParams, TaskItem, TaskItemsCreateParams, TaskScope};

    pub fn global_note(orchestrator: &super::Orchestrator, title: &str) -> Note {
        orchestrator
            .note_create(NotesCreateParams {
                scope: NoteScope::Global,
                project_id: None,
                title: Some(title.into()),
                body: Some(format!("{title} body")),
                project_role: None,
                category: None,
            })
            .unwrap()
    }

    pub fn global_task(orchestrator: &super::Orchestrator, title: &str) -> TaskItem {
        orchestrator
            .task_item_create(TaskItemsCreateParams {
                scope: TaskScope::Global,
                project_id: None,
                title: title.into(),
                body: None,
                status: None,
                priority: None,
                note_ids: None,
                source: None,
            })
            .unwrap()
    }
}
use federated_fixtures::{global_note, global_task};

fn titles(value: &serde_json::Value, key: &str) -> Vec<String> {
    value[key].as_array().unwrap().iter().map(|row| row["title"].as_str().unwrap().to_string()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_all_merges_the_agent_reads_labels_each_row_and_names_an_offline_machine() {
    let Some(p) = Pair::new().await else { return };
    p.set_mode(PermissionMode::Auto);
    global_note(&p.a.state.orchestrator, "note on a");
    global_note(&p.b.state.orchestrator, "note on b");
    global_task(&p.a.state.orchestrator, "task on a");
    global_task(&p.b.state.orchestrator, "task on b");

    // Without `machine`, the tool answers for this machine only.
    let local = p.tool("kybern_notes_search", json!({})).await.unwrap();
    assert_eq!(titles(&local, "notes"), ["note on a"]);

    let found = p.tool("kybern_notes_search", json!({"machine": "all"})).await.unwrap();
    assert_eq!(titles(&found, "notes"), ["note on a", "note on b"], "this machine first: {found}");
    let machines: Vec<&str> = found["notes"].as_array().unwrap().iter().map(|row| row["machine_id"].as_str().unwrap()).collect();
    assert_eq!(machines, [p.a.id(), p.b.id()]);
    assert!(found["notes"][0]["machine"].is_string());
    assert!(found.get("footer").is_none() && found["truncated"] == false, "{found}");
    assert_eq!(found["machines"].as_array().unwrap().len(), 2);
    let tasks = p.tool("kybern_tasks_list", json!({"machine": " ALL "})).await.unwrap();
    assert_eq!(titles(&tasks, "tasks"), ["task on a", "task on b"], "{tasks}");
    // The read on b ran as an inbound thread there, with no card: reads never ask.
    assert_eq!(p.inbound_on_b().len(), 1);
    assert!(p.pending_on_b().is_empty());

    // The limit holds across machines, in turns.
    let one = p.tool("kybern_notes_search", json!({"machine": "all", "limit": 1})).await.unwrap();
    assert_eq!(titles(&one, "notes"), ["note on a"]);
    assert_eq!(one["truncated"], true);

    // machine "all" is for reading. A write is made on the machine that holds the note.
    for (tool, args) in [
        ("kybern_note_create", json!({"title": "x", "body": "y", "machine": "all"})),
        ("kybern_task_create", json!({"title": "x", "machine": "all"})),
        ("kybern_note_read", json!({"note_id": Uuid::now_v7(), "machine": "all"})),
        ("kybern_run_in_terminal", json!({"command": "true", "reason": "x", "machine": "all"})),
    ] {
        let error = p.tool(tool, args).await.unwrap_err().to_string();
        assert!(error.contains("machine") && !error.contains("no machine called"), "{tool}: {error}");
    }
    assert!(p.tool("kybern_note_create", json!({"title": "x", "body": "y", "machine": "all"})).await.unwrap_err().to_string().contains("written on the machine that holds it"));
    assert_eq!(p.a.state.orchestrator.notes_list().unwrap().len(), 1, "nothing was written on a");
    assert_eq!(p.b.state.orchestrator.notes_list().unwrap().len(), 1, "nothing was written on b");
    let project = p.tool("kybern_notes_search", json!({"machine": "all", "project_id": Uuid::now_v7()})).await.unwrap_err().to_string();
    assert!(project.contains("project_id names a project on one machine"), "{project}");

    // Writing on the other machine goes through the forwarding rules, and only b has the note.
    let written = p.on_b("kybern_note_create", json!({"title": "made from a", "body": "hello"})).await.unwrap();
    assert_eq!(written["title"], "made from a");
    assert_eq!(p.b.state.orchestrator.notes_list().unwrap().len(), 2);
    assert_eq!(p.a.state.orchestrator.notes_list().unwrap().len(), 1);

    // b goes away: its rows are left out and the answer says so.
    p.b_offline().await;
    let partial = p.tool("kybern_notes_search", json!({"machine": "all"})).await.unwrap();
    assert_eq!(titles(&partial, "notes"), ["note on a"], "{partial}");
    assert_eq!(partial["skipped"][0]["reason"], "offline");
    assert!(partial["footer"].as_str().unwrap().ends_with("offline; its notes are not included."), "{partial}");
}
