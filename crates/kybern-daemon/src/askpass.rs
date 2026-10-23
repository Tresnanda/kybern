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
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
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
    } else if lower.contains("[sudo]") || program == Some("sudo") {
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
    let output = std::process::Command::new("ps").args(["-o", "ppid=,command=", "-p", &pid.to_string()]).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    let (ppid, command) = line.split_once(char::is_whitespace)?;
    Some(Proc { ppid: ppid.trim().parse().ok()?, command: command.trim().to_string() })
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
        assert_eq!(classify("[sudo] password for me: ", None).purpose, "sudo");
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
