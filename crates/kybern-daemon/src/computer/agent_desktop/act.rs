//! Delivering one action (design §5, "Calls" and "Per OS").
//!
//! Background is agent-desktop's strict headless default; foreground adds
//! `--headed`. Where the OS has no headless path (Windows keys and typing,
//! Linux scroll, every double click and pointer click) the action is refused
//! with the foreground hint instead of being sent, or, for typing into a
//! known field on Windows, carried out as `set-value` of the old text plus
//! the new. `--force` is never passed.

use anyhow::Result;
use serde_json::Value;

use super::super::Mode;
use super::super::backend::{Act, Button, Direction, Effect, Escalation, Os, Outcome, Target};
use super::capture;
use super::envelope::{OutcomeContext, note, outcome};
use super::runner::Cmd;
use super::{ACTION_MS, AgentDesktopBackend, apps};

const WINDOWS_TYPE_NOTE: &str = "set the field (typing needs foreground on Windows)";

/// What `launch` is given for an app (the platform skills' identifier rules).
pub(super) fn launch_arg(os: Os, app: &str, app_id: Option<&str>) -> String {
    match os {
        Os::Mac => app_id.unwrap_or(app).to_owned(),
        Os::Windows => {
            let wanted = app_id.unwrap_or(app);
            apps::resolve_windows(wanted)
                .or_else(|| apps::resolve_windows(app))
                .map(|exe| exe.launch_arg())
                .unwrap_or_else(|| wanted.to_owned())
        }
        Os::Linux | Os::Other => {
            let entries = apps::desktop_entries(&apps::applications_dirs());
            match apps::match_entry(&entries, app_id.unwrap_or(app)).or_else(|| apps::match_entry(&entries, app)) {
                Some(entry) => format!("{}.desktop", entry.id),
                None => app_id.unwrap_or(app).to_owned(),
            }
        }
    }
}

/// Does a window's app name belong to the app that was launched?
pub(super) fn same_app(window_app: &str, launched: &str) -> bool {
    let stem = |name: &str| {
        let name = name.rsplit(['\\', '/']).next().unwrap_or(name).to_lowercase();
        name.strip_suffix(".exe").map(str::to_owned).unwrap_or(name)
    };
    let (window, launched) = (stem(window_app), stem(launched));
    !window.is_empty() && !launched.is_empty() && (window == launched || window.starts_with(&launched) || launched.starts_with(&window))
}

/// `["ctrl", "shift", "p"]` → the combo agent-desktop reads. The logo key is
/// `meta` on Windows and Linux (`cmd` there means the same key, and `win` is
/// not a name Windows documents).
pub(super) fn combo(os: Os, keys: &[String]) -> String {
    keys.iter()
        .map(|key| match key.as_str() {
            "win" | "super" | "logo" if os != Os::Mac => "meta",
            other => other,
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// Windows background typing: the field's text now, then the new text.
pub(super) fn windows_typed_value(current: Option<&str>, text: &str) -> String {
    format!("{}{}", current.unwrap_or(""), text)
}

fn direction(direction: Direction) -> &'static str {
    match direction {
        Direction::Up => "up",
        Direction::Down => "down",
        Direction::Left => "left",
        Direction::Right => "right",
    }
}

fn button(button: Button) -> &'static str {
    match button {
        Button::Left => "left",
        Button::Right => "right",
        Button::Middle => "middle",
    }
}

/// `data.match.ref_id` or the first of `data.matches`.
fn found_ref(data: &Value) -> Option<String> {
    data.pointer("/match/ref_id").or_else(|| data.pointer("/matches/0/ref_id")).and_then(Value::as_str).map(str::to_owned)
}

/// The text a `get` returned.
fn read_value(data: &Value) -> Option<String> {
    match data {
        Value::String(text) => Some(text.clone()),
        Value::Object(map) => ["value", "text", "result"].iter().find_map(|key| map.get(*key).and_then(Value::as_str)).map(str::to_owned),
        _ => None,
    }
}

enum Found {
    Ref(String),
    Missing,
    Failed(Outcome),
}

impl AgentDesktopBackend {
    pub(super) async fn perform(&self, target: Target, act: &Act, mode: Mode, session: &str) -> Result<Outcome> {
        let headed = mode == Mode::Foreground;
        let caps = super::capabilities(self.os, self.display);
        let context = OutcomeContext { headed, no_pixels: !caps.pixels };
        let native = self.native_of(target.window_id);
        match act {
            Act::Press { token, button: which, count } => {
                let command = match (which, count) {
                    (Button::Left, 0 | 1) => "click",
                    (Button::Left, 2) => "double-click",
                    (Button::Left, 3) => "triple-click",
                    (Button::Right, _) => "right-click",
                    (Button::Left, _) => return Ok(Outcome::refused("Clicks are limited to three at a time.", None)),
                    (Button::Middle, _) => {
                        return Ok(Outcome::refused(
                            "A middle click needs a pixel position. Use click_at on a screenshot.",
                            caps.pixels.then_some(Escalation::Pixel),
                        ));
                    }
                };
                if matches!(command, "double-click" | "triple-click") && !headed {
                    return Ok(Outcome::refused(
                        "Double and triple clicks use the real mouse, so they need foreground mode.",
                        Some(Escalation::Foreground),
                    ));
                }
                self.deliver(Cmd::new(command).session(session).headed(headed).timeout_ms(ACTION_MS).positional(token.clone()), context)
                    .await
            }
            Act::ClickAt { x, y, button: which, count, from_zoom } => {
                if !caps.pixels {
                    return Ok(Outcome::refused(
                        "This desktop has no pointer agents can aim, so pixel clicks are not available. Press elements instead.",
                        None,
                    ));
                }
                if !headed {
                    return Ok(Outcome::refused(
                        "A pixel click moves the real mouse, so it needs foreground mode.",
                        Some(Escalation::Foreground),
                    ));
                }
                let Some((geometry, zoom)) = self.captures.geometry(session, target.window_id) else {
                    return Ok(Outcome::refused("Take a screenshot of this window first, then click a position in it.", None));
                };
                let Some((screen_x, screen_y)) = capture::screen_point(&geometry, zoom.as_ref(), *x, *y, *from_zoom) else {
                    return Ok(Outcome::refused("That position is outside the latest screenshot of this window.", None));
                };
                // Raw coordinates never focus an app, so the window comes forward first.
                let focus = Cmd::new("focus-window").session(session).headed(true).flag("--window-id", &native);
                let focused = self.run(focus).await?;
                if focused.error.is_some() {
                    return outcome(&focused, context);
                }
                let click = Cmd::new("mouse-click")
                    .session(session)
                    .headed(true)
                    .switch(&format!("--xy={},{}", screen_x.round() as i64, screen_y.round() as i64))
                    .flag("--button", button(*which))
                    .flag("--count", (*count).clamp(1, 3));
                self.deliver(click, context).await
            }
            Act::Type { text, into } => self.type_text(&native, text, into.as_deref(), headed, context, session).await,
            Act::Set { token, value } => {
                self.deliver(
                    Cmd::new("set-value")
                        .session(session)
                        .headed(headed)
                        .timeout_ms(ACTION_MS)
                        .positional(token.clone())
                        .positional(value.clone()),
                    context,
                )
                .await
            }
            Act::Key { keys, on } => self.press_keys(&native, keys, on.as_deref(), headed, context, session).await,
            Act::Scroll { direction: toward, amount, on } => {
                if self.os == Os::Linux {
                    if self.wayland() {
                        return Ok(Outcome::refused(
                            "Scrolling is not available on Wayland. Move through the content with keys or press the elements you need.",
                            None,
                        ));
                    }
                    if !headed {
                        return Ok(Outcome::refused(
                            "Scrolling uses the real mouse wheel on Linux, so it needs foreground mode.",
                            Some(Escalation::Foreground),
                        ));
                    }
                }
                let area = match on {
                    Some(token) => token.clone(),
                    None => match self
                        .find(
                            Cmd::new("find")
                                .session(session)
                                .flag("--window-id", &native)
                                .flag("--role", "scrollarea")
                                .switch("--first")
                                .timeout_ms(ACTION_MS),
                            context,
                        )
                        .await?
                    {
                        Found::Ref(token) => token,
                        Found::Missing => return Ok(Outcome::refused("No scrollable area was found. Name the element to scroll.", None)),
                        Found::Failed(outcome) => return Ok(outcome),
                    },
                };
                let cmd = Cmd::new("scroll")
                    .session(session)
                    .headed(headed)
                    .flag("--direction", direction(*toward))
                    .flag("--amount", (*amount).max(1))
                    .timeout_ms(ACTION_MS)
                    .positional(area);
                self.deliver(cmd, context).await
            }
            Act::Menu { path } => self.walk_menu(target, &native, path, headed, context, session).await,
        }
    }

    /// Run an action command and judge it.
    async fn deliver(&self, cmd: Cmd, context: OutcomeContext) -> Result<Outcome> {
        let envelope = self.run(cmd).await?;
        outcome(&envelope, context)
    }

    async fn find(&self, cmd: Cmd, context: OutcomeContext) -> Result<Found> {
        let envelope = self.run(cmd).await?;
        if let Some(error) = &envelope.error {
            // Nothing matching is a plain answer here, not a failure.
            if matches!(error.code.as_str(), "ELEMENT_NOT_FOUND" | "WINDOW_NOT_FOUND") {
                return Ok(Found::Missing);
            }
            return Ok(Found::Failed(outcome(&envelope, context)?));
        }
        Ok(match found_ref(&envelope.data) {
            Some(token) => Found::Ref(token),
            None => Found::Missing,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn type_text(
        &self,
        native: &str,
        text: &str,
        into: Option<&str>,
        headed: bool,
        context: OutcomeContext,
        session: &str,
    ) -> Result<Outcome> {
        let windows_background = self.os == Os::Windows && !headed;
        let field = match into {
            Some(token) => token.to_owned(),
            None if windows_background => {
                return Ok(Outcome::refused(
                    "Typing needs the real keyboard on Windows. Pass into with the field to type in, or use foreground mode.",
                    Some(Escalation::Foreground),
                ));
            }
            None => {
                let cmd = Cmd::new("find")
                    .session(session)
                    .flag("--window-id", native)
                    .flag("--role", "textfield")
                    .flag("--state", "focused")
                    .switch("--first")
                    .timeout_ms(ACTION_MS);
                match self.find(cmd, context).await? {
                    Found::Ref(token) => token,
                    Found::Missing => return Ok(Outcome::refused("No text field has focus. Pass into with the field to type in.", None)),
                    Found::Failed(outcome) => return Ok(outcome),
                }
            }
        };
        if windows_background {
            let read = self.run(Cmd::new("get").session(session).flag("--property", "value").positional(field.clone())).await?;
            if read.error.is_some() {
                return outcome(&read, context);
            }
            let current = read_value(&read.data);
            let set = Cmd::new("set-value")
                .session(session)
                .timeout_ms(ACTION_MS)
                .positional(field)
                .positional(windows_typed_value(current.as_deref(), text));
            let mut result = self.deliver(set, context).await?;
            if matches!(result.effect, Effect::Confirmed | Effect::Unverifiable | Effect::Partial) {
                // The text landed through the value, not the keyboard: say so, and never claim more than the read-back.
                result.effect = if result.effect == Effect::Confirmed { Effect::Confirmed } else { Effect::Unverifiable };
                result.note = Some(WINDOWS_TYPE_NOTE.to_owned());
            }
            return Ok(result);
        }
        let timeout = (5_000 + 30 * text.chars().count() as u64).min(15_000);
        self.deliver(Cmd::new("type").session(session).headed(headed).timeout_ms(timeout).positional(field).positional(text), context).await
    }

    async fn press_keys(
        &self,
        native: &str,
        keys: &[String],
        on: Option<&str>,
        headed: bool,
        context: OutcomeContext,
        session: &str,
    ) -> Result<Outcome> {
        let chord = combo(self.os, keys);
        if self.os == Os::Windows {
            if !headed {
                return Ok(Outcome::refused(
                    "Keys reach whichever window is in front on Windows, so they need foreground mode.",
                    Some(Escalation::Foreground),
                ));
            }
            // `press` has no per-window path on Windows (a scoped press is APP_NOT_FOUND):
            // bring the window forward, then send to the foreground.
            let focus = self.run(Cmd::new("focus-window").session(session).headed(true).flag("--window-id", native)).await?;
            if focus.error.is_some() {
                return outcome(&focus, context);
            }
            if let Some(token) = on {
                let focus = self.run(Cmd::new("focus").session(session).headed(true).timeout_ms(ACTION_MS).positional(token)).await?;
                if focus.error.is_some() {
                    return outcome(&focus, context);
                }
            }
            return self.deliver(Cmd::new("press").session(session).headed(true).positional(chord), context).await;
        }
        if let Some(token) = on
            && (headed || self.os == Os::Mac)
        {
            let focus = self.run(Cmd::new("focus").session(session).headed(headed).timeout_ms(ACTION_MS).positional(token)).await?;
            if focus.error.is_some() {
                return outcome(&focus, context);
            }
        }
        self.deliver(Cmd::new("press").session(session).headed(headed).flag("--window-id", native).positional(chord), context).await
    }

    /// Walk a menu bar path (design §2): macOS through the `menubar` surface,
    /// Windows through the window's own menu bar items and then the `menu` surface.
    async fn walk_menu(
        &self,
        target: Target,
        native: &str,
        path: &[String],
        headed: bool,
        context: OutcomeContext,
        session: &str,
    ) -> Result<Outcome> {
        if self.os == Os::Linux || self.os == Os::Other {
            return Ok(Outcome::refused(
                "Menu steps are not available on Linux. Press the menu's items instead: observe lists them.",
                None,
            ));
        }
        let Some((first, rest)) = path.split_first() else { return Ok(Outcome::refused("The menu path is empty.", None)) };
        let app = self.known(target.window_id).map(|known| known.app).unwrap_or_default();
        let mut last: Option<Outcome> = None;
        // The menu bar item that opened the menu, pressed again to close it if
        // a later title is missing, so a failed walk never leaves a menu open.
        let mut opener: Option<String> = None;
        for (index, title) in std::iter::once(first).chain(rest.iter()).enumerate() {
            let cmd = if index == 0 && self.os == Os::Windows {
                Cmd::new("find").session(session).flag("--window-id", native).flag("--role", "menuitem")
            } else if index == 0 {
                Cmd::new("find").session(session).flag("--app", &app).flag("--surface", "menubar")
            } else {
                Cmd::new("find").session(session).flag("--app", &app).flag("--surface", "menu")
            }
            .flag("--name", title)
            .switch("--exact")
            .switch("--first")
            .timeout_ms(ACTION_MS);
            let token = match self.find(cmd, context).await? {
                Found::Ref(token) => token,
                Found::Missing if index == 0 && self.os == Os::Windows => {
                    return Ok(Outcome::refused("This app has no menu bar. Press its menu button instead.", None));
                }
                Found::Missing => {
                    self.close_menu(&app, opener.as_deref(), headed, session).await;
                    return Ok(Outcome::refused(note("ELEMENT_NOT_FOUND", &format!("No menu item named {title:?}.")), None));
                }
                Found::Failed(outcome) => {
                    self.close_menu(&app, opener.as_deref(), headed, session).await;
                    return Ok(outcome);
                }
            };
            if index == 0 {
                opener = Some(token.clone());
            }
            let click =
                self.deliver(Cmd::new("click").session(session).headed(headed).timeout_ms(ACTION_MS).positional(token), context).await?;
            let is_last = index == rest.len();
            if !is_last {
                if click.effect == Effect::Refused || click.stale {
                    return Ok(click);
                }
                // The next level exists once the menu is open.
                let wait = Cmd::new("wait").session(session).switch("--menu").flag("--app", &app).flag("--timeout", 2_000);
                let _ = self.run(wait).await;
            }
            last = Some(click);
        }
        Ok(last.unwrap_or_else(|| Outcome::refused("The menu path is empty.", None)))
    }

    /// Best effort: when a menu is still open, press the menu bar item that
    /// opened it again, which closes it. A closed menu is left alone, since a
    /// press would open it.
    async fn close_menu(&self, app: &str, opener: Option<&str>, headed: bool, session: &str) {
        let Some(opener) = opener else { return };
        let Ok(envelope) = self.run(Cmd::new("list-surfaces").flag("--app", app)).await else { return };
        let Ok(data) = envelope.into_data() else { return };
        if !menu_open(&data) {
            return;
        }
        let _ = self.run(Cmd::new("click").session(session).headed(headed).timeout_ms(ACTION_MS).positional(opener.to_owned())).await;
    }
}

/// Whether a `list-surfaces` answer lists an open menu.
fn menu_open(data: &serde_json::Value) -> bool {
    data.get("surfaces").and_then(serde_json::Value::as_array).is_some_and(|surfaces| {
        surfaces.iter().any(|surface| {
            ["type", "kind", "surface"].iter().any(|key| surface.get(*key).and_then(serde_json::Value::as_str) == Some("menu"))
                || surface.get("menu").is_some()
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_open_menu_is_closed() {
        assert!(!menu_open(&serde_json::json!({"pid": 1, "surfaces": []})));
        assert!(menu_open(&serde_json::json!({"surfaces": [{"type": "menu", "item_count": 4}]})));
        assert!(!menu_open(&serde_json::json!({"surfaces": [{"type": "window"}]})));
    }

    #[test]
    fn launch_arguments_follow_each_platforms_identifier_rules() {
        assert_eq!(launch_arg(Os::Mac, "Calculator", Some("com.apple.calculator")), "com.apple.calculator");
        assert_eq!(launch_arg(Os::Mac, "Calculator", None), "Calculator");
        // Nothing resolves here, so the name passes through and agent-desktop's error says what it wants.
        assert_eq!(launch_arg(Os::Windows, "No Such App 7", None), "No Such App 7");
    }

    #[test]
    fn a_launched_apps_windows_match_by_name_not_pid() {
        // calc.exe starts CalculatorApp.exe (recorded on Windows 11).
        assert!(same_app("CalculatorApp.exe", "Calculator"));
        assert!(same_app("CalculatorApp.exe", "calculatorapp"));
        assert!(same_app("notepad.exe", "notepad"));
        assert!(same_app("gnome-calculator", "gnome-calculator"));
        assert!(!same_app("notepad.exe", "calc.exe"));
        assert!(!same_app("", "calc"));
    }

    #[test]
    fn chords_use_the_platforms_names() {
        let keys = |parts: &[&str]| parts.iter().map(|part| part.to_string()).collect::<Vec<_>>();
        assert_eq!(combo(Os::Mac, &keys(&["cmd", "s"])), "cmd+s");
        assert_eq!(combo(Os::Windows, &keys(&["ctrl", "shift", "p"])), "ctrl+shift+p");
        assert_eq!(combo(Os::Windows, &keys(&["win", "d"])), "meta+d");
        assert_eq!(combo(Os::Linux, &keys(&["super", "a"])), "meta+a");
        assert_eq!(combo(Os::Linux, &keys(&["return"])), "return");
    }

    #[test]
    fn windows_typing_appends_to_the_current_text() {
        assert_eq!(windows_typed_value(Some("12*34"), "+1"), "12*34+1");
        assert_eq!(windows_typed_value(None, "hello"), "hello");
        assert_eq!(windows_typed_value(Some(""), ""), "");
    }

    #[test]
    fn found_refs_and_values_read_both_envelope_shapes() {
        let find7: serde_json::Value = serde_json::from_str(include_str!("fixtures/windows/find7.json")).unwrap();
        assert_eq!(found_ref(&find7["data"]).as_deref(), Some("@s27jc6bzpvdqkh:e1"));
        assert_eq!(found_ref(&serde_json::json!({"matches": [{"ref_id": "@s1:e4"}]})).as_deref(), Some("@s1:e4"));
        assert_eq!(found_ref(&serde_json::json!({"matches": []})), None);
        assert_eq!(read_value(&serde_json::json!({"value": "abc"})).as_deref(), Some("abc"));
        assert_eq!(read_value(&serde_json::json!("abc")).as_deref(), Some("abc"));
        assert_eq!(read_value(&serde_json::json!({"value": null})), None);
    }
}
