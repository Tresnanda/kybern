//! `kybern askpass`: the helper behind `SUDO_ASKPASS`, `SSH_ASKPASS` and
//! `GIT_ASKPASS` for agent sessions, so a password prompt an agent's command
//! hits becomes a private card instead of a hang.
//!
//! Agent shells have no terminal, so `sudo -A`, `ssh` and `git` call the
//! program these variables name with the prompt as its only argument and read
//! the answer from its standard output. Kybern installs a one-line script that
//! runs the bundled `kybern askpass`, which asks the daemon over loopback with a
//! per-session capability (the same kind of credential as the native-tool
//! bridge: it can only raise cards for its own thread and dies with the
//! session). This module holds the pure parts: the environment, the prompt
//! classifier and the parent-process walk. The card lives in
//! `orchestrator/askpass.rs`.
//!
//! A prompt is never answered automatically in any permission mode, and the
//! answer is neither stored nor logged.

use kybern_protocol::process::NoWindow;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kybern_protocol::PromptRequestInput;

/// Seconds the helper waits for the user before it fails the command.
pub const WAIT_SECONDS: u64 = 300;
/// The longest prompt text the card shows.
const MAX_PROMPT_CHARS: usize = 400;
const MAX_COMMAND_CHARS: usize = 300;

/// The `kybern` binary of this daemon's own build: the one beside it (a newer
/// or older CLI would not know the same helper), else the packaging variable.
/// `None` leaves askpass off.
pub fn find_cli() -> Option<PathBuf> {
    if let Some(sibling) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("kybern")))
        && sibling.is_file()
    {
        return Some(sibling);
    }
    std::env::var_os("KYBERN_BUNDLED_CLI").map(PathBuf::from).filter(|path| path.is_file())
}

/// Write the one-line script the three variables point at. Rewritten when the
/// CLI moves (an update), and kept private to the user.
pub fn install_script(data_dir: &Path, cli: &Path) -> std::io::Result<PathBuf> {
    let dir = data_dir.join("run/askpass");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("kybern-askpass");
    let script = format!("#!/bin/sh\nexec '{}' askpass \"$@\"\n", cli.display().to_string().replace('\'', "'\\''"));
    if std::fs::read_to_string(&path).ok().as_deref() != Some(script.as_str()) {
        std::fs::write(&path, script)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

/// The variables an agent session needs so its commands can ask.
pub fn session_env(script: &Path, endpoint: &str, token: &str) -> BTreeMap<String, String> {
    let script = script.display().to_string();
    BTreeMap::from([
        ("SUDO_ASKPASS".into(), script.clone()),
        ("SSH_ASKPASS".into(), script.clone()),
        ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
        ("GIT_ASKPASS".into(), script),
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("KYBERN_ASKPASS_URL".into(), endpoint.into()),
        ("KYBERN_ASKPASS_TOKEN".into(), token.into()),
    ])
}

/// What a prompt is asking for, from its text and the command that raised it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    pub purpose: &'static str,
    pub secret: bool,
    pub confirm: bool,
    pub host: Option<String>,
    pub key_type: Option<String>,
    pub fingerprint: Option<String>,
}

pub fn classify(prompt: &str, command: Option<&str>) -> Classified {
    let lower = prompt.to_ascii_lowercase();
    let program = command.and_then(|command| command.split_whitespace().next()).map(|word| word.rsplit('/').next().unwrap_or(word));
    let quoted = |text: &str| text.split_once('\'').and_then(|(_, rest)| rest.split_once('\'')).map(|(inside, _)| inside.to_string());
    if lower.contains("continue connecting") || lower.contains("(yes/no") {
        let host = prompt
            .split("authenticity of host '")
            .nth(1)
            .and_then(|rest| rest.split('\'').next())
            .map(|host| host.split(" (").next().unwrap_or(host).to_string());
        let fingerprint = prompt
            .split_whitespace()
            .find(|word| word.starts_with("SHA256:") || word.starts_with("MD5:"))
            .map(|word| word.trim_end_matches(['.', ',', ')', '?']).to_string());
        let key_type = ["ED25519", "ECDSA", "RSA", "DSA"]
            .into_iter()
            .find(|kind| prompt.contains(&format!("{kind} key fingerprint")))
            .map(str::to_string);
        return Classified { purpose: "ssh_host_key", secret: false, confirm: true, host, key_type, fingerprint };
    }
    if lower.starts_with("username for '") {
        return Classified {
            purpose: "git_username",
            secret: false,
            confirm: false,
            host: quoted(prompt).map(|url| host_of(&url)),
            key_type: None,
            fingerprint: None,
        };
    }
    if lower.starts_with("password for '") {
        return Classified {
            purpose: "git_password",
            secret: true,
            confirm: false,
            host: quoted(prompt).map(|url| host_of(&url)),
            key_type: None,
            fingerprint: None,
        };
    }
    let purpose = if lower.contains("passphrase") {
        "ssh_passphrase"
    } else if program == Some("sudo") {
        // Only when sudo is the one asking: the prompt text is the asker's to choose, and a custom `GIT_ASKPASS` under git
        // could word its prompt like sudo's to get the Mac password.
        "sudo"
    } else {
        "other"
    };
    Classified { purpose, secret: true, confirm: false, host: None, key_type: None, fingerprint: None }
}

/// `https://user@github.com/org/repo` → `github.com`.
fn host_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let authority = rest.split('/').next().unwrap_or(rest);
    authority.rsplit('@').next().unwrap_or(authority).to_string()
}

pub fn is_github(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    host == "github.com" || host.ends_with(".github.com")
}

/// Take credentials out of any URL in `text` and bound its length.
pub fn scrub(text: &str, max: usize) -> String {
    let mut out = String::new();
    for (index, word) in text.split(' ').enumerate() {
        if index > 0 {
            out.push(' ');
        }
        match word.split_once("://") {
            Some((scheme, rest)) if rest.split('/').next().is_some_and(|authority| authority.contains('@')) => {
                let (authority, tail) = rest.split_once('/').map_or((rest, ""), |(a, t)| (a, t));
                let host = authority.rsplit('@').next().unwrap_or(authority);
                out.push_str(&format!("{scheme}://{host}"));
                if !tail.is_empty() {
                    out.push('/');
                    out.push_str(tail);
                }
            }
            _ => out.push_str(word),
        }
    }
    out.chars().take(max).collect()
}

pub fn clean_prompt(prompt: &str) -> String {
    scrub(prompt.trim(), MAX_PROMPT_CHARS)
}

/// One process in the chain above the helper.
#[derive(Debug, Clone)]
pub struct Proc {
    pub ppid: u32,
    pub command: String,
}

fn proc_of(pid: u32) -> Option<Proc> {
    let output = std::process::Command::new("ps").no_window().args(["-o", "ppid=,command=", "-p", &pid.to_string()]).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    let (ppid, command) = line.split_once(char::is_whitespace)?;
    Some(Proc { ppid: ppid.trim().parse().ok()?, command: command.trim().to_string() })
}

/// The executable a process runs, as the kernel knows it: a script named `sudo` resolves to its interpreter. Linux reads
/// `/proc/<pid>/exe` itself in [`asked_by_trusted_program`], which also has to tell "hidden" from "gone".
#[cfg(target_os = "macos")]
fn executable_of(pid: u32) -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buf` is a writable buffer of the length passed; the call writes at most that many bytes.
    let n = unsafe { libc::proc_pidpath(pid as libc::c_int, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| PathBuf::from(String::from_utf8_lossy(&buf[..n as usize]).into_owned()))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn executable_of(_pid: u32) -> Option<PathBuf> {
    None
}

/// Whether `path` is a real sudo, ssh or git program that may ask through the helper. sudo must be the system one;
/// ssh and git may come from the system, the Xcode or Command Line Tools developer folders, Homebrew or /usr/local.
pub fn is_trusted_asker(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return false };
    if name == "sudo" {
        return path == Path::new("/usr/bin/sudo");
    }
    let known = matches!(name, "ssh" | "scp" | "sftp" | "ssh-add" | "git") || name.starts_with("git-");
    let place = path.to_string_lossy();
    const ROOTS: &[&str] = &[
        "/usr/bin/",
        "/bin/",
        "/usr/libexec/",
        "/usr/lib/git-core/",
        "/opt/homebrew/",
        "/usr/local/",
        "/Library/Developer/CommandLineTools/",
        "/Applications/Xcode",
        "/nix/store/",
    ];
    known && ROOTS.iter().any(|root| place.starts_with(root))
}

/// Whether the helper `helper_pid` was started by a real sudo, ssh or git (its direct parent, since the helper script
/// `exec`s the CLI). Anything else, such as the agent's own shell running `kybern askpass`, may not raise a card.
///
/// `session_token` is the capability of the session that is asking. On Linux a sudo that waits for a password runs
/// setuid root, so the daemon may not read its `/proc/<pid>/exe`; [`linux_privileged_sudo`] then decides from
/// `/proc/<pid>/status` and the sudo's ancestry instead.
pub fn asked_by_trusted_program(helper_pid: u32, session_token: &str) -> bool {
    let Some(parent) = proc_of(helper_pid).map(|helper| helper.ppid) else { return false };
    #[cfg(target_os = "linux")]
    {
        match std::fs::read_link(format!("/proc/{parent}/exe")) {
            Ok(path) => is_trusted_asker(&path),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => linux_privileged_sudo(parent, session_token),
            Err(_) => false,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = session_token;
        executable_of(parent).is_some_and(|path| is_trusted_asker(&path))
    }
}

/// The fields of `/proc/<pid>/status` the sudo check needs.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcStatus {
    name: String,
    ppid: u32,
    /// Real, effective, saved and file-system user ids.
    uid: [u32; 4],
}

#[cfg(target_os = "linux")]
fn parse_proc_status(text: &str) -> Option<ProcStatus> {
    let mut name = None;
    let mut ppid = None;
    let mut uid = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        match key {
            "Name" => name = Some(value.to_string()),
            "PPid" => ppid = value.parse().ok(),
            "Uid" => {
                let ids: Vec<u32> = value.split_whitespace().filter_map(|id| id.parse().ok()).collect();
                uid = <[u32; 4]>::try_from(ids).ok();
            }
            _ => {}
        }
    }
    Some(ProcStatus { name: name?, ppid: ppid?, uid: uid? })
}

/// A sudo that waits for a password: the program is named `sudo`, runs as root (effective uid 0) for the daemon's own
/// user (real uid). Without a setuid binary no process of that user can have an effective uid of 0, so the agent's
/// own shell cannot pass for it.
#[cfg(target_os = "linux")]
fn is_privileged_sudo(status: &ProcStatus, daemon_uid: u32) -> bool {
    status.name == "sudo" && status.uid[0] == daemon_uid && status.uid[1] == 0
}

/// Walk up from `start` (excluded) through at most [`MAX_ANCESTRY`] parents and report whether one of them satisfies
/// `belongs`. `parent_of` gives a process's parent, `None` when it cannot be read.
#[cfg(target_os = "linux")]
fn descends_from(start: u32, parent_of: impl Fn(u32) -> Option<u32>, belongs: impl Fn(u32) -> bool) -> bool {
    const MAX_ANCESTRY: usize = 64;
    let mut pid = start;
    for _ in 0..MAX_ANCESTRY {
        match parent_of(pid) {
            Some(parent) if parent > 1 => {
                if belongs(parent) {
                    return true;
                }
                pid = parent;
            }
            _ => return false,
        }
    }
    false
}

/// Whether `/proc/<pid>/environ` carries this session's askpass capability: every process the session starts (the
/// agent's shells and their children) inherits it, and no other session's processes do.
#[cfg(target_os = "linux")]
fn environ_holds_token(environ: &[u8], token: &str) -> bool {
    let wanted = format!("KYBERN_ASKPASS_TOKEN={token}");
    !token.is_empty() && environ.split(|byte| *byte == 0).any(|entry| entry == wanted.as_bytes())
}

#[cfg(target_os = "linux")]
fn read_proc_status(pid: u32) -> Option<ProcStatus> {
    parse_proc_status(&std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?)
}

/// The Linux answer when the kernel hides a sudo's `exe` from the daemon: see [`asked_by_trusted_program`]. Accepts a
/// real waiting sudo that was started inside the asking session, nothing else.
#[cfg(target_os = "linux")]
fn linux_privileged_sudo(pid: u32, session_token: &str) -> bool {
    // SAFETY: getuid has no arguments and cannot fail.
    let daemon_uid = unsafe { libc::getuid() };
    let Some(status) = read_proc_status(pid) else { return false };
    is_privileged_sudo(&status, daemon_uid)
        && descends_from(
            pid,
            |pid| read_proc_status(pid).map(|status| status.ppid),
            |pid| std::fs::read(format!("/proc/{pid}/environ")).is_ok_and(|environ| environ_holds_token(&environ, session_token)),
        )
}

/// Whether process `pid` holds the client end of the loopback connection that arrived from `peer`, so the pid an askpass
/// request names is really the process that sent it.
pub fn connection_owned_by(pid: u32, peer: std::net::SocketAddr) -> bool {
    if pid == 0 || !peer.ip().is_loopback() {
        return false;
    }
    #[cfg(target_os = "linux")]
    if let Some(owned) = linux_connection_owned_by(pid, peer) {
        return owned;
    }
    // `lsof -F n` prints each socket as `n<local>-><remote>`; the client's local end is the daemon's peer.
    // The system copy on macOS, so a PATH entry cannot answer for it.
    let lsof = if cfg!(target_os = "macos") { "/usr/sbin/lsof" } else { "lsof" };
    let Ok(output) = std::process::Command::new(lsof)
        .no_window()
        .args(["-nP", "-a", "-p", &pid.to_string(), &format!("-iTCP@{}:{}", lsof_host(peer.ip()), peer.port()), "-Fn"])
        .output()
    else {
        return false;
    };
    let local = format!("n{}->", lsof_addr(peer));
    String::from_utf8_lossy(&output.stdout).lines().any(|line| line.starts_with(&local))
}

fn lsof_host(ip: std::net::IpAddr) -> String {
    match ip {
        std::net::IpAddr::V4(ip) => ip.to_string(),
        std::net::IpAddr::V6(ip) => format!("[{ip}]"),
    }
}

fn lsof_addr(addr: std::net::SocketAddr) -> String {
    format!("{}:{}", lsof_host(addr.ip()), addr.port())
}

/// The IPv4 case from `/proc`: the socket inode of the connection whose local end is `peer`, among `pid`'s descriptors.
/// `None` when it cannot tell (IPv6, no `/proc`): `lsof` decides then.
#[cfg(target_os = "linux")]
fn linux_connection_owned_by(pid: u32, peer: std::net::SocketAddr) -> Option<bool> {
    let std::net::IpAddr::V4(ip) = peer.ip() else { return None };
    let local = format!("{:08X}:{:04X}", u32::from_le_bytes(ip.octets()), peer.port());
    let table = std::fs::read_to_string("/proc/net/tcp").ok()?;
    let inode = table.lines().skip(1).find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        (fields.get(1) == Some(&local.as_str())).then(|| fields.get(9).map(|inode| inode.to_string())).flatten()
    });
    let Some(inode) = inode else { return Some(false) };
    let target = format!("socket:[{inode}]");
    let fds = std::fs::read_dir(format!("/proc/{pid}/fd")).ok()?;
    Some(fds.flatten().any(|fd| std::fs::read_link(fd.path()).is_ok_and(|link| link.to_string_lossy() == target)))
}

/// Whether the process still exists.
#[cfg(unix)]
pub fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks for the process; nothing is delivered.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// No askpass prompts outside Unix (no sudo, and ssh and git ask their own way): a card never waits on a process there.
#[cfg(not(unix))]
pub fn process_alive(_pid: u32) -> bool {
    true
}

const ASKERS: &[&str] = &["sudo", "ssh", "scp", "sftp", "rsync", "git"];

/// The command that asked, found by walking up from the helper. The nearest
/// well-known program wins (for git, the outermost `git` of the chain, so a
/// push shows `git push` and not its transport helper); otherwise the helper's
/// parent. Credentials in URLs are removed.
pub fn requesting_command(helper_pid: u32) -> Option<String> {
    let mut chain: Vec<Proc> = Vec::new();
    let mut next = proc_of(helper_pid).map(|helper| helper.ppid);
    while let Some(pid) = next.filter(|pid| *pid > 1 && chain.len() < 10) {
        let Some(process) = proc_of(pid) else { break };
        next = Some(process.ppid);
        chain.push(process);
    }
    command_from_chain(&chain)
}

fn program_of(command: &str) -> &str {
    let first = command.split_whitespace().next().unwrap_or("");
    first.rsplit('/').next().unwrap_or(first)
}

fn is_git_part(program: &str) -> bool {
    program == "git" || program.starts_with("git-")
}

pub fn command_from_chain(chain: &[Proc]) -> Option<String> {
    let pick = chain.iter().position(|process| ASKERS.contains(&program_of(&process.command)) || is_git_part(program_of(&process.command)));
    let chosen = match pick {
        Some(first) if is_git_part(program_of(&chain[first].command)) => {
            // Keep climbing while the parent is still part of git: the outermost is the command the agent ran.
            let mut at = first;
            while chain.get(at + 1).is_some_and(|parent| is_git_part(program_of(&parent.command))) {
                at += 1;
            }
            chain.get(at)
        }
        Some(first) => chain.get(first),
        None => chain.first(),
    }?;
    // `/usr/bin/git push` reads better as `git push`.
    let command = match chosen.command.split_once(char::is_whitespace) {
        Some((first, rest)) => format!("{} {rest}", first.rsplit('/').next().unwrap_or(first)),
        None => chosen.command.rsplit('/').next().unwrap_or(&chosen.command).to_string(),
    };
    Some(scrub(&command, MAX_COMMAND_CHARS))
}

#[allow(clippy::too_many_arguments)]
pub fn card_input(class: &Classified, prompt: &str, command: Option<String>, harness: &str, attempt: u32) -> PromptRequestInput {
    PromptRequestInput {
        purpose: class.purpose.into(),
        prompt: clean_prompt(prompt),
        secret: class.secret,
        confirm: class.confirm,
        command,
        harness: harness.into(),
        host: class.host.clone(),
        key_type: class.key_type.clone(),
        fingerprint: class.fingerprint.clone(),
        attempt,
        wait_seconds: WAIT_SECONDS,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_real_sudo_ssh_and_git_may_ask() {
        for ok in [
            "/usr/bin/sudo",
            "/usr/bin/ssh",
            "/usr/bin/git",
            "/opt/homebrew/bin/ssh",
            "/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core/git-remote-https",
            "/Library/Developer/CommandLineTools/usr/bin/git",
        ] {
            assert!(is_trusted_asker(Path::new(ok)), "{ok}");
        }
        for bad in [
            "/bin/zsh",
            "/bin/sh",
            "/tmp/sudo",
            "/opt/homebrew/bin/sudo",
            "/Users/me/bin/git",
            "/usr/bin/python3",
            "/opt/homebrew/bin/node",
        ] {
            assert!(!is_trusted_asker(Path::new(bad)), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_connection_belongs_to_the_process_that_opened_it() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server, peer) = listener.accept().unwrap();
        assert_eq!(client.local_addr().unwrap(), peer);
        assert!(connection_owned_by(std::process::id(), peer), "this process opened it");
        let mut other = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
        assert!(!connection_owned_by(other.id(), peer), "another process did not");
        let _ = other.kill();
        let _ = other.wait();
        assert!(!connection_owned_by(std::process::id(), "127.0.0.1:1".parse().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn this_process_is_alive_and_a_bogus_one_is_not() {
        assert!(process_alive(std::process::id()));
        assert!(!process_alive(999_999));
    }

    #[cfg(target_os = "linux")]
    mod linux_sudo {
        use super::super::*;

        const WAITING_SUDO: &str = "Name:\tsudo\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t4242\nPid:\t4242\nPPid:\t4100\n\
            Uid:\t1000\t0\t0\t0\nGid:\t1000\t1000\t1000\t1000\nGroups:\t10 1000\n";

        #[test]
        fn proc_status_is_read_from_its_lines() {
            assert_eq!(parse_proc_status(WAITING_SUDO), Some(ProcStatus { name: "sudo".into(), ppid: 4100, uid: [1000, 0, 0, 0] }));
            // A name may hold spaces and colons; only the first colon splits.
            let odd = "Name:\tTerminal: main\nPPid:\t7\nUid:\t501\t501\t501\t501\n";
            assert_eq!(parse_proc_status(odd).map(|status| status.name), Some("Terminal: main".into()));
            for broken in
                ["", "Name:\tsudo\nPPid:\t1\n", "Name:\tsudo\nPPid:\t1\nUid:\t1000\t0\n", "Name:\tsudo\nPPid:\tx\nUid:\t1\t2\t3\t4\n"]
            {
                assert_eq!(parse_proc_status(broken), None, "{broken:?}");
            }
        }

        #[test]
        fn only_a_root_sudo_of_the_daemons_user_counts() {
            let status = |name: &str, uid: [u32; 4]| ProcStatus { name: name.into(), ppid: 1, uid };
            assert!(is_privileged_sudo(&status("sudo", [1000, 0, 0, 0]), 1000));
            // The agent's own shell, a copy named sudo, someone else's sudo, and a sudo that is already root all fail.
            assert!(!is_privileged_sudo(&status("bash", [1000, 0, 0, 0]), 1000));
            assert!(!is_privileged_sudo(&status("sudo", [1000, 1000, 1000, 1000]), 1000));
            assert!(!is_privileged_sudo(&status("sudo", [1001, 0, 0, 0]), 1000));
            assert!(!is_privileged_sudo(&status("sudo", [1000, 1001, 0, 0]), 1000));
        }

        #[test]
        fn a_sudo_must_descend_from_a_process_of_the_asking_session() {
            // sudo 50 <- shell 40 <- agent 30 <- daemon 20 <- init 1
            let parents = |pid: u32| match pid {
                50 => Some(40),
                40 => Some(30),
                30 => Some(20),
                20 => Some(1),
                _ => None,
            };
            assert!(descends_from(50, parents, |pid| pid == 40), "its own shell");
            assert!(descends_from(50, parents, |pid| pid == 30), "further up");
            assert!(!descends_from(50, parents, |pid| pid == 50), "the sudo itself is not its own ancestor");
            assert!(!descends_from(50, parents, |_| false), "another session's processes");
            assert!(!descends_from(50, parents, |pid| pid == 1), "init is never a session");
            assert!(!descends_from(99, parents, |_| true), "an unreadable parent ends the walk");
            // A parent loop cannot hang the walk.
            assert!(!descends_from(5, |pid| Some(if pid == 5 { 6 } else { 5 }), |_| false));
        }

        #[test]
        fn the_session_is_recognised_by_its_capability_in_the_environment() {
            let environ = b"PATH=/usr/bin\0KYBERN_ASKPASS_TOKEN=abc123\0HOME=/home/me\0";
            assert!(environ_holds_token(environ, "abc123"));
            assert!(!environ_holds_token(environ, "abc12"), "a prefix is not the token");
            assert!(!environ_holds_token(environ, "other"));
            assert!(!environ_holds_token(environ, ""), "no token matches nothing");
            assert!(!environ_holds_token(b"X_KYBERN_ASKPASS_TOKEN=abc123\0", "abc123"));
        }

        fn sudo_runs(args: &[&str]) -> Option<std::process::Output> {
            std::process::Command::new("sudo").args(args).stdin(std::process::Stdio::null()).output().ok()
        }

        /// A real `sudo -A` that waits on its askpass program: the case in issue #315. The askpass program only sleeps,
        /// so no password is ever typed or needed. Skipped without sudo, as root, with passwordless sudo, or when sudo
        /// wants a terminal.
        #[test]
        fn a_real_waiting_sudo_is_trusted_inside_its_session_only() {
            // SAFETY: getuid has no arguments and cannot fail.
            if unsafe { libc::geteuid() } == 0 {
                eprintln!("skipped: running as root, sudo never asks");
                return;
            }
            let Some(probe) = sudo_runs(&["-n", "true"]) else {
                eprintln!("skipped: no sudo");
                return;
            };
            let stderr = String::from_utf8_lossy(&probe.stderr).to_ascii_lowercase();
            if probe.status.success() || !stderr.contains("password is required") {
                eprintln!("skipped: sudo does not wait for a password here ({stderr:?})");
                return;
            }
            let dir = std::env::temp_dir().join(format!("kybern-askpass-sudo-{}", uuid::Uuid::now_v7()));
            std::fs::create_dir_all(&dir).unwrap();
            let pid_file = dir.join("helper.pid");
            let script = dir.join("askpass");
            std::fs::write(&script, format!("#!/bin/sh\necho $$ > '{}'\nexec sleep 60\n", pid_file.display())).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
            let token = format!("test-capability-{}", uuid::Uuid::now_v7());
            // The trailing `:` keeps the shell alive as sudo's parent, as the agent's shell is in a real session.
            let mut shell = std::process::Command::new("sh")
                .args(["-c", "sudo -A true; :"])
                .env("SUDO_ASKPASS", &script)
                .env("KYBERN_ASKPASS_TOKEN", &token)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            let helper = loop {
                if let Some(pid) = std::fs::read_to_string(&pid_file).ok().and_then(|text| text.trim().parse::<u32>().ok()) {
                    break Some(pid);
                }
                if std::time::Instant::now() > deadline {
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            };
            let outcome = helper.map(|helper| {
                let sudo = proc_of(helper).unwrap().ppid;
                (
                    std::fs::read_link(format!("/proc/{sudo}/exe")).map_err(|error| error.kind()),
                    asked_by_trusted_program(helper, &token),
                    asked_by_trusted_program(helper, "another-session"),
                    asked_by_trusted_program(helper, ""),
                    helper,
                )
            });
            if let Some((.., helper)) = &outcome {
                // SAFETY: SIGKILL to the helper this test started; sudo then gives up and the shell ends.
                unsafe { libc::kill(*helper as libc::pid_t, libc::SIGKILL) };
            }
            let _ = shell.wait();
            let _ = std::fs::remove_dir_all(&dir);
            let (exe, own, other, empty, _) = outcome.expect("sudo never started the askpass program");
            assert_eq!(exe, Err(std::io::ErrorKind::PermissionDenied), "the kernel hides a waiting sudo's executable (the cause of #315)");
            assert!(own, "the sudo of this session may ask");
            assert!(!other, "another session's capability does not vouch for it");
            assert!(!empty, "no capability vouches for nothing");
            assert!(!asked_by_trusted_program(std::process::id(), &token), "this test process is not a helper of a sudo");
        }
    }

    use super::*;

    const HOST_KEY: &str = "The authenticity of host '203.0.113.24 (203.0.113.24)' can't be established.\nED25519 key fingerprint is SHA256:abc/DEF+123.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";

    #[test]
    fn prompts_are_classified_from_their_text() {
        let host = classify(HOST_KEY, Some("ssh -o StrictHostKeyChecking=ask 203.0.113.24 true"));
        assert_eq!((host.purpose, host.confirm, host.secret), ("ssh_host_key", true, false));
        assert_eq!(host.host.as_deref(), Some("203.0.113.24"));
        assert_eq!(host.key_type.as_deref(), Some("ED25519"));
        assert_eq!(host.fingerprint.as_deref(), Some("SHA256:abc/DEF+123"));
        assert_eq!(classify("Enter passphrase for key '/Users/me/.ssh/id_ed25519': ", None).purpose, "ssh_passphrase");
        assert_eq!(classify("[sudo] password for me: ", Some("sudo -A true")).purpose, "sudo");
        assert_eq!(classify("[sudo] password for me: ", Some("git ls-remote https://example.net/repo")).purpose, "other");
        assert_eq!(classify("Password:", Some("/usr/bin/sudo -A true")).purpose, "sudo");
        let user = classify("Username for 'https://git.studio-example.net': ", None);
        assert_eq!((user.purpose, user.secret, user.host.as_deref()), ("git_username", false, Some("git.studio-example.net")));
        let password = classify("Password for 'https://me@github.com': ", None);
        assert_eq!((password.purpose, password.secret, password.host.as_deref()), ("git_password", true, Some("github.com")));
        assert!(is_github("github.com") && !is_github("notgithub.com"));
        assert_eq!(classify("Password:", None).purpose, "other");
    }

    #[test]
    fn credentials_in_urls_never_reach_a_card() {
        assert_eq!(scrub("git clone https://me:hunter2@host.example/a/b.git", 200), "git clone https://host.example/a/b.git");
        assert_eq!(scrub("Password for 'https://me:tok@host': ", 200), "Password for 'https://host': ");
    }

    fn chain(commands: &[&str]) -> Vec<Proc> {
        commands.iter().map(|command| Proc { ppid: 1, command: (*command).into() }).collect()
    }

    #[test]
    fn the_asking_command_is_the_nearest_known_program() {
        assert_eq!(
            command_from_chain(&chain(&["sudo -A brew services start postgresql@17", "zsh", "claude"])).as_deref(),
            Some("sudo -A brew services start postgresql@17")
        );
        assert_eq!(
            command_from_chain(&chain(&["/usr/libexec/git-core/git-remote-https origin https://x@h/r", "git push origin main", "zsh"]))
                .as_deref(),
            Some("git push origin main")
        );
        assert_eq!(command_from_chain(&chain(&["python3 deploy.py", "zsh"])).as_deref(), Some("python3 deploy.py"));
        assert_eq!(command_from_chain(&chain(&["/usr/bin/sudo -A true", "zsh"])).as_deref(), Some("sudo -A true"));
        assert_eq!(command_from_chain(&[]), None);
    }

    #[test]
    fn the_session_gets_every_variable() {
        let env = session_env(Path::new("/d/kybern-askpass"), "http://127.0.0.1:1/native-tools/askpass", "t");
        for key in ["SUDO_ASKPASS", "SSH_ASKPASS", "GIT_ASKPASS"] {
            assert_eq!(env[key], "/d/kybern-askpass");
        }
        assert_eq!(env["SSH_ASKPASS_REQUIRE"], "force");
        assert_eq!(env["GIT_TERMINAL_PROMPT"], "0");
    }

    #[cfg(unix)]
    #[test]
    fn the_script_runs_the_cli_and_is_private() {
        let dir = std::env::temp_dir().join(format!("kybern-askpass-test-{}", uuid::Uuid::now_v7()));
        let script = install_script(&dir, Path::new("/opt/it's/kybern")).unwrap();
        let text = std::fs::read_to_string(&script).unwrap();
        assert!(text.starts_with("#!/bin/sh\nexec '/opt/it'\\''s/kybern' askpass \"$@\""), "{text}");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(script.metadata().unwrap().permissions().mode() & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(dir);
    }
}
