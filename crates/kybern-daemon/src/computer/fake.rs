//! A backend that records what it is asked to do, for tests of the tools and
//! of the forwarding path.

use std::collections::VecDeque;
use std::sync::Arc;

use anyhow::{Result, bail};

use super::Mode;
use super::backend::Effect;
use super::backend::{self, BackendKind, Capabilities, ComputerBackend, Image, Outcome, ReadOptions, Target};
use super::digest::{self, Snapshot};

/// A backend that records what it is asked to do.
pub(crate) struct Fake {
    pub caps: Capabilities,
    pub acts: std::sync::Mutex<Vec<(backend::Act, Mode)>>,
    pub outcomes: std::sync::Mutex<VecDeque<Outcome>>,
    pub paused: Option<String>,
    /// How many times `release` was called.
    pub released: std::sync::atomic::AtomicUsize,
}

impl Fake {
    pub(crate) fn new(caps: Capabilities) -> Arc<Self> {
        Arc::new(Self { caps, acts: Default::default(), outcomes: Default::default(), paused: None, released: Default::default() })
    }

    pub(crate) fn acts(&self) -> Vec<backend::Act> {
        self.acts.lock().unwrap().iter().map(|(act, _)| act.clone()).collect()
    }
}

pub(crate) fn everything() -> Capabilities {
    Capabilities {
        menu_bar: true,
        background_pixels: true,
        pixels: true,
        background_typing: true,
        background_keys: true,
        background_scroll: true,
        window_capture: true,
        zoom: true,
    }
}

#[async_trait::async_trait]
impl ComputerBackend for Fake {
    fn kind(&self) -> BackendKind {
        BackendKind::AgentDesktop
    }

    fn capabilities(&self) -> Capabilities {
        self.caps
    }

    fn installed(&self) -> bool {
        true
    }

    async fn status(&self) -> backend::BackendStatus {
        unreachable!("not used by the tools")
    }

    async fn install(&self) -> Result<()> {
        Ok(())
    }

    async fn grant(&self) -> Result<()> {
        Ok(())
    }

    async fn warm(&self) -> Result<()> {
        Ok(())
    }

    async fn release(&self) {
        self.released.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    async fn windows(&self, _pid: Option<i64>) -> Result<Vec<backend::WindowInfo>> {
        Ok(vec![backend::WindowInfo {
            window_id: 7,
            pid: 100,
            app: "Notes".into(),
            title: "Todo".into(),
            on_screen: true,
            elsewhere: false,
            z_index: Some(1),
        }])
    }

    async fn apps(&self) -> Result<Vec<backend::AppInfo>> {
        Ok(vec![backend::AppInfo { name: "Notes".into(), app_id: Some("notes.test".into()), pid: Some(100), regular: true }])
    }

    async fn app_id_of(&self, _pid: i64) -> Option<String> {
        Some("notes.test".into())
    }

    async fn find_app(&self, _requested: &str) -> Option<(String, String)> {
        None
    }

    async fn launch(&self, app: &str, app_id: Option<&str>) -> Result<backend::Launched> {
        Ok(backend::Launched { name: app.into(), app_id: app_id.map(str::to_owned), pid: Some(100), windows: self.windows(None).await? })
    }

    async fn read(&self, _target: Target, _options: ReadOptions<'_>, _session: &str) -> Result<backend::WindowRead> {
        let mut save = digest::tests::el("button", "Save");
        save.token = Some("t1".into());
        let mut name = digest::tests::el("textfield", "Name");
        name.token = Some("t2".into());
        Ok(backend::WindowRead {
            snapshot: Snapshot::new(vec![save, name], Vec::new(), false, None, Some("Todo".into()), None),
            image: None,
        })
    }

    async fn zoom(&self, _target: Target, _region: backend::Region, _edge: u32, _session: &str) -> Result<Image> {
        bail!("no pictures in tests")
    }

    async fn act(&self, _target: Target, act: &backend::Act, mode: Mode, _session: &str) -> Result<Outcome> {
        self.acts.lock().unwrap().push((act.clone(), mode));
        Ok(self.outcomes.lock().unwrap().pop_front().unwrap_or_else(|| Outcome::of(Effect::Confirmed)))
    }

    fn capture_paused(&self) -> Option<String> {
        self.paused.clone()
    }
}
