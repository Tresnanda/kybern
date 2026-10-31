//! Which repository a project is, in terms another machine can match (design §4.4).
//!
//! `Project.repo` holds the root commit and the normalized `origin` of a project's checkout; a
//! group project holds the sorted identities of its member repositories in `Project.repos`. The
//! values are cached in `projects.repo_identity`, so listing projects never runs git, and they are
//! what `machines.info` reports and remote delegation matches checkouts by.
//!
//! * A new project is looked at right away, in the background (`Orchestrator::spawn_repo_identity`).
//! * [`run`] looks at every project once after start, a few at a time, then re-reads the remotes
//!   now and then. The root commit never changes for a checkout, so a refresh keeps the cached one
//!   and only asks git for the remote, which is one `git config` call.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use kybern_protocol::{Project, ProjectKind, ProjectRepoIdentity, RepoIdentity};
use kybern_store::Store;
use tokio::sync::Semaphore;

use super::git_transfer::{identity_of, is_shallow, normalize_remote};
use crate::orchestrator::member_dir;
use crate::state::AppState;

/// How long git may take to answer for one checkout before its identity is left for the next pass.
const GIT_BUDGET: Duration = Duration::from_secs(30);
/// Checkouts examined at the same time.
const PARALLEL: usize = 2;
/// Wait after start, so the identity pass never competes with the daemon's own startup work.
const STARTUP_DELAY: Duration = Duration::from_secs(5);
/// How often the remotes of every checkout are read again.
const REFRESH_EVERY: Duration = Duration::from_secs(15 * 60);

/// The checkouts that make up a project: the folder itself, or the member repositories of a group.
fn checkouts(project: &Project) -> Vec<PathBuf> {
    if project.kind != ProjectKind::Group {
        return vec![PathBuf::from(&project.path)];
    }
    let folder = PathBuf::from(&project.path);
    project.members.iter().map(|member| member_dir(&folder, &member.path)).collect()
}

/// The identity of one checkout, reusing the cached root commit when there is one.
async fn identity_for(path: &std::path::Path, cached: Option<&RepoIdentity>) -> RepoIdentity {
    let repo = kybern_git::Repo::new(path);
    // A cached identity from before roots were listed has no `root_commits`, and a shallow clone
    // cached its cut point as a root: both are read again.
    match cached.filter(|cached| !cached.root_commits.is_empty()) {
        Some(cached) if !is_shallow(&repo).await => {
            let remote = repo.config_get("remote.origin.url").await.and_then(|url| normalize_remote(&url));
            RepoIdentity { remote, ..cached.clone() }
        }
        _ => identity_of(path).await,
    }
}

/// The identity a project has now. `cached` is what the store holds, used to skip the expensive
/// root commit lookup. A project that is not a repository has an empty identity.
pub async fn compute(project: &Project, cached: Option<&ProjectRepoIdentity>) -> ProjectRepoIdentity {
    let paths = checkouts(project);
    if project.kind != ProjectKind::Group {
        let known = cached.and_then(|cached| cached.repo.as_ref());
        let identity = match paths.first() {
            Some(path) if project.is_git => identity_for(path, known).await,
            _ => RepoIdentity::default(),
        };
        return ProjectRepoIdentity { repo: Some(identity).filter(|identity| !identity.is_empty()), repos: Vec::new() };
    }
    // A group has no single cached root commit to reuse, so every member is read again.
    let mut members = Vec::new();
    for path in &paths {
        let identity = identity_for(path, None).await;
        if !identity.is_empty() {
            members.push(identity);
        }
    }
    let primary = members.first().cloned();
    members.sort();
    members.dedup();
    ProjectRepoIdentity { repo: primary, repos: members }
}

/// Read one project's identity and store it. Returns whether the stored value changed.
pub async fn refresh(store: &Store, project: &Project) -> bool {
    let cached = ProjectRepoIdentity { repo: project.repo.clone(), repos: project.repos.clone() };
    let cached = Some(&cached).filter(|cached| cached.repo.is_some() || !cached.repos.is_empty());
    let Ok(identity) = tokio::time::timeout(GIT_BUDGET, compute(project, cached)).await else {
        tracing::debug!(project = %project.id, "reading the repository identity took too long; leaving it for the next pass");
        return false;
    };
    let stored = Some(&identity).filter(|identity| identity.repo.is_some() || !identity.repos.is_empty());
    match store.project_set_repo_identity(project.id, stored) {
        Ok(changed) => changed,
        Err(error) => {
            tracing::warn!(project = %project.id, %error, "could not store a project's repository identity");
            false
        }
    }
}

/// Read the identities of `projects`, a few at a time. Returns whether any changed.
pub async fn refresh_all(store: &Store, projects: Vec<Project>) -> bool {
    let gate = Arc::new(Semaphore::new(PARALLEL));
    let jobs = projects.into_iter().map(|project| {
        let gate = gate.clone();
        async move {
            let _permit = gate.acquire().await.ok();
            refresh(store, &project).await
        }
    });
    futures::future::join_all(jobs).await.into_iter().any(|changed| changed)
}

/// The background pass: every project once after start, then the remotes again every so often.
pub async fn run(state: AppState) {
    tokio::select! {
        _ = state.shutdown.cancelled() => return,
        _ = tokio::time::sleep(STARTUP_DELAY) => {}
    }
    loop {
        match state.store.projects_list() {
            Ok(projects) => {
                if refresh_all(&state.store, projects).await {
                    super::spaces::reconcile(&state).await;
                    state.orchestrator.publish_projects();
                }
            }
            Err(error) => tracing::warn!(%error, "could not list projects to read their repository identity"),
        }
        tokio::select! {
            _ = state.shutdown.cancelled() => return,
            _ = tokio::time::sleep(REFRESH_EVERY) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;

    use chrono::Utc;
    use kybern_protocol::{MemberStatus, ProjectMember};
    use uuid::Uuid;

    use super::*;
    use crate::network::testutil::TempDir;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repository with one commit holding `content`, so two of them differ in their root commit.
    fn repo(root: &Path, name: &str, content: &str, remote: Option<&str>) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("file.txt"), content).unwrap();
        git(&dir, &["add", "file.txt"]);
        git(&dir, &["commit", "-q", "-m", content]);
        if let Some(remote) = remote {
            git(&dir, &["remote", "add", "origin", remote]);
        }
        dir
    }

    fn project(path: &Path, kind: ProjectKind, members: Vec<ProjectMember>) -> Project {
        Project {
            repo: None,
            repos: Vec::new(),
            id: Uuid::now_v7(),
            name: "p".into(),
            path: path.to_string_lossy().into_owned(),
            is_git: true,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            kind,
            members,
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
        }
    }

    #[tokio::test]
    async fn the_same_root_commit_with_different_remotes_is_one_repository_by_its_root() {
        let dir = TempDir::new("repoid");
        let a = repo(dir.path(), "a", "one", Some("git@github.com:Acme/Thing.git"));
        // A clone elsewhere with a fork as its origin: the same root commit.
        let b = dir.path().join("b");
        git(dir.path(), &["clone", "-q", a.to_str().unwrap(), b.to_str().unwrap()]);
        git(&b, &["remote", "set-url", "origin", "https://github.com/me/thing-fork.git"]);
        let a = compute(&project(&a, ProjectKind::Single, vec![]), None).await.repo.unwrap();
        let b = compute(&project(&b, ProjectKind::Single, vec![]), None).await.repo.unwrap();
        assert!(a.root_commit.is_some());
        assert_eq!(a.root_commit, b.root_commit);
        assert_eq!(a.remote.as_deref(), Some("github.com/acme/thing"));
        assert_eq!(b.remote.as_deref(), Some("github.com/me/thing-fork"));
        assert!(super::super::git_transfer::same_repo(&a, &b), "the root commit decides when both have one");
    }

    #[tokio::test]
    async fn the_same_remote_with_different_roots_is_a_different_repository_by_its_root() {
        let dir = TempDir::new("repoid");
        let a = repo(dir.path(), "a", "one", Some("https://github.com/acme/thing.git"));
        let b = repo(dir.path(), "b", "two", Some("git@github.com:acme/thing"));
        let a = compute(&project(&a, ProjectKind::Single, vec![]), None).await.repo.unwrap();
        let b = compute(&project(&b, ProjectKind::Single, vec![]), None).await.repo.unwrap();
        assert_eq!(a.remote, b.remote, "both normalize to the same remote");
        assert_ne!(a.root_commit, b.root_commit);
        assert!(!super::super::git_transfer::same_repo(&a, &b), "different roots are different repositories");
    }

    #[tokio::test]
    async fn a_checkout_without_a_remote_is_identified_by_its_root_commit() {
        let dir = TempDir::new("repoid");
        let a = repo(dir.path(), "a", "one", None);
        let identity = compute(&project(&a, ProjectKind::Single, vec![]), None).await;
        let repo = identity.repo.unwrap();
        assert!(repo.root_commit.is_some() && repo.remote.is_none());
        assert!(identity.repos.is_empty(), "a single project has no member list");
    }

    #[tokio::test]
    async fn a_folder_that_is_not_a_repository_has_no_identity() {
        let dir = TempDir::new("repoid");
        let folder = dir.path().join("plain");
        std::fs::create_dir_all(&folder).unwrap();
        let mut plain = project(&folder, ProjectKind::Single, vec![]);
        plain.is_git = false;
        assert_eq!(compute(&plain, None).await, ProjectRepoIdentity::default());
        // Marked as a repository but not one: git fails and the identity stays empty.
        let mut liar = plain.clone();
        liar.is_git = true;
        assert_eq!(compute(&liar, None).await, ProjectRepoIdentity::default());
    }

    #[tokio::test]
    async fn a_group_lists_its_members_sorted_with_the_first_as_primary() {
        let dir = TempDir::new("repoid");
        let folder = dir.path().join("group");
        std::fs::create_dir_all(&folder).unwrap();
        let first = repo(&folder, "zeta", "zeta", Some("https://github.com/acme/zeta.git"));
        let second = repo(&folder, "alpha", "alpha", Some("https://github.com/acme/alpha.git"));
        let plain = folder.join("notes");
        std::fs::create_dir_all(&plain).unwrap();
        let members = ["zeta", "alpha", "notes"]
            .iter()
            .map(|name| ProjectMember { path: (*name).into(), name: (*name).into(), status: MemberStatus::Ok })
            .collect();
        let group = project(&folder, ProjectKind::Group, members);
        let identity = compute(&group, None).await;
        let primary = compute(&project(&first, ProjectKind::Single, vec![]), None).await.repo.unwrap();
        let other = compute(&project(&second, ProjectKind::Single, vec![]), None).await.repo.unwrap();
        assert_eq!(identity.repo, Some(primary.clone()), "the first member is the primary");
        let mut expected = vec![primary, other];
        expected.sort();
        assert_eq!(identity.repos, expected, "sorted, and the folder without a repository is left out");
    }

    #[tokio::test]
    async fn a_refresh_keeps_the_cached_root_commit_and_picks_up_a_changed_remote() {
        let dir = TempDir::new("repoid");
        let a = repo(dir.path(), "a", "one", Some("https://github.com/acme/thing.git"));
        let mut p = project(&a, ProjectKind::Single, vec![]);
        let first = compute(&p, None).await;
        git(&a, &["remote", "set-url", "origin", "https://github.com/acme/renamed.git"]);
        p.repo = first.repo.clone();
        let cached = ProjectRepoIdentity { repo: p.repo.clone(), repos: vec![] };
        let second = compute(&p, Some(&cached)).await;
        assert_eq!(second.repo.as_ref().unwrap().root_commit, first.repo.as_ref().unwrap().root_commit);
        assert_eq!(second.repo.unwrap().remote.as_deref(), Some("github.com/acme/renamed"));
    }

    #[tokio::test]
    async fn refresh_stores_the_identity_and_reports_only_a_change() {
        let dir = TempDir::new("repoid");
        let a = repo(dir.path(), "a", "one", Some("https://github.com/acme/thing.git"));
        let store = Store::open_in_memory().unwrap();
        let mut p = project(&a, ProjectKind::Single, vec![]);
        p.path = a.to_string_lossy().into_owned();
        store.project_insert(&p).unwrap();
        let stored = store.project_get(p.id).unwrap().unwrap();
        assert!(stored.repo.is_none());
        assert!(refresh(&store, &stored).await, "the first read stores the identity");
        let stored = store.project_get(p.id).unwrap().unwrap();
        assert_eq!(stored.repo.as_ref().unwrap().remote.as_deref(), Some("github.com/acme/thing"));
        assert!(!refresh(&store, &stored).await, "reading it again changes nothing");
        git(&a, &["remote", "set-url", "origin", "https://github.com/acme/other.git"]);
        assert!(refresh(&store, &stored).await, "a changed remote is stored");
        assert_eq!(store.project_get(p.id).unwrap().unwrap().repo.unwrap().remote.as_deref(), Some("github.com/acme/other"));
    }
}
