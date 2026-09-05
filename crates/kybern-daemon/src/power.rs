//! Host power state for `settings.background.save_power_on_battery`.
//!
//! The probe is cheap and runs once per maintenance sweep; the result is
//! cached on `AppState` so RPC handlers never spawn a process for it.

/// Whether the host is drawing from a battery right now. `None` when the
/// platform does not expose it, or the probe fails.
pub fn on_battery() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("pmset").args(["-g", "batt"]).output().ok()?;
        parse_pmset(&String::from_utf8_lossy(&output.stdout))
    }
    #[cfg(target_os = "linux")]
    {
        parse_sysfs("/sys/class/power_supply")
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// `pmset -g batt` opens with `Now drawing from 'Battery Power'` or `'AC Power'`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_pmset(output: &str) -> Option<bool> {
    let first = output.lines().next()?;
    if first.contains("Battery Power") {
        Some(true)
    } else if first.contains("AC Power") {
        Some(false)
    } else {
        None
    }
}

/// On battery when at least one battery exists and no mains supply is online.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_sysfs(root: &str) -> Option<bool> {
    let mut has_battery = false;
    let mut mains_online = false;
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let read = |name: &str| std::fs::read_to_string(entry.path().join(name)).ok().map(|s| s.trim().to_string());
        match read("type").as_deref() {
            Some("Battery") => has_battery = true,
            Some("Mains") | Some("USB") if read("online").as_deref() == Some("1") => mains_online = true,
            _ => {}
        }
    }
    has_battery.then_some(!mains_online)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pmset_first_line_names_the_source() {
        assert_eq!(parse_pmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t81%; discharging"), Some(true));
        assert_eq!(parse_pmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t100%; charged"), Some(false));
        assert_eq!(parse_pmset(""), None);
        assert_eq!(parse_pmset("something else"), None);
    }

    #[test]
    fn sysfs_needs_a_battery_and_no_live_mains() {
        let root = std::env::temp_dir().join(format!("kybern-power-{}", uuid::Uuid::now_v7()));
        let supply = |name: &str, kind: &str, online: Option<&str>| {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("type"), kind).unwrap();
            if let Some(online) = online {
                std::fs::write(dir.join("online"), online).unwrap();
            }
        };
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(parse_sysfs(root.to_str().unwrap()), None, "no supplies at all");
        supply("AC", "Mains", Some("1"));
        assert_eq!(parse_sysfs(root.to_str().unwrap()), None, "a desktop has no battery");
        supply("BAT0", "Battery", None);
        assert_eq!(parse_sysfs(root.to_str().unwrap()), Some(false), "plugged in");
        supply("AC", "Mains", Some("0"));
        assert_eq!(parse_sysfs(root.to_str().unwrap()), Some(true), "unplugged");
        let _ = std::fs::remove_dir_all(&root);
    }
}
