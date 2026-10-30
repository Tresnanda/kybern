//! Tiny native child used by protocol tests, including on machines without Unix utilities.
//! It uses only std and is compiled once, with the same rustc as this test run.
use kybern_protocol::process::NoWindow;
use std::path::Path;
use std::sync::OnceLock;

pub fn binary() -> &'static Path {
    static FIXTURE: OnceLock<(tempfile::TempDir, std::path::PathBuf)> = OnceLock::new();
    &FIXTURE
        .get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("child.rs");
            std::fs::write(&source, include_str!("test_process_fixture.rs")).unwrap();
            let binary = dir.path().join(format!("fixture{}", std::env::consts::EXE_SUFFIX));
            let output = std::process::Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
                .no_window()
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(output.status.success(), "fixture compilation: {}", String::from_utf8_lossy(&output.stderr));
            (dir, binary)
        })
        .1
}

pub fn echo() -> tokio::process::Command {
    let mut command = tokio::process::Command::new(binary()).no_window();
    command.env("KYBERN_TEST_ECHO", "1");
    command
}

pub fn sleep() -> tokio::process::Command {
    let mut command = tokio::process::Command::new(binary()).no_window();
    command.env("KYBERN_TEST_SLEEP", "1");
    command
}

/// OMP RPC fixture: emits a terminal turn and answers the follow-up state reads.
pub fn omp() -> tokio::process::Command {
    let mut command = tokio::process::Command::new(binary()).no_window();
    command.env("KYBERN_TEST_OMP", "1");
    command
}
