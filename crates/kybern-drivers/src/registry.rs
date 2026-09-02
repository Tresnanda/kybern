use std::collections::HashMap;
use std::sync::Arc;

use kybern_protocol::ProviderKind;

use crate::AgentDriver;

#[derive(Clone, Default)]
pub struct DriverRegistry {
    drivers: HashMap<ProviderKind, Arc<dyn AgentDriver>>,
}

impl DriverRegistry {
    pub fn with_defaults() -> Self {
        let mut r = Self::default();
        r.register(Arc::new(crate::claude::ClaudeDriver));
        r.register(Arc::new(crate::codex::CodexDriver));
        r.register(Arc::new(crate::opencode::OpencodeDriver));
        r.register(Arc::new(crate::pi::PiDriver::pi()));
        r.register(Arc::new(crate::pi::PiDriver::omp()));
        r.register(Arc::new(crate::cursor::CursorDriver));
        r
    }

    pub fn register(&mut self, driver: Arc<dyn AgentDriver>) {
        self.drivers.insert(driver.kind(), driver);
    }

    pub fn get(&self, kind: ProviderKind) -> Option<Arc<dyn AgentDriver>> {
        self.drivers.get(&kind).cloned()
    }

    pub fn kinds(&self) -> impl Iterator<Item = ProviderKind> + '_ {
        self.drivers.keys().copied()
    }
}
