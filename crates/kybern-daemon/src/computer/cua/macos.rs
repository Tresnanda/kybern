//! macOS helpers for the CuaDriver backend: Spotlight, LaunchServices and
//! `codesign`. On other systems none of these programs exist, so each answers
//! `None` without starting a process.

use std::time::Duration;

use crate::computer::notes;

/// Find an app CuaDriver's list misses with Spotlight: one nested in another
/// bundle (DeviceHub inside Xcode) or given as a path to an `.app`.
pub(crate) async fn spotlight_app(requested: &str) -> Option<(String, String)> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let path = if requested.starts_with('/') {
        requested.trim_end_matches('/').to_owned()
    } else {
        // Plain names only; quotes and wildcards would change the query.
        if requested.contains(['\'', '"', '\\', '*']) {
            return None;
        }
        let name = requested.trim_end_matches(".app");
        let query = format!("kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == '{name}.app'c");
        command_output("/usr/bin/mdfind", &[&query]).await?.lines().next()?.to_owned()
    };
    if !path.ends_with(".app") {
        return None;
    }
    let bundle = command_output("/usr/bin/mdls", &["-raw", "-name", "kMDItemCFBundleIdentifier", &path]).await?;
    let bundle = bundle.trim();
    if bundle.is_empty() || bundle == "(null)" {
        return None;
    }
    let name = std::path::Path::new(&path).file_stem()?.to_str()?.to_owned();
    Some((name, bundle.to_owned()))
}

/// An installed app's name for a bundle id, from Spotlight.
pub(crate) async fn app_name(bundle_id: &str) -> Option<String> {
    if !cfg!(target_os = "macos") || !bundle_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
        return None;
    }
    let query = format!("kMDItemContentType == 'com.apple.application-bundle' && kMDItemCFBundleIdentifier == '{bundle_id}'");
    let path = command_output("/usr/bin/mdfind", &[&query]).await?.lines().next()?.to_owned();
    let name = notes::display_name(std::path::Path::new(&path).file_stem()?.to_str()?);
    (!name.is_empty()).then_some(name)
}

/// The bundle id of a running regular (Dock) app, from LaunchServices.
pub(crate) async fn regular_app_bundle(pid: i64) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let text = command_output("/usr/bin/lsappinfo", &["info", &pid.to_string()]).await?;
    parse_regular_app_bundle(&text)
}

pub(crate) fn parse_regular_app_bundle(text: &str) -> Option<String> {
    if !text.contains("type=\"Foreground\"") {
        return None;
    }
    let start = text.find("bundleID=\"")? + "bundleID=\"".len();
    let end = text[start..].find('"')?;
    Some(text[start..start + end].to_owned()).filter(|bundle| !bundle.is_empty())
}

async fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = tokio::process::Command::new(program).args(args).kill_on_drop(true).output();
    let output = tokio::time::timeout(Duration::from_secs(3), output).await.ok()?.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_services_answers_only_for_regular_apps() {
        let app = "\"Calculator\" ASN:0x0-0x1: \n    bundleID=\"com.apple.calculator\"\n    pid = 7 type=\"Foreground\" flavor=3";
        assert_eq!(parse_regular_app_bundle(app).as_deref(), Some("com.apple.calculator"));
        let helper = "\"Helper\" ASN:0x0-0x2: \n    bundleID=\"com.example.helper\"\n    pid = 8 type=\"BackgroundOnly\"";
        assert_eq!(parse_regular_app_bundle(helper), None);
        assert_eq!(parse_regular_app_bundle(""), None);
    }

    #[tokio::test]
    #[cfg(target_os = "macos")]
    #[ignore = "queries Spotlight on this Mac"]
    async fn spotlight_finds_nested_and_path_apps() {
        let calculator = spotlight_app("/System/Applications/Calculator.app").await;
        assert_eq!(calculator, Some(("Calculator".into(), "com.apple.calculator".into())));
        assert_eq!(spotlight_app("no such app 7f3a").await, None);
        assert_eq!(spotlight_app("Calc*").await, None);
        if std::path::Path::new("/Applications/Xcode.app/Contents/Applications/DeviceHub.app").exists() {
            assert_eq!(spotlight_app("devicehub").await.map(|(_, bundle)| bundle).as_deref(), Some("com.apple.dt.Devices"));
        }
    }
}
