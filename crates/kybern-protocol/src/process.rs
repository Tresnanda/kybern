//! Child processes on Windows.
//!
//! The daemon runs without a console (the desktop shell starts it detached), and a console program
//! it starts (git, gh, an agent CLI, a shell) would then open a console window of its own for the
//! life of the process. `no_window` starts such a child without one. It is for background children
//! whose output the daemon reads; the terminal tab's PTY children are not started through it.
//! On other platforms it does nothing.

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
}
