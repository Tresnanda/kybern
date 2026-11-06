//! Bounded, credential-free link decorations; inaccessible links stay neutral.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};

pub async fn load(cache: &Path, raw: &str) -> Value {
    static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
    let Ok(_permit) = GATE.acquire().await else { return json!({}) };
    let Ok(mut url) = reqwest::Url::parse(raw) else { return json!({}) };
    if !matches!(url.scheme(), "https" | "http") || !url.username().is_empty() || url.password().is_some() {
        return json!({});
    }
    url.set_fragment(None);
    url.set_query(None);
    let github = url.host_str() == Some("github.com");
    if !github {
        url.set_path("/");
    }
    let key = Sha256::digest(url.as_str().as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let directory = cache.join("link-icons");
    let file = directory.join(key);
    if let Ok(meta) = tokio::fs::metadata(&file).await
        && meta.len() < 32_768
        && meta.modified().ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age < Duration::from_secs(300))
        && let Ok(bytes) = tokio::fs::read(&file).await
        && let Ok(value) = serde_json::from_slice(&bytes)
    {
        return value;
    }
    let value = if github {
        github_state(&url).await
    } else {
        crate::previews::probe::public_favicon(url.as_str()).await.map(|favicon| json!({"favicon": favicon})).unwrap_or(json!({}))
    };
    if tokio::fs::create_dir_all(&directory).await.is_ok() {
        let mut files = Vec::new();
        if let Ok(mut entries) = tokio::fs::read_dir(&directory).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Ok(meta) = entry.metadata().await {
                    files.push((meta.modified().ok(), entry.path()));
                }
            }
        }
        files.sort_by_key(|entry| entry.0);
        let excess = files.len().saturating_sub(255);
        for (_, path) in files.into_iter().take(excess) {
            let _ = tokio::fs::remove_file(path).await;
        }
        let _ = tokio::fs::write(file, value.to_string()).await;
    }
    value
}
async fn github_state(url: &reqwest::Url) -> Value {
    let parts: Vec<_> = url.path_segments().into_iter().flatten().collect();
    if parts.len() < 4
        || !matches!(parts[2], "issues" | "pull")
        || parts[3].parse::<u64>().is_err()
        || parts[..2].iter().any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)))
    {
        return json!({});
    }
    let kind = if parts[2] == "pull" { "pulls" } else { "issues" };
    let endpoint = format!("repos/{}/{}/{}/{}", parts[0], parts[1], kind, parts[3]);
    let result = tokio::time::timeout(Duration::from_secs(5), crate::github::run(Path::new("."), "gh", &["api", &endpoint])).await;
    let Ok(Ok(raw)) = result else { return json!({}) };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else { return json!({}) };
    let state = if value["draft"] == true {
        "draft"
    } else if value["merged_at"].is_string() {
        "merged"
    } else if value["state"] == "open" {
        "open"
    } else if value["state_reason"] == "not_planned" || kind == "pulls" {
        "not_planned"
    } else {
        "completed"
    };
    json!({"state":state})
}
