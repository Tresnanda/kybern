//! OMP's profile bootstrap rules, shared by process launch and session discovery.
use crate::{DriverError, Result};
use std::collections::BTreeMap;

pub fn normalize(value: &str) -> Result<String> {
    let profile = value.trim();
    if profile.is_empty() || profile == "default" {
        return Ok(String::new());
    }
    let base = profile.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT")) && base.len() == 4 && base.as_bytes()[3].is_ascii_digit());
    if profile.len() > 64
        || !profile.as_bytes()[0].is_ascii_alphanumeric()
        || !profile.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
        || profile.ends_with('.')
        || reserved
    {
        return Err(DriverError::Protocol("Invalid OMP profile. Use 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit. Avoid trailing dots and reserved device names.".into()));
    }
    Ok(profile.into())
}

pub fn resolve(env: &BTreeMap<String, String>) -> Result<String> {
    let value = env
        .get("OMP_PROFILE")
        .cloned()
        .or_else(|| std::env::var("OMP_PROFILE").ok())
        .or_else(|| env.get("PI_PROFILE").cloned())
        .or_else(|| std::env::var("PI_PROFILE").ok())
        .unwrap_or_default();
    normalize(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profiles_follow_omp_bootstrap_rules() {
        for value in ["", "default", "  default  "] {
            assert_eq!(normalize(value).unwrap(), "");
        }
        assert_eq!(normalize(" work-2.dev ").unwrap(), "work-2.dev");
        for value in ["..", "../other", "/tmp/work", "Work", "work.", "con", "nul.txt", "com9", "-work"] {
            assert!(normalize(value).is_err(), "{value}");
        }
        assert!(normalize(&"a".repeat(65)).is_err());
    }
    #[test]
    fn explicit_empty_canonical_profile_overrides_alias() {
        let env = [("OMP_PROFILE".into(), String::new()), ("PI_PROFILE".into(), "other".into())].into();
        assert_eq!(resolve(&env).unwrap(), "");
        assert_eq!(resolve(&[("OMP_PROFILE".into(), "named".into())].into()).unwrap(), "named");
    }
}
