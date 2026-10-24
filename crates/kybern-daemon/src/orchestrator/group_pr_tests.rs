// Group thread status, commits and pull requests. Included into
// `orchestrator::tests` for its fixture and the `git_in` helper.

fn init_member(dir: &std::path::Path, file: &str) {
    std::fs::create_dir_all(dir).unwrap();
    git_in(dir, &["init", "-q"]);
    git_in(dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    git_in(dir, &["config", "user.name", "Group Test"]);
    git_in(dir, &["config", "user.email", "group@example.com"]);
    git_in(dir, &["config", "commit.gpgsign", "false"]);
    std::fs::write(dir.join(file), "one\n").unwrap();
    git_in(dir, &["add", "."]);
    git_in(dir, &["commit", "-q", "-m", "init"]);
}

fn group_member(folder: &std::path::Path, path: &str, included: bool, missing: bool) -> ThreadMember {
    ThreadMember {
        path: path.into(),
        name: if path == "." { "acme".into() } else { path.into() },
        included: included && !missing,
        source_path: super::group_git::member_dir(folder, path).to_string_lossy().into_owned(),
        worktree: None,
        base_branch: None,
        base_commit: None,
        worktree_state: None,
        missing,
    }
}

/// A local-mode group thread in `<root>/acme`: the folder itself is a repository
/// holding `api` and `web`, `infra` is deselected and `docs` is missing.
fn group_with_folder_repo(fixture: &Fixture) -> (std::path::PathBuf, Thread) {
    let folder = fixture.root.join("acme");
    init_member(&folder, "README.md");
    init_member(&folder.join("api"), "a.rs");
    init_member(&folder.join("web"), "w.ts");
    init_member(&folder.join("infra"), "main.tf");
    let mut thread = fixture.thread(ThreadStatus::Idle);
    thread.cwd = folder.to_string_lossy().into_owned();
    thread.members = vec![
        group_member(&folder, ".", true, false),
        group_member(&folder, "api", true, false),
        group_member(&folder, "web", true, false),
        group_member(&folder, "infra", false, false),
        group_member(&folder, "docs", false, true),
    ];
    fixture.store.thread_upsert(&thread).unwrap();
    (folder, thread)
}

#[tokio::test]
async fn group_status_lists_every_member_and_ignores_nested_members_in_the_folder() {
    let fixture = Fixture::new();
    let (folder, thread) = group_with_folder_repo(&fixture);
    std::fs::write(folder.join("api/new.rs"), "x\n").unwrap();
    let status = fixture.orchestrator.group_git_status(&thread).await.unwrap();
    assert!(status.is_git);
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.dirty_files, 0, "nested members are not the group folder's changes");
    let rows: Vec<_> = status.repos.iter().map(|r| (r.repo.as_str(), r.included, r.status, r.git.dirty_files)).collect();
    assert_eq!(
        rows,
        [
            (".", true, MemberStatus::Ok, 0),
            ("api", true, MemberStatus::Ok, 1),
            ("web", true, MemberStatus::Ok, 0),
            ("infra", false, MemberStatus::Ok, 0),
            ("docs", false, MemberStatus::Missing, 0),
        ]
    );
    assert_eq!(status.repos[3].git.branch.as_deref(), Some("main"));
    assert!(status.repos.iter().all(|r| r.git.repos.is_empty()));
    assert!(!status.repos[4].git.is_git);
}

#[tokio::test]
async fn group_commit_fans_out_and_never_adds_nested_members_to_the_folder() {
    let fixture = Fixture::new();
    let (folder, thread) = group_with_folder_repo(&fixture);
    std::fs::write(folder.join("README.md"), "two\n").unwrap();
    std::fs::write(folder.join("api/new.rs"), "x\n").unwrap();
    assert!(fixture.orchestrator.group_has_changes(&thread).await);
    let result = fixture.orchestrator.group_commit(&thread, Some("Update docs".into())).await.unwrap();
    let repos: Vec<_> = result.commits.iter().map(|c| c.repo.as_str()).collect();
    assert_eq!(repos, [".", "api"]);
    assert_eq!(result.commit, result.commits[0].commit);
    assert_eq!(git_in(&folder, &["show", "--name-only", "--format=", "HEAD"]), "README.md");
    assert_eq!(git_in(&folder.join("api"), &["log", "-1", "--format=%s"]), "Update docs");
    assert_eq!(git_in(&folder.join("web"), &["rev-list", "--count", "HEAD"]), "1");
    assert!(!fixture.orchestrator.group_has_changes(&thread).await);
    let error = fixture.orchestrator.group_commit(&thread, Some("Again".into())).await.unwrap_err();
    assert_eq!(error.to_string(), "nothing to commit");
}

#[test]
fn group_branches_of_an_unknown_member_name_the_project() {
    let fixture = Fixture::new();
    let mut project = fixture.project.clone();
    project.kind = ProjectKind::Group;
    project.members = vec![ProjectMember { path: "api".into(), name: "api".into(), status: MemberStatus::Ok }];
    let error = futures::executor::block_on(fixture.orchestrator.group_branches(&project, Some("web"))).unwrap_err();
    assert_eq!(error.to_string(), "web isn't a repository of fixture.");
}

/// A fake `gh` for group pull requests: `api` opens #128, `web` #77; edits
/// write the new body next to the log.
#[cfg(unix)]
fn fake_group_gh(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir).unwrap();
    let (log, script) = (dir.join("gh.log"), dir.join("gh"));
    let body = r#"#!/bin/sh
name=$(basename "$PWD")
echo "$name $@" >> "LOG"
case "$1 $2" in
  --version*) echo "gh version 2.0.0" ;;
  "repo view") echo main ;;
  "pr create") echo "https://github.com/acme/$name/pull/1" ;;
  "pr view")
    case "$name" in api) n=128 ;; web) n=77 ;; *) n=5 ;; esac
    echo "{\"number\":$n,\"title\":\"t\",\"url\":\"https://github.com/acme/$name/pull/$n\",\"state\":\"OPEN\",\"headRefName\":\"feat\",\"baseRefName\":\"main\",\"isDraft\":false,\"author\":{\"login\":\"me\"},\"updatedAt\":\"2026-01-01T00:00:00Z\"}" ;;
  "pr edit") cat > "DIR/edit-$name-$3" ;;
esac
"#
    .replace("LOG", &log.to_string_lossy())
    .replace("DIR", &dir.to_string_lossy());
    std::fs::write(&script, body).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script, log)
}

#[cfg(unix)]
#[tokio::test]
async fn group_pull_requests_skip_repos_without_a_remote_and_cross_link_the_rest() {
    let fixture = Fixture::new();
    let folder = fixture.root.join("acme");
    for (name, remote) in [("api", true), ("web", true), ("infra", false)] {
        let dir = folder.join(name);
        init_member(&dir, "a.txt");
        if remote {
            let bare = fixture.root.join("github.com/acme").join(format!("{name}.git"));
            std::fs::create_dir_all(&bare).unwrap();
            git_in(&bare, &["init", "-q", "--bare"]);
            git_in(&dir, &["remote", "add", "origin", &bare.to_string_lossy()]);
            git_in(&dir, &["push", "-q", "origin", "main"]);
        }
        git_in(&dir, &["switch", "-q", "-c", "feat"]);
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
    }
    let mut thread = fixture.thread(ThreadStatus::Idle);
    thread.title = "Add SSO to the admin console".into();
    thread.cwd = folder.to_string_lossy().into_owned();
    thread.members = ["api", "web", "infra"].iter().map(|path| group_member(&folder, path, true, false)).collect();
    fixture.store.thread_upsert(&thread).unwrap();
    let (gh, log) = fake_group_gh(&fixture.root.join("gh"));

    let result = fixture
        .orchestrator
        .pr_create_group(
            methods::PrCreateGroupParams { thread_id: thread.id, repos: None, draft: false, commit_first: true },
            &gh.to_string_lossy(),
        )
        .await
        .unwrap();
    let created: Vec<_> = result.pull_requests.iter().map(|p| (p.repo.as_str(), p.pull_request.number)).collect();
    assert_eq!(created, [("api", 128), ("web", 77)]);
    let skipped: Vec<_> = result.skipped.iter().map(|s| (s.path.as_str(), s.reason.as_str())).collect();
    assert_eq!(skipped, [("infra", "No GitHub remote")]);
    for name in ["api", "web"] {
        assert_eq!(git_in(&folder.join(name), &["status", "--porcelain"]), "", "{name} was committed first");
        let bare = fixture.root.join("github.com/acme").join(format!("{name}.git"));
        assert_eq!(git_in(&bare, &["rev-parse", "feat"]), git_in(&folder.join(name), &["rev-parse", "HEAD"]), "{name} was pushed");
    }
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(calls.contains("api pr edit 128 --body-file -"), "{calls}");
    assert!(calls.contains("web pr edit 77 --body-file -"), "{calls}");
    assert!(!calls.lines().any(|line| line.starts_with("infra pr")), "{calls}");
    let body = std::fs::read_to_string(fixture.root.join("gh/edit-api-128")).unwrap();
    assert_eq!(
        body,
        "---\nPart of a change across 2 repositories (Kybern chat \u{201c}Add SSO to the admin console\u{201d}):\n- acme/api#128\n- acme/web#77\n"
    );
    let unknown = fixture
        .orchestrator
        .pr_create_group(
            methods::PrCreateGroupParams { thread_id: thread.id, repos: Some(vec!["docs".into()]), draft: false, commit_first: true },
            &gh.to_string_lossy(),
        )
        .await
        .unwrap_err();
    assert_eq!(unknown.to_string(), "docs isn't a repository of this chat.");
}
