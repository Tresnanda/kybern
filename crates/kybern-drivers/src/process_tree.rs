use std::process::Stdio;

// Own only the isolated process group/tree created for this spawn.
pub(crate) struct ProcessTree(pub u32);
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{}", self.0)])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.0.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
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
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
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
}
