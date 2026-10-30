//! Native executable fixtures: never depend on a Unix shell being installed on Windows.
use std::path::{Path, PathBuf};

pub fn script(dir: &Path, name: &str, unix: &str, windows: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(if cfg!(windows) { format!("{name}.cmd") } else { name.into() });
    std::fs::write(&path, if cfg!(windows) { windows } else { unix }).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

/// PowerShell is only used by fixtures which need loops or JSON output.
pub fn powershell_script(dir: &Path, name: &str, unix: &str, windows: &str) -> PathBuf {
    #[cfg(windows)]
    {
        let _ = unix;
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(format!("{name}.ps1")), windows).unwrap();
        // A batch-file launcher cannot accept arguments containing newlines, such
        // as a PR body. Match a real CLI executable's argument handling instead.
        let executable = dir.join(format!("{name}.exe"));
        std::fs::copy(powershell_launcher(), &executable).unwrap();
        executable
    }
    #[cfg(unix)]
    {
        let _ = windows;
        script(dir, name, unix, "")
    }
}

#[cfg(windows)]
fn powershell_launcher() -> &'static Path {
    use kybern_protocol::process::NoWindow;
    use std::sync::OnceLock;
    static FIXTURE: OnceLock<PathBuf> = OnceLock::new();
    &FIXTURE.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("kybern-test-launcher-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("launcher.rs");
        std::fs::write(&source, include_str!("test_windows_launcher.rs")).unwrap();
        let binary = dir.join("launcher.exe");
        let output = std::process::Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .no_window()
            .arg(source)
            .arg("-o")
            .arg(&binary)
            .output()
            .unwrap();
        assert!(output.status.success(), "fixture compilation: {}", String::from_utf8_lossy(&output.stderr));
        binary
    })
}

pub fn environment_command() -> std::process::Command {
    if cfg!(windows) {
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/D", "/C", "set"]);
        command
    } else {
        std::process::Command::new("/usr/bin/env")
    }
}
