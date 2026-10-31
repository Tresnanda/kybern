use super::*;
use uuid::Uuid;

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("kybern-preview-open-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn write(&self, rel: &str) -> PathBuf {
        let path = self.0.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"<html></html>").unwrap();
        path
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A policy whose system list is empty so temp dirs (under /var on macOS)
/// stay grantable; the system list has its own test.
fn policy(home: &Path, data: &Path) -> GrantPolicy {
    GrantPolicy { home: Some(home.to_path_buf()), data_dir: data.to_path_buf(), system: Vec::new() }
}

/// Home and data directory far from every temp dir the tests create.
fn elsewhere_policy() -> GrantPolicy {
    policy(Path::new("/nonexistent-kybern-home"), Path::new("/nonexistent-kybern-home/.kybern"))
}

// ---- address classification ----

#[test]
fn loopback_and_private_hosts_are_local() {
    for host in [
        "localhost",
        "LOCALHOST",
        "app.localhost",
        "127.0.0.1",
        "127.255.255.254",
        "0.0.0.0",
        "[::1]",
        "::1",
        "[::]",
        "10.0.0.5",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.20",
        "100.64.0.1",
        "100.127.255.255",
        "printer.local",
        "[fe80::1]",
        "[fc00::1]",
        "[fd12:3456::1]",
    ] {
        assert!(is_local_or_private_host(host), "{host} should be local");
    }
    assert!(is_loopback_host("localhost") && is_loopback_host("127.0.0.1") && is_loopback_host("[::1]"));
    assert!(!is_loopback_host("192.168.1.2") && !is_loopback_host("box.local"));
}

#[test]
fn public_and_tricky_hosts_are_not_local() {
    for host in [
        "",
        "example.com",
        "8.8.8.8",
        "172.15.0.1",
        "172.32.0.1",
        "100.63.255.255",
        "100.128.0.1",
        "192.169.0.1",
        "11.0.0.1",
        "169.254.169.254",
        "localhost.evil.com",
        "127.0.0.1.evil.com",
        "evil.com.local.evil.com",
        "notlocalhost",
        "localhostx",
        "local",
        // trailing dots
        "localhost.",
        "127.0.0.1.",
        "foo.local.",
        ".localhost",
        // userinfo, ports, paths
        "127.0.0.1@evil.com",
        "evil.com@127.0.0.1",
        "user:pw@localhost",
        "localhost:3000",
        "127.0.0.1:80",
        "127.0.0.1/",
        "localhost/x",
        "127.0.0.1\\x",
        "127.0.0.1%00",
        "127.0.0.1 ",
        " localhost",
        // decimal, hex, octal and short IPv4 forms
        "2130706433",
        "0x7f000001",
        "0x7f.0.0.1",
        "0177.0.0.1",
        "017700000001",
        "127.1",
        "127.0.1",
        "010.0.0.1",
        "127.000.000.001",
        // IPv4 smuggled through IPv6
        "[::ffff:127.0.0.1]",
        "[::ffff:7f00:1]",
        "[::ffff:8.8.8.8]",
        "[::127.0.0.1]",
        "[::7f00:1]",
        "[64:ff9b::7f00:1]",
        "[2001:db8::1]",
        "[2606:4700::1111]",
        "[::1",
        "::ffff:127.0.0.1",
        // names that are not DNS-safe
        "lo\u{0441}alhost",
        "a b.local",
        "-x.local",
    ] {
        assert!(!is_local_or_private_host(host), "{host:?} must not be local");
    }
}

// ---- target classification ----

fn roots(dir: &Dir) -> ThreadRoots {
    ThreadRoots { cwd: dir.0.clone(), project: None }
}

#[test]
fn urls_become_servers_or_external() {
    let work = Dir::new();
    let pol = elsewhere_policy();
    let resolve = |input: &str| resolve(input, &roots(&work), &[], false, &pol);
    let server = |input: &str| match resolve(input).unwrap().info {
        PreviewTargetInfo::Server { url, port } => (url, port),
        other => panic!("{input}: {other:?}"),
    };
    assert_eq!(server("http://localhost:5173"), ("http://localhost:5173/".into(), 5173));
    assert_eq!(server("localhost:3000"), ("http://localhost:3000/".into(), 3000));
    assert_eq!(server("5173"), ("http://localhost:5173/".into(), 5173));
    assert_eq!(server(":5173"), ("http://localhost:5173/".into(), 5173));
    assert_eq!(server("https://127.0.0.1:8443/app").1, 8443);
    assert_eq!(server("http://192.168.1.4:8080").1, 8080);
    assert_eq!(server("http://[::1]:4000").1, 4000);
    assert_eq!(server("http://vite.localhost:5173").1, 5173);
    // Alternative IP spellings normalize to the address a browser would use.
    assert_eq!(server("http://0x7f.1:9000").1, 9000);
    for external in ["https://example.com", "example.com", "http://127.0.0.1.evil.com:80", "http://8.8.8.8"] {
        assert!(matches!(resolve(external).unwrap().info, PreviewTargetInfo::External { .. }), "{external}");
    }
    // Userinfo tricks never reach the local classifier.
    assert!(resolve("http://127.0.0.1@evil.com/").is_err());
    assert!(resolve("http://localhost:3000@evil.com/").is_err());
    for rejected in [
        "javascript:alert(1)",
        "data:text/html,hi",
        "blob:abc",
        "about:blank",
        "tauri://localhost",
        "ipc:x",
        "kybern:x",
        "ftp://x.com",
        "",
        "react docs",
    ] {
        assert_eq!(resolve(rejected).unwrap_err().code, "invalid_address", "{rejected}");
    }
}

// ---- file roots and grants ----

#[test]
fn file_inside_the_worktree_needs_no_permission() {
    let work = Dir::new();
    let page = work.write("mockups/index.html");
    let resolved = resolve("mockups/index.html", &roots(&work), &[], false, &elsewhere_policy()).unwrap();
    assert!(resolved.needs_permission.is_none() && resolved.grant.is_none());
    let plan = resolved.file.unwrap();
    assert_eq!(plan, FilePlan { root: work.0.clone(), rel: "mockups/index.html".into() });
    assert!(matches!(resolved.info, PreviewTargetInfo::File { in_project: true, .. }));
    // The same file by absolute path and file URL.
    for form in [page.to_string_lossy().into_owned(), reqwest::Url::from_file_path(&page).unwrap().into()] {
        let r = resolve(&form, &roots(&work), &[], false, &elsewhere_policy()).unwrap();
        assert_eq!(r.file.unwrap().rel, "mockups/index.html", "{form}");
    }
}

/// ADE-74: an agent's mockup in `.kybern-artifacts/` previews from its own dot-folder; `.git` and secrets never do.
#[test]
fn a_page_in_a_project_dot_folder_is_served_from_that_folder() {
    let work = Dir::new();
    work.write(".kybern-artifacts/ade-74/mockup.html");
    let resolved = resolve(".kybern-artifacts/ade-74/mockup.html", &roots(&work), &[], false, &elsewhere_policy()).unwrap();
    assert!(resolved.needs_permission.is_none() && resolved.grant.is_none());
    assert_eq!(resolved.file.unwrap(), FilePlan { root: work.0.join(".kybern-artifacts"), rel: "ade-74/mockup.html".into() });
    assert!(matches!(resolved.info, PreviewTargetInfo::File { in_project: true, .. }));
    // The deepest dot-folder is the root, so the served path never has a dot segment.
    work.write("docs/.drafts/v2/.cache/page.html");
    let nested = resolve("docs/.drafts/v2/.cache/page.html", &roots(&work), &[], false, &elsewhere_policy()).unwrap();
    assert_eq!(nested.file.unwrap(), FilePlan { root: work.0.join("docs/.drafts/v2/.cache"), rel: "page.html".into() });
    for refused in [".git/page.html", ".ssh/page.html", ".env.html"] {
        work.write(refused);
        let error = resolve(refused, &roots(&work), &[], false, &elsewhere_policy()).unwrap_err();
        assert_eq!(error.code, "folder_not_grantable", "{refused}");
        assert!(!error.message.contains("doesn't exist"), "{refused}: {}", error.message);
    }
    // A page that is itself a dotfile is still not served.
    work.write("mockups/.page.html");
    assert!(resolve("mockups/.page.html", &roots(&work), &[], false, &elsewhere_policy()).is_err());
}

#[test]
fn project_root_outside_the_worktree_is_the_root() {
    let project = Dir::new();
    let worktree = Dir::new();
    let page = project.write("design/home.html");
    worktree.write("other.html");
    let roots = ThreadRoots { cwd: worktree.0.clone(), project: Some(project.0.clone()) };
    let r = resolve(page.to_str().unwrap(), &roots, &[], false, &elsewhere_policy()).unwrap();
    assert!(r.needs_permission.is_none());
    assert_eq!(r.file.unwrap(), FilePlan { root: project.0.clone(), rel: "design/home.html".into() });
    // Worktree wins when the file is inside both.
    let inside = resolve("other.html", &roots, &[], false, &elsewhere_policy()).unwrap();
    assert_eq!(inside.file.unwrap().root, worktree.0);
}

#[test]
fn outside_files_need_a_grant_that_persists() {
    let work = Dir::new();
    let elsewhere = Dir::new();
    let page = elsewhere.write("mock/ade-34.html");
    let pol = elsewhere_policy();
    let first = resolve(page.to_str().unwrap(), &roots(&work), &[], false, &pol).unwrap();
    assert!(first.file.is_none() && first.grant.is_none());
    let request = first.needs_permission.unwrap();
    assert_eq!(request.folder, elsewhere.0.join("mock").to_string_lossy());
    assert!(request.grantable);
    // allow_folder returns the plan and the grant to persist.
    let allowed = resolve(page.to_str().unwrap(), &roots(&work), &[], true, &pol).unwrap();
    assert_eq!(allowed.grant.as_deref(), Some(elsewhere.0.join("mock").as_path()));
    assert_eq!(allowed.file.unwrap().rel, "ade-34.html");
    // With the grant persisted (as it is in settings.json across restarts), no card.
    let saved = vec![elsewhere.0.join("mock").to_string_lossy().into_owned()];
    let again = resolve(page.to_str().unwrap(), &roots(&work), &saved, false, &pol).unwrap();
    assert!(again.needs_permission.is_none() && again.grant.is_none() && again.file.is_some());
    // A grant covers descendants.
    let nested = elsewhere.write("mock/deeper/page.html");
    let parent_grant = vec![elsewhere.0.to_string_lossy().into_owned()];
    let nested_open = resolve(nested.to_str().unwrap(), &roots(&work), &parent_grant, false, &pol).unwrap();
    assert!(nested_open.needs_permission.is_none());
    assert_eq!(nested_open.file.unwrap().root, elsewhere.0.join("mock/deeper"));
    // A sibling folder is not covered.
    let sibling = elsewhere.write("other/x.html");
    let sibling_open = resolve(sibling.to_str().unwrap(), &roots(&work), &saved, false, &pol).unwrap();
    assert!(sibling_open.needs_permission.is_some());
}

#[test]
fn stored_grants_are_revalidated_on_every_open() {
    let work = Dir::new();
    let elsewhere = Dir::new();
    let page = elsewhere.write("x.html");
    let pol = policy(&work.0, &work.0.join("data"));
    // A tampered settings.json granting a non-grantable folder is ignored.
    for bad in ["/", &work.0.to_string_lossy(), &work.0.join("data").to_string_lossy(), "/does/not/exist"] {
        let r = resolve(page.to_str().unwrap(), &roots(&Dir::new()), &[bad.to_owned()], false, &pol).unwrap();
        assert!(r.needs_permission.is_some(), "grant {bad} must not apply");
    }
}

#[test]
fn non_grantable_folders() {
    let home = Dir::new();
    std::fs::create_dir_all(home.0.join("Library/Caches")).unwrap();
    std::fs::create_dir_all(home.0.join("Documents")).unwrap();
    std::fs::create_dir_all(home.0.join(".ssh")).unwrap();
    std::fs::create_dir_all(home.0.join(".kybern/worktrees")).unwrap();
    let data = home.0.join(".kybern");
    let pol = policy(&home.0, &data);
    assert!(pol.grantable(&home.0.join("Documents")));
    assert!(pol.grantable(&home.0.join("Documents").join("a b")));
    for no in [
        Path::new("/"),
        home.0.as_path(),
        home.0.parent().unwrap(),
        &home.0.join("Library"),
        &home.0.join("Library/Caches"),
        &data,
        &data.join("worktrees"),
        &home.0.join(".ssh"),
        &home.0.join("Documents/.hidden"),
        Path::new("relative/path"),
    ] {
        assert!(!pol.grantable(no), "{} must not be grantable", no.display());
    }
    let real = GrantPolicy::new(&data);
    for no in ["/System", "/System/Library", "/usr/share", "/bin", "/etc", "/private/etc", "/var", "/private/var/log", "/dev"] {
        if cfg!(target_os = "macos") || !no.contains("private") && !no.starts_with("/System") {
            assert!(!real.grantable(Path::new(no)), "{no}");
        }
    }
    if cfg!(target_os = "linux") {
        for no in ["/proc", "/sys", "/proc/self"] {
            assert!(!real.grantable(Path::new(no)), "{no}");
        }
    }
}

#[test]
fn outside_non_grantable_folder_is_refused_even_with_allow_folder() {
    let home = Dir::new();
    std::fs::create_dir_all(home.0.join(".hidden")).unwrap();
    let hidden = home.write(".hidden/page.html");
    let work = Dir::new();
    let pol = policy(&home.0, &home.0.join(".kybern"));
    for allow in [false, true] {
        let error = resolve(hidden.to_str().unwrap(), &roots(&work), &[], allow, &pol).unwrap_err();
        assert_eq!(error.code, "folder_not_grantable");
    }
    // A file directly in the home directory has the home as its folder.
    let loose = home.write("loose.html");
    assert_eq!(resolve(loose.to_str().unwrap(), &roots(&work), &[], true, &pol).unwrap_err().code, "folder_not_grantable");
}

#[test]
fn entry_documents_and_missing_files() {
    let work = Dir::new();
    let pol = elsewhere_policy();
    for ok in ["a.html", "b.htm", "c.svg", "d.xhtml", "E.HTML"] {
        work.write(ok);
        assert!(resolve(ok, &roots(&work), &[], false, &pol).unwrap().file.is_some(), "{ok}");
    }
    for bad in ["a.txt", "b.js", "c.css", "d.png", "e"] {
        work.write(bad);
        assert_eq!(resolve(&format!("./{bad}"), &roots(&work), &[], false, &pol).unwrap_err().code, "unsupported_file", "{bad}");
    }
    std::fs::create_dir_all(work.0.join("dir.html")).unwrap();
    assert_eq!(resolve("./dir.html", &roots(&work), &[], false, &pol).unwrap_err().code, "unsupported_file");
    assert_eq!(resolve("./missing.html", &roots(&work), &[], false, &pol).unwrap_err().code, "not_found");
    // A page in a dot-folder is served from that folder (see the dot-folder test); a dotfile page is not served.
    work.write(".private/page.html");
    assert_eq!(resolve("./.private/page.html", &roots(&work), &[], false, &pol).unwrap().file.unwrap().rel, "page.html");
    work.write(".page.html");
    assert_eq!(resolve("./.page.html", &roots(&work), &[], false, &pol).unwrap_err().code, "not_found");
}

#[cfg(unix)]
#[test]
fn symlinked_entries_resolve_to_their_real_folder() {
    let work = Dir::new();
    let outside = Dir::new();
    let page = outside.write("real.html");
    std::os::unix::fs::symlink(&page, work.0.join("link.html")).unwrap();
    let pol = elsewhere_policy();
    // The link lives in the worktree, but its target does not: a grant is needed.
    let r = resolve("link.html", &roots(&work), &[], false, &pol).unwrap();
    assert!(r.file.is_none());
    assert_eq!(r.needs_permission.unwrap().folder, outside.0.to_string_lossy());
}

#[test]
fn paths_encode_and_decode() {
    assert_eq!(encode_path("a b/ü.html"), "a%20b/%C3%BC.html");
    assert_eq!(file_path_for("T", "mock/index.html"), "/preview-files/T/mock/index.html");
    assert_eq!(percent_decode("a%20b%2e%2e").unwrap(), "a b..");
    assert!(percent_decode("%zz").is_none() && percent_decode("%f").is_none() && percent_decode("%ff").is_none());
}

#[test]
fn thread_roots_covering_home_or_data_are_not_served_whole() {
    let home = Dir::new();
    let data = home.0.join(".kybern");
    std::fs::create_dir_all(data.join("worktrees/wt")).unwrap();
    std::fs::write(data.join("daemon.token"), "kyb_secret").unwrap();
    let page = home.write("Documents/mock/page.html");
    let pol = policy(&home.0, &data);
    // A thread opened on the home directory: the page's own folder needs a grant,
    // never the whole home (which holds the data directory and its token).
    let at_home = ThreadRoots { cwd: home.0.clone(), project: None };
    let r = resolve(page.to_str().unwrap(), &at_home, &[], false, &pol).unwrap();
    assert!(r.file.is_none(), "the home directory is never a served root");
    assert_eq!(r.needs_permission.unwrap().folder, home.0.join("Documents/mock").to_string_lossy());
    // A thread on `/` or a parent of home behaves the same.
    for cwd in [PathBuf::from("/"), home.0.parent().unwrap().to_path_buf()] {
        let r = resolve(page.to_str().unwrap(), &ThreadRoots { cwd, project: None }, &[], false, &pol).unwrap();
        assert!(r.file.is_none());
    }
    // The data directory itself is never a root; its worktrees are.
    let in_data = home.write(".kybern/page.html");
    let on_data = ThreadRoots { cwd: data.clone(), project: None };
    assert!(resolve(in_data.to_str().unwrap(), &on_data, &[], true, &pol).is_err());
    let wt_page = home.write(".kybern/worktrees/wt/index.html");
    let on_worktree = ThreadRoots { cwd: data.join("worktrees/wt"), project: Some(home.0.clone()) };
    let r = resolve(wt_page.to_str().unwrap(), &on_worktree, &[], false, &pol).unwrap();
    assert_eq!(r.file.unwrap().root, data.join("worktrees/wt"));
    assert!(!pol.servable_thread_root(&home.0.join("Library/Application Support")));
    assert!(pol.servable_thread_root(&home.0.join("Documents")));
}

#[tokio::test]
async fn device_server_preview_needs_no_thread_and_preserves_proxy_boundaries() {
    use kybern_protocol::methods::PreviewServerOpenParams;
    let dir = Dir::new();
    let paths = crate::config::Paths::resolve(Some(dir.0.clone())).unwrap();
    let state = crate::state::AppState::initialize_in_memory(&paths).unwrap();
    let device = Uuid::new_v4();
    for url in [
        "file:///tmp/a.html",
        "/tmp/a.html",
        "https://example.com",
        "http://192.168.1.1",
        "http://169.254.169.254",
        "http://user:pass@localhost:5173",
        "http://localhost:0",
        "ftp://localhost",
    ] {
        assert!(open_server(&state, device, &PreviewServerOpenParams { url: url.into(), proxy: true }).await.is_err(), "{url}");
    }
    let port = probe::tests::serve("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<title>App</title>").await;
    state.port.store(port, std::sync::atomic::Ordering::Relaxed);
    assert!(open_server(&state, device, &PreviewServerOpenParams { url: format!("http://localhost:{port}"), proxy: true }).await.is_err());
    state.port.store(0, std::sync::atomic::Ordering::Relaxed);
    let result =
        open_server(&state, device, &PreviewServerOpenParams { url: format!("http://localhost:{port}/app?q=1#hash"), proxy: true })
            .await
            .unwrap();
    assert!(result.needs_permission.is_none());
    let ticket = result.ticket.unwrap();
    let info = state.previews.lookup(&ticket).unwrap();
    assert_eq!(info.thread_id, None);
    assert_eq!(info.principal, Some(device));
    assert_eq!(info.kind, tickets::TicketKind::Proxy { port });
    assert!(result.path.unwrap().starts_with("/preview-proxy/"));
    assert_eq!(state.previews.revoke_thread(Uuid::new_v4()), 0);
    assert_eq!(state.previews.revoke_principal(device), 1);
    assert!(state.previews.lookup(&ticket).is_none());
    let direct =
        open_server(&state, device, &PreviewServerOpenParams { url: format!("http://localhost:{port}/app"), proxy: false }).await.unwrap();
    assert!(direct.ticket.is_none() && direct.path.is_none());
    let https = format!("https://localhost:{port}/app?q=1#hash");
    let refused = open_server(&state, device, &PreviewServerOpenParams { url: https.clone(), proxy: true }).await.unwrap_err();
    assert_eq!(refused.code, "unsupported_proxy");
    assert!(refused.message.contains("HTTP port"));
    let direct = open_server(&state, device, &PreviewServerOpenParams { url: https.clone(), proxy: false }).await.unwrap();
    assert_eq!(direct.target, PreviewTargetInfo::Server { url: https, port });
    assert!(direct.ticket.is_none() && direct.path.is_none());
}

/// A remote-environment client consumes the primary's HTTP ticket, while the server lives behind
/// a separate loopback TCP forward. Neither the forward nor ticket needs a thread on the primary.
#[tokio::test]
async fn device_server_proxy_preserves_forwarded_page_assets_and_hot_reload_without_a_thread() {
    use axum::{
        Router,
        extract::ws::{Message as AxumMessage, WebSocketUpgrade},
        routing::{any, get},
    };
    use futures::{SinkExt, StreamExt};
    use kybern_protocol::methods::PreviewServerOpenParams;
    use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
    let dir = Dir::new();
    let paths = crate::config::Paths::resolve(Some(dir.0.clone())).unwrap();
    let state = crate::state::AppState::initialize_in_memory(&paths).unwrap();
    let dev = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dev_port = dev.local_addr().unwrap().port();
    let app = Router::new()
        .route("/app", get(|| async { "<script src='/asset.js'></script>" }))
        .route("/asset.js", get(|| async { "window.loaded = true" }))
        .route(
            "/hmr",
            get(|ws: WebSocketUpgrade| async {
                ws.protocols(["vite-hmr"]).on_upgrade(|mut socket| async move {
                    while let Some(Ok(AxumMessage::Text(text))) = socket.recv().await {
                        if socket.send(AxumMessage::Text(text)).await.is_err() {
                            break;
                        }
                    }
                })
            }),
        );
    let dev_task = tokio::spawn(async move { axum::serve(dev, app).await.unwrap() });
    let forward = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = forward.local_addr().unwrap().port();
    let forward_task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = forward.accept().await else {
                break;
            };
            tokio::spawn(async move {
                if let Ok(mut target) = tokio::net::TcpStream::connect(("127.0.0.1", dev_port)).await {
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut target).await;
                }
            });
        }
    });
    let primary = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let primary_addr = primary.local_addr().unwrap();
    state.port.store(primary_addr.port(), std::sync::atomic::Ordering::Relaxed);
    let result = open_server(&state, Uuid::new_v4(), &PreviewServerOpenParams { url: format!("http://localhost:{port}/app"), proxy: true })
        .await
        .unwrap();
    let proxy = Router::new().route("/preview-proxy/{ticket}/{*path}", any(proxy::serve)).with_state(state.clone());
    let primary_task = tokio::spawn(async move { axum::serve(primary, proxy).await.unwrap() });
    let base = format!("http://{primary_addr}{}", result.path.unwrap().trim_end_matches('/'));
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(http.get(format!("{base}/app")).send().await.unwrap().text().await.unwrap(), "<script src='/asset.js'></script>");
    assert_eq!(http.get(format!("{base}/asset.js")).send().await.unwrap().text().await.unwrap(), "window.loaded = true");
    let mut request = format!("{}/hmr", base.replace("http://", "ws://")).into_client_request().unwrap();
    request.headers_mut().insert("sec-websocket-protocol", "vite-hmr".parse().unwrap());
    let (mut socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(response.headers().get("sec-websocket-protocol").unwrap(), "vite-hmr");
    socket.send(Message::Text("update".into())).await.unwrap();
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(response, Message::Text("update".into()));
    socket.close(None).await.unwrap();
    primary_task.abort();
    forward_task.abort();
    dev_task.abort();
}
