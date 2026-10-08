//! `GET /preview-files/{ticket}/{*path}`: serve a ticket's folder to the
//! sandboxed preview iframe (spec 6.1). The unguessable ticket is the only
//! credential; nothing here ever sees the daemon token.

use std::path::{Component, Path, PathBuf};

use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Response, StatusCode, header};
use futures::stream;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::tickets::{PreviewTickets, TicketKind};
use super::mime;
use crate::state::AppState;

pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const BRIDGE_JS: &str = include_str!("bridge.js");
const EXPIRED: &str = "Preview expired. Reopen it from Kybern.";
/// Origins allowed to frame a preview: the desktop shell, its dev server and the daemon.
const FRAME_ANCESTORS: &str = "tauri://localhost http://tauri.localhost http://localhost:1420 'self'";
const CHUNK: usize = 64 * 1024;

pub async fn serve(State(state): State<AppState>, headers: HeaderMap, UrlPath((ticket, path)): UrlPath<(String, String)>) -> Response<Body> {
    respond(&state.previews, state.port.load(std::sync::atomic::Ordering::Relaxed), &headers, &ticket, &path, MAX_FILE_BYTES).await
}

pub async fn serve_index(State(state): State<AppState>, headers: HeaderMap, UrlPath(ticket): UrlPath<String>) -> Response<Body> {
    respond(&state.previews, state.port.load(std::sync::atomic::Ordering::Relaxed), &headers, &ticket, "", MAX_FILE_BYTES).await
}

/// Everything the route does, minus axum state, so tests drive it directly.
/// `path` is the percent-decoded request path after the ticket.
pub async fn respond(
    tickets: &PreviewTickets,
    daemon_port: u16,
    headers: &HeaderMap,
    ticket: &str,
    path: &str,
    max_bytes: u64,
) -> Response<Body> {
    let Some(info) = tickets.lookup(ticket) else { return text(StatusCode::NOT_FOUND, EXPIRED, None) };
    let TicketKind::Files { root } = info.kind else { return text(StatusCode::NOT_FOUND, EXPIRED, None) };
    let base = format!("http://{}/preview-files/{ticket}/", host_for_csp(headers, daemon_port));
    let policy = Some(csp(&base));
    let Some(target) = locate(&root, path).await else { return text(StatusCode::NOT_FOUND, "Not found", policy) };
    let len = match tokio::fs::metadata(&target).await {
        Ok(meta) => meta.len(),
        Err(_) => return text(StatusCode::NOT_FOUND, "Not found", policy),
    };
    if len > max_bytes {
        return text(StatusCode::PAYLOAD_TOO_LARGE, "That file is too large to preview.", policy);
    }
    let content_type = mime::content_type(&target);
    if mime::is_html(&target) {
        // HTML is read whole so the bridge can be injected; Range is ignored.
        return match tokio::fs::read(&target).await {
            Ok(bytes) => {
                let body = inject_bridge(&bytes);
                with_headers(Response::builder().status(StatusCode::OK), content_type, policy.as_deref(), Some(body.len() as u64))
                    .body(Body::from(body))
                    .unwrap_or_default()
            }
            Err(_) => text(StatusCode::NOT_FOUND, "Not found", policy),
        };
    }
    let range = match headers.get(header::RANGE).and_then(|value| value.to_str().ok()).map(|value| parse_range(value, len)) {
        Some(RangeOutcome::Unsatisfiable) => {
            let mut response = text(StatusCode::RANGE_NOT_SATISFIABLE, "Range not satisfiable", policy);
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{len}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            return response;
        }
        Some(RangeOutcome::Range(start, end)) => Some((start, end)),
        _ => None,
    };
    let (start, end) = range.unwrap_or((0, len.saturating_sub(1)));
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut file = match tokio::fs::File::open(&target).await {
        Ok(file) => file,
        Err(_) => return text(StatusCode::NOT_FOUND, "Not found", policy),
    };
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return text(StatusCode::NOT_FOUND, "Not found", policy);
    }
    let status = if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
    let mut builder = with_headers(Response::builder().status(status), content_type, policy.as_deref(), Some(count));
    builder = builder.header(header::ACCEPT_RANGES, "bytes");
    if range.is_some() {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    let body = Body::from_stream(stream::unfold((file, count), |(mut file, remaining)| async move {
        if remaining == 0 {
            return None;
        }
        let mut buffer = vec![0u8; CHUNK.min(remaining as usize)];
        match file.read(&mut buffer).await {
            Ok(0) => None,
            Ok(read) => {
                buffer.truncate(read);
                Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(buffer)), (file, remaining - read as u64)))
            }
            Err(error) => Some((Err(error), (file, 0))),
        }
    }));
    builder.body(body).unwrap_or_default()
}

fn with_headers(
    builder: axum::http::response::Builder,
    content_type: &str,
    policy: Option<&str>,
    length: Option<u64>,
) -> axum::http::response::Builder {
    let mut builder = builder
        .header(header::CONTENT_TYPE, content_type)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(HeaderName::from_static("cross-origin-resource-policy"), "cross-origin")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if let Some(policy) = policy {
        builder = builder.header(header::CONTENT_SECURITY_POLICY, policy);
    }
    if let Some(length) = length {
        builder = builder.header(header::CONTENT_LENGTH, length);
    }
    builder
}

fn text(status: StatusCode, message: &str, policy: Option<String>) -> Response<Body> {
    with_headers(Response::builder().status(status), "text/plain; charset=utf-8", policy.as_deref(), Some(message.len() as u64))
        .body(Body::from(message.to_owned()))
        .unwrap_or_default()
}

/// `host[:port]` for the CSP, from the request's own Host header when it is a
/// plain authority, else the daemon's loopback address.
fn host_for_csp(headers: &HeaderMap, daemon_port: u16) -> String {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .filter(|host| !host.is_empty() && host.len() <= 255 && host.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._:[]".contains(&b)))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("127.0.0.1:{daemon_port}"))
}

/// The Content-Security-Policy for a ticket whose URL prefix is `base`.
/// `sandbox` without `allow-same-origin` makes the document's origin opaque;
/// CSP path matching on `base` confines same-host loads to this ticket's tree.
pub fn csp(base: &str) -> String {
    format!(
        "sandbox allow-scripts allow-forms allow-modals; default-src {base} https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src {base} https: wss: data: blob:; frame-src {base} https:; form-action 'none'; base-uri {base}; frame-ancestors {FRAME_ANCESTORS}"
    )
}

/// Split a decoded request path into serveable segments. `None` rejects it:
/// empty, `.`, `..` or dot-prefixed segments, `\`, NUL. A single trailing `/`
/// is allowed (directory request).
pub fn split_segments(path: &str) -> Option<Vec<&str>> {
    if path.contains('\0') || path.contains('\\') {
        return None;
    }
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    if trimmed.is_empty() {
        return path.is_empty().then(Vec::new);
    }
    let segments: Vec<&str> = trimmed.split('/').collect();
    segments.iter().all(|segment| !segment.is_empty() && !segment.starts_with('.')).then_some(segments)
}

/// Resolve a request path to a regular file inside `root` (canonical). Handles
/// directories (`index.html` only), symlink escapes and dotted targets.
pub async fn locate(root: &Path, path: &str) -> Option<PathBuf> {
    let segments = split_segments(path)?;
    let mut candidate = root.to_path_buf();
    candidate.extend(&segments);
    let mut canonical = tokio::fs::canonicalize(&candidate).await.ok()?;
    if tokio::fs::metadata(&canonical).await.ok()?.is_dir() {
        canonical = tokio::fs::canonicalize(canonical.join("index.html")).await.ok()?;
    }
    if !canonical.starts_with(root) || !tokio::fs::metadata(&canonical).await.ok()?.is_file() {
        return None;
    }
    // A symlink inside the root may point at a dotted file or folder inside it.
    let relative = canonical.strip_prefix(root).ok()?;
    let clean = relative.components().all(|component| match component {
        Component::Normal(name) => name.to_str().is_some_and(|name| !name.starts_with('.')),
        _ => false,
    });
    clean.then_some(canonical)
}

enum RangeOutcome {
    None,
    Unsatisfiable,
    Range(u64, u64),
}

/// A single `bytes=` range. Multiple ranges are ignored (full response).
fn parse_range(value: &str, len: u64) -> RangeOutcome {
    let Some(spec) = value.trim().strip_prefix("bytes=") else { return RangeOutcome::None };
    if spec.contains(',') {
        return RangeOutcome::None;
    }
    let Some((from, to)) = spec.split_once('-') else { return RangeOutcome::None };
    let (from, to) = (from.trim(), to.trim());
    if len == 0 {
        return RangeOutcome::Unsatisfiable;
    }
    if from.is_empty() {
        let Ok(suffix) = to.parse::<u64>() else { return RangeOutcome::None };
        if suffix == 0 {
            return RangeOutcome::Unsatisfiable;
        }
        return RangeOutcome::Range(len.saturating_sub(suffix), len - 1);
    }
    let Ok(start) = from.parse::<u64>() else { return RangeOutcome::None };
    let end = if to.is_empty() {
        len - 1
    } else {
        match to.parse::<u64>() {
            Ok(end) => end.min(len - 1),
            Err(_) => return RangeOutcome::None,
        }
    };
    if start >= len || start > end { RangeOutcome::Unsatisfiable } else { RangeOutcome::Range(start, end) }
}

/// Insert the navigation bridge once, as the first child of `<head>`; when
/// there is no head, after `<html>`, else after the doctype, else first.
pub fn inject_bridge(html: &[u8]) -> Vec<u8> {
    let script = format!("<script>{BRIDGE_JS}</script>");
    let lower: Vec<u8> = html.iter().map(u8::to_ascii_lowercase).collect();
    let at = tag_end(&lower, b"<head").or_else(|| tag_end(&lower, b"<html")).or_else(|| doctype_end(&lower)).unwrap_or(0);
    let mut out = Vec::with_capacity(html.len() + script.len());
    out.extend_from_slice(&html[..at]);
    out.extend_from_slice(script.as_bytes());
    out.extend_from_slice(&html[at..]);
    out
}

/// Index just past the `>` of the first `<name ...>` open tag (not `<header`).
fn tag_end(lower: &[u8], name: &[u8]) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = find(&lower[from..], name) {
        let start = from + found;
        let after = start + name.len();
        if matches!(lower.get(after), Some(b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/')) {
            return lower[after..].iter().position(|b| *b == b'>').map(|close| after + close + 1);
        }
        from = after;
    }
    None
}

fn doctype_end(lower: &[u8]) -> Option<usize> {
    let start = lower.iter().position(|b| !b.is_ascii_whitespace() && *b != 0xEF && *b != 0xBB && *b != 0xBF)?;
    lower[start..].starts_with(b"<!doctype").then(|| lower[start..].iter().position(|b| *b == b'>').map(|close| start + close + 1))?
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::previews::tickets::TicketKind;
    use axum::body::to_bytes;
    use uuid::Uuid;

    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("kybern-preview-test-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn write(&self, rel: &str, bytes: &[u8]) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (Dir, PreviewTickets, String) {
        let dir = Dir::new();
        let tickets = PreviewTickets::new();
        let ticket = tickets.mint(TicketKind::Files { root: dir.0.clone() }, Uuid::new_v4(), None);
        (dir, tickets, ticket)
    }

    async fn get(tickets: &PreviewTickets, ticket: &str, path: &str) -> Response<Body> {
        respond(tickets, 4199, &HeaderMap::new(), ticket, path, MAX_FILE_BYTES).await
    }

    async fn body(response: Response<Body>) -> String {
        String::from_utf8_lossy(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).into_owned()
    }

    #[tokio::test]
    async fn blocks_dotfiles_dot_dirs_and_traversal() {
        let (dir, tickets, ticket) = fixture();
        dir.write("index.html", b"<html></html>");
        dir.write(".env", b"SECRET=1");
        dir.write(".git/config", b"[core]");
        std::fs::write(dir.0.parent().unwrap().join(format!("secret-{ticket}.txt")), b"outside").unwrap();
        for path in [
            ".env",
            ".git/config",
            "a/../../secret.txt",
            "../secret.txt",
            "..",
            "%2e%2e/secret.txt",
            "a//b",
            "./index.html",
            "a/./index.html",
            "sub\\..\\x",
            "x\0.html",
        ] {
            assert_eq!(get(&tickets, &ticket, path).await.status(), StatusCode::NOT_FOUND, "{path}");
        }
        // The route decodes once before this layer, so an encoded form that
        // survives decoding (`%2e%2e` decoded to `..`) is the same case.
        let decoded = crate::previews::percent_decode("%2e%2e/secret.txt").unwrap();
        assert_eq!(get(&tickets, &ticket, &decoded).await.status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_file(dir.0.parent().unwrap().join(format!("secret-{ticket}.txt")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_cannot_escape_the_root() {
        let (dir, tickets, ticket) = fixture();
        let outside = Dir::new();
        outside.write("secret.txt", b"nope");
        outside.write("page.html", b"<p>outside</p>");
        std::os::unix::fs::symlink(outside.0.join("secret.txt"), dir.0.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&outside.0, dir.0.join("linkdir")).unwrap();
        dir.write("inside/real.txt", b"fine");
        std::os::unix::fs::symlink(dir.0.join("inside"), dir.0.join("alias")).unwrap();
        std::os::unix::fs::symlink(dir.0.join(".hidden"), dir.0.join("tohidden")).unwrap();
        dir.write(".hidden/x.txt", b"hidden");
        assert_eq!(get(&tickets, &ticket, "link.txt").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(get(&tickets, &ticket, "linkdir/page.html").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(get(&tickets, &ticket, "alias/real.txt").await.status(), StatusCode::OK, "symlinks inside the root work");
        assert_eq!(get(&tickets, &ticket, "tohidden/x.txt").await.status(), StatusCode::NOT_FOUND, "symlink to a dotted target");
    }

    #[tokio::test]
    async fn directories_serve_index_html_and_never_list() {
        let (dir, tickets, ticket) = fixture();
        dir.write("index.html", b"<html><head></head>root</html>");
        dir.write("sub/index.html", b"<html><head></head>sub</html>");
        dir.write("empty/readme.txt", b"hi");
        assert!(body(get(&tickets, &ticket, "").await).await.contains("root"));
        assert!(body(get(&tickets, &ticket, "sub/").await).await.contains("sub"));
        assert!(body(get(&tickets, &ticket, "sub").await).await.contains("sub"));
        let listing = get(&tickets, &ticket, "empty/").await;
        assert_eq!(listing.status(), StatusCode::NOT_FOUND);
        assert!(!body(listing).await.contains("readme.txt"));
    }

    #[tokio::test]
    async fn sets_type_nosniff_and_security_headers() {
        let (dir, tickets, ticket) = fixture();
        for (name, expected) in [
            ("a.css", "text/css; charset=utf-8"),
            ("a.js", "text/javascript; charset=utf-8"),
            ("a.mjs", "text/javascript; charset=utf-8"),
            ("a.woff2", "font/woff2"),
            ("a.png", "image/png"),
            ("a.svg", "image/svg+xml"),
            ("a.wasm", "application/wasm"),
            ("a.json", "application/json; charset=utf-8"),
            ("a.md", "text/plain; charset=utf-8"),
            ("a.unknown", "application/octet-stream"),
        ] {
            dir.write(name, b"x");
            let response = get(&tickets, &ticket, name).await;
            assert_eq!(response.status(), StatusCode::OK, "{name}");
            let headers = response.headers();
            assert_eq!(headers[header::CONTENT_TYPE], expected, "{name}");
            assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert_eq!(headers[header::CACHE_CONTROL], "no-store");
            assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
            assert_eq!(headers["cross-origin-resource-policy"], "cross-origin");
            assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        }
        // Errors carry the same hardening.
        let missing = get(&tickets, &ticket, "nope.css").await;
        assert_eq!(missing.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    }

    #[tokio::test]
    async fn csp_confines_the_page_to_its_ticket_without_same_origin() {
        let (dir, tickets, ticket) = fixture();
        dir.write("a.css", b"x");
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:4199"));
        let response = respond(&tickets, 1, &headers, &ticket, "a.css", MAX_FILE_BYTES).await;
        let policy = response.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_owned();
        let base = format!("http://127.0.0.1:4199/preview-files/{ticket}/");
        assert!(policy.starts_with("sandbox allow-scripts allow-forms allow-modals;"), "{policy}");
        assert!(!policy.contains("allow-same-origin"));
        assert!(!policy.contains("allow-top-navigation") && !policy.contains("allow-popups"));
        for directive in ["default-src", "connect-src", "frame-src", "base-uri"] {
            assert!(policy.contains(&format!("{directive} {base}")), "{directive}: {policy}");
        }
        assert!(policy.contains("form-action 'none'"));
        assert!(policy.contains("frame-ancestors tauri://localhost http://tauri.localhost http://localhost:1420 'self'"));
        // A hostile Host header cannot inject into the policy.
        headers.insert(header::HOST, HeaderValue::from_static("evil.com; script-src *"));
        let response = respond(&tickets, 4199, &headers, &ticket, "a.css", MAX_FILE_BYTES).await;
        let policy = response.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(!policy.contains("evil.com"));
        assert!(policy.contains(&format!("http://127.0.0.1:4199/preview-files/{ticket}/")));
    }

    #[tokio::test]
    async fn injects_the_bridge_once_into_html_only() {
        let (dir, tickets, ticket) = fixture();
        dir.write("a.html", b"<!doctype html><html><head><title>t</title></head><body><head></body></html>");
        dir.write("b.htm", b"<p>no head</p>");
        dir.write("c.html", b"<!DOCTYPE html><html lang=en><body>x</body></html>");
        dir.write("d.svg", b"<svg xmlns='http://www.w3.org/2000/svg'><head/></svg>");
        dir.write("e.js", b"<head>");
        let a = body(get(&tickets, &ticket, "a.html").await).await;
        assert_eq!(a.matches("<script>").count(), 1);
        assert!(a.contains("<head><script>(function(){"), "first child of head");
        let b = body(get(&tickets, &ticket, "b.htm").await).await;
        assert!(b.starts_with("<script>") && b.ends_with("<p>no head</p>"));
        let c = body(get(&tickets, &ticket, "c.html").await).await;
        assert!(c.starts_with("<!DOCTYPE html><html lang=en><script>"), "after <html> keeps standards mode: {c}");
        for plain in ["d.svg", "e.js"] {
            let text = body(get(&tickets, &ticket, plain).await).await;
            assert!(!text.contains("kybern-preview"), "{plain} must not be injected");
        }
        assert!(include_str!("bridge.js").len() <= 1536);
        assert!(!include_str!("bridge.js").contains("token"));
    }

    #[test]
    fn bridge_ignores_header_tags_and_handles_uppercase() {
        let out = String::from_utf8(inject_bridge(b"<HEADER>x</HEADER><HEAD ><title>")).unwrap();
        assert!(out.contains("<HEAD ><script>"), "{out}");
        assert_eq!(out.matches("<script>").count(), 1);
    }

    #[tokio::test]
    async fn range_requests_stream_one_range() {
        let (dir, tickets, ticket) = fixture();
        dir.write("v.mp4", b"0123456789");
        let ranged = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::RANGE, HeaderValue::from_static(value));
            headers
        };
        let r = respond(&tickets, 1, &ranged("bytes=2-5"), &ticket, "v.mp4", MAX_FILE_BYTES).await;
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(body(r).await, "2345");
        let r = respond(&tickets, 1, &ranged("bytes=-3"), &ticket, "v.mp4", MAX_FILE_BYTES).await;
        assert_eq!(body(r).await, "789");
        let r = respond(&tickets, 1, &ranged("bytes=8-"), &ticket, "v.mp4", MAX_FILE_BYTES).await;
        assert_eq!(body(r).await, "89");
        let r = respond(&tickets, 1, &ranged("bytes=50-60"), &ticket, "v.mp4", MAX_FILE_BYTES).await;
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        let r = respond(&tickets, 1, &ranged("bytes=0-1,4-5"), &ticket, "v.mp4", MAX_FILE_BYTES).await;
        assert_eq!(r.status(), StatusCode::OK, "multiple ranges fall back to the whole file");
        assert_eq!(body(r).await, "0123456789");
    }

    #[tokio::test]
    async fn files_over_the_cap_are_refused() {
        let (dir, tickets, ticket) = fixture();
        dir.write("big.bin", &[0u8; 2048]);
        dir.write("small.bin", &[0u8; 100]);
        let big = respond(&tickets, 1, &HeaderMap::new(), &ticket, "big.bin", 1024).await;
        assert_eq!(big.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(respond(&tickets, 1, &HeaderMap::new(), &ticket, "small.bin", 1024).await.status(), StatusCode::OK);
        assert_eq!(MAX_FILE_BYTES, 50 * 1024 * 1024);
    }

    #[tokio::test]
    async fn tickets_are_scoped_and_revocable() {
        let (dir_a, tickets, ticket_a) = fixture();
        let dir_b = Dir::new();
        dir_a.write("a.txt", b"a");
        dir_b.write("b.txt", b"b");
        let thread = Uuid::new_v4();
        let ticket_b = tickets.mint(TicketKind::Files { root: dir_b.0.clone() }, thread, None);
        assert_eq!(get(&tickets, &ticket_a, "a.txt").await.status(), StatusCode::OK);
        assert_eq!(get(&tickets, &ticket_b, "b.txt").await.status(), StatusCode::OK);
        assert_eq!(get(&tickets, &ticket_a, "b.txt").await.status(), StatusCode::NOT_FOUND, "ticket A cannot read B's root");
        assert_eq!(get(&tickets, &ticket_b, "a.txt").await.status(), StatusCode::NOT_FOUND);
        tickets.revoke_thread(thread);
        let expired = get(&tickets, &ticket_b, "b.txt").await;
        assert_eq!(expired.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(expired).await, "Preview expired. Reopen it from Kybern.");
        assert_eq!(get(&tickets, "not-a-ticket", "a.txt").await.status(), StatusCode::NOT_FOUND);
        // A proxy ticket never serves files.
        let proxy = tickets.mint(TicketKind::Proxy { port: 5173 }, thread, None);
        assert_eq!(get(&tickets, &proxy, "a.txt").await.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn segment_rules() {
        assert_eq!(split_segments(""), Some(vec![]));
        assert_eq!(split_segments("a/b.css"), Some(vec!["a", "b.css"]));
        assert_eq!(split_segments("a/"), Some(vec!["a"]));
        for bad in ["/", "a//b", ".", "..", "a/..", ".hidden", "a/.b/c", "a\\b", "a\0b"] {
            assert_eq!(split_segments(bad), None, "{bad:?}");
        }
    }
}
