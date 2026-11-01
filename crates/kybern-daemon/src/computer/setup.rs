//! Install and permission status for Settings, `kybern computer doctor`, and
//! the setup actions behind them. The shared fields are filled here; the rest
//! comes from the active backend.

use anyhow::Result;
use kybern_protocol::methods::{ComputerCheck, ComputerSetupAction, ComputerStatus};

use super::backend::Os;
use super::{ComputerUse, driver_of, drivers_for};

pub(crate) fn platform_slug(os: Os) -> Option<&'static str> {
    match os {
        Os::Mac => Some("macos"),
        Os::Windows => Some("windows"),
        Os::Linux => Some("linux"),
        Os::Other => None,
    }
}

pub(crate) async fn status(computer: &ComputerUse) -> ComputerStatus {
    let os = Os::current();
    let enabled = computer.inner.settings.get().computer_use.enabled;
    let backend = computer.backend().await;
    // Opening Settings → Computer use tries pictures again.
    backend.resume_capture();
    let reported = backend.status().await;
    let mut checks = reported.checks;
    if !enabled {
        checks.push(ComputerCheck {
            name: "enabled".into(),
            ok: false,
            message: "Computer use is turned off.".into(),
            fix: Some("Turn it on in Settings → Computer use.".into()),
        });
    }
    // The answer may have changed since the last look (an install, a removal).
    computer.publish_offer();
    ComputerStatus {
        supported: os != Os::Other,
        enabled,
        installed: reported.installed,
        app_path: reported.path,
        version: reported.version,
        required_version: reported.required_version,
        signed: reported.verified,
        accessibility: reported.accessibility,
        screen_recording: reported.screen_recording,
        ready: enabled && reported.ready,
        checks,
        platform: platform_slug(os).map(str::to_owned),
        driver: Some(driver_of(backend.kind())),
        drivers: drivers_for(os),
        permission_holder: reported.permission_holder,
        session: reported.session,
    }
}

pub(crate) async fn setup(computer: &ComputerUse, action: ComputerSetupAction) -> Result<ComputerStatus> {
    let backend = computer.backend().await;
    match action {
        ComputerSetupAction::Install => backend.install().await?,
        ComputerSetupAction::GrantPermissions => backend.grant().await?,
    }
    Ok(status(computer).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platforms_have_stable_names() {
        assert_eq!(platform_slug(Os::Mac), Some("macos"));
        assert_eq!(platform_slug(Os::Windows), Some("windows"));
        assert_eq!(platform_slug(Os::Linux), Some("linux"));
        assert_eq!(platform_slug(Os::Other), None);
    }
}
