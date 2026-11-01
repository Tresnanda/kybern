//! A backend whose program is not there. It stands in for a driver Kybern
//! cannot start, so the tools and Settings answer with a clear sentence
//! instead of failing to build a backend.

use anyhow::{Result, bail};
use async_trait::async_trait;
use kybern_protocol::methods::{ComputerCheck, ComputerPermission};

use super::Mode;
use super::backend::{
    Act, AppInfo, BackendKind, BackendStatus, Capabilities, ComputerBackend, Image, Launched, Outcome, ReadOptions, Region, Target,
    WindowInfo, WindowRead,
};

pub(crate) struct NotInstalled {
    kind: BackendKind,
}

impl NotInstalled {
    pub(crate) fn new(kind: BackendKind) -> Self {
        Self { kind }
    }

    fn message(&self) -> String {
        format!("{} is not installed. Ask the user to install it in Kybern Settings → Computer use.", self.kind.display_name())
    }
}

#[async_trait]
impl ComputerBackend for NotInstalled {
    fn kind(&self) -> BackendKind {
        self.kind
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            menu_bar: false,
            background_pixels: false,
            pixels: false,
            background_typing: false,
            background_keys: false,
            background_scroll: false,
            window_capture: true,
            zoom: false,
        }
    }

    fn installed(&self) -> bool {
        false
    }

    async fn status(&self) -> BackendStatus {
        BackendStatus {
            installed: false,
            path: None,
            version: None,
            required_version: String::new(),
            verified: false,
            accessibility: ComputerPermission::Unknown,
            screen_recording: ComputerPermission::Unknown,
            permission_holder: None,
            session: None,
            ready: false,
            checks: vec![ComputerCheck {
                name: "installed".into(),
                ok: false,
                message: format!("{} is not installed.", self.kind.display_name()),
                fix: Some("Install it from Settings → Computer use, or run `kybern computer install`.".into()),
            }],
        }
    }

    async fn install(&self) -> Result<()> {
        bail!("{} cannot be installed by this build of Kybern yet.", self.kind.display_name())
    }

    async fn grant(&self) -> Result<()> {
        bail!("{}", self.message())
    }

    async fn warm(&self) -> Result<()> {
        bail!("{}", self.message())
    }

    async fn release(&self) {}

    async fn windows(&self, _pid: Option<i64>) -> Result<Vec<WindowInfo>> {
        bail!("{}", self.message())
    }

    async fn apps(&self) -> Result<Vec<AppInfo>> {
        bail!("{}", self.message())
    }

    async fn app_id_of(&self, _pid: i64) -> Option<String> {
        None
    }

    async fn find_app(&self, _requested: &str) -> Option<(String, String)> {
        None
    }

    async fn launch(&self, _app: &str, _app_id: Option<&str>) -> Result<Launched> {
        bail!("{}", self.message())
    }

    async fn read(&self, _target: Target, _options: ReadOptions<'_>, _session: &str) -> Result<WindowRead> {
        bail!("{}", self.message())
    }

    async fn zoom(&self, _target: Target, _region: Region, _edge: u32, _session: &str) -> Result<Image> {
        bail!("{}", self.message())
    }

    async fn act(&self, _target: Target, _act: &Act, _mode: Mode, _session: &str) -> Result<Outcome> {
        bail!("{}", self.message())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn says_what_is_missing_and_how_to_fix_it() {
        let backend = NotInstalled::new(BackendKind::AgentDesktop);
        assert!(!backend.installed());
        let status = backend.status().await;
        assert!(!status.installed && !status.ready);
        assert_eq!(status.checks[0].message, "agent-desktop is not installed.");
        assert!(backend.windows(None).await.unwrap_err().to_string().contains("Settings → Computer use"));
    }
}
