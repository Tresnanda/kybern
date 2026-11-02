//! Child processes on Windows.
//!
//! The daemon runs without a console (the desktop shell starts it detached), and a console program
//! it starts (git, gh, an agent CLI, a shell) would then open a console window of its own for the
//! life of the process. `no_window` starts such a child without one. It is for background children
//! whose output the daemon reads; the terminal tab's PTY children are not started through it.
//! On other platforms it does nothing.
//!
//! `write_executable` writes a program this process is about to start, such as a test fixture,
//! so that Linux cannot refuse to run it as busy.

/// Start a child process without a console window (Windows `CREATE_NO_WINDOW`).
pub trait NoWindow: Sized {
    fn no_window(self) -> Self;
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

impl NoWindow for std::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    fn no_window(mut self) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoWindow for tokio::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    fn no_window(mut self) -> Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

/// Write `contents` to `path` as an executable file (mode 0755 on Unix), replacing any file there.
///
/// Linux refuses to run a file while any process holds it open for writing (`ETXTBSY`, "Text file
/// busy"). A file this process writes itself can stay busy after the write returns: a child that
/// another thread forks during the write inherits the writable descriptor and keeps it until that
/// child execs. So on Unix a short-lived `/bin/sh` writes a new file, which is renamed into place
/// once the shell has exited; this process never opens the file for writing, and nothing still
/// can when this returns. On Windows it is a plain write.
pub fn write_executable(path: &std::path::Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::{Error, Write};
        use std::process::{Command, Stdio};
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let name = path.file_name().ok_or_else(|| Error::other(format!("{} has no file name", path.display())))?;
        let staging =
            path.with_file_name(format!(".{}.{}-{}.tmp", name.to_string_lossy(), std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let mut child = Command::new("/bin/sh")
            .args(["-c", r#"cat > "$1" && chmod 755 "$1""#, "sh"])
            .arg(&staging)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?;
        // Dropping stdin at the end of the statement ends the shell's input.
        let written = child.stdin.take().expect("stdin is piped").write_all(contents.as_ref());
        let output = child.wait_with_output()?;
        let result = if !output.status.success() {
            Err(Error::other(format!("writing {} failed: {}", staging.display(), String::from_utf8_lossy(&output.stderr).trim())))
        } else {
            written.and_then(|()| std::fs::rename(&staging, path))
        };
        if result.is_err() {
            let _ = std::fs::remove_file(&staging);
        }
        result
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)
    }
}

#[cfg(test)]
mod tests {
    use super::NoWindow;

    #[test]
    fn leaves_the_command_usable() {
        let output = std::process::Command::new("rustc").no_window().arg("--version").output();
        // Whether or not rustc is on PATH, the builder chain must compile and run unchanged.
        if let Ok(output) = output {
            assert!(output.status.success());
        }
    }

    #[cfg(unix)]
    #[test]
    fn written_executables_run_at_once_and_replace_what_was_there() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("kybern-write-executable-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fixture with spaces");
        std::fs::write(&path, "old").unwrap();
        for round in 0..20 {
            super::write_executable(&path, format!("#!/bin/sh\necho {round}\n")).unwrap();
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o755);
            let output = std::process::Command::new(&path).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&output.stdout), format!("{round}\n"));
        }
        // Binary contents pass through unchanged, and no staging file is left behind.
        super::write_executable(&path, [0u8, 255, 10, 13]).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), [0u8, 255, 10, 13]);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        assert!(super::write_executable(&dir.join("missing").join("x"), "x").is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
