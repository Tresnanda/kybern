//! Authorize-only sign-in for another machine (accounts spec, "Authorize-only sign-in").
//!
//! Claude Code (`claude auth login`: `http://localhost:<port>/callback`) and Codex (`codex login`:
//! `http://127.0.0.1:1455/auth/callback`) finish a browser sign-in when the browser comes back to a
//! loopback address **on their own machine**. When that machine is not the one with the browser:
//!
//! 1. The machine being signed in runs the unmodified harness behind the URL shim (`account_login`), which
//!    reports the page; [`loopback_redirect`] reads its `redirect_uri` and `state`, and the login shows a
//!    `handoff`.
//! 2. The desktop asks the daemon on its own computer for `providers.accounts.login.handoff`. That daemon
//!    reads the page with `peer.accounts.login.peek`, listens on the same loopback port here for a short
//!    while, and gives the page back to be opened in this computer's browser.
//! 3. The browser comes back here. Only a request to the harness's path carrying the page's `state` is
//!    taken; its path and query go to the other machine with `peer.accounts.login.callback`, which checks
//!    them again and [`replay`]s them to the waiting harness on its own `127.0.0.1:<port>`.
//!
//! The PKCE verifier and the tokens never leave the machine being signed in. A port that is busy here
//! fails the handoff (`NOT_AVAILABLE`), and the client falls back to a code.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Result, anyhow, ensure};
use axum::extract::State;
use axum::http::{StatusCode, Uri, header};
use axum::response::{Html, IntoResponse, Response};
use chrono::Utc;
use kybern_protocol::methods::*;
use kybern_protocol::{RpcError, codes};
use tokio_util::sync::CancellationToken;

use crate::orchestrator::remote_delegation::{CallFailure, RemoteHub};
use crate::state::AppState;

/// How long this computer listens for the browser at most.
const LISTEN_FOR: Duration = Duration::from_secs(10 * 60);
/// How long the waiting harness may take to answer the replayed redirect.
const REPLAY_WAIT: Duration = Duration::from_secs(20);
/// The longest redirect taken (path and query).
const MAX_REDIRECT: usize = 8192;

/// The loopback redirect of a sign-in page and its OAuth `state`, when the page sends the browser back to
/// a loopback address (`localhost`, `127.0.0.1`, `[::1]`) with a port.
pub fn loopback_redirect(page: &str) -> Option<(LoginHandoff, String)> {
    let page = reqwest::Url::parse(page).ok()?;
    if page.scheme() != "https" {
        return None;
    }
    let query = |name: &str| page.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
    let redirect = reqwest::Url::parse(&query("redirect_uri")?).ok()?;
    let loopback = matches!(redirect.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if redirect.scheme() != "http" || !loopback || redirect.query().is_some() {
        return None;
    }
    let state = query("state").filter(|state| !state.is_empty() && state.len() <= 1024)?;
    Some((LoginHandoff { port: redirect.port()?, path: redirect.path().to_string() }, state))
}

/// Whether `path_and_query` is the harness's redirect for this page: its path, with the page's `state`.
pub fn check_redirect(handoff: &LoginHandoff, state: &str, path_and_query: &str) -> Result<()> {
    ensure!(path_and_query.len() <= MAX_REDIRECT, "The sign-in redirect is too long.");
    let url =
        reqwest::Url::parse(&format!("http://localhost{path_and_query}")).map_err(|_| anyhow!("The sign-in redirect isn't valid."))?;
    ensure!(url.path() == handoff.path, "That isn't this sign-in's redirect.");
    let given = url.query_pairs().find(|(key, _)| key == "state").map(|(_, value)| value.into_owned());
    ensure!(given.as_deref() == Some(state), "The sign-in redirect is for another sign-in. Start again.");
    Ok(())
}

/// Send the redirect to the harness waiting on this machine's loopback `port`, as the browser would have.
pub async fn replay(port: u16, path_and_query: &str) -> Result<PeerLoginCallbackResult> {
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(REPLAY_WAIT).no_proxy().build()?;
    // `localhost` may be either family; the harness listens on one of them.
    for host in ["127.0.0.1", "[::1]"] {
        match client.get(format!("http://{host}:{port}{path_and_query}")).header(header::HOST, format!("localhost:{port}")).send().await {
            Ok(response) => {
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .filter(|location| location.starts_with("https://"))
                    .map(str::to_string);
                return Ok(PeerLoginCallbackResult { status: response.status().as_u16(), location });
            }
            Err(_) => continue,
        }
    }
    Err(anyhow!("The sign-in on this machine stopped waiting for the browser. Start again."))
}

// ---- the computer with the browser ----

/// The handoffs listening here, by login id; a new one for the same login replaces the old.
fn running() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

struct Catch {
    hub: Arc<dyn RemoteHub>,
    machine_id: String,
    machine_name: String,
    login_id: String,
    handoff: LoginHandoff,
    state: String,
    done: CancellationToken,
}

fn failure(code: i32, message: impl Into<String>) -> RpcError {
    RpcError::new(code, message.into())
}

/// `providers.accounts.login.handoff`.
pub async fn start(state: &AppState, params: AccountLoginHandoffParams) -> Result<AccountLoginHandoffResult, RpcError> {
    let hub = state
        .orchestrator
        .remote_hub()
        .cloned()
        .ok_or_else(|| failure(codes::NOT_AVAILABLE, "This daemon cannot reach other machines."))?;
    if params.machine_id == hub.self_id() {
        return Err(RpcError::invalid_params("This computer signs in with its browser directly; no handoff is needed."));
    }
    start_with(hub, params, LISTEN_FOR).await
}

pub(crate) async fn start_with(
    hub: Arc<dyn RemoteHub>,
    params: AccountLoginHandoffParams,
    listen_for: Duration,
) -> Result<AccountLoginHandoffResult, RpcError> {
    let machine_name = hub.target(&params.machine_id).map_or_else(|| "the other machine".to_string(), |target| target.name);
    let peek = hub
        .call(
            &params.machine_id,
            PeerAccountsLoginPeek::NAME,
            serde_json::to_value(PeerLoginPeekParams { login_id: params.login_id.clone() }).map_err(RpcError::internal)?,
        )
        .await
        .map_err(|error| match error {
            CallFailure::Remote(error) if error.code == codes::METHOD_NOT_FOUND => {
                failure(codes::NOT_AVAILABLE, format!("{machine_name} needs a newer Kybern to sign in this way. Use a code instead."))
            }
            CallFailure::Remote(error) => RpcError::invalid_params(error.message),
            other => failure(codes::NOT_AVAILABLE, other.to_string()),
        })?;
    let peek: PeerLoginPeek =
        serde_json::from_value(peek).map_err(|error| RpcError::invalid_params(format!("The sign-in answer is unreadable: {error}")))?;
    if loopback_redirect(&peek.url) != Some((peek.handoff.clone(), peek.state.clone())) {
        return Err(RpcError::invalid_params("This sign-in doesn't come back to its machine. Use a code instead."));
    }
    let port = peek.handoff.port;
    let busy = || {
        failure(
            codes::NOT_AVAILABLE,
            format!(
                "Port {port} is in use on this computer, so the sign-in can't come back to {machine_name} through it. Use a code instead."
            ),
        )
    };
    let v4 = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|_| busy())?;
    let v6 = tokio::net::TcpListener::bind(("::1", port)).await.ok();

    let done = CancellationToken::new();
    if let Some(previous) = running().lock().unwrap_or_else(|error| error.into_inner()).insert(params.login_id.clone(), done.clone()) {
        previous.cancel();
    }
    let until = (Utc::now() + chrono::Duration::from_std(listen_for).unwrap_or_default()).min(peek.expires_at);
    let catch = Arc::new(Catch {
        hub,
        machine_id: params.machine_id,
        machine_name,
        login_id: params.login_id.clone(),
        handoff: peek.handoff,
        state: peek.state,
        done: done.clone(),
    });
    let app = axum::Router::new().fallback(catch_redirect).with_state(catch);
    let wait = (until - Utc::now()).to_std().unwrap_or_default();
    for listener in std::iter::once(v4).chain(v6) {
        let (app, done) = (app.clone(), done.clone());
        tokio::spawn(async move {
            let stop = async move {
                tokio::select! {
                    _ = done.cancelled() => {}
                    _ = tokio::time::sleep(wait) => {}
                }
            };
            let _ = axum::serve(listener, app).with_graceful_shutdown(stop).await;
        });
    }
    let login_id = params.login_id;
    tokio::spawn(async move {
        tokio::select! {
            _ = done.cancelled() => {}
            _ = tokio::time::sleep(wait) => done.cancel(),
        }
        let mut running = running().lock().unwrap_or_else(|error| error.into_inner());
        if running.get(&login_id).is_some_and(|token| token.is_cancelled()) {
            running.remove(&login_id);
        }
    });
    Ok(AccountLoginHandoffResult { url: peek.url, expires_at: until })
}

fn page(status: StatusCode, title: &str, body: &str) -> Response {
    let escape = |text: &str| text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>{}</title><body style=\"font:16px system-ui;margin:4em auto;max-width:32em\"><h1 style=\"font-size:1.3em\">{}</h1><p>{}</p>",
        escape(title),
        escape(title),
        escape(body)
    );
    (status, Html(html)).into_response()
}

async fn catch_redirect(State(catch): State<Arc<Catch>>, uri: Uri) -> Response {
    let path_and_query = uri.path_and_query().map(|part| part.as_str().to_string()).unwrap_or_else(|| uri.path().to_string());
    if uri.path() != catch.handoff.path {
        return StatusCode::NOT_FOUND.into_response();
    }
    if check_redirect(&catch.handoff, &catch.state, &path_and_query).is_err() {
        return page(
            StatusCode::BAD_REQUEST,
            "This isn't the sign-in Kybern is waiting for",
            "Go back to Kybern and start the sign-in again.",
        );
    }
    // One redirect is all a sign-in takes: stop listening whatever the answer.
    catch.done.cancel();
    let params = PeerLoginCallbackParams { login_id: catch.login_id.clone(), path_and_query };
    let answer = match serde_json::to_value(params) {
        Ok(params) => catch.hub.call(&catch.machine_id, PeerAccountsLoginCallback::NAME, params).await,
        Err(error) => Err(CallFailure::Remote(RpcError::internal(error))),
    };
    match answer.map(serde_json::from_value::<PeerLoginCallbackResult>) {
        Ok(Ok(PeerLoginCallbackResult { location: Some(location), .. })) => {
            (StatusCode::FOUND, [(header::LOCATION, location)]).into_response()
        }
        Ok(Ok(result)) if result.status < 400 => {
            page(StatusCode::OK, &format!("Signed in on {}", catch.machine_name), "You can close this tab and go back to Kybern.")
        }
        Ok(Ok(result)) => page(
            StatusCode::BAD_GATEWAY,
            &format!("{} didn't take the sign-in", catch.machine_name),
            &format!("It answered with status {}. Go back to Kybern and try again.", result.status),
        ),
        Ok(Err(error)) => {
            page(StatusCode::BAD_GATEWAY, "The sign-in answer is unreadable", &format!("{error}. Go back to Kybern and try again."))
        }
        Err(error) => page(
            StatusCode::BAD_GATEWAY,
            &format!("Couldn't hand the sign-in to {}", catch.machine_name),
            &format!("{error}. Go back to Kybern and try again."),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::remote_delegation::RemoteTarget;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn the_loopback_redirect_and_state_are_read_from_the_page() {
        let claude =
            "https://claude.com/cai/oauth/authorize?code=true&client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback&state=abc";
        assert_eq!(loopback_redirect(claude), Some((LoginHandoff { port: 54321, path: "/callback".into() }, "abc".into())));
        let codex = "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=s1";
        assert_eq!(loopback_redirect(codex).unwrap().0, LoginHandoff { port: 1455, path: "/auth/callback".into() });
        // A hosted callback (paste code), a non-loopback host or no state is no handoff.
        assert!(
            loopback_redirect("https://claude.com/a?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s")
                .is_none()
        );
        assert!(loopback_redirect("https://x.test/a?redirect_uri=http%3A%2F%2Fevil.test%3A1%2Fcb&state=s").is_none());
        assert!(loopback_redirect("https://x.test/a?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb").is_none());
        assert!(loopback_redirect("http://x.test/a?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=s").is_none());
    }

    #[test]
    fn only_the_harness_path_with_the_page_state_is_taken() {
        let handoff = LoginHandoff { port: 1, path: "/callback".into() };
        assert!(check_redirect(&handoff, "abc", "/callback?code=c&state=abc").is_ok());
        assert!(check_redirect(&handoff, "abc", "/callback?code=c&state=other").is_err());
        assert!(check_redirect(&handoff, "abc", "/callback?code=c").is_err());
        assert!(check_redirect(&handoff, "abc", "/elsewhere?state=abc").is_err());
        assert!(check_redirect(&handoff, "abc", &format!("/callback?state=abc&x={}", "a".repeat(9000))).is_err());
    }

    /// A harness waiting for its redirect: answers one request with a redirect to its "signed in" page and
    /// reports the request line it got.
    async fn fake_harness() -> (u16, tokio::sync::oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0u8; 4096];
            let read = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).lines().next().unwrap_or_default().to_string();
            let _ = socket
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: https://claude.com/oauth/success\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            let _ = tx.send(request);
        });
        (port, rx)
    }

    #[tokio::test]
    async fn the_replay_reaches_the_waiting_harness_and_brings_back_its_page() {
        let (port, request) = fake_harness().await;
        let answer = replay(port, "/callback?code=c&state=abc").await.unwrap();
        assert_eq!(answer.status, 302);
        assert_eq!(answer.location.as_deref(), Some("https://claude.com/oauth/success"));
        assert_eq!(request.await.unwrap(), "GET /callback?code=c&state=abc HTTP/1.1");
    }

    /// The machine being signed in, as a hub sees it: answers peek with a page that comes back to `port`, and
    /// the callback by replaying to the fake harness on `harness`.
    struct OtherMachine {
        port: u16,
        harness: u16,
        calls: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl RemoteHub for OtherMachine {
        fn self_id(&self) -> String {
            "here".into()
        }
        fn self_name(&self) -> String {
            "Mac".into()
        }
        fn resolve(&self, _query: &str) -> Result<RemoteTarget, String> {
            Err("none".into())
        }
        fn target(&self, _id: &str) -> Option<RemoteTarget> {
            None
        }
        fn targets(&self) -> Vec<RemoteTarget> {
            Vec::new()
        }
        async fn call(&self, _target: &str, method: &str, params: serde_json::Value) -> Result<serde_json::Value, CallFailure> {
            self.calls.lock().unwrap().push(method.to_string());
            let handoff = LoginHandoff { port: self.port, path: "/callback".into() };
            match method {
                PeerAccountsLoginPeek::NAME => Ok(serde_json::to_value(PeerLoginPeek {
                    url: format!(
                        "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A{}%2Fcallback&state=abc",
                        self.port
                    ),
                    handoff,
                    state: "abc".into(),
                    expires_at: Utc::now() + chrono::Duration::minutes(10),
                })
                .unwrap()),
                PeerAccountsLoginCallback::NAME => {
                    let params: PeerLoginCallbackParams = serde_json::from_value(params).unwrap();
                    check_redirect(&handoff, "abc", &params.path_and_query)
                        .map_err(|error| CallFailure::Remote(RpcError::invalid_params(error.to_string())))?;
                    let answer = replay(self.harness, &params.path_and_query)
                        .await
                        .map_err(|error| CallFailure::Remote(RpcError::invalid_params(error.to_string())))?;
                    Ok(serde_json::to_value(answer).unwrap())
                }
                _ => Err(CallFailure::Remote(RpcError::method_not_found(method))),
            }
        }
        fn changes(&self) -> tokio::sync::broadcast::Receiver<()> {
            tokio::sync::broadcast::channel(1).1
        }
        fn kick(&self) {}
        async fn kicked(&self) {}
        fn shutdown(&self) -> CancellationToken {
            CancellationToken::new()
        }
    }

    async fn free_port() -> u16 {
        tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap().port()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_browser_here_signs_in_the_other_machine() {
        let (harness, request) = fake_harness().await;
        let port = free_port().await;
        let other = Arc::new(OtherMachine { port, harness, calls: Mutex::new(Vec::new()) });
        let params = AccountLoginHandoffParams { machine_id: "vps".into(), login_id: "l1".into() };
        let result = start_with(other.clone(), params.clone(), Duration::from_secs(30)).await.unwrap();
        assert!(result.url.starts_with("https://claude.com/"));
        let browser = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().unwrap();
        // A stray request (another page, the wrong state) is not forwarded.
        let stray = browser.get(format!("http://127.0.0.1:{port}/callback?code=c&state=nope")).send().await.unwrap();
        assert_eq!(stray.status(), 400);
        assert_eq!(browser.get(format!("http://127.0.0.1:{port}/favicon.ico")).send().await.unwrap().status(), 404);
        // The real redirect goes to the other machine's harness, and the browser lands on its page.
        let back = browser.get(format!("http://127.0.0.1:{port}/callback?code=c&state=abc")).send().await.unwrap();
        assert_eq!(back.status(), 302);
        assert_eq!(back.headers()[header::LOCATION], "https://claude.com/oauth/success");
        assert_eq!(request.await.unwrap(), "GET /callback?code=c&state=abc HTTP/1.1");
        assert_eq!(
            *other.calls.lock().unwrap(),
            vec![PeerAccountsLoginPeek::NAME.to_string(), PeerAccountsLoginCallback::NAME.to_string()]
        );
        // The port is let go once the sign-in came back.
        let mut free = false;
        for _ in 0..100 {
            if tokio::net::TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
                free = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(free, "the handoff stopped listening");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_busy_port_here_fails_the_handoff_so_the_client_uses_a_code() {
        let taken = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = taken.local_addr().unwrap().port();
        let other = Arc::new(OtherMachine { port, harness: 1, calls: Mutex::new(Vec::new()) });
        let error =
            start_with(other, AccountLoginHandoffParams { machine_id: "vps".into(), login_id: "l2".into() }, Duration::from_secs(5))
                .await
                .unwrap_err();
        assert_eq!(error.code, codes::NOT_AVAILABLE);
        assert!(error.message.contains("Use a code instead"), "{}", error.message);
    }
}
