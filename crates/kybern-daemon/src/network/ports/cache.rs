//! The viewing side's cache of a forward's dev server responses (ADE-126).
//!
//! A dev server sends most of a page with `Cache-Control: no-cache` and a validator, so even a browser that keeps them
//! asks again for each one on a reload: one round trip to the other machine per request, six at a time. Kybern's web
//! views often start with no cache at all. This cache keeps the responses the forward already carried, keyed by host,
//! path and the request headers they `Vary` on, with their validators.
//!
//! * A page load (a navigation request) revalidates every kept response with **one** request over the forward's HTTP/2
//!   connection ([`REVALIDATE_HEADER`]): the target checks each validator against its dev server over loopback, in
//!   parallel, and answers fresh, changed (with the new body, compressed) or gone. Requests of the page that arrive
//!   meanwhile wait for that answer instead of crossing the network. A reload of an unchanged page costs one round trip
//!   plus the changed bytes.
//! * A response validated in the last [`FRESH_FOR`] is answered here; an older one is revalidated on its own (a 304 then
//!   costs a round trip but no body). A hot-reload message on the forward's WebSockets makes everything stale at once.
//! * Only whole `200` answers to plain `GET`s with an `ETag` or `Last-Modified` are kept: never with `Set-Cookie`,
//!   `Cache-Control: private` or `no-store`, `Vary: *`, a range, an `Authorization` header or an event stream. One
//!   response is at most [`MAX_ENTRY`] as it travelled, a forward keeps at most [`MAX_FORWARD`] and all forwards
//!   [`MAX_TOTAL`], least recently used first out. It lives in memory and ends with the forward.
//! * Only a target that lists `ports.cache.v1` is cached for: it keeps the dev server's own `ETag` beside the weak one a
//!   compressed body gets ([`ORIGINAL_ETAG_HEADER`]), so revalidation sends exactly what the dev server issued.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::{Request, Response, StatusCode};
use serde::{Deserialize, Serialize};

use super::direct::{self, ProxyBody, status_response, strip_hop_headers};

const TARGET: &str = "kybern::network::ports";

/// Viewing side → target: the viewing machine keeps a cache of this forward's responses.
pub const CACHE_HEADER: &str = "x-kybern-cache";
/// Target → viewing side, beside a weakened `ETag`: the dev server's own tag.
pub const ORIGINAL_ETAG_HEADER: &str = "x-kybern-etag";
/// Viewing side → target: this request is a batched revalidation, not a request for the dev server.
pub const REVALIDATE_HEADER: &str = "x-kybern-revalidate";

/// A response validated this recently is answered without asking the target.
pub const FRESH_FOR: Duration = Duration::from_secs(20);
/// What counts as checked by the page load now, for a request that asks for a checked answer.
const JUST_CHECKED: Duration = Duration::from_secs(3);
pub const MAX_ENTRY: usize = 32 * 1024 * 1024;
pub const MAX_FORWARD: usize = 96 * 1024 * 1024;
pub const MAX_TOTAL: usize = 256 * 1024 * 1024;
/// Responses one batch revalidates at most.
const MAX_BATCH: usize = 2000;
/// Changed bodies one batch answer carries at most; the rest are reported gone and fetched as usual.
const MAX_BATCH_BODIES: usize = 4 * 1024 * 1024;
/// One changed body a batch carries at most, before compression.
const MAX_BATCH_BODY: usize = 512 * 1024;
/// How long the target waits for the dev server on one entry of a batch.
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
/// Checks a target runs against its dev server at once.
const BATCH_CONCURRENCY: usize = 16;
/// How long a page request waits for a batch before it asks on its own.
const BATCH_WAIT: Duration = Duration::from_secs(30);
/// Two navigations this close together share one batch.
const BATCH_SPACING: Duration = Duration::from_secs(1);
/// The request headers a revalidation repeats (besides those the response varies on).
const REPLAYED: [&str; 7] = ["host", "accept", "accept-encoding", "accept-language", "user-agent", "cookie", "x-forwarded-proto"];

/// What every forward's cache holds together.
static TOTAL: AtomicUsize = AtomicUsize::new(0);

pub struct Entry {
    key: String,
    /// The request headers the response varies on, as this request had them (lowercase names).
    vary: Vec<(String, Option<String>)>,
    /// The request headers a revalidation sends again.
    replay: Vec<(String, String)>,
    status: StatusCode,
    headers: HeaderMap,
    pub body: Bytes,
    /// The tag the dev server issued (what a revalidation sends), and the one the browser saw.
    upstream_etag: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
    validated_at: Mutex<Instant>,
    used: AtomicU64,
}

impl Entry {
    /// The tag a revalidation sends: the dev server's own.
    pub fn upstream_etag(&self) -> Option<&str> {
        self.upstream_etag.as_deref().or(self.etag.as_deref())
    }

    pub fn last_modified(&self) -> Option<&str> {
        self.last_modified.as_deref()
    }

    fn size(&self) -> usize {
        self.body.len() + self.key.len() + 512
    }

    fn validated_at(&self) -> Instant {
        *self.validated_at.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn matches(&self, headers: &HeaderMap) -> bool {
        self.vary.iter().all(|(name, value)| header_text(headers, name).as_deref() == value.as_deref())
    }
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<&str> = headers.get_all(name).iter().filter_map(|value| value.to_str().ok()).collect();
    (!values.is_empty()).then(|| values.join(", "))
}

pub enum Lookup {
    /// Validated recently: answer from here.
    Fresh(Arc<Entry>),
    /// Kept but not validated recently: ask with its validators.
    Stale(Arc<Entry>),
    Miss,
}

struct Batch {
    keys: std::collections::HashSet<String>,
    done: tokio::sync::watch::Receiver<bool>,
}

#[derive(Default)]
struct State {
    entries: HashMap<String, Vec<Arc<Entry>>>,
    size: usize,
    invalidated_at: Option<Instant>,
    batch: Option<Batch>,
    last_batch: Option<Instant>,
}

/// One forward's cache.
#[derive(Default)]
pub struct Cache {
    state: Mutex<State>,
    clock: AtomicU64,
    /// Bytes answered from here and bytes that crossed the network, over the forward's life.
    pub served: AtomicU64,
}

impl Drop for Cache {
    fn drop(&mut self) {
        let size = self.lock().size;
        TOTAL.fetch_sub(size, Ordering::Relaxed);
    }
}

/// The key of a request this cache may answer: host and path, for a plain `GET` with nothing that makes it personal or
/// partial.
pub fn request_key(method: &hyper::Method, headers: &HeaderMap, path: &str) -> Option<String> {
    if method != hyper::Method::GET
        || headers.contains_key(hyper::header::AUTHORIZATION)
        || headers.contains_key(hyper::header::RANGE)
        || headers.contains_key(hyper::header::UPGRADE)
        || has_directive(headers, hyper::header::CACHE_CONTROL, "no-store")
    {
        return None;
    }
    let host = header_text(headers, "host").unwrap_or_default();
    Some(format!("{host}{path}"))
}

fn has_directive(headers: &HeaderMap, name: HeaderName, directive: &str) -> bool {
    headers
        .get_all(name)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|part| part.trim().split('=').next().is_some_and(|name| name.trim().eq_ignore_ascii_case(directive)))
}

/// The request asks for an answer the server has checked: `Cache-Control: no-cache` or `max-age=0`, or `Pragma: no-cache`.
fn wants_checked(headers: &HeaderMap) -> bool {
    has_directive(headers, hyper::header::CACHE_CONTROL, "no-cache")
        || has_directive(headers, hyper::header::PRAGMA, "no-cache")
        || headers
            .get_all(hyper::header::CACHE_CONTROL)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .any(|part| part.trim().eq_ignore_ascii_case("max-age=0"))
}

/// Whether a response may be kept, and the request headers it varies on.
pub fn storable(parts: &hyper::http::response::Parts) -> Option<Vec<String>> {
    let headers = &parts.headers;
    if parts.status != StatusCode::OK
        || !(headers.contains_key(hyper::header::ETAG) || headers.contains_key(hyper::header::LAST_MODIFIED))
        || headers.contains_key(hyper::header::SET_COOKIE)
        || headers.contains_key(hyper::header::CONTENT_RANGE)
        || has_directive(headers, hyper::header::CACHE_CONTROL, "no-store")
        || has_directive(headers, hyper::header::CACHE_CONTROL, "private")
    {
        return None;
    }
    let kind = header_text(headers, "content-type").unwrap_or_default().to_ascii_lowercase();
    if kind.starts_with("text/event-stream") {
        return None;
    }
    if header_text(headers, "content-length").and_then(|n| n.trim().parse::<usize>().ok()).is_some_and(|n| n > MAX_ENTRY) {
        return None;
    }
    let mut vary: Vec<String> = headers
        .get_all(hyper::header::VARY)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect();
    if vary.iter().any(|name| name == "*") {
        return None;
    }
    vary.sort();
    vary.dedup();
    Some(vary)
}

/// Whether the browser's conditional request matches the kept response (`If-None-Match` compares weakly).
fn browser_has(entry: &Entry, headers: &HeaderMap) -> bool {
    let weak = |tag: &str| tag.trim().trim_start_matches("W/").to_string();
    if let Some(asked) = header_text(headers, "if-none-match") {
        let Some(tag) = entry.etag.as_deref() else { return false };
        return asked.split(',').any(|candidate| candidate.trim() == "*" || weak(candidate) == weak(tag));
    }
    match (header_text(headers, "if-modified-since"), entry.last_modified.as_deref()) {
        (Some(since), Some(modified)) => since.trim() == modified.trim(),
        _ => false,
    }
}

/// The answer to `request_headers` from a kept response: `304` when the browser already has it.
pub fn respond(entry: &Entry, request_headers: &HeaderMap) -> Response<ProxyBody> {
    if browser_has(entry, request_headers) {
        let mut response = status_response(StatusCode::NOT_MODIFIED);
        for name in [hyper::header::ETAG, hyper::header::CACHE_CONTROL, hyper::header::LAST_MODIFIED, hyper::header::VARY] {
            for value in entry.headers.get_all(&name) {
                response.headers_mut().append(name.clone(), value.clone());
            }
        }
        return response;
    }
    let mut response = Response::new(Full::new(entry.body.clone()).map_err(|never| match never {}).boxed());
    *response.status_mut() = entry.status;
    *response.headers_mut() = entry.headers.clone();
    response.headers_mut().insert(hyper::header::CONTENT_LENGTH, HeaderValue::from(entry.body.len()));
    response
}

impl Cache {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Validated within `window`, and after the last hot-reload message.
    fn fresh(&self, state: &State, entry: &Entry, window: Duration) -> bool {
        let at = entry.validated_at();
        at.elapsed() < window && state.invalidated_at.is_none_or(|invalidated| at > invalidated)
    }

    /// A request that asks for an answer checked with the server (`no-cache`, `max-age=0`, a hard reload) is answered from
    /// here only when this page load's batch has just checked it.
    pub fn lookup(&self, key: &str, headers: &HeaderMap) -> Lookup {
        let state = self.lock();
        let Some(entry) = state.entries.get(key).and_then(|variants| variants.iter().find(|entry| entry.matches(headers))) else {
            return Lookup::Miss;
        };
        entry.used.store(self.clock.fetch_add(1, Ordering::Relaxed), Ordering::Relaxed);
        let window = if wants_checked(headers) { JUST_CHECKED } else { FRESH_FOR };
        if self.fresh(&state, entry, window) { Lookup::Fresh(entry.clone()) } else { Lookup::Stale(entry.clone()) }
    }

    /// The dev server confirmed `entry` (a `304`) for a request sent at `sent`.
    pub fn confirm(&self, entry: &Entry, sent: Instant) {
        let mut at = entry.validated_at.lock().unwrap_or_else(|p| p.into_inner());
        *at = (*at).max(sent);
    }

    /// Keep a response. `request` are the browser's request headers, `parts` the response as it travelled (headers that
    /// belong to Kybern are taken out here), `sent` when the request left: the body is what the server had then, so a
    /// hot-reload message after that point makes it stale even when the body arrives later.
    pub fn store(
        &self,
        key: String,
        request: &HeaderMap,
        mut parts: hyper::http::response::Parts,
        mut vary: Vec<String>,
        body: Bytes,
        sent: Instant,
    ) {
        if body.len() > MAX_ENTRY {
            return;
        }
        // A cookie is part of what the browser asked for even when the server does not say it varies on it: a page for
        // one session is never answered to another.
        if request.contains_key(hyper::header::COOKIE) && !vary.iter().any(|name| name == "cookie") {
            vary.push("cookie".into());
        }
        let upstream_etag = parts
            .headers
            .remove(ORIGINAL_ETAG_HEADER)
            .or_else(|| parts.headers.get(hyper::header::ETAG).cloned())
            .and_then(|tag| tag.to_str().ok().map(str::to_string));
        parts.headers.remove(hyper::header::CONTENT_LENGTH);
        let mut replay: Vec<(String, String)> = REPLAYED
            .iter()
            .chain(vary.iter().map(String::as_str).collect::<Vec<_>>().iter())
            .filter_map(|name| header_text(request, name).map(|value| (name.to_string(), value)))
            .collect();
        replay.sort();
        replay.dedup();
        let entry = Arc::new(Entry {
            vary: vary.iter().map(|name| (name.clone(), header_text(request, name))).collect(),
            replay,
            status: parts.status,
            etag: header_text(&parts.headers, "etag"),
            last_modified: header_text(&parts.headers, "last-modified"),
            upstream_etag,
            headers: parts.headers,
            body,
            key: key.clone(),
            validated_at: Mutex::new(sent),
            used: AtomicU64::new(self.clock.fetch_add(1, Ordering::Relaxed)),
        });
        self.insert(entry);
    }

    fn insert(&self, entry: Arc<Entry>) {
        let size = entry.size();
        let mut state = self.lock();
        Self::remove_variant(&mut state, &entry.key, |held| held.vary == entry.vary);
        while state.size + size > MAX_FORWARD || (TOTAL.load(Ordering::Relaxed) + size > MAX_TOTAL && state.size > 0) {
            let oldest = state
                .entries
                .values()
                .flatten()
                .min_by_key(|held| held.used.load(Ordering::Relaxed))
                .map(|held| (held.key.clone(), held.vary.clone()));
            let Some((key, vary)) = oldest else { break };
            Self::remove_variant(&mut state, &key, |held| held.vary == vary);
        }
        if state.size + size > MAX_FORWARD || TOTAL.load(Ordering::Relaxed) + size > MAX_TOTAL {
            return;
        }
        state.size += size;
        TOTAL.fetch_add(size, Ordering::Relaxed);
        state.entries.entry(entry.key.clone()).or_default().push(entry);
    }

    fn remove_variant(state: &mut State, key: &str, which: impl Fn(&Entry) -> bool) {
        let Some(variants) = state.entries.get_mut(key) else { return };
        let mut freed = 0;
        variants.retain(|held| {
            let drop = which(held);
            if drop {
                freed += held.size();
            }
            !drop
        });
        if variants.is_empty() {
            state.entries.remove(key);
        }
        state.size -= freed;
        TOTAL.fetch_sub(freed, Ordering::Relaxed);
    }

    pub fn remove(&self, entry: &Entry) {
        let mut state = self.lock();
        Self::remove_variant(&mut state, &entry.key, |held| std::ptr::eq(held, entry));
    }

    /// A hot-reload message: whatever is kept is asked about again before it is used.
    pub fn invalidate(&self) {
        self.lock().invalidated_at = Some(Instant::now());
    }

    pub fn len(&self) -> usize {
        self.lock().entries.values().map(Vec::len).sum()
    }

    pub fn bytes(&self) -> usize {
        self.lock().size
    }

    /// Start a batch for a page load on `host`: the kept responses of that host to revalidate, or `None` when there are
    /// none or a batch runs or just ran. The returned sender ends the batch.
    pub fn begin_batch(&self, host: &str) -> Option<(Vec<Arc<Entry>>, tokio::sync::watch::Sender<bool>)> {
        let mut state = self.lock();
        if state.batch.is_some() || state.last_batch.is_some_and(|at| at.elapsed() < BATCH_SPACING) {
            return None;
        }
        // The plain and the Fast listener are different hosts with their own entries; a page loads from one of them.
        let mut entries: Vec<Arc<Entry>> = state
            .entries
            .values()
            .flatten()
            .filter(|entry| entry.key.strip_prefix(host).is_some_and(|path| path.starts_with('/')))
            .cloned()
            .collect();
        if entries.is_empty() {
            return None;
        }
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.used.load(Ordering::Relaxed)));
        entries.truncate(MAX_BATCH);
        let (done, waiting) = tokio::sync::watch::channel(false);
        state.batch = Some(Batch { keys: entries.iter().map(|entry| entry.key.clone()).collect(), done: waiting });
        state.last_batch = Some(Instant::now());
        Some((entries, done))
    }

    /// Apply a batch's answer (`None` when it failed: the batch's responses are then asked about one by one). `sent` is
    /// when the batch left: what it confirmed was true then.
    pub fn finish_batch(
        &self,
        entries: &[Arc<Entry>],
        outcome: Option<Vec<Outcome>>,
        done: tokio::sync::watch::Sender<bool>,
        sent: Instant,
    ) {
        if let Some(outcomes) = outcome {
            let now = sent;
            let mut answered = vec![false; entries.len()];
            for outcome in outcomes {
                let Some(entry) = entries.get(outcome.index) else { continue };
                answered[outcome.index] = true;
                match outcome.state {
                    Answer::Fresh => *entry.validated_at.lock().unwrap_or_else(|p| p.into_inner()) = now,
                    Answer::Changed { mut headers, body } => {
                        let etag = header_text(&headers, "etag");
                        let upstream = headers.remove(ORIGINAL_ETAG_HEADER).and_then(|tag| tag.to_str().ok().map(str::to_string));
                        let changed = Arc::new(Entry {
                            key: entry.key.clone(),
                            vary: entry.vary.clone(),
                            replay: entry.replay.clone(),
                            status: StatusCode::OK,
                            upstream_etag: upstream.or_else(|| etag.clone()),
                            etag,
                            last_modified: header_text(&headers, "last-modified"),
                            headers,
                            body,
                            validated_at: Mutex::new(now),
                            used: AtomicU64::new(entry.used.load(Ordering::Relaxed)),
                        });
                        self.remove(entry);
                        self.insert(changed);
                    }
                    Answer::Gone => self.remove(entry),
                }
            }
            for (entry, answered) in entries.iter().zip(answered) {
                if !answered {
                    self.remove(entry);
                }
            }
        }
        self.lock().batch = None;
        let _ = done.send(true);
    }

    /// Wait for a batch that covers `key`, if one runs.
    pub async fn wait_for_batch(&self, key: &str) {
        let waiting = {
            let state = self.lock();
            match &state.batch {
                Some(batch) if batch.keys.contains(key) => Some(batch.done.clone()),
                _ => None,
            }
        };
        if let Some(mut done) = waiting {
            let _ = tokio::time::timeout(BATCH_WAIT, done.wait_for(|finished| *finished)).await;
        }
    }
}

/// Whether a request is a page load (a document or frame navigation), which starts a batch.
pub fn is_navigation(method: &hyper::Method, headers: &HeaderMap) -> bool {
    if method != hyper::Method::GET {
        return false;
    }
    match (header_text(headers, "sec-fetch-mode"), header_text(headers, "sec-fetch-dest")) {
        (Some(mode), _) => mode.eq_ignore_ascii_case("navigate"),
        (None, Some(dest)) => matches!(dest.to_ascii_lowercase().as_str(), "document" | "iframe" | "frame"),
        (None, None) => header_text(headers, "accept").is_some_and(|accept| accept.to_ascii_lowercase().starts_with("text/html")),
    }
}

// ---- the batch on the wire ----

#[derive(Serialize, Deserialize)]
struct BatchRequest {
    entries: Vec<BatchEntry>,
}

#[derive(Serialize, Deserialize)]
struct BatchEntry {
    path: String,
    headers: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct RecordHead {
    i: usize,
    /// `fresh`, `changed` (the new headers and a body follow) or `gone`.
    state: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    headers: Vec<(String, String)>,
}

pub enum Answer {
    Fresh,
    Changed { headers: HeaderMap, body: Bytes },
    Gone,
}

pub struct Outcome {
    pub index: usize,
    pub state: Answer,
}

/// The path of a key (`host` + path).
fn path_of(entry: &Entry) -> &str {
    let host = entry.replay.iter().find(|(name, _)| name == "host").map(|(_, host)| host.len()).unwrap_or(0);
    &entry.key[host.min(entry.key.len())..]
}

/// The request a batch sends over the forward's HTTP/2 connection. `authority` is any host of the forward.
pub fn batch_request(entries: &[Arc<Entry>], authority: &str) -> Option<Request<ProxyBody>> {
    let body = BatchRequest {
        entries: entries
            .iter()
            .map(|entry| BatchEntry {
                path: path_of(entry).to_string(),
                headers: entry.replay.clone(),
                etag: entry.upstream_etag.clone().or_else(|| entry.etag.clone()),
                last_modified: entry.last_modified.clone(),
            })
            .collect(),
    };
    let body = serde_json::to_vec(&body).ok()?;
    Request::post(format!("https://{authority}/"))
        .version(hyper::Version::HTTP_2)
        .header(REVALIDATE_HEADER, "1")
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed())
        .ok()
}

/// Read a batch answer: length-prefixed JSON heads, each `changed` one followed by a length-prefixed body.
pub fn parse_batch(mut bytes: &[u8]) -> Option<Vec<Outcome>> {
    fn take<'a>(bytes: &mut &'a [u8]) -> Option<&'a [u8]> {
        let len = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
        let part = bytes.get(4..4 + len)?;
        *bytes = &bytes[4 + len..];
        Some(part)
    }
    let mut outcomes = Vec::new();
    while !bytes.is_empty() {
        let head: RecordHead = serde_json::from_slice(take(&mut bytes)?).ok()?;
        let state = match head.state.as_str() {
            "fresh" => Answer::Fresh,
            "changed" => {
                let body = Bytes::copy_from_slice(take(&mut bytes)?);
                let mut headers = HeaderMap::new();
                for (name, value) in head.headers {
                    if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(&value)) {
                        headers.append(name, value);
                    }
                }
                Answer::Changed { headers, body }
            }
            _ => Answer::Gone,
        };
        outcomes.push(Outcome { index: head.i, state });
    }
    Some(outcomes)
}

fn push_record(out: &mut Vec<u8>, head: &RecordHead, body: Option<&[u8]>) {
    let head = serde_json::to_vec(head).unwrap_or_default();
    out.extend_from_slice(&(head.len() as u32).to_be_bytes());
    out.extend_from_slice(&head);
    if let Some(body) = body {
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(body);
    }
}

// ---- the target: one batch, many loopback checks ----

/// Answer a batched revalidation from the viewing machine: each entry is asked of the dev server with its validators.
pub(super) async fn serve_revalidate(upstream: SocketAddr, request: Request<Incoming>) -> Response<ProxyBody> {
    let authority = request.uri().authority().map(|authority| authority.to_string());
    let Ok(body) = Limited::new(request.into_body(), 8 * 1024 * 1024).collect().await else {
        return status_response(StatusCode::PAYLOAD_TOO_LARGE);
    };
    let Ok(batch) = serde_json::from_slice::<BatchRequest>(&body.to_bytes()) else {
        return status_response(StatusCode::BAD_REQUEST);
    };
    let started = Instant::now();
    // Its own small pool: the forward's pool carries the browser's request bodies, these have none.
    let mut connector = hyper_util::client::legacy::connect::HttpConnector::new();
    connector.set_nodelay(true);
    connector.set_connect_timeout(Some(Duration::from_secs(3)));
    let client: CheckClient = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .pool_max_idle_per_host(BATCH_CONCURRENCY)
        .build(connector);
    let client = &client;
    let budget = Arc::new(AtomicUsize::new(MAX_BATCH_BODIES));
    let count = batch.entries.len().min(MAX_BATCH);
    let checks = futures::stream::iter(batch.entries.into_iter().take(MAX_BATCH).enumerate())
        .map(|(i, entry)| {
            let (client, authority, budget) = (client.clone(), authority.clone(), budget.clone());
            async move { (i, check_one(&client, upstream, authority.as_deref(), entry, &budget).await) }
        })
        .buffer_unordered(BATCH_CONCURRENCY);
    let results: Vec<(usize, Checked)> = checks.collect().await;
    let mut out = Vec::new();
    let (mut fresh, mut changed) = (0, 0);
    for (i, result) in results {
        match result {
            Checked::Fresh => {
                fresh += 1;
                push_record(&mut out, &RecordHead { i, state: "fresh".into(), headers: Vec::new() }, None);
            }
            Checked::Changed(headers, body) => {
                changed += 1;
                push_record(&mut out, &RecordHead { i, state: "changed".into(), headers }, Some(&body));
            }
            Checked::Gone => push_record(&mut out, &RecordHead { i, state: "gone".into(), headers: Vec::new() }, None),
        }
    }
    tracing::debug!(target: TARGET, count, fresh, changed, ms = started.elapsed().as_millis() as u64, "revalidated a forward's cache");
    let mut response = Response::new(Full::new(Bytes::from(out)).map_err(|never| match never {}).boxed());
    response.headers_mut().insert(hyper::header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    response
}

/// Take `amount` from `left` when that much is left, in one step however many tasks take at once.
pub(super) fn take_from(left: &AtomicUsize, amount: usize) -> bool {
    let mut current = left.load(Ordering::Acquire);
    loop {
        let Some(next) = current.checked_sub(amount) else { return false };
        match left.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return true,
            Err(seen) => current = seen,
        }
    }
}

enum Checked {
    Fresh,
    Changed(Vec<(String, String)>, Vec<u8>),
    Gone,
}

type CheckClient = hyper_util::client::legacy::Client<hyper_util::client::legacy::connect::HttpConnector, http_body_util::Empty<Bytes>>;

async fn check_one(
    client: &CheckClient,
    upstream: SocketAddr,
    authority: Option<&str>,
    entry: BatchEntry,
    budget: &AtomicUsize,
) -> Checked {
    if !entry.path.starts_with('/') {
        return Checked::Gone;
    }
    let Ok(uri) = format!("http://{upstream}{}", entry.path).parse::<hyper::Uri>() else { return Checked::Gone };
    let mut headers = HeaderMap::new();
    for (name, value) in &entry.headers {
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(value)) {
            headers.append(name, value);
        }
    }
    strip_hop_headers(&mut headers);
    direct::take_kybern_headers(&mut headers);
    direct::set_dev_host(&mut headers, authority);
    if let Some(value) = entry.etag.as_deref().and_then(|tag| HeaderValue::from_str(tag).ok()) {
        headers.insert(hyper::header::IF_NONE_MATCH, value);
    }
    if let Some(value) = entry.last_modified.as_deref().and_then(|at| HeaderValue::from_str(at).ok()) {
        headers.insert(hyper::header::IF_MODIFIED_SINCE, value);
    }
    let gzip_ok = direct::accepts_gzip(&headers);
    let mut request = Request::new(http_body_util::Empty::<Bytes>::new());
    *request.uri_mut() = uri;
    *request.headers_mut() = headers;
    // A dev server that holds a request (Vite while it optimizes dependencies) must not hold the whole batch: that
    // response is reported gone and the browser asks for it as usual.
    let Ok(Ok(response)) = tokio::time::timeout(CHECK_TIMEOUT, client.request(request)).await else { return Checked::Gone };
    if response.status() == StatusCode::NOT_MODIFIED {
        return Checked::Fresh;
    }
    let (mut parts, body) = response.into_parts();
    if storable(&parts).is_none() {
        return Checked::Gone;
    }
    // Only small changed bodies travel in the batch, so its answer stays quick on a slow link and the page's requests
    // are not held behind a large one; a large change is fetched by the browser and streams as usual.
    let Ok(Ok(body)) = tokio::time::timeout(CHECK_TIMEOUT, Limited::new(body, MAX_BATCH_BODY).collect()).await else {
        return Checked::Gone;
    };
    let mut body = body.to_bytes().to_vec();
    strip_hop_headers(&mut parts.headers);
    if gzip_ok && direct::compressible(&parts) {
        let Some(zipped) = direct::gzip_all(&body) else { return Checked::Gone };
        direct::mark_gzipped(&mut parts.headers, true);
        body = zipped;
    }
    parts.headers.remove(hyper::header::CONTENT_LENGTH);
    // A changed body counts against the batch's budget; past it the viewing machine fetches it as usual.
    if !take_from(budget, body.len()) {
        return Checked::Gone;
    }
    let headers = parts
        .headers
        .iter()
        .filter_map(|(name, value)| value.to_str().ok().map(|value| (name.as_str().to_string(), value.to_string())))
        .collect();
    Checked::Changed(headers, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(status: u16, headers: &[(&str, &str)]) -> hyper::http::response::Parts {
        let mut builder = Response::builder().status(status);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(()).unwrap().into_parts().0
    }

    fn request(headers: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in headers {
            map.append(HeaderName::from_bytes(name.as_bytes()).unwrap(), HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn only_whole_validated_shareable_answers_are_kept() {
        let tag = ("etag", "W/\"1\"");
        assert_eq!(
            storable(&parts(200, &[tag, ("vary", "Accept-Encoding, Origin")])),
            Some(vec!["accept-encoding".into(), "origin".into()])
        );
        assert!(storable(&parts(200, &[("last-modified", "Tue, 03 Nov 2026 00:00:00 GMT")])).is_some());
        assert!(storable(&parts(200, &[])).is_none(), "no validator");
        assert!(storable(&parts(206, &[tag])).is_none());
        assert!(storable(&parts(304, &[tag])).is_none());
        assert!(storable(&parts(200, &[tag, ("set-cookie", "a=b")])).is_none());
        assert!(storable(&parts(200, &[tag, ("cache-control", "private, max-age=10")])).is_none());
        assert!(storable(&parts(200, &[tag, ("cache-control", "no-store")])).is_none());
        assert!(storable(&parts(200, &[tag, ("vary", "*")])).is_none());
        assert!(storable(&parts(200, &[tag, ("content-range", "bytes 0-1/2")])).is_none());
        assert!(storable(&parts(200, &[tag, ("content-type", "text/event-stream")])).is_none());
        assert!(storable(&parts(200, &[tag, ("cache-control", "no-cache")])).is_some(), "no-cache only means ask again");

        let get = hyper::Method::GET;
        assert_eq!(request_key(&get, &request(&[("host", "localhost:3000")]), "/a.js?v=1").as_deref(), Some("localhost:3000/a.js?v=1"));
        assert!(request_key(&hyper::Method::POST, &request(&[]), "/").is_none());
        assert!(request_key(&get, &request(&[("authorization", "Bearer x")]), "/").is_none());
        assert!(request_key(&get, &request(&[("range", "bytes=0-1")]), "/").is_none());
        assert!(request_key(&get, &request(&[("cache-control", "no-store")]), "/").is_none());
    }

    fn keep(cache: &Cache, key: &str, request_headers: &[(&str, &str)], response: &[(&str, &str)], body: &str) {
        let parts = parts(200, response);
        let vary = storable(&parts).unwrap();
        cache.store(key.into(), &request(request_headers), parts, vary, Bytes::from(body.to_string()), Instant::now());
    }

    #[test]
    fn a_kept_answer_matches_its_variant_and_the_browser_gets_a_304_for_what_it_has() {
        let cache = Cache::default();
        let gzip = [("host", "localhost:3000"), ("accept-encoding", "gzip")];
        keep(&cache, "localhost:3000/a.js", &gzip, &[("etag", "W/\"1\""), ("x-kybern-etag", "\"1\""), ("vary", "accept-encoding")], "zip");
        let Lookup::Fresh(entry) = cache.lookup("localhost:3000/a.js", &request(&gzip)) else { panic!("a fresh entry") };
        assert_eq!(entry.upstream_etag.as_deref(), Some("\"1\""), "revalidation sends the dev server's own tag");
        assert!(!entry.headers.contains_key(ORIGINAL_ETAG_HEADER), "the browser never sees Kybern's header");
        assert!(matches!(cache.lookup("localhost:3000/a.js", &request(&[("accept-encoding", "br")])), Lookup::Miss), "another variant");
        let full = respond(&entry, &request(&gzip));
        assert_eq!(full.status(), 200);
        assert_eq!(full.headers()["content-length"], "3");
        assert_eq!(respond(&entry, &request(&[("if-none-match", "\"1\"")])).status(), 304, "weak comparison");
        assert_eq!(respond(&entry, &request(&[("if-none-match", "\"2\"")])).status(), 200);
        cache.invalidate();
        assert!(matches!(cache.lookup("localhost:3000/a.js", &request(&gzip)), Lookup::Stale(_)), "a hot reload makes it stale");
        cache.confirm(&entry, Instant::now());
        assert!(matches!(cache.lookup("localhost:3000/a.js", &request(&gzip)), Lookup::Fresh(_)));
    }

    #[test]
    fn the_cache_stays_within_its_size_dropping_the_least_recently_used() {
        let cache = Cache::default();
        // Four of these are just over what one forward keeps.
        let big = "x".repeat(MAX_FORWARD / 4);
        for name in ["a", "b", "c"] {
            keep(&cache, name, &[], &[("etag", "\"1\"")], &big);
        }
        assert!(matches!(cache.lookup("a", &HeaderMap::new()), Lookup::Fresh(_)), "a is used again");
        keep(&cache, "d", &[], &[("etag", "\"1\"")], &big);
        assert!(cache.bytes() <= MAX_FORWARD);
        assert!(matches!(cache.lookup("b", &HeaderMap::new()), Lookup::Miss), "the oldest unused one went");
        assert!(matches!(cache.lookup("a", &HeaderMap::new()), Lookup::Fresh(_)));
        keep(&cache, "huge", &[], &[("etag", "\"1\"")], &"x".repeat(MAX_ENTRY + 1));
        assert!(matches!(cache.lookup("huge", &HeaderMap::new()), Lookup::Miss));
        let before = TOTAL.load(Ordering::Relaxed);
        let held = cache.bytes();
        drop(cache);
        assert!(TOTAL.load(Ordering::Relaxed) <= before - held + MAX_FORWARD, "a closed forward gives its bytes back");
    }

    #[test]
    fn a_batch_answer_refreshes_replaces_and_drops_entries() {
        let cache = Cache::default();
        for name in ["/same", "/new", "/gone", "/silent"] {
            keep(&cache, &format!("h{name}"), &[("host", "h")], &[("etag", "\"1\"")], name);
        }
        keep(&cache, "other/x", &[("host", "other")], &[("etag", "\"1\"")], "x");
        cache.invalidate();
        assert!(cache.begin_batch("nothing-here").is_none(), "no entries of that host");
        let (entries, done) = cache.begin_batch("h").unwrap();
        assert_eq!(entries.len(), 4, "only the page's own host");
        assert!(cache.begin_batch("h").is_none(), "one batch at a time");
        let index = |key: &str| entries.iter().position(|entry| entry.key == key).unwrap();
        assert_eq!(path_of(&entries[index("h/new")]), "/new");
        let mut wire = Vec::new();
        push_record(&mut wire, &RecordHead { i: index("h/same"), state: "fresh".into(), headers: vec![] }, None);
        push_record(
            &mut wire,
            &RecordHead { i: index("h/new"), state: "changed".into(), headers: vec![("etag".into(), "\"2\"".into())] },
            Some(b"fresh body"),
        );
        push_record(&mut wire, &RecordHead { i: index("h/gone"), state: "gone".into(), headers: vec![] }, None);
        let outcomes = parse_batch(&wire).unwrap();
        cache.finish_batch(&entries, Some(outcomes), done, Instant::now());
        let headers = request(&[("host", "h")]);
        assert!(matches!(cache.lookup("h/same", &headers), Lookup::Fresh(_)));
        let Lookup::Fresh(new) = cache.lookup("h/new", &headers) else { panic!("the changed body is kept") };
        assert_eq!((&new.body[..], new.etag.as_deref()), (&b"fresh body"[..], Some("\"2\"")));
        assert!(matches!(cache.lookup("h/gone", &headers), Lookup::Miss));
        assert!(matches!(cache.lookup("h/silent", &headers), Lookup::Miss), "an entry the answer left out is dropped");
        assert!(matches!(cache.lookup("other/x", &request(&[("host", "other")])), Lookup::Stale(_)), "another host's entry is left alone");
        assert!(matches!(cache.lookup("other/x", &request(&[("host", "other")])), Lookup::Stale(_)), "another host's entry is left alone");
        assert!(parse_batch(&[0, 0, 0, 9, b'{']).is_none(), "a cut answer is refused");
    }

    #[test]
    fn a_page_kept_for_one_session_is_never_answered_to_another() {
        let cache = Cache::default();
        let signed_in = [("host", "h"), ("cookie", "session=alice")];
        keep(&cache, "h/dashboard", &signed_in, &[("etag", "W/\"1\"")], "alice's dashboard");
        assert!(matches!(cache.lookup("h/dashboard", &request(&signed_in)), Lookup::Fresh(_)));
        assert!(matches!(cache.lookup("h/dashboard", &request(&[("host", "h")])), Lookup::Miss), "signed out");
        assert!(matches!(cache.lookup("h/dashboard", &request(&[("host", "h"), ("cookie", "session=bob")])), Lookup::Miss));
    }

    #[test]
    fn a_request_that_asks_for_a_checked_answer_gets_one_unless_this_load_just_checked() {
        let cache = Cache::default();
        let parts = parts(200, &[("etag", "\"1\"")]);
        let vary = storable(&parts).unwrap();
        cache.store("h/a.js".into(), &HeaderMap::new(), parts, vary, Bytes::from_static(b"a"), Instant::now() - Duration::from_secs(10));
        assert!(matches!(cache.lookup("h/a.js", &HeaderMap::new()), Lookup::Fresh(_)), "within the fresh window");
        for asks in [("cache-control", "no-cache"), ("cache-control", "max-age=0"), ("pragma", "no-cache")] {
            assert!(matches!(cache.lookup("h/a.js", &request(&[asks])), Lookup::Stale(_)), "{asks:?}");
        }
        let Lookup::Stale(entry) = cache.lookup("h/a.js", &request(&[("cache-control", "no-cache")])) else { unreachable!() };
        cache.confirm(&entry, Instant::now());
        assert!(matches!(cache.lookup("h/a.js", &request(&[("cache-control", "no-cache")])), Lookup::Fresh(_)), "just checked");
    }

    #[test]
    fn a_hot_update_during_a_slow_answer_leaves_that_answer_stale() {
        let cache = Cache::default();
        let sent = Instant::now();
        std::thread::sleep(Duration::from_millis(5));
        cache.invalidate();
        let parts = parts(200, &[("etag", "\"1\"")]);
        let vary = storable(&parts).unwrap();
        cache.store("h/a.js".into(), &HeaderMap::new(), parts, vary, Bytes::from_static(b"old"), sent);
        assert!(matches!(cache.lookup("h/a.js", &HeaderMap::new()), Lookup::Stale(_)), "the body is from before the edit");
    }

    #[test]
    fn a_budget_is_taken_whole_or_not_at_all() {
        let left = AtomicUsize::new(10);
        assert!(take_from(&left, 6));
        assert!(!take_from(&left, 6), "only 4 left");
        assert!(take_from(&left, 4));
        assert_eq!(left.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn page_loads_are_recognized() {
        let get = hyper::Method::GET;
        assert!(is_navigation(&get, &request(&[("sec-fetch-mode", "navigate")])));
        assert!(!is_navigation(&get, &request(&[("sec-fetch-mode", "cors"), ("accept", "text/html")])));
        assert!(is_navigation(&get, &request(&[("sec-fetch-dest", "iframe")])));
        assert!(is_navigation(&get, &request(&[("accept", "text/html,application/xhtml+xml")])));
        assert!(!is_navigation(&get, &request(&[("accept", "*/*")])));
        assert!(!is_navigation(&hyper::Method::POST, &request(&[("sec-fetch-mode", "navigate")])));
    }
}
