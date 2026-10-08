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
    let pol = policy(&work.0, &work.0.join("data"));
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
    for rejected in ["javascript:alert(1)", "data:text/html,hi", "blob:abc", "about:blank", "tauri://localhost", "ipc:x", "kybern:x", "ftp://x.com", "", "react docs"] {
        assert_eq!(resolve(rejected).unwrap_err().code, "invalid_address", "{rejected}");
    }
}

// ---- file roots and grants ----

#[test]
fn file_inside_the_worktree_needs_no_permission() {
    let work = Dir::new();
    let page = work.write("mockups/index.html");
    let resolved = resolve("mockups/index.html", &roots(&work), &[], false, &policy(&work.0, &work.0.join("data"))).unwrap();
    assert!(resolved.needs_permission.is_none() && resolved.grant.is_none());
    let plan = resolved.file.unwrap();
    assert_eq!(plan, FilePlan { root: work.0.clone(), rel: "mockups/index.html".into() });
    assert!(matches!(resolved.info, PreviewTargetInfo::File { in_project: true, .. }));
    // The same file by absolute path and file URL.
    for form in [page.to_string_lossy().into_owned(), format!("file://{}", page.display())] {
        let r = resolve(&form, &roots(&work), &[], false, &policy(&work.0, &work.0.join("data"))).unwrap();
        assert_eq!(r.file.unwrap().rel, "mockups/index.html", "{form}");
    }
}

#[test]
fn project_root_outside_the_worktree_is_the_root() {
    let project = Dir::new();
    let worktree = Dir::new();
    let page = project.write("design/home.html");
    worktree.write("other.html");
    let roots = ThreadRoots { cwd: worktree.0.clone(), project: Some(project.0.clone()) };
    let r = resolve(page.to_str().unwrap(), &roots, &[], false, &policy(&worktree.0, &worktree.0.join("data"))).unwrap();
    assert!(r.needs_permission.is_none());
    assert_eq!(r.file.unwrap(), FilePlan { root: project.0.clone(), rel: "design/home.html".into() });
    // Worktree wins when the file is inside both.
    let inside = resolve("other.html", &roots, &[], false, &policy(&worktree.0, &worktree.0.join("data"))).unwrap();
    assert_eq!(inside.file.unwrap().root, worktree.0);
}

#[test]
fn outside_files_need_a_grant_that_persists() {
    let work = Dir::new();
    let elsewhere = Dir::new();
    let page = elsewhere.write("mock/ade-34.html");
    let pol = policy(&work.0, &work.0.join("data"));
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
    let pol = policy(&work.0, &work.0.join("data"));
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
    // Dot-segment entries cannot be served by the file route.
    work.write(".private/page.html");
    assert_eq!(resolve("./.private/page.html", &roots(&work), &[], false, &pol).unwrap_err().code, "not_found");
}

#[cfg(unix)]
#[test]
fn symlinked_entries_resolve_to_their_real_folder() {
    let work = Dir::new();
    let outside = Dir::new();
    let page = outside.write("real.html");
    std::os::unix::fs::symlink(&page, work.0.join("link.html")).unwrap();
    let pol = policy(&work.0, &work.0.join("data"));
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
