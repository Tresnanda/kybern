//! Provider-owned plugins and connections. Credentials stay with the provider.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationKind {
    Plugin,
    Connector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationAction {
    Install,
    Uninstall,
    Enable,
    Disable,
    Update,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Integration {
    pub id: String,
    pub name: String,
    pub kind: IntegrationKind,
    pub description: Option<String>,
    pub scope: Option<String>,
    pub installed: bool,
    pub enabled: bool,
    pub status: String,
    pub actions: Vec<IntegrationAction>,
    /// Provider-supplied setup page, never a daemon token or credential.
    pub connect_url: Option<String>,
    pub can_login: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct IntegrationsCatalog {
    pub items: Vec<Integration>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct IntegrationChangeResult {
    pub message: String,
    pub connections: Vec<Integration>,
}
