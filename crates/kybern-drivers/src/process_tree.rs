use std::process::Stdio;
use std::time::Duration;

/// How long a stopped provider gets to exit before it is killed. Claude Code
/// and Codex rotate OAuth refresh tokens: the server retires the old token as
/// soon as it answers, so a process killed before it saves the new one leaves
/// a dead token on disk and signs the user out. Claude Code's own shutdown
/// waits up to 2 s for a refresh in flight.
pub(crate) const TERMINATE_GRACE: Duration = Duration::from_secs(5);

// Own only the isolated process group/tree created for this spawn. Dropping
// it asks the group to exit and kills what remains after `TERMINATE_GRACE`.
pub(crate) struct ProcessTree(pub u32);

impl ProcessTree {
    /// Ask every process in the group to exit. Windows has no such signal for
    /// console processes; there, closing stdin is the graceful stop, and a
    /// process that keeps running is killed when the grace runs out.
    pub(crate) fn terminate(&self) {
        #[cfg(unix)]
        signal_group(self.0, "-TERM");
    }

    /// Kill the group now, for a process that ignored `terminate`.
    pub(crate) fn kill_now(self) {
        force_kill(self.0);
        std::mem::forget(self);
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.terminate();
        let group = self.0;
        // Drop cannot wait, so a detached thread finishes the job. It stops
        // polling as soon as the group is gone, so it never signals a
        // recycled id.
        let _ = std::thread::Builder::new().name("kybern-reap".into()).spawn(move || {
            let deadline = std::time::Instant::now() + TERMINATE_GRACE;
            while std::time::Instant::now() < deadline {
                if !alive(group) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            force_kill(group);
        });
    }
}

#[cfg(unix)]
fn signal_group(group: u32, signal: &str) -> bool {
    std::process::Command::new("/bin/kill")
        .args([signal, "--", &format!("-{group}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(unix)]
fn force_kill(group: u32) {
    signal_group(group, "-KILL");
}

#[cfg(unix)]
fn alive(group: u32) -> bool {
    signal_group(group, "-0")
}

#[cfg(windows)]
fn force_kill(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")))
}

/// A worker must not outlive the session handle or a cancelled startup future.
pub(crate) struct SessionTask(pub tokio::task::JoinHandle<()>);
impl Drop for SessionTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Collect a short-lived probe/job without leaving launcher descendants behind
/// when its timeout or caller cancels the future.
pub(crate) async fn output(command: &mut tokio::process::Command) -> std::io::Result<std::process::Output> {
    // `ProcessTree` stops a cancelled command. Tokio's kill-on-drop would
    // SIGKILL it first, even while it saves a refreshed login.
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(false);
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn()?;
    let tree = ProcessTree(child.id().expect("spawned provider command"));
    let result = child.wait_with_output().await;
    drop(tree);
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::process::Command;

    #[tokio::test]
    async fn collected_commands_preserve_output_and_cancel_their_descendants() {
        let result = output(Command::new("sh").args(["-c", "printf out; printf err >&2"])).await.unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout, b"out");
        assert_eq!(result.stderr, b"err");
        let root = tempfile::tempdir().unwrap();
        let mut command = Command::new("sh");
        command.current_dir(root.path()).args(["-c", "(sleep 0.3; touch escaped) & wait"]);
        assert!(tokio::time::timeout(Duration::from_millis(40), output(&mut command)).await.is_err());
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!root.path().join("escaped").exists());
    }

    /// A cancelled probe gets SIGTERM, not SIGKILL, so a CLI that is saving a
    /// rotated login can finish the write before it exits.
    #[tokio::test]
    async fn cancelled_commands_may_finish_saving_before_they_exit() {
        let root = tempfile::tempdir().unwrap();
        let mut command = Command::new("sh");
        command.current_dir(root.path()).args(["-c", "trap 'sleep 0.3; touch saved; exit 0' TERM; touch started; sleep 30 & wait"]);
        let started = root.path().join("started");
        let run = tokio::spawn(async move { output(&mut command).await });
        while !started.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        run.abort();
        let saved = root.path().join("saved");
        tokio::time::timeout(Duration::from_secs(3), async {
            while !saved.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the cancelled command was killed before it could save");
    }

    #[tokio::test]
    async fn processes_that_ignore_terminate_are_killed_after_the_grace() {
        let root = tempfile::tempdir().unwrap();
        let mut command = Command::new("sh");
        // The ignored signal is inherited, so the whole group ignores SIGTERM.
        command.current_dir(root.path()).args(["-c", "trap '' TERM; sleep 30 & echo $! > pid; wait"]);
        let pid_file = root.path().join("pid");
        let run = tokio::spawn(async move { output(&mut command).await });
        while std::fs::read_to_string(&pid_file).map_or(true, |text| text.trim().is_empty()) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pid = std::fs::read_to_string(&pid_file).unwrap().trim().to_string();
        run.abort();
        let alive = || std::process::Command::new("/bin/kill").args(["-0", &pid]).stderr(Stdio::null()).status().unwrap().success();
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(alive(), "SIGTERM-ignoring process was killed before the grace period");
        tokio::time::sleep(TERMINATE_GRACE).await;
        assert!(!alive(), "process {pid} survived the grace period");
    }
}
