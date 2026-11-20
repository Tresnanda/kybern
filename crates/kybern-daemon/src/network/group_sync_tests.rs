//! Group member sync across two machines on the in-process harness, with real git repositories and bare
//! "remotes" in a temporary folder. They skip on a computer without the `127.x.0.n` loopback aliases.

use std::path::{Path, PathBuf};

use super::super::harness::*;
use super::super::testutil::TempDir;
use super::*;

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// A bare repository with one commit, standing in for a remote.
fn remote(work: &Path, name: &str) -> PathBuf {
    let seed = work.join(format!("seed-{name}"));
    std::fs::create_dir_all(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    std::fs::write(seed.join("README"), name).unwrap();
    git(&seed, &["add", "README"]);
    git(&seed, &["commit", "-q", "-m", name]);
    let bare = work.join("remotes").join(format!("{name}.git"));
    std::fs::create_dir_all(bare.parent().unwrap()).unwrap();
    git(work, &["clone", "-q", "--bare", seed.to_str().unwrap(), bare.to_str().unwrap()]);
    bare
}

fn clone_into(remote: &Path, dir: &Path) {
    std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
    git(dir.parent().unwrap(), &["clone", "-q", remote.to_str().unwrap(), dir.file_name().unwrap().to_str().unwrap()]);
}

fn add_group(node: &Node, folder: &Path, members: &[&str]) -> ProjectId {
    let members = members.iter().map(|m| m.to_string()).collect();
    node.state.orchestrator.add_group_project(folder.to_string_lossy().into_owned(), Some("shop".into()), None, members).unwrap().id
}

/// What `projects.update { members }` does.
fn set_members(node: &Node, id: ProjectId, members: &[&str]) {
    let mut project = node.state.store.project_get(id).unwrap().unwrap();
    let paths = node
        .state
        .orchestrator
        .apply_group_update(&mut project, Some(members.iter().map(|m| m.to_string()).collect()), None, None)
        .unwrap()
        .unwrap();
    node.state.store.project_update(&project).unwrap();
    node.state.store.project_set_members(id, &paths).unwrap();
    node.state.network.wake();
}

fn member_paths(node: &Node, id: ProjectId) -> Vec<String> {
    node.state.store.project_get(id).unwrap().unwrap().members.into_iter().map(|m| m.path).collect()
}

struct Pair {
    _cluster: Cluster,
    a: Node,
    b: Node,
}

async fn pair() -> Option<Pair> {
    let cluster = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")])?.auto_join(true);
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    eventually("linked", WAIT, || linked(&a, &b)).await;
    Some(Pair { _cluster: cluster, a, b })
}

/// Run both machines' group sync once each way, as the network pass does.
async fn round(p: &Pair) {
    for (from, to) in [(&p.a, &p.b), (&p.b, &p.a)] {
        reconcile(&from.state).await;
        if let Some(link) = from.state.network.peers.link(&to.id()) {
            sync(&from.state, &link).await;
        }
        reconcile(&from.state).await;
    }
}

#[test]
fn group_keys_ignore_order_and_name_the_root_first() {
    let a = RepoIdentity { root_commit: Some("aaa".into()), remote: Some("github.com/x/a".into()), ..Default::default() };
    let b = RepoIdentity { remote: Some("github.com/x/b".into()), ..Default::default() };
    assert_eq!(group_key(&[a.clone(), b.clone()]), group_key(&[b.clone(), a.clone()]));
    assert_ne!(group_key(std::slice::from_ref(&a)), group_key(&[a.clone(), b.clone()]));
    assert_eq!(identity_key(&a).as_deref(), Some("root:aaa"));
    assert_eq!(member_entity("group:k", &b).as_deref(), Some("group:k|remote:github.com/x/b"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_repository_added_on_one_machine_is_cloned_into_the_group_on_the_other_and_removed_again() {
    let Some(p) = pair().await else { return };
    let work = TempDir::new("group-sync");
    let (api, web, docs) = (remote(work.path(), "api"), remote(work.path(), "web"), remote(work.path(), "docs"));
    let (mac, fedora) = (work.path().join("mac/shop"), work.path().join("fedora/shop"));
    for folder in [&mac, &fedora] {
        clone_into(&api, &folder.join("api"));
        clone_into(&web, &folder.join("web"));
    }
    let on_a = add_group(&p.a, &mac, &["api", "web"]);
    let on_b = add_group(&p.b, &fedora, &["api", "web"]);
    round(&p).await;
    let lineage = |node: &Node, id| load_local(&node.state).unwrap().get(&id).map(|l| l.lineage.clone());
    assert!(lineage(&p.a, on_a).is_some());
    assert_eq!(lineage(&p.a, on_a), lineage(&p.b, on_b), "the same group joins the same lineage on both machines");

    // Added on the Mac: fedora clones it into its own group folder.
    clone_into(&docs, &mac.join("docs"));
    set_members(&p.a, on_a, &["api", "web", "docs"]);
    round(&p).await;
    eventually("fedora's group has docs", WAIT, || member_paths(&p.b, on_b).contains(&"docs".to_string())).await;
    assert!(fedora.join("docs/README").is_file());
    round(&p).await;
    assert!(pending(&p.b.state, on_b).is_empty());

    // Removed on fedora: the Mac drops it too, and both folders stay.
    set_members(&p.b, on_b, &["api", "docs"]);
    round(&p).await;
    eventually("the Mac's group drops web", WAIT, || !member_paths(&p.a, on_a).contains(&"web".to_string())).await;
    assert!(mac.join("web/README").is_file(), "a removed repository's folder is never deleted");
    round(&p).await;
    assert_eq!(member_paths(&p.b, on_b), vec!["api", "docs"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repositories_added_on_both_machines_at_once_both_survive() {
    let Some(p) = pair().await else { return };
    let work = TempDir::new("group-sync-both");
    let (api, web, docs, ops) =
        (remote(work.path(), "api"), remote(work.path(), "web"), remote(work.path(), "docs"), remote(work.path(), "ops"));
    let (mac, fedora) = (work.path().join("mac/shop"), work.path().join("fedora/shop"));
    for folder in [&mac, &fedora] {
        clone_into(&api, &folder.join("api"));
        clone_into(&web, &folder.join("web"));
    }
    let on_a = add_group(&p.a, &mac, &["api", "web"]);
    let on_b = add_group(&p.b, &fedora, &["api", "web"]);
    round(&p).await;
    clone_into(&docs, &mac.join("docs"));
    set_members(&p.a, on_a, &["api", "web", "docs"]);
    clone_into(&ops, &fedora.join("ops"));
    set_members(&p.b, on_b, &["api", "web", "ops"]);
    for _ in 0..3 {
        round(&p).await;
    }
    let all = |node: &Node, id| {
        let mut paths = member_paths(node, id);
        paths.sort();
        paths == ["api", "docs", "ops", "web"]
    };
    eventually("both groups hold all four", WAIT, || all(&p.a, on_a) && all(&p.b, on_b)).await;
}

/// A Mac and a fedora with the same two-repository group, synced once.
struct Shop {
    p: Pair,
    work: TempDir,
    mac: PathBuf,
    fedora: PathBuf,
    on_a: ProjectId,
    on_b: ProjectId,
}

async fn shop(name: &str) -> Option<Shop> {
    let p = pair().await?;
    let work = TempDir::new(name);
    let (api, web) = (remote(work.path(), "api"), remote(work.path(), "web"));
    let (mac, fedora) = (work.path().join("mac/shop"), work.path().join("fedora/shop"));
    for folder in [&mac, &fedora] {
        clone_into(&api, &folder.join("api"));
        clone_into(&web, &folder.join("web"));
    }
    let on_a = add_group(&p.a, &mac, &["api", "web"]);
    let on_b = add_group(&p.b, &fedora, &["api", "web"]);
    round(&p).await;
    Some(Shop { p, work, mac, fedora, on_a, on_b })
}

/// A repository with one commit and no remote.
fn local_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "trunk"]);
    std::fs::write(dir.join("n.md"), "n").unwrap();
    git(dir, &["add", "n.md"]);
    git(dir, &["commit", "-q", "-m", "n"]);
}

fn origin(dir: &Path) -> Option<String> {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(["config", "--get", "remote.origin.url"]).output().unwrap();
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_repository_without_a_remote_is_copied_from_the_machine_that_has_it() {
    let Some(t) = shop("group-sync-local").await else { return };
    local_repo(&t.mac.join("notes"));
    set_members(&t.p.a, t.on_a, &["api", "web", "notes"]);
    round(&t.p).await;
    eventually("fedora's group has notes", WAIT, || member_paths(&t.p.b, t.on_b).contains(&"notes".to_string())).await;
    let notes = t.fedora.join("notes");
    assert_eq!(std::fs::read_to_string(notes.join("n.md")).unwrap(), "n");
    let head = std::process::Command::new("git").arg("-C").arg(&notes).args(["symbolic-ref", "--short", "HEAD"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "trunk", "the copy is on the branch the other machine has");
    assert_eq!(origin(&notes), None);
    round(&t.p).await;
    assert!(pending(&t.p.b.state, t.on_b).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_repository_this_machine_cannot_clone_is_copied_and_keeps_its_origin() {
    let Some(t) = shop("group-sync-noclone").await else { return };
    let docs = remote(t.work.path(), "docs");
    clone_into(&docs, &t.mac.join("docs"));
    // The remote is gone (or this machine has no access): the clone fails, the copy works.
    std::fs::remove_dir_all(&docs).unwrap();
    set_members(&t.p.a, t.on_a, &["api", "web", "docs"]);
    round(&t.p).await;
    eventually("fedora's group has docs", WAIT, || member_paths(&t.p.b, t.on_b).contains(&"docs".to_string())).await;
    assert!(t.fedora.join("docs/README").is_file());
    assert_eq!(
        origin(&t.fedora.join("docs")),
        Some(docs.to_string_lossy().into_owned()),
        "fetch and push work once this machine has access"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_large_copy_waits_for_the_person_and_then_goes() {
    let Some(t) = shop("group-sync-large").await else { return };
    t.p.b.state.network.group_sync.auto_copy.store(1, Ordering::Relaxed);
    local_repo(&t.mac.join("notes"));
    set_members(&t.p.a, t.on_a, &["api", "web", "notes"]);
    round(&t.p).await;
    let offer = || {
        pending(&t.p.b.state, t.on_b)
            .into_iter()
            .find_map(|m| m.problem)
            .and_then(|p| p.action)
            .filter(|a| a.label.starts_with("Copy it ("))
    };
    eventually("fedora offers to copy it", WAIT, || offer().is_some()).await;
    assert_eq!(offer().unwrap().params.unwrap()["copy_large"], true);
    assert!(!t.fedora.join("notes").exists());
    retry(&t.p.b.state, t.on_b, true).await.unwrap();
    eventually("fedora's group has notes", WAIT, || member_paths(&t.p.b, t.on_b).contains(&"notes".to_string())).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_transport_helper_url_from_another_machine_is_never_run() {
    let Some(t) = shop("group-sync-ext").await else { return };
    let evil = t.mac.join("evil");
    local_repo(&evil);
    let ran = t.work.path().join("ran");
    git(&evil, &["remote", "add", "origin", &format!("ext::sh -c touch% {}", ran.display())]);
    set_members(&t.p.a, t.on_a, &["api", "web", "evil"]);
    round(&t.p).await;
    eventually("fedora's group has the repository, copied", WAIT, || member_paths(&t.p.b, t.on_b).contains(&"evil".to_string())).await;
    assert!(!ran.exists(), "the helper never ran");
    assert_eq!(origin(&t.fedora.join("evil")), None, "the helper URL is not set as origin here");
}
