//! Images in issue and pull request Markdown, fetched by the daemon that owns the project and served to its clients
//! (`GET /github/image`, `http.rs`). Only GitHub's own image hosts are fetched here; a client loads any other host itself.
//!
//! An attachment (`https://github.com/user-attachments/assets/<id>`) redirects to a signed download when the repository
//! is public. In a private one GitHub answers only a browser session, so the signed, short-lived copy is read from the
//! issue's HTML (`gh api` with `application/vnd.github.full+json`, through the user's own `gh` sign-in) and fetched
//! instead. The token never leaves `gh`, and no client sees it. Signed copies are remembered for a few minutes per issue;
//! one that expired is looked up again.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures::StreamExt;
use reqwest::Url;
use serde_json::Value;

/// The largest image served, like `/threads/{id}/image`.
pub(crate) const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
/// One fetch, redirects included.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// How long signed copies read from an issue are reused. GitHub signs them for five minutes.
const SIGNED_TTL: Duration = Duration::from_secs(4 * 60);
/// Issues whose signed copies are kept; the oldest goes first.
const SIGNED_KEPT: usize = 32;
const SIGNED_HOST: &str = "private-user-images.githubusercontent.com";

/// Why an image could not be served, each with its own HTTP status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageFailure {
    /// Not on one of GitHub's image hosts: the client loads it itself.
    NotGithub,
    NotFound,
    TooLarge,
    NotImage,
    Unreachable,
}

/// What kind of GitHub image a URL is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GithubImage {
    /// An upload on github.com (`/user-attachments/assets/<id>` or `/<owner>/<repo>/assets/…/<id>`): signed when private.
    Attachment { key: String },
    /// A signed copy (`private-user-images.githubusercontent.com`), which may have expired.
    Signed { key: String },
    /// Any other GitHub image host, served as it is.
    Plain,
}

/// `url` as a GitHub image, or `None` for any other address (and anything not https).
pub(crate) fn classify(url: &Url) -> Option<GithubImage> {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let path = url.path();
    match host.as_str() {
        "github.com" => {
            let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
            let upload =
                matches!(segments.as_slice(), ["user-attachments", "assets", _]) || (segments.len() >= 4 && segments[2] == "assets");
            if upload { asset_key(path).map(|key| GithubImage::Attachment { key }) } else { None }
        }
        SIGNED_HOST => Some(match asset_key(path) {
            Some(key) => GithubImage::Signed { key },
            None => GithubImage::Plain,
        }),
        "user-images.githubusercontent.com"
        | "raw.githubusercontent.com"
        | "camo.githubusercontent.com"
        | "avatars.githubusercontent.com"
        | "objects.githubusercontent.com"
        | "media.githubusercontent.com" => Some(GithubImage::Plain),
        _ => None,
    }
}

/// The upload's id in a path: the last UUID in it (`…/assets/<uuid>`, `…/697015619-<uuid>.png`).
pub(crate) fn asset_key(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let shape = |i: usize| -> bool {
        bytes.len() >= i + 36
            && (0..36).all(|j| {
                let c = bytes[i + j];
                if matches!(j, 8 | 13 | 18 | 23) { c == b'-' } else { c.is_ascii_hexdigit() }
            })
    };
    (0..bytes.len()).rev().find(|&i| shape(i)).map(|i| path[i..i + 36].to_ascii_lowercase())
}

/// Hosts a fetch may be redirected to: GitHub's and the S3 bucket its uploads live in, over https only.
fn allowed_redirect(url: &Url) -> bool {
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else { return false };
    url.scheme() == "https"
        && (host == "github.com"
            || host.ends_with(".githubusercontent.com")
            || (host.starts_with("github-production-") && host.ends_with(".s3.amazonaws.com")))
}

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !allowed_redirect(attempt.url()) { attempt.stop() } else { attempt.follow() }
        });
        reqwest::Client::builder()
            .redirect(policy)
            .timeout(FETCH_TIMEOUT)
            .user_agent(concat!("kybern/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

/// The image type of `bytes` by their first bytes: PNG, JPEG, GIF, WebP or AVIF.
pub(crate) fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis") {
        Some("image/avif")
    } else {
        None
    }
}

/// GET `url` without credentials, at most `MAX_IMAGE_BYTES`, and only an image.
async fn download(url: &Url) -> Result<(&'static str, Vec<u8>), ImageFailure> {
    let response = client().get(url.clone()).send().await.map_err(|error| {
        tracing::debug!(target: "kybern::images", %error, "github image fetch");
        ImageFailure::Unreachable
    })?;
    let status = response.status();
    if matches!(status.as_u16(), 401 | 403 | 404 | 410) || status.is_redirection() {
        return Err(ImageFailure::NotFound);
    }
    if !status.is_success() {
        return Err(ImageFailure::Unreachable);
    }
    if response.content_length().is_some_and(|n| n > MAX_IMAGE_BYTES as u64) {
        return Err(ImageFailure::TooLarge);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ImageFailure::Unreachable)?;
        if bytes.len() + chunk.len() > MAX_IMAGE_BYTES {
            return Err(ImageFailure::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    let mime = sniff(&bytes).ok_or(ImageFailure::NotImage)?;
    Ok((mime, bytes))
}

/// Every signed image address in a GitHub API answer: its HTML fields carry them (`&amp;` unescaped).
pub(crate) fn signed_urls(value: &Value) -> Vec<String> {
    fn visit(value: &Value, found: &mut Vec<String>) {
        match value {
            Value::String(text) => {
                let prefix = format!("https://{SIGNED_HOST}/");
                let mut rest = text.as_str();
                while let Some(start) = rest.find(&prefix) {
                    let tail = &rest[start..];
                    let end = tail
                        .find(|c: char| c == '"' || c == '\'' || c == '<' || c == '>' || c == ')' || c.is_whitespace())
                        .unwrap_or(tail.len());
                    let url = tail[..end].replace("&amp;", "&");
                    if !found.contains(&url) {
                        found.push(url);
                    }
                    rest = &tail[end..];
                }
            }
            Value::Array(items) => items.iter().for_each(|item| visit(item, found)),
            Value::Object(map) => map.values().for_each(|item| visit(item, found)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    visit(value, &mut found);
    found
}

type SignedCache = std::sync::Mutex<Vec<(PathBuf, u64, Instant, Vec<String>)>>;
static SIGNED: SignedCache = std::sync::Mutex::new(Vec::new());

fn remembered(cwd: &Path, number: u64) -> Option<Vec<String>> {
    let cache = SIGNED.lock().unwrap_or_else(|error| error.into_inner());
    cache.iter().find(|(dir, n, at, _)| dir == cwd && *n == number && at.elapsed() < SIGNED_TTL).map(|(_, _, _, urls)| urls.clone())
}

fn remember(cwd: &Path, number: u64, urls: Vec<String>) {
    let mut cache = SIGNED.lock().unwrap_or_else(|error| error.into_inner());
    cache.retain(|(dir, n, _, _)| !(dir == cwd && *n == number));
    cache.push((cwd.to_path_buf(), number, Instant::now(), urls));
    if cache.len() > SIGNED_KEPT {
        cache.remove(0);
    }
}

fn forget(cwd: &Path, number: u64) {
    SIGNED.lock().unwrap_or_else(|error| error.into_inner()).retain(|(dir, n, _, _)| !(dir == cwd && *n == number));
}

/// One `gh api` read with the HTML bodies; `None` when it fails (a pull request's review endpoints on an issue).
async fn full_json(gh: &str, cwd: &Path, endpoint: &str) -> Option<Value> {
    let json = crate::github::run(cwd, gh, &["api", "-H", "Accept: application/vnd.github.full+json", endpoint]).await.ok()?;
    serde_json::from_str(&json).ok()
}

/// The signed copy of upload `key` in issue or pull request `number`: its description and comments first, then a pull
/// request's reviews and review comments. Read again when the remembered copies are older than `SIGNED_TTL`, or `fresh`.
async fn signed_copy(gh: &str, cwd: &Path, number: u64, key: &str, fresh: bool) -> Option<Url> {
    let find = |urls: &[String]| urls.iter().find(|url| url.to_ascii_lowercase().contains(key)).and_then(|url| Url::parse(url).ok());
    if !fresh && let Some(urls) = remembered(cwd, number) {
        return find(&urls);
    }
    let issue = format!("repos/{{owner}}/{{repo}}/issues/{number}");
    let comments = format!("{issue}/comments?per_page=100");
    let (issue, comments) = tokio::join!(full_json(gh, cwd, &issue), full_json(gh, cwd, &comments));
    // `gh` could not read the issue at all: try again next time rather than remember nothing.
    let read = issue.is_some() || comments.is_some();
    let mut urls: Vec<String> = [issue, comments].iter().flatten().flat_map(signed_urls).collect();
    if find(&urls).is_none() {
        let reviews = format!("repos/{{owner}}/{{repo}}/pulls/{number}/reviews?per_page=100");
        let inline = format!("repos/{{owner}}/{{repo}}/pulls/{number}/comments?per_page=100");
        let (reviews, inline) = tokio::join!(full_json(gh, cwd, &reviews), full_json(gh, cwd, &inline));
        urls.extend([reviews, inline].iter().flatten().flat_map(signed_urls));
    }
    let found = find(&urls);
    if read {
        remember(cwd, number, urls);
    }
    found
}

/// The image at `raw` for issue or pull request `number` of the repository in `cwd`, as its type and bytes.
pub(crate) async fn fetch(gh: &str, cwd: &Path, number: Option<u64>, raw: &str) -> Result<(&'static str, Vec<u8>), ImageFailure> {
    let url = Url::parse(raw.trim()).map_err(|_| ImageFailure::NotGithub)?;
    let kind = classify(&url).ok_or(ImageFailure::NotGithub)?;
    let first = download(&url).await;
    let key = match (&kind, &first) {
        (_, Ok(_)) | (GithubImage::Plain, _) => return first,
        (_, Err(ImageFailure::TooLarge | ImageFailure::NotImage)) => return first,
        (GithubImage::Attachment { key } | GithubImage::Signed { key }, Err(_)) => key.clone(),
    };
    // A private repository's upload, or a signed copy that expired: read the issue's own signed copy.
    let Some(number) = number.filter(|n| *n > 0) else { return first };
    let mut fresh = false;
    loop {
        let Some(signed) = signed_copy(gh, cwd, number, &key, fresh).await else { return first };
        match download(&signed).await {
            Err(ImageFailure::NotFound) if !fresh => {
                // Remembered, but expired since: once more from GitHub.
                forget(cwd, number);
                fresh = true;
            }
            other => return other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "a519dc07-d427-4203-ab12-f5d66c026c71";

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn github_hosts_are_ours_and_any_other_is_the_clients() {
        let key = ID.to_owned();
        assert_eq!(
            classify(&url(&format!("https://github.com/user-attachments/assets/{ID}"))),
            Some(GithubImage::Attachment { key: key.clone() })
        );
        assert_eq!(
            classify(&url(&format!("https://github.com/acme/api/assets/12345/{ID}"))),
            Some(GithubImage::Attachment { key: key.clone() }),
            "the older per-repository upload"
        );
        assert_eq!(
            classify(&url(&format!("https://private-user-images.githubusercontent.com/1/697015619-{ID}.png?jwt=x"))),
            Some(GithubImage::Signed { key })
        );
        assert_eq!(classify(&url("https://user-images.githubusercontent.com/1/a.png")), Some(GithubImage::Plain));
        assert_eq!(classify(&url("https://camo.githubusercontent.com/abc")), Some(GithubImage::Plain));
        for other in [
            "https://example.com/a.png",
            "http://github.com/user-attachments/assets/a519dc07-d427-4203-ab12-f5d66c026c71",
            "https://github.com/acme/api/issues/1",
            "https://github.com:8443/user-attachments/assets/a519dc07-d427-4203-ab12-f5d66c026c71",
            "https://user@github.com/user-attachments/assets/a519dc07-d427-4203-ab12-f5d66c026c71",
            "https://github.com.evil.example/user-attachments/assets/a519dc07-d427-4203-ab12-f5d66c026c71",
            "https://raw.githubusercontent.com.evil.example/a.png",
            "file:///etc/passwd",
        ] {
            assert_eq!(classify(&url(other)), None, "{other}");
        }
    }

    #[test]
    fn the_upload_key_is_the_last_uuid_in_the_path() {
        assert_eq!(asset_key(&format!("/1/697015619-{}.png", ID.to_uppercase())).as_deref(), Some(ID));
        assert_eq!(asset_key("/user-attachments/assets/not-a-uuid"), None);
    }

    #[test]
    fn redirects_stay_on_github_and_its_bucket() {
        assert!(allowed_redirect(&url("https://github-production-user-asset-6210df.s3.amazonaws.com/1/a.png?X-Amz=1")));
        assert!(allowed_redirect(&url("https://private-user-images.githubusercontent.com/1/a.png")));
        assert!(!allowed_redirect(&url("http://github-production-user-asset-6210df.s3.amazonaws.com/a.png")));
        assert!(!allowed_redirect(&url("https://evil.s3.amazonaws.com/a.png")));
        assert!(!allowed_redirect(&url("https://127.0.0.1/a.png")));
        assert!(!allowed_redirect(&url("https://github.com.evil.example/a.png")));
    }

    #[test]
    fn only_image_bytes_are_served() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif"), Some("image/avif"));
        assert_eq!(sniff(b"<!DOCTYPE html>"), None, "a sign-in page is not an image");
    }

    #[test]
    fn signed_copies_are_read_from_every_html_field() {
        let a = format!("https://private-user-images.githubusercontent.com/1/2-{ID}.png?jwt=abc");
        let value = serde_json::json!({
            "body_html": format!("<p><a href=\"{a}\"><img src=\"{a}\" alt=\"Image\"></a></p>"),
            "nested": [{"body_html": "<img src='https://private-user-images.githubusercontent.com/1/3-x.png?jwt=d&amp;e=1'>"}],
            "body": "no html here"
        });
        assert_eq!(signed_urls(&value), vec![a, "https://private-user-images.githubusercontent.com/1/3-x.png?jwt=d&e=1".to_owned()]);
    }

    #[test]
    fn signed_copies_are_remembered_per_issue_and_bounded() {
        let dir = std::env::temp_dir().join(format!("kybern-gh-images-{}", uuid::Uuid::now_v7()));
        remember(&dir, 7, vec!["a".into()]);
        assert_eq!(remembered(&dir, 7), Some(vec!["a".to_owned()]));
        assert_eq!(remembered(&dir, 8), None);
        forget(&dir, 7);
        assert_eq!(remembered(&dir, 7), None);
        for n in 0..(SIGNED_KEPT as u64 + 5) {
            remember(&dir, 100 + n, Vec::new());
        }
        assert!(SIGNED.lock().unwrap().len() <= SIGNED_KEPT);
    }

    /// A fake `gh` whose issue 5 has one signed copy in its description and nothing in its comments.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_private_upload_is_found_in_the_issues_html() {
        let root = std::env::temp_dir().join(format!("kybern-gh-images-gh-{}", uuid::Uuid::now_v7()));
        let log = root.join("calls.log");
        let script = format!(
            r#"#!/bin/sh
echo "$@" >> '{log}'
case "$4" in
  "repos/{{owner}}/{{repo}}/issues/5") echo '{{"body_html":"<img src=\"https://private-user-images.githubusercontent.com/1/2-{ID}.png?jwt=t\">"}}' ;;
  *) echo '[]' ;;
esac
"#,
            log = log.display()
        );
        let gh = crate::test_support::script(&root, "gh", &script, "").to_string_lossy().into_owned();
        let found = signed_copy(&gh, &root, 5, ID, false).await.unwrap();
        assert_eq!(found.as_str(), format!("https://private-user-images.githubusercontent.com/1/2-{ID}.png?jwt=t"));
        let again = signed_copy(&gh, &root, 5, ID, false).await.unwrap();
        assert_eq!(again, found, "remembered");
        let calls = std::fs::read_to_string(&log).unwrap();
        assert_eq!(calls.lines().count(), 2, "the description and comments, once: {calls}");
        assert!(calls.contains("api -H Accept: application/vnd.github.full+json repos/{owner}/{repo}/issues/5"), "{calls}");
        assert!(signed_copy(&gh, &root, 5, "00000000-0000-0000-0000-000000000000", true).await.is_none());
        assert!(std::fs::read_to_string(&log).unwrap().contains("pulls/5/reviews"), "a missing upload looks in the reviews too");
        let _ = std::fs::remove_dir_all(root);
    }
}
