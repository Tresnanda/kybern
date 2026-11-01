//! agent-desktop's JSON envelope and how it becomes an [`Outcome`].
//!
//! Every command prints one object: `{ok:true, data}` or
//! `{ok:false, error:{code, message, suggestion, disposition, details}}`.
//! Real envelopes from the macOS 1.0.2 binary are in `fixtures/macos`; the
//! Windows and Linux ones in the tests are transcribed from the platform skills.

use anyhow::{Result, anyhow};
use serde_json::Value;

use super::super::backend::{Effect, Escalation, Outcome};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AdError {
    pub code: String,
    pub message: String,
    pub suggestion: Option<String>,
    /// `error.disposition.delivery`: `not_delivered`, `delivered_unverified`, …
    pub delivery: Option<String>,
    pub details: Value,
}

impl AdError {
    pub(crate) fn kind(&self) -> Option<&str> {
        self.details.get("kind").and_then(Value::as_str)
    }

    /// `CODE: message`, one line, at most 600 characters.
    pub(crate) fn note(&self) -> String {
        note(&self.code, &self.message)
    }

    pub(crate) fn not_delivered(&self) -> bool {
        self.delivery.as_deref().is_none_or(|delivery| delivery == "not_delivered")
    }
}

pub(crate) fn note(code: &str, message: &str) -> String {
    let line = format!("{code}: {message}").split_whitespace().collect::<Vec<_>>().join(" ");
    clip(&line, 600)
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    clipped.push('…');
    clipped
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Envelope {
    pub ok: bool,
    pub data: Value,
    pub error: Option<AdError>,
}

impl Envelope {
    /// Parse the process output. The tool prints one JSON object; anything
    /// logged around it (a registry banner on a hand-started Linux bus) is
    /// skipped by taking the first line that parses as an envelope.
    pub(crate) fn parse(stdout: &str) -> Result<Self> {
        let value = serde_json::from_str::<Value>(stdout.trim())
            .ok()
            .filter(|value| value.get("ok").is_some())
            .or_else(|| {
                stdout
                    .lines()
                    .rev()
                    .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                    .find(|value| value.get("ok").is_some())
            })
            .ok_or_else(|| anyhow!("agent-desktop printed no JSON envelope: {}", clip(stdout.trim(), 200)))?;
        let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let error = value.get("error").filter(|error| error.is_object()).map(|error| {
            let text = |key: &str| error.get(key).and_then(Value::as_str).map(str::to_owned);
            AdError {
                code: text("code").unwrap_or_else(|| "UNKNOWN".into()),
                message: text("message").unwrap_or_default(),
                suggestion: text("suggestion"),
                delivery: error.pointer("/disposition/delivery").and_then(Value::as_str).map(str::to_owned),
                details: error.get("details").cloned().unwrap_or(Value::Null),
            }
        });
        Ok(Self { ok: ok && error.is_none(), data: value.get("data").cloned().unwrap_or(Value::Null), error })
    }

    /// The `data` of a successful envelope, or its error as an `anyhow` error
    /// carrying `CODE: message`.
    pub(crate) fn into_data(self) -> Result<Value> {
        match self.error {
            Some(error) => Err(anyhow!("{}", error.note())),
            None if self.ok => Ok(self.data),
            None => Err(anyhow!("agent-desktop answered not ok")),
        }
    }
}

/// What the mapping needs to know about the call.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct OutcomeContext {
    /// The call already asked for physical input (`--headed`).
    pub headed: bool,
    /// Pixel clicks do not exist here (Wayland).
    pub no_pixels: bool,
}

/// Judge a finished action command (design §5, "Outcome mapping").
pub(crate) fn outcome(envelope: &Envelope, context: OutcomeContext) -> Result<Outcome> {
    if let Some(error) = &envelope.error {
        return error_outcome(error, context);
    }
    let delivery = envelope.data.pointer("/disposition/delivery").and_then(Value::as_str);
    let effect = match delivery {
        Some("delivered_verified") => Effect::Confirmed,
        Some("not_delivered") => Effect::SuspectedNoop,
        _ => Effect::Unverifiable,
    };
    let physical = context.headed
        || envelope.data.get("steps").and_then(Value::as_array).is_some_and(|steps| {
            steps.iter().any(|step| {
                step.get("mechanism").and_then(Value::as_str) == Some("physical_synthetic")
                    && step.get("outcome").and_then(Value::as_str) == Some("succeeded")
            })
        });
    let mut outcome = Outcome::of(effect);
    outcome.physical = physical;
    // An unverified delivery that left a sheet or menu open usually waits on a confirmation.
    if matches!(outcome.effect, Effect::Unverifiable)
        && let Some(surfaces) = envelope.data.get("surfaces").and_then(Value::as_array)
        && !surfaces.is_empty()
    {
        let kinds: Vec<&str> =
            surfaces.iter().filter_map(|surface| surface.as_str().or_else(|| surface.get("kind").and_then(Value::as_str))).collect();
        if !kinds.is_empty() {
            outcome.note = Some(format!("An overlay is open ({}); it may be waiting for an answer.", kinds.join(", ")));
        }
    }
    Ok(outcome)
}

fn error_outcome(error: &AdError, context: OutcomeContext) -> Result<Outcome> {
    let note = error.note();
    let delivered = !error.not_delivered();
    let mut outcome = match error.code.as_str() {
        // A scoped key press on Linux that cannot confirm the window has focus: reading
        // the window again changes nothing, only bringing it to the front does.
        "STALE_REF" if error.details.get("cause").and_then(Value::as_str) == Some("exact_window_focus_unconfirmed") => {
            Outcome::refused(note, if context.headed { None } else { Some(Escalation::Foreground) })
        }
        "STALE_REF" | "AMBIGUOUS_TARGET" | "SNAPSHOT_NOT_FOUND" | "ELEMENT_NOT_FOUND" => {
            if delivered {
                // The read after delivery failed: the tools must not repeat the action.
                Outcome { note: Some(note), ..Outcome::of(Effect::Unverifiable) }
            } else {
                Outcome::stale(note)
            }
        }
        "POLICY_DENIED" => Outcome::refused(note, if context.headed || delivered { None } else { Some(Escalation::Foreground) }),
        "ACTION_NOT_SUPPORTED" => Outcome::refused(note, if context.no_pixels { None } else { Some(Escalation::Pixel) }),
        "ACTION_FAILED" => {
            if error.kind() == Some("post_action_verification") {
                Outcome { note: Some(note), ..Outcome::of(Effect::Partial) }
            } else if delivered {
                Outcome { note: Some(note), ..Outcome::of(Effect::Unverifiable) }
            } else {
                Outcome::refused(note, None)
            }
        }
        "TIMEOUT" => Outcome { note: Some(note), ..Outcome::of(Effect::Timeout) },
        "APP_UNRESPONSIVE" => Outcome { note: Some(note), ..Outcome::of(Effect::Unverifiable) },
        "PERM_DENIED" | "APP_NOT_FOUND" | "WINDOW_NOT_FOUND" | "INVALID_ARGS" | "PLATFORM_NOT_SUPPORTED" | "NOTIFICATION_NOT_FOUND" => {
            Outcome::refused(note, None)
        }
        // INTERNAL and anything new: the backend failed, not the action.
        _ => return Err(anyhow!("{note}")),
    };
    outcome.physical = context.headed && delivered;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn error_envelope(code: &str, delivery: &str, details: Value) -> Envelope {
        Envelope::parse(
            &json!({
                "ok": false, "version": "2.5", "command": "click",
                "error": { "code": code, "message": "m", "suggestion": "s", "disposition": { "delivery": delivery, "retry": "safe" }, "details": details }
            })
            .to_string(),
        )
        .unwrap()
    }

    fn map(code: &str, delivery: &str, details: Value, context: OutcomeContext) -> Result<Outcome> {
        outcome(&error_envelope(code, delivery, details), context)
    }

    #[test]
    fn real_macos_envelopes_parse() {
        let version = Envelope::parse(include_str!("fixtures/macos/version.json")).unwrap();
        assert!(version.ok);
        assert_eq!(version.data["version"], "1.0.2");
        assert_eq!(version.data["os"], "macos");

        let denied = Envelope::parse(include_str!("fixtures/macos/error_perm_denied.json")).unwrap();
        let error = denied.error.unwrap();
        assert_eq!(error.code, "PERM_DENIED");
        assert!(error.not_delivered());
        assert_eq!(error.note(), "PERM_DENIED: Accessibility permission not granted");

        let invalid = Envelope::parse(include_str!("fixtures/macos/error_invalid_ref.json")).unwrap();
        let out = outcome(&invalid, OutcomeContext::default()).unwrap();
        assert_eq!(out.effect, Effect::Refused);
        assert!(out.note.unwrap().starts_with("INVALID_ARGS: Invalid ref_id 'bad'"));

        let surface = Envelope::parse(include_str!("fixtures/macos/error_surface_read.json")).unwrap();
        assert_eq!(surface.error.unwrap().details["attribute"], "AXFrontmost");
    }

    #[test]
    fn linux_and_windows_envelopes_from_real_machines_map() {
        let context = OutcomeContext::default();
        // GNOME 46 Wayland: a semantic click is delivered but unobserved.
        let click = Envelope::parse(include_str!("fixtures/linux/click7.json")).unwrap();
        assert_eq!(outcome(&click, context).unwrap().effect, Effect::Unverifiable);
        // set-value and type are read back.
        for fixture in [include_str!("fixtures/linux/setvalue.json"), include_str!("fixtures/linux/type.json")] {
            let out = outcome(&Envelope::parse(fixture).unwrap(), context).unwrap();
            assert_eq!(out.effect, Effect::Confirmed);
            assert!(!out.physical);
        }
        // A key to an unfocused window is a foreground matter, not a stale ref.
        let press = Envelope::parse(include_str!("fixtures/linux/press8.json")).unwrap();
        let out = outcome(&press, context).unwrap();
        assert!(!out.stale);
        assert_eq!((out.effect, out.escalation), (Effect::Refused, Some(Escalation::Foreground)));
        // Scroll is physical on Linux.
        let scroll = Envelope::parse(include_str!("fixtures/linux/scroll.json")).unwrap();
        let out = outcome(&scroll, OutcomeContext { headed: false, no_pixels: true }).unwrap();
        assert_eq!((out.effect, out.escalation), (Effect::Refused, None));
        // Windows: a scoped press by window id is not found; the menu surface may simply be closed.
        let press = Envelope::parse(include_str!("fixtures/windows/press.json")).unwrap();
        assert_eq!(outcome(&press, context).unwrap().effect, Effect::Refused);
        let menu = Envelope::parse(include_str!("fixtures/windows/menu.json")).unwrap();
        assert_eq!(menu.error.unwrap().code, "WINDOW_NOT_FOUND");
    }

    #[test]
    fn a_banner_before_the_envelope_is_skipped() {
        let text = "SpiRegistry daemon is running with well-known name - org.a11y.atspi.Registry\n{\"ok\":true,\"data\":{\"x\":1},\"version\":\"2.5\"}\n";
        assert_eq!(Envelope::parse(text).unwrap().data["x"], 1);
        assert!(Envelope::parse("not json").is_err());
    }

    #[test]
    fn delivery_maps_to_effect() {
        let verified = Envelope::parse(r#"{"ok":true,"data":{"disposition":{"delivery":"delivered_verified","retry":"unsafe"},"steps":[{"label":"AXPress","outcome":"succeeded","mechanism":"semantic_api","verified":true}]}}"#).unwrap();
        let out = outcome(&verified, OutcomeContext::default()).unwrap();
        assert_eq!(out.effect, Effect::Confirmed);
        assert!(!out.physical);

        let unverified = Envelope::parse(r#"{"ok":true,"data":{"disposition":{"delivery":"delivered_unverified","retry":"unsafe"},"steps":[{"outcome":"succeeded","mechanism":"physical_synthetic"}],"surfaces":["sheet"]}}"#).unwrap();
        let out = outcome(&unverified, OutcomeContext::default()).unwrap();
        assert_eq!(out.effect, Effect::Unverifiable);
        assert!(out.physical);
        assert!(out.note.unwrap().contains("sheet"));

        let none = Envelope::parse(r#"{"ok":true,"data":{"disposition":{"delivery":"not_delivered","retry":"safe"}}}"#).unwrap();
        assert_eq!(outcome(&none, OutcomeContext::default()).unwrap().effect, Effect::SuspectedNoop);
    }

    #[test]
    fn every_error_code_has_its_mapping() {
        let context = OutcomeContext::default();
        for code in ["STALE_REF", "AMBIGUOUS_TARGET", "SNAPSHOT_NOT_FOUND", "ELEMENT_NOT_FOUND"] {
            let out = map(code, "not_delivered", Value::Null, context).unwrap();
            assert!(out.stale, "{code}");
            assert_eq!(out.effect, Effect::Refused);
        }
        // After delivery a stale read must not make the tools repeat the action.
        let out = map("STALE_REF", "delivered_unverified", Value::Null, context).unwrap();
        assert!(!out.stale);
        assert_eq!(out.effect, Effect::Unverifiable);

        let out = map("POLICY_DENIED", "not_delivered", Value::Null, context).unwrap();
        assert_eq!((out.effect, out.escalation), (Effect::Refused, Some(Escalation::Foreground)));
        let out = map("POLICY_DENIED", "not_delivered", Value::Null, OutcomeContext { headed: true, no_pixels: false }).unwrap();
        assert_eq!(out.escalation, None);

        let out = map("ACTION_NOT_SUPPORTED", "not_delivered", Value::Null, context).unwrap();
        assert_eq!((out.effect, out.escalation), (Effect::Refused, Some(Escalation::Pixel)));
        let wayland = OutcomeContext { headed: false, no_pixels: true };
        assert_eq!(map("ACTION_NOT_SUPPORTED", "not_delivered", Value::Null, wayland).unwrap().escalation, None);

        let out = map("ACTION_FAILED", "delivered_unverified", json!({"kind": "post_action_verification"}), context).unwrap();
        assert_eq!(out.effect, Effect::Partial);
        assert_eq!(map("ACTION_FAILED", "not_delivered", Value::Null, context).unwrap().effect, Effect::Refused);

        assert_eq!(map("TIMEOUT", "delivered_unverified", Value::Null, context).unwrap().effect, Effect::Timeout);
        let out = map("APP_UNRESPONSIVE", "delivered_unverified", Value::Null, context).unwrap();
        assert_eq!(out.effect, Effect::Unverifiable);
        assert!(out.note.unwrap().starts_with("APP_UNRESPONSIVE: m"));

        for code in ["PERM_DENIED", "APP_NOT_FOUND", "WINDOW_NOT_FOUND", "INVALID_ARGS", "PLATFORM_NOT_SUPPORTED"] {
            assert_eq!(map(code, "not_delivered", Value::Null, context).unwrap().effect, Effect::Refused, "{code}");
        }
        assert!(map("INTERNAL", "not_delivered", Value::Null, context).is_err());
    }

    #[test]
    fn notes_are_one_clipped_line() {
        let long = format!("line one\nline two {}", "x".repeat(900));
        let note = note("ACTION_FAILED", &long);
        assert!(!note.contains('\n'));
        assert_eq!(note.chars().count(), 600);
        assert!(note.starts_with("ACTION_FAILED: line one line two"));
    }
}
