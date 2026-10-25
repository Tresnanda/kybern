//! Stale flags for memory notes.
//!
//! A claim (`note_claims`) that says ``As of `abc1234` `` and cites files is stale when
//! any cited path changed in `abc1234..HEAD` in one of the project's repositories. A
//! claim whose commit is not an ancestor of HEAD (rewritten history, another
//! clone) cannot be checked and is never flagged. A note is stale when any of its
//! live claims is; the first one found names the path.
//!
//! The git calls are small, local and blocking (`std::process`): callers are the
//! session spawn and `spawn_blocking` RPC reads. Results are cached by
//! `(note id, revision, HEAD of every repository)`, so a note is checked again only
//! after it or the code changed.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use anyhow::Result;
use kybern_protocol::methods::{Note, NoteId, NoteScope, NoteSummary, ProjectNoteRole, StaleInfo};
use kybern_protocol::{Project, ProjectId, ProjectKind};

use super::Orchestrator;
use super::note_claims::{Claim, parse_claims};

/// Entries kept before the cache starts over. A note costs one entry per revision and HEAD.
const CACHE_MAX_ENTRIES: usize = 4096;

type CacheKey = (NoteId, i64, String);

fn cache() -> &'static Mutex<HashMap<CacheKey, Option<StaleInfo>>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheKey, Option<StaleInfo>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// One git repository of a project.
#[derive(Debug, Clone)]
pub(super) struct RepoRef {
    pub path: PathBuf,
    /// For a group member: its folder relative to the group folder, so a note that
    /// writes `api/src/a.ts` can be matched to the repository's `src/a.ts`.
    pub prefix: Option<String>,
}

/// The repositories of a project: itself, or every member of a group that is still a repository.
pub(super) fn project_repos(project: &Project) -> Vec<RepoRef> {
    match project.kind {
        ProjectKind::Single => {
            if project.is_git {
                vec![RepoRef { path: PathBuf::from(&project.path), prefix: None }]
            } else {
                Vec::new()
            }
        }
        ProjectKind::Group => project
            .members
            .iter()
            .filter(|member| member.status == kybern_protocol::MemberStatus::Ok)
            .map(|member| {
                if member.path == kybern_store::GROUP_FOLDER_MEMBER {
                    RepoRef { path: PathBuf::from(&project.path), prefix: None }
                } else {
                    let path = member.path.split('/').fold(PathBuf::from(&project.path), |dir, part| dir.join(part));
                    RepoRef { path, prefix: Some(member.path.clone()) }
                }
            })
            .collect(),
    }
}

fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim_end().to_owned())
}

fn is_ancestor(repo: &Path, ancestor: &str, descendant: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["merge-base", "--is-ancestor", ancestor, descendant])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// What a project's repositories point at, one entry per repository that has a commit.
fn heads(repos: &[RepoRef]) -> Vec<(RepoRef, String)> {
    repos
        .iter()
        .filter_map(|repo| git(&repo.path, &["rev-parse", "--verify", "--quiet", "HEAD"]).map(|head| (repo.clone(), head)))
        .collect()
}

/// The paths a claim cites match a changed path when equal, or when the cited path is a
/// folder that contains it.
fn cited_changed<'a>(cited: &'a str, repo: &RepoRef, changed: &HashSet<String>) -> Option<&'a str> {
    let plain = cited.trim_start_matches("./").trim_end_matches('/');
    let relative = repo.prefix.as_deref().and_then(|prefix| plain.strip_prefix(prefix)).and_then(|rest| rest.strip_prefix('/'));
    [Some(plain), relative]
        .into_iter()
        .flatten()
        .any(|path| {
            !path.is_empty()
                && changed.iter().any(|changed| changed == path || changed.strip_prefix(path).is_some_and(|rest| rest.starts_with('/')))
        })
        .then_some(cited)
}

/// Check the claims against the repositories at `heads`. `None` when no cited path changed or
/// nothing could be checked.
fn check_claims(claims: &[Claim], heads: &[(RepoRef, String)]) -> Option<StaleInfo> {
    // Changed paths per (repository, commit): one diff however many claims cite the commit.
    let mut changed: HashMap<(PathBuf, String), Option<(String, HashSet<String>)>> = HashMap::new();
    for claim in claims {
        for (repo, head) in heads {
            let entry = changed.entry((repo.path.clone(), claim.sha.clone())).or_insert_with(|| {
                let full = git(&repo.path, &["rev-parse", "--verify", "--quiet", &format!("{}^{{commit}}", claim.sha)])?;
                if !is_ancestor(&repo.path, &full, head) {
                    return None;
                }
                // Both sides of a rename count as changed: a claim may cite the old path.
                let range = format!("{full}..{head}");
                let names = git(&repo.path, &["diff", "--name-only", "--no-renames", "-z", &range])?;
                Some((full, names.split('\0').filter(|name| !name.is_empty()).map(str::to_owned).collect()))
            });
            let Some((full, paths)) = entry else { continue };
            for cited in &claim.paths {
                if let Some(path) = cited_changed(cited, repo, paths) {
                    let range = format!("{full}..{head}");
                    let plain = path.trim_start_matches("./").trim_end_matches('/');
                    let inside = repo
                        .prefix
                        .as_deref()
                        .and_then(|prefix| plain.strip_prefix(prefix))
                        .and_then(|r| r.strip_prefix('/'))
                        .unwrap_or(plain);
                    let commit = git(&repo.path, &["log", "-1", "--format=%h", &range, "--", inside]).filter(|id| !id.is_empty());
                    return Some(StaleInfo { path: path.to_owned(), commit: commit.unwrap_or_else(|| head.chars().take(7).collect()) });
                }
            }
        }
    }
    None
}

/// Whether a summary can carry claims at all.
fn holds_claims(summary: &NoteSummary) -> bool {
    summary.scope == NoteScope::Project && summary.deleted_at.is_none() && summary.project_role != Some(ProjectNoteRole::Brief)
}

/// The stale flag of `note` against `repos`, from the cache when the note and the code are unchanged.
pub(super) fn note_stale(repos: &[RepoRef], note: &Note) -> Option<StaleInfo> {
    if !holds_claims(&note.summary) {
        return None;
    }
    let claims = parse_claims(&note.body);
    if claims.is_empty() {
        return None;
    }
    let heads = heads(repos);
    if heads.is_empty() {
        return None;
    }
    let head_key = heads.iter().map(|(repo, head)| format!("{}={head}", repo.path.display())).collect::<Vec<_>>().join(";");
    let key = (note.summary.id, note.summary.revision, head_key);
    if let Some(hit) = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&key) {
        return hit.clone();
    }
    let result = check_claims(&claims, &heads);
    let mut cache = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.len() >= CACHE_MAX_ENTRIES {
        cache.clear();
    }
    cache.insert(key, result.clone());
    result
}

impl Orchestrator {
    /// The project's repositories for staleness checks.
    fn stale_repos(&self, project_id: ProjectId) -> Vec<RepoRef> {
        match self.inner.store.project_get(project_id) {
            Ok(Some(project)) => project_repos(&project),
            _ => Vec::new(),
        }
    }

    /// Set `note.summary.stale` from git. A no-op for notes without claims.
    pub(super) fn flag_stale(&self, note: &mut Note) {
        if !holds_claims(&note.summary) {
            return;
        }
        let Some(project_id) = note.summary.project_id else { return };
        if parse_claims(&note.body).is_empty() {
            return;
        }
        note.summary.stale = note_stale(&self.stale_repos(project_id), note);
    }

    /// `summary` with its stale flag set; reads the body only when the note can hold claims.
    pub(super) fn flag_stale_summary(&self, summary: &mut NoteSummary) {
        if !holds_claims(summary) || summary.project_id.is_none() {
            return;
        }
        if let Ok(Some(mut note)) = self.inner.store.note_get(summary.id) {
            self.flag_stale(&mut note);
            summary.stale = note.summary.stale;
        }
    }

    /// The stale live notes of a project, each with the claim that flagged it.
    pub(super) fn stale_notes(&self, project_id: ProjectId) -> Result<Vec<(Note, StaleInfo)>> {
        let repos = self.stale_repos(project_id);
        let mut out = Vec::new();
        for note in self.inner.store.project_notes(project_id)? {
            if let Some(stale) = note_stale(&repos, &note) {
                out.push((note, stale));
            }
        }
        Ok(out)
    }

    /// `notes` (from `notes.list`) with the stale flags of every project note set.
    pub(super) fn flag_stale_all(&self, notes: &mut [NoteSummary]) {
        let mut by_project: HashMap<ProjectId, HashMap<NoteId, StaleInfo>> = HashMap::new();
        for summary in notes.iter().filter(|summary| holds_claims(summary)) {
            if let Some(project_id) = summary.project_id {
                by_project.entry(project_id).or_default();
            }
        }
        for (project_id, flagged) in &mut by_project {
            if let Ok(stale) = self.stale_notes(*project_id) {
                flagged.extend(stale.into_iter().map(|(note, info)| (note.summary.id, info)));
            }
        }
        for summary in notes.iter_mut() {
            summary.stale = summary.project_id.and_then(|id| by_project.get(&id)).and_then(|flagged| flagged.get(&summary.id)).cloned();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use chrono::Utc;
    use kybern_protocol::methods::{NoteChecklist, NoteSummary};

    use super::*;

    fn run(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    /// A scratch directory that removes itself.
    struct TempDir(PathBuf);

    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn repo() -> (TempDir, RepoRef) {
        let dir = TempDir(std::env::temp_dir().join(format!("kybern-stale-{}", uuid::Uuid::now_v7())));
        fs::create_dir_all(dir.path()).unwrap();
        run(dir.path(), &["init", "-q", "-b", "main"]);
        fs::create_dir_all(dir.path().join("src/auth")).unwrap();
        fs::write(dir.path().join("src/auth/session.ts"), "a").unwrap();
        fs::write(dir.path().join("src/other.ts"), "a").unwrap();
        run(dir.path(), &["add", "."]);
        run(dir.path(), &["commit", "-q", "-m", "first"]);
        let repo = RepoRef { path: dir.path().to_path_buf(), prefix: None };
        (dir, repo)
    }

    fn note(body: &str, revision: i64) -> Note {
        Note {
            summary: NoteSummary {
                id: uuid::Uuid::now_v7(),
                scope: NoteScope::Project,
                project_id: Some(uuid::Uuid::now_v7()),
                thread_id: None,
                title: "t".into(),
                preview: String::new(),
                checklist: NoteChecklist::default(),
                pinned: false,
                revision,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                deleted_at: None,
                origin: None,
                created_by_thread: None,
                project_role: None,
                category: None,
                stale: None,
                undated: false,
            },
            body: body.into(),
        }
    }

    fn claim(sha: &str, path: &str) -> String {
        format!("- 2026-10-25 · As of `{sha}`: login works (`{path}`).")
    }

    #[test]
    fn a_claim_is_stale_only_when_a_cited_path_changed_after_its_commit() {
        let (dir, repo) = repo();
        let first = run(dir.path(), &["rev-parse", "--short", "HEAD"]);
        let repos = [repo];
        assert_eq!(note_stale(&repos, &note(&claim(&first, "src/auth/session.ts"), 1)), None, "nothing changed yet");

        fs::write(dir.path().join("src/auth/session.ts"), "b").unwrap();
        run(dir.path(), &["commit", "-qam", "change session"]);
        let second = run(dir.path(), &["rev-parse", "--short", "HEAD"]);

        let stale = note_stale(&repos, &note(&claim(&first, "src/auth/session.ts"), 1)).expect("stale");
        assert_eq!((stale.path.as_str(), stale.commit.as_str()), ("src/auth/session.ts", second.as_str()));
        // A folder, a path that did not change, and a claim made after the change.
        assert!(note_stale(&repos, &note(&claim(&first, "src/auth/"), 1)).is_some());
        assert_eq!(note_stale(&repos, &note(&claim(&first, "src/other.ts"), 1)), None);
        assert_eq!(note_stale(&repos, &note(&claim(&second, "src/auth/session.ts"), 1)), None);
    }

    #[test]
    fn renames_and_deletions_of_a_cited_path_count_as_changes() {
        let (dir, repo) = repo();
        let first = run(dir.path(), &["rev-parse", "--short", "HEAD"]);
        run(dir.path(), &["mv", "src/other.ts", "src/moved.ts"]);
        run(dir.path(), &["commit", "-qam", "move"]);
        assert!(note_stale(&[repo], &note(&claim(&first, "src/other.ts"), 1)).is_some(), "the old path of a rename");
    }

    #[test]
    fn a_commit_that_is_not_an_ancestor_of_head_cannot_be_checked() {
        let (dir, repo) = repo();
        run(dir.path(), &["checkout", "-q", "-b", "side"]);
        fs::write(dir.path().join("src/auth/session.ts"), "side").unwrap();
        run(dir.path(), &["commit", "-qam", "side change"]);
        let side = run(dir.path(), &["rev-parse", "--short", "HEAD"]);
        run(dir.path(), &["checkout", "-q", "main"]);
        fs::write(dir.path().join("src/auth/session.ts"), "main").unwrap();
        run(dir.path(), &["commit", "-qam", "main change"]);
        let repos = [repo];
        assert_eq!(note_stale(&repos, &note(&claim(&side, "src/auth/session.ts"), 1)), None, "not an ancestor");
        assert_eq!(note_stale(&repos, &note(&claim("deadbeef", "src/auth/session.ts"), 1)), None, "unknown commit");
    }

    #[test]
    fn superseded_claims_and_notes_without_claims_are_not_flagged() {
        let (dir, repo) = repo();
        let first = run(dir.path(), &["rev-parse", "--short", "HEAD"]);
        fs::write(dir.path().join("src/auth/session.ts"), "b").unwrap();
        run(dir.path(), &["commit", "-qam", "change"]);
        let repos = [repo];
        let retired = format!("- ~~{}~~ (superseded 2026-10-26)", &claim(&first, "src/auth/session.ts")[2..]);
        assert_eq!(note_stale(&repos, &note(&retired, 1)), None);
        assert_eq!(note_stale(&repos, &note("Just prose about `src/auth/session.ts`.", 1)), None);
        let mut global = note(&claim(&first, "src/auth/session.ts"), 1);
        global.summary.scope = NoteScope::Global;
        assert_eq!(note_stale(&repos, &global), None);
    }

    #[test]
    fn results_are_cached_by_note_revision_and_head() {
        let (dir, repo) = repo();
        let first = run(dir.path(), &["rev-parse", "--short", "HEAD"]);
        let repos = [repo];
        let flagged = note(&claim(&first, "src/auth/session.ts"), 1);
        assert_eq!(note_stale(&repos, &flagged), None);
        // The same note and revision at the same HEAD never reads git again: poison the repo and ask.
        let head_key = format!("{}={}", dir.path().display(), run(dir.path(), &["rev-parse", "HEAD"]));
        cache().lock().unwrap().insert((flagged.summary.id, 1, head_key), Some(StaleInfo { path: "cached".into(), commit: "c".into() }));
        assert_eq!(note_stale(&repos, &flagged).unwrap().path, "cached");
        // A new revision, or a new HEAD, is checked again.
        let mut revised = flagged.clone();
        revised.summary.revision = 2;
        assert_eq!(note_stale(&repos, &revised), None);
        fs::write(dir.path().join("src/auth/session.ts"), "b").unwrap();
        run(dir.path(), &["commit", "-qam", "change"]);
        assert_eq!(note_stale(&repos, &flagged).unwrap().path, "src/auth/session.ts");
    }

    #[test]
    fn group_members_match_paths_written_with_the_member_folder() {
        let (dir, mut repo) = repo();
        let first = run(dir.path(), &["rev-parse", "--short", "HEAD"]);
        fs::write(dir.path().join("src/auth/session.ts"), "b").unwrap();
        run(dir.path(), &["commit", "-qam", "change"]);
        repo.prefix = Some("api".into());
        let repos = [repo];
        assert!(note_stale(&repos, &note(&claim(&first, "api/src/auth/session.ts"), 1)).is_some());
        assert!(note_stale(&repos, &note(&claim(&first, "src/auth/session.ts"), 2)).is_some());
    }
}
