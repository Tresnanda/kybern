use super::*;
use crate::network::testutil::TempDir;
use serde_json::json;

fn put(home: &Path, path: &str, body: &str) {
    let p = home.join(path);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}
fn context(dir: &TempDir) -> Context {
    Context { home: std::fs::canonicalize(dir.path()).unwrap(), env: BTreeMap::new() }
}
fn seed(ctx: &Context) {
    let h = &ctx.home;
    put(h, ".claude/plugins/known_marketplaces.json", r#"{"tools":{"source":{"source":"github","repo":"acme/tools"}}}"#);
    put(h, ".claude/settings.json", r#"{"enabledPlugins":{"review@tools":false}}"#);
    put(h,".claude/plugins/installed_plugins.json",&json!({"version":2,"plugins":{"review@tools":[{"scope":"project","version":"99"},{"scope":"user","version":"1","installPath":h.join(".claude/plugins/cache/tools/review/1")} ]}}).to_string());
    put(h, ".claude/plugins/cache/tools/review/1/.claude-plugin/plugin.json", r#"{"name":"review","version":"1"}"#);
    put(h, ".claude/plugins/cache/tools/review/1/hooks/hooks.json", r#"{"hooks":{"PreToolUse":[{},{}]}}"#);
    put(h, ".claude/plugins/cache/tools/review/1/.mcp.json", r#"{"mcpServers":{"review":{}}}"#);
    put(
        h,
        ".codex/config.toml",
        "# keep\n[marketplaces.tools]\nsource_type='git'\nsource='https://github.com/acme/tools.git'\n[plugins._default]\nenabled=false\n",
    );
    put(h, ".codex/plugins/cache/tools/review/1/.claude-plugin/plugin.json", r#"{"name":"review","version":"1"}"#);
    put(
        h,
        ".config/opencode/opencode.jsonc",
        r#"{ // keep
 "model": "test/model", "plugin": ["@acme/review@1.2.3", "./local.ts", {"package":"custom","options":{"secret":"never-send"}}],
}"#,
    );
    put(
        h,
        ".pi/agent/settings.json",
        r#"{"packages":[{"source":"npm:pi-review@2.0.0","extensions":[],"skills":[],"prompts":[],"themes":[]},"./local"]}"#,
    );
    put(h, ".omp/plugins/package.json", r#"{"dependencies":{"omp-review":"npm:omp-review@1.0.0"}}"#);
    put(
        h,
        ".omp/plugins/omp-plugins.lock.json",
        r#"{"plugins":{"omp-review":{"version":"1.0.0","enabled":false,"enabledFeatures":null}}}"#,
    );
    put(h, ".cursor/plugins/cache/tools/review/abc/.cursor-plugin/plugin.json", r#"{"name":"review","version":"1"}"#);
}
#[test]
fn inventory_covers_six_harnesses_without_credentials_or_cli() {
    let dir = TempDir::new("plugins-inventory");
    let ctx = context(&dir);
    seed(&ctx);
    let inv = inventory::read(&ctx);
    assert!(inv.warnings.is_empty(), "{:?}", inv.warnings);
    for provider in ProviderKind::ALL {
        assert!(inv.plugins.iter().any(|p| p.provider == provider), "{provider:?}");
    }
    let cc = inv.plugins.iter().find(|p| p.provider == ProviderKind::ClaudeCode && p.kind == PluginKind::Plugin).unwrap();
    assert_eq!(cc.version.as_deref(), Some("1"));
    assert_eq!(cc.enabled, Some(false));
    assert_eq!(cc.contents.hooks, 2);
    assert_eq!(cc.contents.mcp_servers, 1);
    let pi = inv.plugins.iter().find(|p| p.id == "pi-review").unwrap();
    assert_eq!(pi.enabled, Some(false));
    assert_eq!(pi.resources.len(), 4);
    assert!(inv.plugins.iter().find(|p| p.provider == ProviderKind::Cursor).unwrap().problem.is_some());
    assert!(!serde_json::to_string(&inv).unwrap().contains("never-send"));
    assert!(!serde_json::to_string(&inv).unwrap().contains(dir.path().to_str().unwrap()));
}
#[test]
fn sources_and_fingerprints_fail_closed() {
    for bad in
        ["/tmp/local", "../local", "file:///tmp/p", "--help", "https://user:secret@host/repo", "https://host/repo?token=x", "acme/$(cmd)"]
    {
        assert!(!portable_source(bad), "{bad}");
    }
    for good in ["https://github.com/acme/tools.git", "acme/tools", "acme/tools#v1"] {
        assert!(portable_source(good));
    }
    for bad in ["-x", "../local", "pkg;touch", "pkg@https://host"] {
        assert!(!npm_spec(bad));
    }
    let dir = TempDir::new("plugins-hash");
    let ctx = context(&dir);
    seed(&ctx);
    for mut p in inventory::read(&ctx).plugins.into_iter().filter(|p| p.problem.is_none()) {
        install::validate(&p).unwrap();
        p.enabled = Some(!p.enabled.unwrap());
        assert!(install::validate(&p).is_err());
    }
}
#[test]
fn jsonc_edits_preserve_other_bytes_and_refuse_duplicates() {
    let input = "{ // comment\n\"auth\":{\"nested\":true}, \"plugin\": [\"a\",], }";
    let out = json_config::replace(input, "plugin", &json!(["b"])).unwrap();
    assert!(out.contains("// comment"));
    assert!(out.contains("\"auth\":{\"nested\":true}"));
    assert_eq!(json_config::parse(&out).unwrap()["plugin"], json!(["b"]));
    assert!(json_config::replace(r#"{"plugin":[],"plugin":[]}"#, "plugin", &json!([])).is_err());
    let out = json_config::replace("{\"other\":true,}", "plugin", &json!([])).unwrap();
    assert_eq!(json_config::parse(&out).unwrap()["other"], true);
}
fn state(dir: &TempDir) -> crate::state::AppState {
    let paths = crate::config::Paths::resolve(Some(dir.path().join("data"))).unwrap();
    let state = AppState::initialize_in_memory(&paths).unwrap();
    state.skill_homes.set(BTreeMap::new(), dir.path().join("home"));
    std::fs::create_dir_all(dir.path().join("home")).unwrap();
    state
}
#[tokio::test]
async fn configured_packages_are_idempotent_and_refuse_stale_replacements() {
    let source = TempDir::new("plugin-source");
    let ctx = context(&source);
    seed(&ctx);
    let p = inventory::read(&ctx).plugins.into_iter().find(|p| p.id == "@acme/review").unwrap();
    let target = TempDir::new("plugin-target");
    let state = state(&target);
    let request = PluginInstallRequest { operation_id: uuid::Uuid::now_v7(), plugin: p.clone(), replaces: None };
    let result = install(&state, "a", request.clone()).await.unwrap();
    assert_eq!(result.state, PluginInstallState::Configured, "{}", result.message);
    let again = install(&state, "a", request.clone()).await.unwrap();
    assert_eq!(again.message, result.message);
    let again = install(&state, "a", PluginInstallRequest { operation_id: uuid::Uuid::now_v7(), ..request.clone() }).await.unwrap();
    assert_eq!(again.state, PluginInstallState::AlreadyThere);
    let mut changed = p.clone();
    changed.source = Some("@acme/review@2.0.0".into());
    changed.version = Some("2.0.0".into());
    changed.fingerprint = fingerprint(&changed);
    let refused =
        install(&state, "a", PluginInstallRequest { operation_id: uuid::Uuid::now_v7(), plugin: changed.clone(), replaces: None })
            .await
            .unwrap();
    assert_eq!(refused.state, PluginInstallState::Failed);
    let replaced =
        install(&state, "a", PluginInstallRequest { operation_id: uuid::Uuid::now_v7(), plugin: changed, replaces: Some(p.fingerprint) })
            .await
            .unwrap();
    assert_eq!(replaced.state, PluginInstallState::Configured, "{}", replaced.message);
    let tampered = PluginInstallRequest { plugin: inventory(&state).await.unwrap().plugins[0].clone(), ..request };
    assert!(install(&state, "a", tampered).await.is_err());
}
#[cfg(unix)]
#[tokio::test]
async fn fake_installers_receive_only_the_target_environment_and_report_failures() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new("plugins-fake");
    let state = state(&dir);
    let home = dir.path().join("home");
    let fake = dir.path().join("fake.py");
    std::fs::write(
        &fake,
        r#"#!/usr/bin/python3
import os,sys,json
from pathlib import Path
h=Path(os.environ['HOME'])
assert os.environ['USERPROFILE']==str(h)
assert os.environ['CODEX_HOME']==str(h/'.codex')
assert os.environ['CLAUDE_CONFIG_DIR']==str(h/'.claude')
assert os.environ['XDG_CONFIG_HOME']==str(h/'.config')
assert os.environ['PI_CODING_AGENT_DIR']==str(h/'.pi/agent')
assert os.environ['APPDATA']==str(h/'AppData/Roaming')
with (h/'calls.jsonl').open('a') as f:f.write(json.dumps(sys.argv[1:])+'\n')
print('fake harness refuses this package',file=sys.stderr)
sys.exit(7)
"#,
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let src = TempDir::new("plugins-fake-source");
    let ctx = context(&src);
    seed(&ctx);
    for provider in [ProviderKind::ClaudeCode, ProviderKind::Codex, ProviderKind::Pi, ProviderKind::Omp] {
        state.plugin_runtime.binaries.write().unwrap().insert(provider, fake.clone());
        let p = inventory::read(&ctx)
            .plugins
            .into_iter()
            .find(|p| p.provider == provider && p.kind == PluginKind::Plugin && p.problem.is_none())
            .unwrap();
        let r = install(&state, "a", PluginInstallRequest { operation_id: uuid::Uuid::now_v7(), plugin: p, replaces: None }).await.unwrap();
        assert_eq!(r.state, PluginInstallState::Failed);
        assert!(r.message.contains("fake harness refuses"), "{}", r.message);
    }
    let calls = std::fs::read_to_string(home.join("calls.jsonl")).unwrap();
    assert_eq!(calls.lines().count(), 4);
    assert!(calls.contains("marketplace"));
    assert!(calls.contains("npm:pi-review@2.0.0"));
    assert!(calls.contains("omp-review@1.0.0"));
    let cursor = inventory::read(&ctx).plugins.into_iter().find(|p| p.provider == ProviderKind::Cursor).unwrap();
    assert!(
        install(&state, "a", PluginInstallRequest { operation_id: uuid::Uuid::now_v7(), plugin: cursor, replaces: None }).await.is_err()
    );
}
#[tokio::test]
async fn unconfigured_test_state_never_reads_real_harness_data() {
    let dir = TempDir::new("plugin-isolation");
    let paths = crate::config::Paths::resolve(Some(dir.path().to_path_buf())).unwrap();
    let state = AppState::initialize_in_memory(&paths).unwrap();
    assert!(inventory(&state).await.unwrap().plugins.is_empty());
}
