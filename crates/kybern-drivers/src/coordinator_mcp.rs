//! Read native MCP configuration without starting servers or exposing credentials to clients.
use crate::ProbeContext;
use kybern_protocol::ProviderKind;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

/// Only harnesses with an enforced Coordinator tool boundary have a catalog.
pub fn servers(kind: ProviderKind, context: &ProbeContext) -> BTreeMap<String, Value> {
    let env = |key: &str| context.env.get(key).cloned().or_else(|| std::env::var(key).ok());
    let home = env("HOME").or_else(|| env("USERPROFILE")).map(PathBuf::from);
    let Some(home) = home else { return BTreeMap::new() };
    let mut sources: Vec<(PathBuf, &str)> = Vec::new();
    let cwd = context.cwd.as_deref();
    match kind {
        ProviderKind::ClaudeCode => {
            let config =
                env("CLAUDE_CONFIG_DIR").map(|dir| PathBuf::from(dir).join(".claude.json")).unwrap_or_else(|| home.join(".claude.json"));
            sources.push((config.clone(), "mcpServers"));
            if let Some(cwd) = cwd {
                sources.push((cwd.join(".mcp.json"), "mcpServers"));
                // Claude stores local project servers under the canonical project's path.
                if let Some(value) = read(&config).and_then(|v| v.get("projects")?.get(cwd.to_str()?).cloned()) {
                    let mut result = merge_sources(&sources);
                    merge(&mut result, &value, "mcpServers");
                    return result;
                }
            }
        }
        ProviderKind::Opencode => {
            let root = env("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
            sources.push((root.join("opencode/opencode.json"), "mcp"));
            if let Some(file) = env("OPENCODE_CONFIG") {
                sources.push((file.into(), "mcp"));
            }
            if let Some(cwd) = cwd {
                sources.push((cwd.join("opencode.json"), "mcp"));
            }
        }
        ProviderKind::Omp | ProviderKind::Pi => {
            let is_omp = kind == ProviderKind::Omp;
            let root = env("PI_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(if is_omp { ".omp" } else { ".pi" }));
            let profile = if is_omp { crate::omp_profile::resolve(&context.env).unwrap_or_default() } else { String::new() };
            let dir = if profile.is_empty() {
                env("PI_CODING_AGENT_DIR").map(PathBuf::from).unwrap_or_else(|| root.join("agent"))
            } else {
                root.join("profiles").join(profile).join("agent")
            };
            for name in [".mcp.json", "mcp.json"] {
                sources.push((dir.join(name), "mcpServers"));
            }
            if let Some(cwd) = cwd {
                for name in ["mcp.json", ".mcp.json"] {
                    sources.push((cwd.join(name), "mcpServers"));
                }
                for name in [".mcp.json", "mcp.json"] {
                    sources.push((cwd.join(if is_omp { ".omp" } else { ".pi" }).join(name), "mcpServers"));
                }
            }
        }
        _ => return BTreeMap::new(),
    }
    if kind == ProviderKind::Opencode {
        sources = sources
            .into_iter()
            .flat_map(|(path, key)| {
                if path.extension().is_some_and(|ext| ext == "json") {
                    vec![(path.clone(), key), (path.with_extension("jsonc"), key)]
                } else {
                    vec![(path, key)]
                }
            })
            .collect();
    }
    let mut result = merge_sources(&sources);
    if kind == ProviderKind::Opencode
        && let Some(value) = env("OPENCODE_CONFIG_CONTENT").and_then(|raw| parse_json_config(&raw))
    {
        merge(&mut result, &value, "mcp");
    }
    result
}

fn read(path: &Path) -> Option<Value> {
    // Configs are small; refuse accidental large files and never log their contents.
    if std::fs::metadata(path).ok()?.len() > 2 * 1024 * 1024 {
        return None;
    }
    parse_json_config(&std::fs::read_to_string(path).ok()?)
}
fn merge_sources(sources: &[(PathBuf, &str)]) -> BTreeMap<String, Value> {
    let mut result = BTreeMap::new();
    for (path, key) in sources {
        if let Some(value) = read(path) {
            merge(&mut result, &value, key);
        }
    }
    result
}
fn merge(result: &mut BTreeMap<String, Value>, value: &Value, key: &str) {
    if let Some(servers) = value.get(key).and_then(Value::as_object) {
        for (name, config) in servers {
            if !valid_server_name(name) || name == "kybern" {
                continue;
            }
            if config.get("enabled").and_then(Value::as_bool) == Some(false) {
                result.remove(name);
            } else if config.is_object() {
                result.insert(name.clone(), config.clone());
            }
        }
    }
}
/// Reject glob syntax: server names become native tool permission patterns.
pub fn valid_server_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// JSONC comments and trailing commas, without changing string contents (URLs, commands).
fn parse_json_config(raw: &str) -> Option<Value> {
    let mut bytes = raw.as_bytes().to_vec();
    let mut i = 0;
    let mut string = false;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if string => {
                i += 2;
                continue;
            }
            b'"' => string = !string,
            b'/' if !string && bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    bytes[i] = b' ';
                    i += 1;
                }
                continue;
            }
            b'/' if !string && bytes.get(i + 1) == Some(&b'*') => {
                bytes[i] = b' ';
                bytes[i + 1] = b' ';
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    bytes[i] = b' ';
                    i += 1;
                }
                if i + 1 >= bytes.len() {
                    return None;
                }
                bytes[i] = b' ';
                bytes[i + 1] = b' ';
                i += 2;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    string = false;
    i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if string => {
                i += 2;
                continue;
            }
            b'"' => string = !string,
            b',' if !string => {
                let next = bytes[i + 1..].iter().find(|b| !b.is_ascii_whitespace());
                if matches!(next, Some(b'}' | b']')) {
                    bytes[i] = b' ';
                }
            }
            _ => {}
        }
        i += 1;
    }
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn discovery_respects_profile_overrides_and_hides_disabled_servers() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".omp/profiles/work/agent");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("mcp.json"),
            json!({"mcpServers":{"memory":{"command":"memory"},"off":{"enabled":false},"*":{"command":"bad"}}}).to_string(),
        )
        .unwrap();
        let context = ProbeContext {
            binary: None,
            cwd: None,
            env: [("HOME".into(), home.path().to_string_lossy().into_owned()), ("OMP_PROFILE".into(), "work".into())].into(),
        };
        assert_eq!(servers(ProviderKind::Omp, &context).keys().collect::<Vec<_>>(), vec!["memory"]);
        assert!(servers(ProviderKind::Cursor, &context).is_empty());
    }

    #[test]
    fn jsonc_keeps_urls_and_escaped_strings() {
        let raw = r#"{/* comment */ "mcp": {"memory": {"url":"https://example.test//mcp",},}, // end
        }"#;
        assert_eq!(parse_json_config(raw).unwrap()["mcp"]["memory"]["url"], "https://example.test//mcp");
        assert!(parse_json_config("{/* unterminated").is_none());
    }
    #[test]
    fn native_configs_follow_project_precedence() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        std::fs::write(
            home.path().join(".claude/.claude.json"),
            json!({"mcpServers":{"memory":{"command":"user"},"other":{"command":"other"}}}).to_string(),
        )
        .unwrap();
        std::fs::write(
            project.path().join(".mcp.json"),
            json!({"mcpServers":{"memory":{"command":"project"},"other":{"enabled":false}}}).to_string(),
        )
        .unwrap();
        let context = ProbeContext {
            binary: None,
            cwd: Some(project.path().into()),
            env: [
                ("HOME".into(), home.path().to_string_lossy().into_owned()),
                ("CLAUDE_CONFIG_DIR".into(), home.path().join(".claude").to_string_lossy().into_owned()),
            ]
            .into(),
        };
        let found = servers(ProviderKind::ClaudeCode, &context);
        assert_eq!(found["memory"]["command"], "project");
        assert!(!found.contains_key("other"));
    }
}
