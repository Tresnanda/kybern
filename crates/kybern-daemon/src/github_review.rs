//! Bounded, native GitHub review reads and explicit human actions.
use std::path::Path;

use anyhow::{Result, anyhow, ensure};
use kybern_protocol::methods::*;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::github::{parse_pr, run};

const PAGE_SIZE: usize = 30;
const PATCH_BYTES: usize = 64 * 1024;

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}
fn bounded(mut value: String, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value, false);
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    (value, true)
}
fn validate_number(number: u64) -> Result<()> {
    ensure!(number > 0, "Choose a pull request number greater than zero.");
    Ok(())
}

pub async fn detail(cwd: &Path, number: u64) -> Result<PrDetailResult> {
    validate_number(number)?;
    let number = number.to_string();
    let json = run(cwd, "gh", &["pr", "view", &number, "--json", "number,title,url,state,headRefName,baseRefName,isDraft,author,updatedAt,body,headRefOid,reviewRequests,statusCheckRollup,changedFiles"]).await?;
    let value: Value = serde_json::from_str(&json)?;
    Ok(PrDetailResult {
        pull_request: parse_pr(&value).ok_or_else(|| anyhow!("Unable to read this pull request. Refresh and try again."))?,
        body: text(&value, "body"),
        head_sha: text(&value, "headRefOid"),
        changed_files: value["changedFiles"].as_u64().unwrap_or(0) as u32,
        reviewers: value["reviewRequests"]
            .as_array()
            .into_iter()
            .flatten()
            .take(100)
            .map(|v| v.get("login").or_else(|| v.get("name")).and_then(Value::as_str).unwrap_or_default().to_owned())
            .collect(),
        checks: value["statusCheckRollup"]
            .as_array()
            .into_iter()
            .flatten()
            .take(100)
            .map(|v| PrCheck {
                name: v.get("name").or_else(|| v.get("context")).and_then(Value::as_str).unwrap_or_default().to_owned(),
                status: text(v, "status"),
                conclusion: v.get("conclusion").or_else(|| v.get("state")).and_then(Value::as_str).unwrap_or_default().to_owned(),
                url: v.get("detailsUrl").or_else(|| v.get("targetUrl")).and_then(Value::as_str).unwrap_or_default().to_owned(),
            })
            .collect(),
    })
}

pub async fn page(cwd: &Path, p: &PrPageParams) -> Result<PrPageResult> {
    validate_number(p.number)?;
    ensure!((1..=1000).contains(&p.page), "Choose a page between 1 and 1000.");
    if matches!(p.kind, PrPageKind::Checks) {
        let head = detail(cwd, p.number).await?.head_sha;
        let checks_endpoint = format!("repos/{{owner}}/{{repo}}/commits/{head}/check-runs?per_page={PAGE_SIZE}&page={}", p.page);
        let status_endpoint = format!("repos/{{owner}}/{{repo}}/commits/{head}/status?per_page={PAGE_SIZE}&page={}", p.page);
        let checks_args = ["api", checks_endpoint.as_str(), "--method", "GET"];
        let status_args = ["api", status_endpoint.as_str(), "--method", "GET"];
        let (checks, statuses) = tokio::try_join!(run(cwd, "gh", &checks_args), run(cwd, "gh", &status_args))?;
        let checks: Value = serde_json::from_str(&checks)?;
        let statuses: Value = serde_json::from_str(&statuses)?;
        return parse_checks(&checks, &statuses, p.page);
    }
    let endpoint = match p.kind {
        PrPageKind::Files => format!("repos/{{owner}}/{{repo}}/pulls/{}/files", p.number),
        PrPageKind::Comments => format!("repos/{{owner}}/{{repo}}/issues/{}/comments", p.number),
        PrPageKind::Reviews => format!("repos/{{owner}}/{{repo}}/pulls/{}/reviews", p.number),
        PrPageKind::ReviewComments => format!("repos/{{owner}}/{{repo}}/pulls/{}/comments", p.number),
        PrPageKind::Checks => unreachable!("checks handled above"),
    };
    let endpoint = format!("{endpoint}?per_page={PAGE_SIZE}&page={}", p.page);
    let response = run(cwd, "gh", &["api", &endpoint, "--method", "GET"]).await?;
    let value: Value = serde_json::from_str(&response)?;
    parse_page(&value, p.kind, p.page)
}

fn parse_page(value: &Value, kind: PrPageKind, page: u32) -> Result<PrPageResult> {
    let items = value.as_array().ok_or_else(|| anyhow!("Unable to read GitHub results. Refresh and try again."))?;
    let mut result = PrPageResult { checks: vec![], files: vec![], entries: vec![], page, has_more: items.len() == PAGE_SIZE };
    for v in items.iter().take(PAGE_SIZE) {
        if matches!(kind, PrPageKind::Files) {
            let (patch, truncated) = bounded(text(v, "patch"), PATCH_BYTES);
            result.files.push(PrFile {
                path: text(v, "filename"),
                old_path: v["previous_filename"].as_str().map(str::to_owned),
                status: text(v, "status"),
                additions: v["additions"].as_u64().unwrap_or(0) as u32,
                deletions: v["deletions"].as_u64().unwrap_or(0) as u32,
                patch,
                patch_truncated: truncated || v.get("patch").is_none(),
            });
        } else {
            result.entries.push(PrReviewEntry {
                id: v["id"].as_u64().unwrap_or(0),
                author: v.pointer("/user/login").and_then(Value::as_str).unwrap_or_default().to_owned(),
                body: bounded(text(v, "body"), 64 * 1024).0,
                state: text(v, "state"),
                path: v["path"].as_str().map(str::to_owned),
                line: v.get("line").or_else(|| v.get("original_line")).and_then(Value::as_u64).map(|n| n as u32),
                side: v["side"].as_str().map(str::to_owned),
                url: text(v, "html_url"),
                updated_at: v.get("updated_at").or_else(|| v.get("submitted_at")).and_then(Value::as_str).unwrap_or_default().to_owned(),
            });
        }
    }
    Ok(result)
}

fn parse_checks(checks: &Value, statuses: &Value, page: u32) -> Result<PrPageResult> {
    let checks = checks["check_runs"].as_array().ok_or_else(|| anyhow!("Unable to read check runs. Refresh and try again."))?;
    let statuses = statuses["statuses"].as_array().ok_or_else(|| anyhow!("Unable to read commit statuses. Refresh and try again."))?;
    let mut result = PrPageResult {
        checks: vec![],
        files: vec![],
        entries: vec![],
        page,
        has_more: checks.len() == PAGE_SIZE || statuses.len() == PAGE_SIZE,
    };
    for value in checks.iter().take(PAGE_SIZE) {
        result.checks.push(PrCheck {
            name: text(value, "name"),
            status: text(value, "status"),
            conclusion: text(value, "conclusion"),
            url: text(value, "details_url"),
        });
    }
    for value in statuses.iter().take(PAGE_SIZE) {
        result.checks.push(PrCheck {
            name: text(value, "context"),
            status: text(value, "state"),
            conclusion: text(value, "state"),
            url: text(value, "target_url"),
        });
    }
    Ok(result)
}

async fn write_api(cwd: &Path, endpoint: &str, method: &str, value: Value) -> Result<()> {
    let mut child = Command::new("gh")
        .current_dir(cwd)
        .args(["api", endpoint, "--method", method, "--input", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    child.stdin.take().ok_or_else(|| anyhow!("Unable to send the GitHub request."))?.write_all(&serde_json::to_vec(&value)?).await?;
    let output = child.wait_with_output().await?;
    ensure!(
        output.status.success(),
        "GitHub rejected this action: {}. Your draft is kept; refresh and try again.",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    if let Ok(response) = serde_json::from_slice::<Value>(&output.stdout)
        && response.get("merged").is_some_and(|v| v.as_bool() == Some(false))
    {
        return Err(anyhow!("{}. Refresh the pull request and try again.", text(&response, "message")));
    }
    Ok(())
}

pub(crate) fn validate_checkout_head(expected: &str, current: &str) -> Result<()> {
    ensure!(!expected.is_empty(), "Refresh this pull request before checkout or repair.");
    ensure!(expected == current, "The pull request changed. Refresh it and check the selected findings before checkout or repair.");
    Ok(())
}

pub async fn action(cwd: &Path, p: &PrActionParams) -> Result<()> {
    validate_number(p.number)?;
    ensure!(p.body.len() <= 64 * 1024 && p.inline_comments.len() <= 100, "Keep the review below 64 KiB and 100 inline comments.");
    ensure!(
        p.body.len() + p.inline_comments.iter().map(|comment| comment.body.len()).sum::<usize>() <= 128 * 1024,
        "This review exceeds 128 KiB. Shorten your summary or submit fewer inline comments."
    );
    let pull = format!("repos/{{owner}}/{{repo}}/pulls/{}", p.number);
    match p.action {
        PrActionKind::Checkout => {
            let current = detail(cwd, p.number).await?;
            validate_checkout_head(&p.head_sha, &current.head_sha)?;
            run(cwd, "gh", &["pr", "checkout", &p.number.to_string()]).await?;
        }
        PrActionKind::Close => write_api(cwd, &pull, "PATCH", json!({"state":"closed"})).await?,
        PrActionKind::Merge => {
            ensure!(!p.head_sha.is_empty(), "Refresh this pull request before merging.");
            write_api(cwd, &format!("{pull}/merge"), "PUT", json!({"sha":p.head_sha,"merge_method":"squash"})).await?;
        }
        PrActionKind::Comment if p.inline_comments.is_empty() => {
            ensure!(!p.body.trim().is_empty(), "Write a comment before posting.");
            write_api(cwd, &format!("repos/{{owner}}/{{repo}}/issues/{}/comments", p.number), "POST", json!({"body":p.body})).await?;
        }
        _ => {
            ensure!(!p.head_sha.is_empty(), "Refresh this pull request before submitting a review.");
            let current = detail(cwd, p.number).await?;
            ensure!(current.head_sha == p.head_sha, "The pull request changed. Refresh it and check your draft before submitting.");
            if matches!(p.action, PrActionKind::RequestChanges) {
                ensure!(!p.body.trim().is_empty() || !p.inline_comments.is_empty(), "Describe the changes you need before submitting.");
            }
            let comments = p
                .inline_comments
                .iter()
                .map(|c| {
                    ensure!(
                        c.line > 0
                            && matches!(c.side.as_str(), "LEFT" | "RIGHT")
                            && !c.path.is_empty()
                            && !c.body.trim().is_empty()
                            && c.body.len() <= 64 * 1024,
                        "Choose a file, line, side and comment for each finding."
                    );
                    Ok(json!({"path":c.path,"line":c.line,"side":c.side,"body":c.body}))
                })
                .collect::<Result<Vec<_>>>()?;
            let event = match p.action {
                PrActionKind::Approve => "APPROVE",
                PrActionKind::RequestChanges => "REQUEST_CHANGES",
                _ => "COMMENT",
            };
            write_api(
                cwd,
                &format!("{pull}/reviews"),
                "POST",
                json!({"commit_id":p.head_sha,"event":event,"body":p.body,"comments":comments}),
            )
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_preserve_inline_identity_and_bound_large_patches() {
        let value = json!([{"id":7,"user":{"login":"reviewer"},"body":"fix this","path":"a.rs","original_line":12,"side":"LEFT","state":"CHANGES_REQUESTED"}]);
        let page = parse_page(&value, PrPageKind::ReviewComments, 2).unwrap();
        assert_eq!(page.entries[0].line, Some(12));
        assert_eq!(page.entries[0].side.as_deref(), Some("LEFT"));
        assert_eq!(page.page, 2);
        let value = json!([{"filename":"a.rs","patch":"é".repeat(PATCH_BYTES)}]);
        let page = parse_page(&value, PrPageKind::Files, 1).unwrap();
        assert!(page.files[0].patch_truncated);
        assert_eq!(page.files[0].patch.len(), PATCH_BYTES);
    }
    #[test]
    fn exact_page_size_offers_following_page() {
        let value = json!(vec![json!({"filename":"a"}); PAGE_SIZE]);
        assert!(parse_page(&value, PrPageKind::Files, 1).unwrap().has_more);
        assert!(!parse_page(&json!([]), PrPageKind::Files, 2).unwrap().has_more);
    }

    #[test]
    fn checks_page_includes_legacy_contexts_and_offers_more_without_truncating() {
        let checks = json!({"check_runs":vec![json!({"name":"CI","status":"completed","conclusion":"success","details_url":"https://github.com/example/repo/actions/1"}); PAGE_SIZE]});
        let statuses = json!({"statuses":[{"context":"Build","state":"pending","target_url":"https://example.test/build"}]});
        let page = parse_checks(&checks, &statuses, 2).unwrap();
        assert_eq!(page.checks.len(), PAGE_SIZE + 1);
        assert!(page.has_more);
        assert_eq!(page.checks[PAGE_SIZE].name, "Build");
        assert_eq!(page.checks[PAGE_SIZE].conclusion, "pending");
    }
}
