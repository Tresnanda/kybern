//! Repository issues through the user's `gh` CLI (#217): `github.issue.list` and `github.issue.detail`,
//! built like the pull request calls in `github.rs` and `github_review.rs`.

use std::path::Path;

use anyhow::{Result, anyhow, ensure};
use kybern_protocol::methods::*;
use serde_json::Value;

use crate::github::{avatar_url, run};

const LIST_FIELDS: &str =
    "number,title,url,state,stateReason,author,labels,assignees,milestone,createdAt,updatedAt,closedByPullRequestsReferences";
const VIEW_FIELDS: &str =
    "number,title,url,state,stateReason,author,labels,assignees,milestone,createdAt,updatedAt,closedByPullRequestsReferences,body,comments";
/// Issues per page.
pub(crate) const MAX_LIMIT: u32 = 100;
/// Furthest an offset may reach: `gh` has no cursor, so a page is read by skipping what precedes it.
pub(crate) const MAX_OFFSET: u32 = 400;
const MAX_LABELS: usize = 10;
const MAX_TEXT: usize = 256;
/// Comments, and linked pull requests, read per issue.
const MAX_COMMENTS: usize = 100;
const MAX_LINKED: usize = 10;
/// Characters kept of a body or a comment.
const MAX_BODY: usize = 60_000;
/// Labels offered to the Labels filter.
const MAX_REPO_LABELS: usize = 100;

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn time(v: &Value, key: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    v.get(key).and_then(Value::as_str).and_then(|s| s.parse().ok())
}

fn truncated(value: &str, limit: usize) -> String {
    match value.char_indices().nth(limit) {
        Some((end, _)) => value[..end].to_owned(),
        None => value.to_owned(),
    }
}

/// One issue of `gh issue list|view --json`. `None` for an entry without a number, title and link.
pub(crate) fn parse_issue(v: &Value) -> Option<Issue> {
    let number = v.get("number")?.as_u64()?;
    let title = v.get("title")?.as_str()?.to_owned();
    let url = v.get("url")?.as_str()?.to_owned();
    let author = v.pointer("/author/login").and_then(Value::as_str).unwrap_or_default().to_owned();
    let author_is_bot = v.pointer("/author/is_bot").and_then(Value::as_bool).unwrap_or(false);
    let updated_at = time(v, "updatedAt").unwrap_or_else(chrono::Utc::now);
    let labels = v
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|l| Some(PrLabel { name: l.get("name")?.as_str()?.to_owned(), color: text(l, "color") }))
        .collect();
    let assignees = v
        .get("assignees")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let login = a.get("login").and_then(Value::as_str).filter(|s| !s.is_empty())?;
            let is_bot = a.get("is_bot").and_then(Value::as_bool).unwrap_or(false);
            Some(PrPerson { login: login.to_owned(), avatar_url: avatar_url(&url, login, is_bot), is_bot })
        })
        .take(20)
        .collect();
    Some(Issue {
        number,
        title,
        state: text(v, "state").to_ascii_uppercase(),
        state_reason: Some(text(v, "stateReason").to_ascii_uppercase()).filter(|s| !s.is_empty()),
        author_avatar_url: avatar_url(&url, &author, author_is_bot),
        author,
        author_is_bot,
        created_at: time(v, "createdAt").unwrap_or(updated_at),
        updated_at,
        labels,
        assignees,
        milestone: v.pointer("/milestone/title").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned),
        linked_pull_requests: v
            .get("closedByPullRequestsReferences")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|r| r.get("number")?.as_u64())
            .collect(),
        url,
        repo: None,
    })
}

/// The `gh issue list` arguments for `p`, or why it cannot be asked. Values that `gh` could read as a
/// flag are passed as `--flag=value`.
fn list_args(p: &IssueListParams) -> Result<Vec<String>> {
    ensure!(["open", "closed", "all"].contains(&p.state.as_str()), "Choose open, closed or all issues.");
    ensure!((1..=MAX_LIMIT).contains(&p.limit), "Choose between 1 and {MAX_LIMIT} issues per page.");
    ensure!(p.offset <= MAX_OFFSET, "That page is too far down the list. Narrow the search with a label or a search term.");
    ensure!(p.labels.len() <= MAX_LABELS, "Choose at most {MAX_LABELS} labels.");
    let fetch = (p.offset + p.limit + 1).to_string();
    let mut args: Vec<String> =
        ["issue", "list", "--state", &p.state, "--limit", &fetch, "--json", LIST_FIELDS].into_iter().map(str::to_owned).collect();
    for label in &p.labels {
        let label = label.trim();
        ensure!(!label.is_empty() && label.chars().count() <= 100 && !label.chars().any(char::is_control), "That label name isn't valid.");
        args.push(format!("--label={label}"));
    }
    if let Some(assignee) = p.assignee.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        ensure!(
            assignee.len() <= 64 && assignee.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '@' | '[' | ']')),
            "That assignee isn't a GitHub login."
        );
        args.push(format!("--assignee={assignee}"));
    }
    if let Some(search) = p.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        ensure!(search.chars().count() <= MAX_TEXT && !search.chars().any(char::is_control), "Shorten the search.");
        // The search API has no default order: ask for the same newest-first as the plain list.
        args.push(format!("--search={search} sort:created-desc"));
    }
    Ok(args)
}

/// Whether `p` can be asked of `gh` at all.
pub(crate) fn validate(p: &IssueListParams) -> Result<()> {
    list_args(p).map(drop)
}

/// Newest-first issues of the repository in `cwd`, up to `offset + limit + 1` of them: the one past the
/// page tells the caller whether another page follows. Nothing is skipped here (a group merges members first).
pub(crate) async fn fetch(gh: &str, cwd: &Path, p: &IssueListParams) -> Result<Vec<Issue>> {
    let args = list_args(p)?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let json = run(cwd, gh, &args).await?;
    let v: Value = serde_json::from_str(&json)?;
    Ok(v.as_array().map(|a| a.iter().filter_map(parse_issue).collect()).unwrap_or_default())
}

/// How long a repository's labels are reused: typing in the search box lists again for every pause.
const LABELS_TTL: std::time::Duration = std::time::Duration::from_secs(60);
/// Repositories whose labels are kept; the oldest goes first.
const LABELS_KEPT: usize = 32;
type LabelCache = std::sync::Mutex<Vec<(std::path::PathBuf, std::time::Instant, Vec<PrLabel>)>>;
static LABELS: LabelCache = std::sync::Mutex::new(Vec::new());

/// The repository's labels for the filter menu, read at most once a minute. Best effort: a repository whose labels
/// cannot be read just has an empty menu, and that is not remembered.
pub(crate) async fn repo_labels(gh: &str, cwd: &Path) -> Vec<PrLabel> {
    let lock = || LABELS.lock().unwrap_or_else(|error| error.into_inner());
    if let Some((_, _, labels)) = lock().iter().find(|(dir, at, _)| dir == cwd && at.elapsed() < LABELS_TTL) {
        return labels.clone();
    }
    let limit = MAX_REPO_LABELS.to_string();
    let Ok(json) = run(cwd, gh, &["label", "list", "--json", "name,color", "--limit", &limit]).await else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&json) else { return Vec::new() };
    let labels: Vec<PrLabel> = v
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| Some(PrLabel { name: l.get("name")?.as_str()?.to_owned(), color: text(l, "color") }))
        .collect();
    let mut cache = lock();
    cache.retain(|(dir, _, _)| dir != cwd);
    cache.push((cwd.to_path_buf(), std::time::Instant::now(), labels.clone()));
    if cache.len() > LABELS_KEPT {
        cache.remove(0);
    }
    labels
}

/// One page of `issues` (newest first, as fetched): skip `p.offset`, keep `p.limit`, and say if more follow.
pub(crate) fn page(mut issues: Vec<Issue>, p: &IssueListParams) -> (Vec<Issue>, bool) {
    issues.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    let offset = p.offset as usize;
    let limit = p.limit as usize;
    let has_more = issues.len() > offset + limit;
    (issues.into_iter().skip(offset).take(limit).collect(), has_more)
}

/// `github.issue.list` of one repository.
pub async fn list(gh: &str, cwd: &Path, p: &IssueListParams) -> Result<IssueListResult> {
    // The labels are read once, with the first page.
    let (issues, labels) =
        if p.offset == 0 { tokio::join!(fetch(gh, cwd, p), repo_labels(gh, cwd)) } else { (fetch(gh, cwd, p).await, Vec::new()) };
    let (issues, has_more) = page(issues?, p);
    Ok(IssueListResult { issues, has_more, labels, repos: Vec::new() })
}

fn parse_comment(v: &Value, issue_url: &str) -> Option<IssueComment> {
    let author = v.pointer("/author/login").and_then(Value::as_str).unwrap_or_default().to_owned();
    let author_is_bot = v.pointer("/author/is_bot").and_then(Value::as_bool).unwrap_or(false);
    Some(IssueComment {
        id: v.get("id")?.as_str()?.to_owned(),
        author_avatar_url: avatar_url(issue_url, &author, author_is_bot),
        author,
        author_is_bot,
        body: truncated(&text(v, "body"), MAX_BODY),
        created_at: time(v, "createdAt")?,
        url: text(v, "url"),
    })
}

/// A pull request that closes the issue, looked up by its reference. `None` when `gh` cannot read it.
async fn linked_pull(gh: &str, cwd: &Path, reference: &Value) -> Option<IssueLinkedPull> {
    let number = reference.get("number")?.as_u64()?.to_string();
    let owner = reference.pointer("/repository/owner/login").and_then(Value::as_str);
    let name = reference.pointer("/repository/name").and_then(Value::as_str);
    let repo = owner.zip(name).map(|(owner, name)| format!("{owner}/{name}"));
    let mut args = vec!["pr", "view", number.as_str(), "--json", "number,title,state,url"];
    if let Some(repo) = repo.as_deref() {
        args.extend(["--repo", repo]);
    }
    let json = run(cwd, gh, &args).await.ok()?;
    let v: Value = serde_json::from_str(&json).ok()?;
    Some(IssueLinkedPull {
        number: v.get("number")?.as_u64()?,
        title: text(&v, "title"),
        url: text(&v, "url"),
        state: text(&v, "state").to_ascii_uppercase(),
    })
}

/// `github.issue.detail`: the issue, its body, its first comments and the pull requests that close it.
pub async fn detail(gh: &str, cwd: &Path, number: u64) -> Result<IssueDetailResult> {
    ensure!(number > 0, "Choose an issue number greater than zero.");
    let number = number.to_string();
    let json = run(cwd, gh, &["issue", "view", &number, "--json", VIEW_FIELDS]).await?;
    let v: Value = serde_json::from_str(&json)?;
    let issue = parse_issue(&v).ok_or_else(|| anyhow!("Unable to read this issue. Refresh and try again."))?;
    // Comments GitHub hid as spam or off topic are neither shown nor counted.
    let visible: Vec<&Value> = v
        .get("comments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| !c.get("isMinimized").and_then(Value::as_bool).unwrap_or(false))
        .collect();
    let comments = visible.iter().take(MAX_COMMENTS).filter_map(|c| parse_comment(c, &issue.url)).collect();
    let references: Vec<&Value> =
        v.get("closedByPullRequestsReferences").and_then(Value::as_array).into_iter().flatten().take(MAX_LINKED).collect();
    let pull_requests = futures::future::join_all(references.iter().map(|r| linked_pull(gh, cwd, r))).await.into_iter().flatten().collect();
    Ok(IssueDetailResult {
        body: truncated(&text(&v, "body"), MAX_BODY),
        comment_count: visible.len() as u32,
        comments,
        pull_requests,
        issue,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> IssueListParams {
        IssueListParams {
            project_id: uuid::Uuid::now_v7(),
            state: "open".into(),
            search: None,
            labels: Vec::new(),
            assignee: None,
            limit: 30,
            offset: 0,
            repo: None,
        }
    }

    fn sample() -> Value {
        serde_json::json!({
            "number": 12, "title": "Crash on start", "url": "https://github.com/acme/api/issues/12", "state": "CLOSED", "stateReason": "COMPLETED",
            "author": {"login": "ada", "is_bot": false}, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-03T00:00:00Z",
            "labels": [{"name": "bug", "color": "d73a4a"}, {"name": "ui", "color": "0e8a16"}],
            "assignees": [{"login": "grace", "id": "x"}], "milestone": {"title": "v2"},
            "closedByPullRequestsReferences": [{"number": 30}, {"number": 31}]
        })
    }

    #[test]
    fn an_issue_keeps_what_the_list_shows() {
        let issue = parse_issue(&sample()).unwrap();
        assert_eq!((issue.number, issue.state.as_str(), issue.state_reason.as_deref()), (12, "CLOSED", Some("COMPLETED")));
        assert_eq!(issue.labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["bug", "ui"]);
        assert_eq!(issue.assignees[0].login, "grace");
        assert_eq!(issue.assignees[0].avatar_url.as_deref(), Some("https://github.com/grace.png?size=40"));
        assert_eq!((issue.milestone.as_deref(), issue.linked_pull_requests.as_slice()), (Some("v2"), &[30, 31][..]));
        assert!(issue.repo.is_none());
        assert!(parse_issue(&serde_json::json!({"number": 1})).is_none(), "an entry without a title and link is dropped");
    }

    #[test]
    fn an_open_issue_has_no_reason_and_no_milestone() {
        let mut v = sample();
        v["state"] = "OPEN".into();
        v["stateReason"] = "".into();
        v["milestone"] = Value::Null;
        v["closedByPullRequestsReferences"] = serde_json::json!([]);
        let issue = parse_issue(&v).unwrap();
        assert_eq!((issue.state_reason, issue.milestone, issue.linked_pull_requests), (None, None, Vec::<u64>::new()));
        let wire = serde_json::to_value(parse_issue(&v).unwrap()).unwrap();
        assert!(wire.get("linked_pull_requests").is_none() && wire.get("milestone").is_none(), "empty fields stay off the wire");
    }

    #[test]
    fn list_arguments_pass_filters_as_flag_values_and_fetch_one_extra_issue() {
        let mut p = params();
        p.labels = vec!["bug".into(), "--web".into()];
        p.assignee = Some("@me".into());
        p.search = Some("crash on start".into());
        p.offset = 30;
        let args = list_args(&p).unwrap();
        assert_eq!(&args[..8], ["issue", "list", "--state", "open", "--limit", "61", "--json", LIST_FIELDS]);
        assert_eq!(&args[8..], ["--label=bug", "--label=--web", "--assignee=@me", "--search=crash on start sort:created-desc"]);
    }

    #[test]
    fn list_arguments_refuse_what_gh_would_misread() {
        for bad in [
            IssueListParams { state: "merged".into(), ..params() },
            IssueListParams { limit: 0, ..params() },
            IssueListParams { limit: 101, ..params() },
            IssueListParams { offset: MAX_OFFSET + 1, ..params() },
            IssueListParams { labels: vec![String::new()], ..params() },
            IssueListParams { labels: vec!["a\nb".into()], ..params() },
            IssueListParams { labels: vec!["x".into(); 11], ..params() },
            IssueListParams { assignee: Some("ada; rm".into()), ..params() },
            IssueListParams { search: Some("x".repeat(300)), ..params() },
        ] {
            assert!(list_args(&bad).is_err(), "{bad:?}");
        }
        assert!(
            list_args(&IssueListParams { search: Some("   ".into()), assignee: Some(" ".into()), ..params() }).unwrap().len() == 8,
            "blank filters are ignored"
        );
    }

    #[test]
    fn a_page_skips_the_offset_and_says_when_more_follow() {
        let issues: Vec<Issue> = (1..=5)
            .map(|n| {
                let mut v = sample();
                v["number"] = n.into();
                v["createdAt"] = format!("2026-01-0{n}T00:00:00Z").into();
                parse_issue(&v).unwrap()
            })
            .collect();
        let (first, more) = page(issues.clone(), &IssueListParams { limit: 2, ..params() });
        assert_eq!((first.iter().map(|i| i.number).collect::<Vec<_>>(), more), (vec![5, 4], true));
        let (last, more) = page(issues, &IssueListParams { limit: 2, offset: 4, ..params() });
        assert_eq!((last.iter().map(|i| i.number).collect::<Vec<_>>(), more), (vec![1], false));
    }

    #[test]
    fn a_comment_needs_an_id_and_a_time_and_a_long_body_is_cut() {
        let url = "https://github.com/acme/api/issues/12";
        let comment = serde_json::json!({"id": "IC_1", "author": {"login": "ada"}, "body": "é".repeat(MAX_BODY + 5), "createdAt": "2026-01-02T00:00:00Z", "url": "u"});
        let parsed = parse_comment(&comment, url).unwrap();
        assert_eq!(parsed.body.chars().count(), MAX_BODY);
        assert_eq!(parsed.author_avatar_url.as_deref(), Some("https://github.com/ada.png?size=40"));
        assert!(parse_comment(&serde_json::json!({"author": {"login": "ada"}}), url).is_none());
    }

    /// A fake `gh` that logs its arguments and answers `issue list`, `issue view`, `pr view` and `label list`.
    #[cfg(unix)]
    fn fake_gh(dir: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
        std::fs::create_dir_all(dir).unwrap();
        let (script, log) = (dir.join("gh"), dir.join("calls.log"));
        let body = format!(
            r#"#!/bin/sh
echo "$@" >> '{log}'
case "$1 $2" in
  "issue list") echo '[{{"number":2,"title":"B","url":"https://github.com/acme/api/issues/2","state":"OPEN","author":{{"login":"ada"}},"createdAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z"}},{{"number":1,"title":"A","url":"https://github.com/acme/api/issues/1","state":"OPEN","author":{{"login":"ada"}},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}}]' ;;
  "issue view") echo '{{"number":2,"title":"B","url":"https://github.com/acme/api/issues/2","state":"OPEN","author":{{"login":"ada"}},"createdAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","body":"Body","comments":[{{"id":"IC_1","author":{{"login":"grace"}},"body":"first","createdAt":"2026-01-03T00:00:00Z","url":"u1"}},{{"id":"IC_2","author":{{"login":"spam"}},"body":"hidden","createdAt":"2026-01-04T00:00:00Z","url":"u2","isMinimized":true}}],"closedByPullRequestsReferences":[{{"number":30,"repository":{{"name":"api","owner":{{"login":"acme"}}}}}}]}}' ;;
  "pr view") echo '{{"number":30,"title":"Fix B","state":"MERGED","url":"https://github.com/acme/api/pull/30"}}' ;;
  "label list") echo '[{{"name":"bug","color":"d73a4a"}}]' ;;
  *) echo "unexpected: $@" >&2; exit 1 ;;
esac
"#,
            log = log.display()
        );
        kybern_protocol::process::write_executable(&script, &body).unwrap();
        (script, log)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listing_and_opening_an_issue_ask_gh_for_them() {
        let root = std::env::temp_dir().join(format!("kybern-issues-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        let (gh, log) = fake_gh(&root.join("bin"));
        let gh = gh.to_string_lossy().into_owned();
        let listed = list(&gh, &root, &IssueListParams { limit: 1, ..params() }).await.unwrap();
        assert_eq!(
            (listed.issues.iter().map(|i| i.number).collect::<Vec<_>>(), listed.has_more),
            (vec![2], true),
            "newest first, one more follows"
        );
        assert_eq!(listed.labels[0].name, "bug");
        let later = list(&gh, &root, &IssueListParams { limit: 1, offset: 1, ..params() }).await.unwrap();
        assert_eq!((later.issues[0].number, later.has_more, later.labels.len()), (1, false, 0), "labels come with the first page only");

        let again = list(&gh, &root, &IssueListParams { limit: 1, ..params() }).await.unwrap();
        assert_eq!(again.labels[0].name, "bug", "the labels come from memory");

        let opened = detail(&gh, &root, 2).await.unwrap();
        assert_eq!(
            (opened.body.as_str(), opened.comment_count, opened.comments.len()),
            ("Body", 1, 1),
            "a hidden comment is neither shown nor counted"
        );
        assert_eq!(opened.comments[0].author, "grace");
        assert_eq!((opened.pull_requests[0].title.as_str(), opened.pull_requests[0].state.as_str()), ("Fix B", "MERGED"));
        let calls = std::fs::read_to_string(log).unwrap();
        assert!(calls.contains("pr view 30 --json number,title,state,url --repo acme/api"), "{calls}");
        assert_eq!(calls.matches("label list").count(), 1, "labels are read once a minute: {calls}");
        assert!(detail(&gh, &root, 0).await.is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(all(test, unix))]
mod rpc_tests {
    use kybern_protocol::methods::*;
    use serde_json::{Value, json};

    /// A fake `gh`: `issue list` has #2 and #1, and every call fails like a signed-out `gh` in a folder named `signed-out`.
    fn fake_gh(dir: &std::path::Path) -> std::path::PathBuf {
        let unix = r#"#!/bin/sh
case "$(basename "$PWD")" in
  signed-out) echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 1 ;;
esac
case "$1 $2" in
  "issue list") echo '[{"number":2,"title":"B","url":"https://github.com/acme/api/issues/2","state":"OPEN","author":{"login":"ada"},"createdAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z"},{"number":1,"title":"A","url":"https://github.com/acme/api/issues/1","state":"OPEN","author":{"login":"ada"},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}]' ;;
  "issue view") echo '{"number":2,"title":"B","url":"https://github.com/acme/api/issues/2","state":"OPEN","author":{"login":"ada"},"createdAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","body":"Body","comments":[]}' ;;
  "label list") echo '[]' ;;
  *) echo "unexpected: $@" >&2; exit 1 ;;
esac
"#;
        crate::test_support::script(dir, "gh", unix, "")
    }

    #[tokio::test]
    async fn issue_methods_run_gh_in_the_project_and_explain_its_failures() {
        let root = std::env::temp_dir().join(format!("kybern-issues-rpc-{}", uuid::Uuid::now_v7()));
        let paths = crate::config::Paths::resolve(Some(root.join("data"))).unwrap();
        let state = crate::state::AppState::initialize(&paths).unwrap();
        let (checkout, signed_out) = (root.join("checkout"), root.join("signed-out"));
        std::fs::create_dir_all(&checkout).unwrap();
        std::fs::create_dir_all(&signed_out).unwrap();
        let project = state.orchestrator.add_project(checkout.to_string_lossy().into_owned(), Some("Fixture".into()), None).unwrap();
        let broken = state.orchestrator.add_project(signed_out.to_string_lossy().into_owned(), Some("Broken".into()), None).unwrap();
        let gh = fake_gh(&root.join("bin")).to_string_lossy().into_owned();
        let call = |method: &'static str, params: Value| {
            let (state, gh) = (state.clone(), gh.clone());
            async move { crate::rpc::issues_call(&state, &gh, method, params).await }
        };

        let listed: IssueListResult =
            serde_json::from_value(call(IssueList::NAME, json!({"project_id": project.id, "limit": 1})).await.unwrap()).unwrap();
        assert_eq!((listed.issues.len(), listed.issues[0].number, listed.has_more), (1, 2, true));
        assert!(listed.issues[0].repo.is_none(), "a single project's issues are untagged");
        let opened: IssueDetailResult =
            serde_json::from_value(call(IssueDetail::NAME, json!({"project_id": project.id, "number": 2})).await.unwrap()).unwrap();
        assert_eq!((opened.issue.number, opened.body.as_str(), opened.comment_count), (2, "Body", 0));

        // A single repository takes no member, and a bad filter is refused before `gh` runs.
        let member = call(IssueDetail::NAME, json!({"project_id": project.id, "number": 2, "repo": "api"})).await.unwrap_err();
        assert!(member.message.contains("single repository"), "{}", member.message);
        assert!(call(IssueList::NAME, json!({"project_id": project.id, "state": "merged"})).await.is_err());
        assert!(call(IssueList::NAME, json!({"project_id": uuid::Uuid::now_v7()})).await.is_err(), "unknown project");

        // A signed-out `gh` reads like the pull request page's: the words and the typed problem to recover by.
        for (method, params) in
            [(IssueList::NAME, json!({"project_id": broken.id})), (IssueDetail::NAME, json!({"project_id": broken.id, "number": 2}))]
        {
            let error = call(method, params).await.unwrap_err();
            assert!(error.message.starts_with("gh isn't signed in"), "{}", error.message);
            let problem = &error.data.as_ref().unwrap()["problem"];
            assert_eq!((problem["kind"].as_str(), problem["subject"].as_str()), (Some("signed_out"), Some("gh")), "{problem}");
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
