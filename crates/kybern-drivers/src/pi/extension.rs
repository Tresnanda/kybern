use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use kybern_protocol::{ApprovalDecision, PermissionMode};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::process::Command;
use uuid::Uuid;

use crate::{DriverError, Result};

const SOURCE: &str = include_str!("extension.ts");
const PROTOCOL_VERSION: u8 = 1;
const MAX_MARKER_BYTES: usize = 256 * 1024;
const MAX_APP_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_ID_LEN: usize = 128;
const MAX_NAME_LEN: usize = 128;

pub const COMMAND_SENTINEL: &str = "kybern-extension";
pub const MODE_COMMAND: &str = "kybern-permission-mode";
pub const PERMISSION_TITLE_PREFIX: &str = "kybern_permission_request:";
pub const APP_TOOL_TITLE_PREFIX: &str = "kybern_app_tool_request:";

pub const ALLOW_ONCE: &str = "Allow once";
pub const ALLOW_ALWAYS: &str = "Always allow this exact call";
pub const DENY: &str = "Deny";
pub const APP_TOOL_NAMES: [&str; 7] = [
    "kybern_thread_context",
    "kybern_workspace_diff",
    "kybern_read_file",
    "kybern_list_files",
    "kybern_runtime_tasks",
    "kybern_list_terminals",
    "kybern_read_terminal",
];

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionRequest {
    pub version: u8,
    pub request_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppToolRequest {
    pub version: u8,
    pub id: String,
    pub name: String,
    pub arguments: Value,
    pub tool_call_id: String,
}

/// A process-owned copy of the bundled extension. Keeping this value alive
/// keeps the asset available for reloads; dropping it removes only its private
/// file and directory.
#[derive(Debug)]
pub struct StagedExtension {
    directory: PathBuf,
    path: PathBuf,
    mode: PermissionMode,
}

impl StagedExtension {
    pub fn new(mode: PermissionMode) -> Result<Self> {
        mode_name_checked(mode)?;
        let directory = std::env::temp_dir().join(format!("kybern-pi-extension-{}-{}", std::process::id(), Uuid::new_v4().simple()));
        create_private_directory(&directory)?;
        let path = directory.join("kybern-extension.ts");
        let write_result = write_private_file(&path, SOURCE.as_bytes());
        if let Err(error) = write_result {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_dir(&directory);
            return Err(error.into());
        }
        Ok(Self { directory, path, mode })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Add the supported Pi extension flag and fail-safe initial permission
    /// mode to a command before spawning it.
    pub fn configure(&self, command: &mut Command) {
        command.arg("--extension").arg(&self.path);
        command.env("KYBERN_PI_PERMISSION_MODE", mode_name(self.mode));
    }

    /// Require Pi to advertise our versioned sentinel before any prompt is
    /// sent. This is deliberately strict so an extension load error cannot
    /// silently widen permissions.
    pub fn verify(&self, command_response: &Value) -> Result<()> {
        let commands = command_response
            .get("commands")
            .and_then(Value::as_array)
            .ok_or_else(|| DriverError::Protocol("Pi extension handshake returned no command catalog".into()))?;
        let expected_description = format!("Kybern extension protocol {PROTOCOL_VERSION}");
        let loaded = commands.iter().any(|command| {
            command.get("name").and_then(Value::as_str) == Some(COMMAND_SENTINEL)
                && command.get("source").and_then(Value::as_str) == Some("extension")
                && command.get("description").and_then(Value::as_str) == Some(expected_description.as_str())
        });
        if loaded {
            Ok(())
        } else {
            Err(DriverError::Protocol("Pi did not load Kybern's permission extension; fix the extension error and send again".into()))
        }
    }
}

impl Drop for StagedExtension {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}

pub fn mode_command(mode: PermissionMode) -> Result<String> {
    Ok(format!("/{MODE_COMMAND} {}", mode_name_checked(mode)?))
}

pub fn permission_response(decision: &ApprovalDecision) -> Result<&'static str> {
    match decision {
        ApprovalDecision::AllowOnce => Ok(ALLOW_ONCE),
        ApprovalDecision::AllowAlways => Ok(ALLOW_ALWAYS),
        ApprovalDecision::Deny { .. } => Ok(DENY),
        ApprovalDecision::Submit { .. } => Err(DriverError::Protocol("expected a permission decision".into())),
    }
}

/// Reserved prefixes return `Some` even when malformed so callers can fail
/// closed instead of showing an internal bridge request as an ordinary dialog.
pub fn parse_permission_request(title: &str) -> Option<Result<PermissionRequest>> {
    parse_marker(title, PERMISSION_TITLE_PREFIX).map(|result| {
        let request: PermissionRequest = result?;
        if request.version != PROTOCOL_VERSION
            || !valid_bounded_string(&request.request_id, MAX_ID_LEN)
            || !valid_bounded_string(&request.tool_call_id, MAX_ID_LEN)
            || !valid_bounded_string(&request.tool_name, MAX_NAME_LEN)
            || !request.input.is_object()
        {
            return Err(DriverError::Protocol("invalid Kybern Pi permission request".into()));
        }
        Ok(request)
    })
}

/// Reserved prefixes return `Some` even when malformed so callers can cancel
/// them without surfacing an internal bridge request to the user.
pub fn parse_app_tool_request(title: &str) -> Option<Result<AppToolRequest>> {
    parse_marker(title, APP_TOOL_TITLE_PREFIX).map(|result| {
        let request: AppToolRequest = result?;
        if request.version != PROTOCOL_VERSION
            || !valid_bounded_string(&request.id, MAX_ID_LEN)
            || !valid_bounded_string(&request.name, MAX_NAME_LEN)
            || !valid_bounded_string(&request.tool_call_id, MAX_ID_LEN)
            || !request.arguments.is_object()
            || !APP_TOOL_NAMES.contains(&request.name.as_str())
            || serde_json::to_vec(&request.arguments).map_or(true, |bytes| bytes.len() > MAX_APP_ARGUMENT_BYTES)
        {
            return Err(DriverError::Protocol("invalid Kybern Pi app tool request".into()));
        }
        Ok(request)
    })
}

pub fn encode_app_tool_result(success: bool, data: Option<&Value>, error: Option<&str>) -> String {
    let value = json!({
        "version": PROTOCOL_VERSION,
        "success": success,
        "data": data,
        "error": error,
    });
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
}

fn parse_marker<T: for<'de> Deserialize<'de>>(title: &str, prefix: &str) -> Option<Result<T>> {
    let encoded = title.strip_prefix(prefix)?;
    Some((|| {
        if encoded.is_empty() || encoded.len() > MAX_MARKER_BYTES.saturating_mul(2) {
            return Err(DriverError::Protocol("invalid Kybern Pi extension marker".into()));
        }
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| DriverError::Protocol("invalid Kybern Pi extension marker encoding".into()))?;
        if bytes.len() > MAX_MARKER_BYTES {
            return Err(DriverError::Protocol("Kybern Pi extension marker is too large".into()));
        }
        serde_json::from_slice(&bytes).map_err(|_| DriverError::Protocol("invalid Kybern Pi extension marker payload".into()))
    })())
}

fn valid_bounded_string(value: &str, max_len: usize) -> bool {
    !value.is_empty() && value.len() <= max_len
}

fn mode_name(mode: PermissionMode) -> &'static str {
    mode_name_checked(mode).unwrap_or("supervised")
}

fn mode_name_checked(mode: PermissionMode) -> Result<&'static str> {
    match mode {
        PermissionMode::Supervised => Ok("supervised"),
        PermissionMode::AcceptEdits => Ok("accept_edits"),
        PermissionMode::FullAccess => Ok("full_access"),
        PermissionMode::Auto => {
            Err(DriverError::Unsupported("Pi does not support Auto permissions; choose Supervised, Accept edits, or Full access".into()))
        }
    }
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir(path)
}

fn write_private_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use std::process::Command as StdCommand;

    use super::*;

    fn marker(prefix: &str, value: Value) -> String {
        format!("{prefix}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string()))
    }

    #[test]
    fn staged_extension_is_private_and_removed_on_drop() {
        let staged = StagedExtension::new(PermissionMode::Supervised).unwrap();
        let path = staged.path().to_path_buf();
        let directory = staged.directory.clone();
        assert_eq!(fs::read_to_string(&path).unwrap(), SOURCE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&directory).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        drop(staged);
        assert!(!path.exists());
        assert!(!directory.exists());
    }

    #[test]
    fn handshake_requires_the_versioned_extension_command() {
        let staged = StagedExtension::new(PermissionMode::AcceptEdits).unwrap();
        staged
            .verify(&json!({
                "commands": [{
                    "name": COMMAND_SENTINEL,
                    "description": "Kybern extension protocol 1",
                    "source": "extension"
                }]
            }))
            .unwrap();
        assert!(staged.verify(&json!({"commands": []})).is_err());
        assert!(
            staged
                .verify(&json!({
                    "commands": [{
                        "name": COMMAND_SENTINEL,
                        "description": "Kybern extension protocol 2",
                        "source": "extension"
                    }]
                }))
                .is_err()
        );
    }

    #[test]
    fn parses_structured_permission_and_app_tool_markers() {
        let permission = marker(
            PERMISSION_TITLE_PREFIX,
            json!({
                "version": 1,
                "requestId": "permission-1",
                "toolCallId": "call-1",
                "toolName": "bash",
                "input": {"command": "cargo test"}
            }),
        );
        let parsed = parse_permission_request(&permission).unwrap().unwrap();
        assert_eq!(parsed.tool_name, "bash");
        assert_eq!(parsed.input["command"], "cargo test");

        let app = marker(
            APP_TOOL_TITLE_PREFIX,
            json!({
                "version": 1,
                "id": "request-1",
                "name": "kybern_read_file",
                "arguments": {"path": "README.md"},
                "toolCallId": "call-2"
            }),
        );
        let parsed = parse_app_tool_request(&app).unwrap().unwrap();
        assert_eq!(parsed.name, "kybern_read_file");
        assert_eq!(parsed.arguments["path"], "README.md");
    }

    #[test]
    fn malformed_reserved_markers_fail_closed() {
        assert!(parse_permission_request("ordinary title").is_none());
        assert!(parse_permission_request(PERMISSION_TITLE_PREFIX).unwrap().is_err());
        assert!(parse_app_tool_request(&format!("{APP_TOOL_TITLE_PREFIX}not-base64")).unwrap().is_err());
    }

    #[test]
    fn maps_modes_and_decisions_without_auto() {
        assert_eq!(mode_command(PermissionMode::AcceptEdits).unwrap(), "/kybern-permission-mode accept_edits");
        assert!(mode_command(PermissionMode::Auto).is_err());
        assert_eq!(permission_response(&ApprovalDecision::AllowOnce).unwrap(), ALLOW_ONCE);
        assert_eq!(permission_response(&ApprovalDecision::AllowAlways).unwrap(), ALLOW_ALWAYS);
        assert_eq!(permission_response(&ApprovalDecision::Deny { reason: None }).unwrap(), DENY);
    }

    #[test]
    fn extension_behavior_passes_the_fake_pi_harness() {
        if StdCommand::new("node").arg("--version").output().is_err() {
            return;
        }
        let staged = StagedExtension::new(PermissionMode::Supervised).unwrap();
        let module_path = staged.directory.join("extension.mjs");
        let harness_path = staged.directory.join("extension.test.mjs");
        fs::copy(staged.path(), &module_path).unwrap();
        write_private_file(&harness_path, include_bytes!("extension.test.mjs")).unwrap();
        let output = StdCommand::new("node").arg(&harness_path).arg(&module_path).output().unwrap();
        assert!(
            output.status.success(),
            "fake Pi harness failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let _ = fs::remove_file(module_path);
        let _ = fs::remove_file(harness_path);
    }
}
