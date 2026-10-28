//! Shared state across machines on the in-process multi-daemon harness (ADE-86 M5, design §9, §11.2 S1
//! and S2): a shared setting fans out and shows **Mixed** until it does, an offline machine gets the
//! change when it returns, a stale queued change does not win; notes and tasks merge across machines
//! with a footer for the ones left out. They skip on a computer without the `127.x.0.n` loopback aliases.

use kybern_client::{Client, Endpoint};
use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde_json::{Value, json};

use super::harness::*;
use super::manage::rename;

/// Three machines in one network, named "mac", "satyamas" and "vps", with their links up.
struct Trio {
    cluster: Cluster,
    a: Node,
    b: Node,
    c: Node,
}

async fn trio() -> Option<Trio> {
    let cluster = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")])?;
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    cluster.form(&a, &[&b, &c], JoinVia::Auto).await;
    for (node, name) in [(&a, "mac"), (&b, "satyamas"), (&c, "vps")] {
        rename(&a.state, &node.id(), name).await.unwrap();
    }
    eventually("everyone is linked", WAIT, || linked(&a, &b) && linked(&a, &c) && linked(&b, &c)).await;
    eventually("the names reach everyone", WAIT, || {
        [&a, &b, &c].iter().all(|node| node.membership().projection().entry(&c.id()).is_some_and(|entry| entry.descriptor.name == "vps"))
    })
    .await;
    Some(Trio { cluster, a, b, c })
}

impl Trio {
    async fn go_offline(&self, node: &Node) {
        node.set_network_enabled(false);
        eventually("the others lose it", WAIT, || {
            [&self.a, &self.b, &self.c]
                .iter()
                .filter(|other| other.id() != node.id())
                .all(|other| other.state.network.peers.link(&node.id()).is_none())
        })
        .await;
    }

    async fn come_back(&self, node: &Node) {
        node.set_network_enabled(true);
        eventually("it is linked again", WAIT, || {
            [&self.a, &self.b, &self.c].iter().filter(|other| other.id() != node.id()).all(|other| linked(other, node))
        })
        .await;
    }
}

async fn client(node: &Node) -> Client {
    Client::connect(&Endpoint { url: node.ws_url(), token: node.device_token(&Scope::ALL) }).await.unwrap()
}

fn share(path: &str, value: Value) -> SettingsShareParams {
    SettingsShareParams { fields: [(path.to_string(), value)].into(), machines: None }
}

fn field<'a>(view: &'a SettingsNetworkView, path: &str) -> &'a SettingsFieldView {
    view.fields.iter().find(|field| field.path == path).unwrap_or_else(|| panic!("no field {path}"))
}

fn mode(mode: PermissionMode) -> Value {
    serde_json::to_value(mode).unwrap()
}

fn queued_settings_items(node: &Node, target: &str, state: OutboxState) -> Vec<OutboxItem> {
    node.state
        .store
        .outbox_list(Some(target), Some(state))
        .unwrap()
        .into_iter()
        .filter(|item| item.kind == OutboxKind::SettingsPatch)
        .collect()
}

// ---- S1: settings fan-out ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_shared_setting_reaches_every_online_machine_and_mixed_resolves() {
    let Some(t) = trio().await else { return };
    let at_a = client(&t.a).await;
    // The vps was set up differently: generate_titles is off there.
    let mut settings = t.c.state.settings.get();
    settings.generate_titles = false;
    t.c.state.settings.set(settings).unwrap();

    let view = at_a.call::<SettingsNetworkViewMethod>(Empty {}).await.unwrap();
    assert_eq!(
        view.machines.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        ["mac", "satyamas", "vps"],
        "this machine first, then by name"
    );
    assert!(view.machines.iter().all(|machine| machine.state == SettingsMachineState::Reported), "{view:?}");
    let titles = field(&view, "generate_titles");
    assert!(titles.mixed, "the machines disagree: {titles:?}");
    assert_eq!(titles.values.iter().map(|v| v.value.clone().unwrap()).collect::<Vec<_>>(), [json!(true), json!(true), json!(false)]);
    assert!(!field(&view, "notifications").mixed);

    // "Use true on all machines".
    let shared = at_a.call::<SettingsShare>(share("generate_titles", json!(true))).await.unwrap();
    assert_eq!(shared.machines.len(), 2);
    assert!(shared.machines.iter().all(|target| target.state == SettingsShareState::Queued && target.outbox_id.is_some()));
    eventually("the vps takes it", WAIT, || t.c.state.settings.get().generate_titles).await;
    eventually("nothing is left in the outbox", WAIT, || {
        [&t.b, &t.c].iter().all(|node| queued_settings_items(&t.a, &node.id(), OutboxState::Queued).is_empty())
            && [&t.b, &t.c].iter().all(|node| queued_settings_items(&t.a, &node.id(), OutboxState::Sending).is_empty())
    })
    .await;

    let view = at_a.call::<SettingsNetworkViewMethod>(Empty {}).await.unwrap();
    let titles = field(&view, "generate_titles");
    assert!(!titles.mixed, "Mixed resolved: {titles:?}");
    assert!(titles.pending.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_offline_machine_is_queued_and_gets_the_change_when_it_returns() {
    let Some(t) = trio().await else { return };
    let at_a = client(&t.a).await;
    t.go_offline(&t.b).await;

    let shared = at_a
        .call::<SettingsShare>(SettingsShareParams {
            fields: [
                ("default_permission_mode".to_string(), mode(PermissionMode::Auto)),
                ("providers.codex.model".to_string(), json!("gpt-x")),
            ]
            .into(),
            machines: None,
        })
        .await
        .unwrap();
    assert_eq!(shared.machines.len(), 2);
    eventually("the vps took it", WAIT, || t.c.state.settings.get().default_permission_mode == PermissionMode::Auto).await;
    assert_eq!(t.b.state.settings.get().default_permission_mode, PermissionMode::Supervised, "the offline machine has not heard");

    let queued = queued_settings_items(&t.a, &t.b.id(), OutboxState::Queued);
    assert_eq!(queued.len(), 1, "{queued:?}");
    let view = at_a.call::<SettingsNetworkViewMethod>(Empty {}).await.unwrap();
    let satyamas = view.machines.iter().find(|m| m.name == "satyamas").unwrap();
    assert_eq!(satyamas.state, SettingsMachineState::Offline);
    let permission = field(&view, "default_permission_mode");
    assert_eq!(permission.pending, vec![t.b.id()], "{permission:?}");
    assert_eq!(permission.values[1].value, None, "an offline machine reports nothing");
    assert!(!permission.mixed, "an offline machine never makes a field Mixed");

    // The user changes their mind while it is away: the newer share replaces the queued one.
    at_a.call::<SettingsShare>(SettingsShareParams {
        fields: [
            ("default_permission_mode".to_string(), mode(PermissionMode::AcceptEdits)),
            ("providers.codex.model".to_string(), json!("gpt-y")),
        ]
        .into(),
        machines: None,
    })
    .await
    .unwrap();
    let still_queued = queued_settings_items(&t.a, &t.b.id(), OutboxState::Queued);
    assert_eq!(still_queued.len(), 1, "one waiting item, not two");
    assert_ne!(still_queued[0].id, queued[0].id);
    assert_eq!(queued_settings_items(&t.a, &t.b.id(), OutboxState::Cancelled).len(), 1);

    t.come_back(&t.b).await;
    eventually("the machine takes the change on its return", WAIT, || {
        let settings = t.b.state.settings.get();
        settings.default_permission_mode == PermissionMode::AcceptEdits
            && settings.providers.get(&ProviderKind::Codex).and_then(|p| p.model.as_deref()) == Some("gpt-y")
    })
    .await;
    eventually("it is delivered", WAIT, || !queued_settings_items(&t.a, &t.b.id(), OutboxState::Delivered).is_empty()).await;
    let view = at_a.call::<SettingsNetworkViewMethod>(Empty {}).await.unwrap();
    assert!(
        !field(&view, "default_permission_mode").mixed
            || field(&view, "default_permission_mode").values[2].value != Some(mode(PermissionMode::AcceptEdits))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_queued_change_does_not_win_over_a_newer_change_on_the_machine() {
    let Some(t) = trio().await else { return };
    let at_a = client(&t.a).await;
    t.go_offline(&t.b).await;
    at_a.call::<SettingsShare>(share("default_permission_mode", mode(PermissionMode::Auto))).await.unwrap();
    // Later, on the offline machine itself, the user picks something else.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let mut settings = t.b.state.settings.get();
    settings.default_permission_mode = PermissionMode::AcceptEdits;
    t.b.state.settings.set(settings).unwrap();

    t.come_back(&t.b).await;
    eventually("the queued change is delivered", WAIT, || !queued_settings_items(&t.a, &t.b.id(), OutboxState::Delivered).is_empty()).await;
    let delivered = &queued_settings_items(&t.a, &t.b.id(), OutboxState::Delivered)[0];
    let result: PeerSettingsPatchResult = serde_json::from_value(delivered.result.clone().unwrap()).unwrap();
    assert_eq!(result.stale, vec!["default_permission_mode".to_string()], "{result:?}");
    assert!(result.applied.is_empty());
    assert_eq!(t.b.state.settings.get().default_permission_mode, PermissionMode::AcceptEdits, "the newer local change stays");
    // It shows as Mixed until the user chooses again, and choosing again wins everywhere.
    let view = at_a.call::<SettingsNetworkViewMethod>(Empty {}).await.unwrap();
    assert!(field(&view, "default_permission_mode").mixed);
    at_a.call::<SettingsShare>(share("default_permission_mode", mode(PermissionMode::Auto))).await.unwrap();
    eventually("the second choice wins", WAIT, || t.b.state.settings.get().default_permission_mode == PermissionMode::Auto).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peer_cannot_read_or_change_a_per_machine_setting() {
    let Some(t) = trio().await else { return };
    let mut settings = t.b.state.settings.get();
    settings.providers.entry(ProviderKind::Codex).or_default().env.insert("OPENAI_API_KEY".into(), "sk-secret-value".into());
    t.b.state.settings.set(settings).unwrap();
    let link = t.a.state.network.peers.link(&t.b.id()).unwrap();

    let got = link.call::<PeerSettingsGet>(Empty {}).await.unwrap();
    let text = serde_json::to_string(&got).unwrap();
    assert!(!text.contains("sk-secret-value") && !text.contains("OPENAI"), "{text}");
    assert!(got.values.contains_key("default_provider") && !got.values.contains_key("access"));

    let stamp = crate::settings_share::next_stamp(&t.a.state.store);
    let patch = SettingsPatch {
        stamp,
        fields: [("providers.codex.binary".to_string(), json!("/tmp/evil")), ("access".to_string(), json!({"tailscale": true}))].into(),
    };
    let result = link.call::<PeerSettingsPatch>(patch).await.unwrap();
    assert_eq!(result.refused.len(), 2, "{result:?}");
    assert_eq!(t.b.state.settings.get().providers[&ProviderKind::Codex].binary, None);
    assert!(!t.b.state.settings.get().access.tailscale);
}

// ---- S2: notes and tasks readable from every machine ----

fn note(node: &Node, title: &str) -> Note {
    node.state
        .orchestrator
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

fn task(node: &Node, title: &str) -> TaskItem {
    node.state
        .orchestrator
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_all_merges_notes_and_tasks_and_names_the_machine_it_left_out() {
    let Some(t) = trio().await else { return };
    let (mac, sat, vps) = (note(&t.a, "mac note"), note(&t.b, "satyamas note"), note(&t.c, "vps note"));
    let (mac_task, sat_task) = (task(&t.a, "mac task"), task(&t.b, "satyamas task"));
    let at_a = client(&t.a).await;

    // Without `machine` nothing changes: this machine only, no federation block.
    let local = at_a.call::<NotesList>(NotesListParams::default()).await.unwrap();
    assert_eq!(local.notes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![mac.summary.id]);
    assert!(local.federation.is_none());

    let all = at_a.call::<NotesList>(NotesListParams { machine: Some("all".into()) }).await.unwrap();
    let ids: Vec<_> = all.notes.iter().map(|n| n.id).collect();
    assert_eq!(ids, vec![mac.summary.id, sat.summary.id, vps.summary.id], "this machine first, then by name");
    let federation = all.federation.unwrap();
    assert_eq!(federation.sections.iter().map(|s| s.machine_name.as_str()).collect::<Vec<_>>(), ["mac", "satyamas", "vps"]);
    assert_eq!(federation.sections[1].ids, vec![sat.summary.id]);
    assert!(federation.skipped.is_empty() && federation.footer.is_none());

    let found =
        at_a.call::<NotesSearch>(NotesSearchParams { query: "body".into(), limit: None, machine: Some("all".into()) }).await.unwrap();
    assert_eq!(found.results.len(), 3, "{found:?}");
    let tasks = at_a.call::<TaskItemsList>(TaskItemsListParams { machine: Some("all".into()) }).await.unwrap();
    assert_eq!(tasks.tasks.iter().map(|t| t.id).collect::<Vec<_>>(), vec![mac_task.id, sat_task.id]);

    // The vps goes away: its notes are left out and the footer says so.
    t.go_offline(&t.c).await;
    let all = at_a.call::<NotesList>(NotesListParams { machine: Some("all".into()) }).await.unwrap();
    assert_eq!(all.notes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![mac.summary.id, sat.summary.id]);
    let federation = all.federation.unwrap();
    assert_eq!(federation.skipped.len(), 1);
    assert_eq!((federation.skipped[0].machine_name.as_str(), federation.skipped[0].reason), ("vps", SkipReason::Offline));
    assert_eq!(federation.footer.as_deref(), Some("vps offline; its notes are not included."));
    let tasks = at_a.call::<TaskItemsList>(TaskItemsListParams { machine: Some("all".into()) }).await.unwrap();
    assert_eq!(tasks.federation.unwrap().footer.as_deref(), Some("vps offline; its tasks are not included."));
    let found =
        at_a.call::<NotesSearch>(NotesSearchParams { query: "body".into(), limit: Some(1), machine: Some("all".into()) }).await.unwrap();
    assert_eq!(found.results.len(), 1, "the limit holds across machines");

    // One machine by name: only its notes; offline, a clear error rather than an empty list.
    let only = at_a.call::<NotesList>(NotesListParams { machine: Some("satyamas".into()) }).await.unwrap();
    assert_eq!(only.notes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![sat.summary.id]);
    let gone = at_a.call::<NotesList>(NotesListParams { machine: Some("vps".into()) }).await.unwrap_err();
    assert!(gone.to_string().contains("vps is offline"), "{gone}");
    // Naming this machine reads only here.
    let own = at_a.call::<NotesList>(NotesListParams { machine: Some("mac".into()) }).await.unwrap();
    assert_eq!(own.notes.len(), 1);

    // Reading is all a member may do: the owner stays the only writer.
    let after = t.b.state.orchestrator.notes_list().unwrap();
    assert_eq!(after.len(), 1, "nothing was written to satyamas");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_member_that_turned_sharing_off_is_left_out_of_a_merged_read() {
    let Some(t) = trio().await else { return };
    let (mac, sat) = (note(&t.a, "mac note"), note(&t.b, "satyamas note"));
    // satyamas stops letting the other machines use its tools: its notes are not theirs to read.
    let at_b = client(&t.b).await;
    at_b.call::<NetworkAllowSet>(NetworkAllowSetParams { machine_id: t.b.id(), capability: "tools".into(), allowed: false }).await.unwrap();
    assert!(!t.b.state.network.policy_scopes(&t.a.id()).contains(&Scope::MachineTools));
    let at_a = client(&t.a).await;
    let all = at_a.call::<NotesList>(NotesListParams { machine: Some("all".into()) }).await.unwrap();
    assert!(all.notes.iter().any(|n| n.id == mac.summary.id) && !all.notes.iter().any(|n| n.id == sat.summary.id));
    let federation = all.federation.unwrap();
    let left_out = federation.skipped.iter().find(|s| s.machine_name == "satyamas").expect("satyamas is named");
    assert_eq!(left_out.reason, SkipReason::Refused);
    assert!(federation.footer.unwrap().contains("satyamas has sharing turned off; its notes are not included"));
}
