use std::io::IsTerminal;
use std::os::windows::process::CommandExt;

fn main() {
    let script = std::env::current_exe().unwrap().with_extension("ps1");
    let mut command = std::process::Command::new("powershell.exe");
    // Preserve the pseudoconsole in interactive fixtures. A piped/background
    // fixture still must not open a console window.
    if !std::io::stdout().is_terminal() {
        command.creation_flags(0x08000000);
    }
    let status = command
        .args(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script)
        .args(std::env::args_os().skip(1))
        .status()
        .unwrap();
    std::process::exit(status.code().unwrap_or(1));
}
