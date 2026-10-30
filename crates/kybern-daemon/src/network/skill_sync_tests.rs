//! Skill copies between machines on the in-process multi-daemon harness (ADE-86): a skill goes from a to b and
//! from b to c (asked from a), a different version is kept until the user agrees to replace it and then backed up,
//! an offline machine gets its copy when it returns, and a machine that turned Files off refuses. Every node gets
//! its own fake home folder; no test reads or writes the real skill folders. They skip on a computer without the
//! `127.x.0.n` loopback aliases.

use std::path::{Path, PathBuf};

use kybern_client::{Client, Endpoint};
use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde_json::json;

use super::harness::*;
use super::manage::rename;
use super::testutil::TempDir;

struct Trio {
    _cluster: Cluster,
    _homes: TempDir,
    a: Node,
    b: Node,
    c: Node,
}

/// The fake home folder of a node, set before anything reads it.
fn home_of(homes: &TempDir, node: &Node) -> PathBuf {
    let home = std::fs::canonicalize(homes.path()).unwrap().join(node.id());
    std::fs::create_dir_all(&home).unwrap();
    node.state.skill_homes.set([("OMP_PROFILE".to_string(), String::new())].into(), home.clone());
    home
}

async fn trio() -> Option<Trio> {
    let cluster = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")])?;
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    cluster.form(&a, &[&b, &c], JoinVia::Auto).await;
    for (node, name) in [(&a, "mac"), (&b, "os-kdi"), (&c, "satyamas")] {
        rename(&a.state, &node.id(), name).await.unwrap();
    }
    eventually("everyone is linked", WAIT, || linked(&a, &b) && linked(&a, &c) && linked(&b, &c)).await;
    let homes = TempDir::new("skill-homes");
    for node in [&a, &b, &c] {
        home_of(&homes, node);
    }
    Some(Trio { _cluster: cluster, _homes: homes, a, b, c })
}

impl Trio {
    fn home(&self, node: &Node) -> PathBuf {
        std::fs::canonicalize(self._homes.path()).unwrap().join(node.id())
    }
}

async fn client(node: &Node) -> Client {
    Client::connect(&Endpoint { url: node.ws_url(), token: node.device_token(&Scope::ALL) }).await.unwrap()
}

fn skill(dir: &Path, body: &str) {
    std::fs::create_dir_all(dir.join("scripts")).unwrap();
    std::fs::write(dir.join("SKILL.md"), format!("---\nname: review\ndescription: Reviews a change.\n---\n{body}")).unwrap();
    std::fs::write(dir.join("scripts/check.sh"), "#!/bin/sh\necho ok\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join("scripts/check.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(dir.join(".env"), "TOKEN=secret").unwrap();
    std::fs::create_dir_all(dir.join("node_modules/dep")).unwrap();
    std::fs::write(dir.join("node_modules/dep/index.js"), "x").unwrap();
}

fn to(machine: &str) -> SkillCopyTarget {
    SkillCopyTarget { machine: machine.into(), homes: Vec::new(), replaces: Vec::new() }
}

fn copy(name: &str, from: Option<String>, targets: Vec<SkillCopyTarget>) -> SkillsCopyParams {
    SkillsCopyParams { name: name.into(), from, from_home: None, to: targets }
}

fn item_state(node: &Node, id: uuid::Uuid) -> OutboxItem {
    node.state.store.outbox_get(id).unwrap().unwrap()
}

async fn settled(node: &Node, id: uuid::Uuid) -> OutboxItem {
    eventually("the copy settles", std::time::Duration::from_secs(40), || item_state(node, id).state.is_settled()).await;
    item_state(node, id)
}

fn entry<'a>(view: &'a SkillsNetworkView, name: &str) -> &'a SkillNetworkEntry {
    view.skills.iter().find(|skill| skill.name == name).unwrap_or_else(|| panic!("no {name} in the view"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_skill_goes_from_a_to_b_and_from_b_to_c_and_the_view_shows_them_in_step() {
    let Some(t) = trio().await else { return };
    let a_home = t.home(&t.a);
    skill(&a_home.join(".agents/skills/review"), "v1");
    // The same skill linked into Claude's folder, the way `npx skills` installs it.
    #[cfg(unix)]
    {
        std::fs::create_dir_all(a_home.join(".claude/skills")).unwrap();
        std::os::unix::fs::symlink(a_home.join(".agents/skills/review"), a_home.join(".claude/skills/review")).unwrap();
    }
    let a = client(&t.a).await;
    let before = a.call::<SkillsNetworkViewMethod>(Empty {}).await.unwrap();
    assert_eq!(before.machines.len(), 3);
    assert!(before.machines.iter().all(|machine| machine.state == SkillsMachineState::Reported), "{:?}", before.machines);
    let review = entry(&before, "review");
    assert_eq!(review.machines.len(), 1, "only a has it");
    assert_eq!(review.description.as_deref(), Some("Reviews a change."));

    // a → b, into the homes it lives in on a.
    let sent = a.call::<SkillsCopy>(copy("review", None, vec![to(&t.b.id())])).await.unwrap();
    assert_eq!(sent.source, t.a.id());
    assert_eq!(sent.files, 2, "SKILL.md and the script; not .env or node_modules");
    assert!(sent.skipped.iter().any(|skipped| skipped == ".env") && sent.skipped.iter().any(|skipped| skipped == "node_modules/"));
    assert_eq!(sent.targets[0].state, SkillCopyState::Queued);
    let item = settled(&t.a, sent.targets[0].outbox_id.unwrap()).await;
    assert_eq!(item.state, OutboxState::Delivered, "{:?}", item.last_error);
    assert_eq!(item.kind, OutboxKind::SkillCopy);
    let landed: SkillLanded = serde_json::from_value(item.result.unwrap()).unwrap();
    assert_eq!(landed.hash, sent.hash);
    let b_home = t.home(&t.b);
    let mut folders = vec![".agents/skills/review"];
    if cfg!(unix) {
        folders.push(".claude/skills/review");
    }
    for folder in folders {
        let dir = b_home.join(folder);
        assert!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap().ends_with("v1"), "{folder}");
        assert!(!dir.join(".env").exists() && !dir.join("node_modules").exists(), "secrets and dependencies never travel");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.join("scripts/check.sh")).unwrap().permissions().mode() & 0o111,
                0o111,
                "the script stays executable"
            );
        }
    }

    // b → c, asked from a: b sends it, from its own outbox.
    let relayed = a.call::<SkillsCopy>(copy("review", Some("os-kdi".into()), vec![to("satyamas")])).await.unwrap();
    assert_eq!(relayed.source, t.b.id());
    assert_eq!(relayed.hash, sent.hash, "b's copy is the same version");
    let item = settled(&t.b, relayed.targets[0].outbox_id.unwrap()).await;
    assert_eq!(item.state, OutboxState::Delivered, "{:?}", item.last_error);
    assert!(t.home(&t.c).join(".agents/skills/review/SKILL.md").is_file());

    let after = a.call::<SkillsNetworkViewMethod>(Empty {}).await.unwrap();
    let review = entry(&after, "review");
    assert_eq!(review.machines.len(), 3);
    assert_eq!(review.versions, std::slice::from_ref(&sent.hash));
    assert!(!review.differs);
    assert!(review.pending.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_different_version_is_kept_until_the_user_replaces_it_and_the_old_one_is_backed_up() {
    let Some(t) = trio().await else { return };
    skill(&t.home(&t.a).join(".claude/skills/review"), "new");
    skill(&t.home(&t.c).join(".claude/skills/review"), "theirs");
    let a = client(&t.a).await;
    let view = a.call::<SkillsNetworkViewMethod>(Empty {}).await.unwrap();
    let review = entry(&view, "review");
    assert!(review.differs);
    let theirs = review.machines.iter().find(|on| on.machine_id == t.c.id()).and_then(|on| on.copies[0].hash.clone()).unwrap();

    // Without agreeing, the copy fails and says what is there.
    let sent = a.call::<SkillsCopy>(copy("review", None, vec![to("satyamas")])).await.unwrap();
    let item = settled(&t.a, sent.targets[0].outbox_id.unwrap()).await;
    assert_eq!(item.state, OutboxState::Failed);
    assert!(item.last_error.as_deref().unwrap().contains("Replace"), "{:?}", item.last_error);
    let c_skill = t.home(&t.c).join(".claude/skills/review");
    assert!(std::fs::read_to_string(c_skill.join("SKILL.md")).unwrap().ends_with("theirs"));

    // Agreeing to the version that is there replaces it and keeps a backup in c's data folder.
    let replace = SkillCopyTarget { machine: "satyamas".into(), homes: vec![SkillHome::Claude], replaces: vec![theirs] };
    let sent = a.call::<SkillsCopy>(copy("review", None, vec![replace])).await.unwrap();
    let item = settled(&t.a, sent.targets[0].outbox_id.unwrap()).await;
    assert_eq!(item.state, OutboxState::Delivered, "{:?}", item.last_error);
    let landed: SkillLanded = serde_json::from_value(item.result.unwrap()).unwrap();
    assert_eq!(landed.placed[0].action, SkillPlaceAction::Replaced);
    let backup = PathBuf::from(landed.placed[0].backup.clone().unwrap());
    assert!(backup.starts_with(t.c.state.paths.root.join(super::skill_sync::BACKUPS)), "{backup:?}");
    assert!(std::fs::read_to_string(backup.join("SKILL.md")).unwrap().ends_with("theirs"));
    assert!(std::fs::read_to_string(c_skill.join("SKILL.md")).unwrap().ends_with("new"));
    let view = a.call::<SkillsNetworkViewMethod>(Empty {}).await.unwrap();
    assert!(!entry(&view, "review").differs);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_copy_for_an_offline_machine_waits_in_the_outbox_and_lands_when_it_returns() {
    let Some(t) = trio().await else { return };
    skill(&t.home(&t.a).join(".agents/skills/review"), "v1");
    t.b.set_network_enabled(false);
    eventually("a loses b", WAIT, || t.a.state.network.peers.link(&t.b.id()).is_none()).await;
    let a = client(&t.a).await;
    let view = a.call::<SkillsNetworkViewMethod>(Empty {}).await.unwrap();
    assert_eq!(view.machines.iter().find(|machine| machine.id == t.b.id()).unwrap().state, SkillsMachineState::Offline);

    let sent = a.call::<SkillsCopy>(copy("review", None, vec![to(&t.b.id())])).await.unwrap();
    let id = sent.targets[0].outbox_id.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(item_state(&t.a, id).state, OutboxState::Queued, "nothing is delivered to an offline machine");
    let view = a.call::<SkillsNetworkViewMethod>(Empty {}).await.unwrap();
    assert_eq!(entry(&view, "review").pending.iter().map(|pending| pending.machine_id.clone()).collect::<Vec<_>>(), [t.b.id()]);
    // A second copy of the same skill replaces the one that waits.
    let again = a.call::<SkillsCopy>(copy("review", None, vec![to(&t.b.id())])).await.unwrap();
    assert_eq!(item_state(&t.a, id).state, OutboxState::Cancelled);

    t.b.set_network_enabled(true);
    eventually("a and b are linked again", WAIT, || linked(&t.a, &t.b)).await;
    let item = settled(&t.a, again.targets[0].outbox_id.unwrap()).await;
    assert_eq!(item.state, OutboxState::Delivered, "{:?}", item.last_error);
    assert!(t.home(&t.b).join(".agents/skills/review/SKILL.md").is_file());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_machine_that_turned_files_off_neither_lists_nor_takes_skills() {
    let Some(t) = trio().await else { return };
    skill(&t.home(&t.a).join(".agents/skills/review"), "v1");
    skill(&t.home(&t.b).join(".agents/skills/theirs"), "x");
    t.b.membership().set(&format!("allow.{}.files", t.b.id()), json!(false)).unwrap();
    let link = t.a.state.network.peers.link(&t.b.id()).unwrap();
    let refused = link.call::<PeerSkillsInventory>(Empty {}).await.unwrap_err();
    assert_eq!(refused.code, codes::FORBIDDEN);
    let a = client(&t.a).await;
    let view = a.call::<SkillsNetworkViewMethod>(Empty {}).await.unwrap();
    let b = view.machines.iter().find(|machine| machine.id == t.b.id()).unwrap();
    assert_eq!(b.state, SkillsMachineState::Unreachable);
    assert!(b.detail.as_deref().unwrap().contains("Files"), "{:?}", b.detail);
    assert!(view.skills.iter().all(|skill| skill.name != "theirs"));
    // Neither can it be asked to send one.
    let error = a.call::<SkillsCopy>(copy("theirs", Some(t.b.id()), vec![to(&t.c.id())])).await.unwrap_err();
    assert!(error.to_string().contains("Files"), "{error}");
    let sent = a.call::<SkillsCopy>(copy("review", None, vec![to(&t.b.id())])).await.unwrap();
    let item = settled(&t.a, sent.targets[0].outbox_id.unwrap()).await;
    assert_eq!(item.state, OutboxState::Failed);
    assert!(item.last_error.unwrap().contains("Files"), "names the setting to turn on");
    assert!(!t.home(&t.b).join(".agents/skills/review").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_skill_is_made_available_to_more_harnesses_on_its_own_machine_at_once() {
    let Some(t) = trio().await else { return };
    skill(&t.home(&t.a).join(".claude/skills/review"), "v1");
    let a = client(&t.a).await;
    let here = SkillCopyTarget { machine: t.a.id(), homes: vec![SkillHome::Agents, SkillHome::Claude], replaces: Vec::new() };
    let done = a.call::<SkillsCopy>(copy("review", None, vec![here])).await.unwrap();
    assert_eq!(done.targets[0].state, SkillCopyState::Done, "{:?}", done.targets[0].error);
    let actions: Vec<_> = done.targets[0].placed.iter().map(|placed| (placed.home, placed.action)).collect();
    assert_eq!(actions, [(SkillHome::Agents, SkillPlaceAction::Written), (SkillHome::Claude, SkillPlaceAction::Same)]);
    let inventory = a.call::<SkillsInventoryMethod>(Empty {}).await.unwrap();
    let review = inventory.skills.iter().find(|skill| skill.name == "review").unwrap();
    assert_eq!(review.copies.len(), 2);
    assert_eq!(review.copies[0].hash, review.copies[1].hash);
    // A skill that is not there, or a name that climbs out, is refused before anything is queued.
    let missing = a.call::<SkillsCopy>(copy("missing", None, vec![to(&t.b.id())])).await.unwrap_err();
    assert!(missing.to_string().contains("no skill called missing"), "{missing}");
    assert!(a.call::<SkillsCopy>(copy("../review", None, vec![to(&t.b.id())])).await.is_err());
    assert!(t.a.state.store.outbox_list(Some(&t.b.id()), None).unwrap().is_empty());
}
