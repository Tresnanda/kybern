//! `snapshot` output → a [`Snapshot`] with neutral roles.
//!
//! One full (not `-i`) pass is read, so the same tree gives the controls
//! (nodes with a `ref_id`) and the static text rows (nodes without one). The
//! shape comes from the core skill:
//! `data: {app, window:{id,title}, snapshot_id, complete, tree:{role, name,
//! states, bounds?, children:[{ref_id?, role, name, value?, states, …}]}}`.

use serde_json::Value;

use super::super::backend::neutral_role;
use super::super::digest::{Element, Snapshot};

const MAX_DEPTH: usize = 64;

pub(crate) struct ParsedTree {
    pub snapshot: Snapshot,
    /// The window's screen rectangle, when the tree carried bounds.
    pub window_bounds: Option<(f64, f64, f64, f64)>,
}

pub(crate) fn parse_snapshot(data: &Value) -> ParsedTree {
    let mut walk = Walk::default();
    if let Some(tree) = data.get("tree") {
        walk.visit(tree, 0, false, true, None);
    }
    let window_bounds = walk.elements.iter().find(|element| element.role == "window").and_then(|element| element.bounds);
    let truncated = data.get("complete").and_then(Value::as_bool).is_some_and(|complete| !complete)
        || data.get("truncated").and_then(Value::as_bool) == Some(true);
    let empty = !walk.elements.iter().any(|element| element.token.is_some()) && walk.texts.is_empty();
    let degraded =
        empty.then(|| "The window exposed no controls or text; the app may still be loading or may not support accessibility.".to_owned());
    let title = data.pointer("/window/title").and_then(Value::as_str).map(str::to_owned).filter(|title| !title.is_empty());
    let app_name = data.get("app").and_then(Value::as_str).map(str::to_owned);
    ParsedTree { snapshot: Snapshot::new(walk.elements, walk.texts, truncated, degraded, title, app_name), window_bounds }
}

#[derive(Default)]
struct Walk {
    elements: Vec<Element>,
    texts: Vec<Element>,
}

impl Walk {
    fn visit(&mut self, node: &Value, depth: usize, in_menu_bar: bool, is_root: bool, control: Option<&str>) {
        if depth > MAX_DEPTH {
            return;
        }
        let raw_role = node.get("role").and_then(Value::as_str).unwrap_or("group");
        // Windows prints a menu bar as role "menu" with role_description "menu bar".
        let role = if node.get("role_description").and_then(Value::as_str) == Some("menu bar") {
            "menubar".to_owned()
        } else {
            neutral_role(raw_role)
        };
        let states = states(node);
        let has = |state: &str| states.iter().any(|candidate| candidate == state);
        let bounds = bounds(node.get("bounds"));
        let text = |key: &str| node.get(key).and_then(Value::as_str).map(one_line).filter(|text| !text.is_empty());
        let label = text("name").or_else(|| text("title")).or_else(|| text("description")).unwrap_or_default();
        let value = match node.get("value") {
            Some(Value::String(text)) if !text.trim().is_empty() => Some(one_line(text)),
            Some(Value::Number(number)) => Some(number.to_string()),
            Some(Value::Bool(flag)) => Some(flag.to_string()),
            _ => None,
        };
        let token = node.get("ref_id").and_then(Value::as_str).map(str::to_owned);
        let offscreen = has("offscreen") || has("hidden") || has("invisible") || has("minimized");
        let sized = bounds.is_none_or(|(_, _, width, height)| width > 1.0 && height > 1.0);
        // Icon-font glyphs (Segoe MDL2 and the like) are private-use characters, not words.
        let label = if is_glyph_only(&label) { String::new() } else { label };
        let element = Element {
            has_actions: token.is_some(),
            token,
            role: role.clone(),
            label,
            value,
            enabled: if has("disabled") {
                Some(false)
            } else if has("enabled") {
                Some(true)
            } else {
                None
            },
            selected: (has("selected") || has("checked") || has("pressed") || has("on")).then_some(true),
            rendered: !offscreen && sized,
            in_menu_bar: in_menu_bar || role == "menubar",
            bounds,
        };
        let below_menu_bar = element.in_menu_bar;
        // A control's own caption (GTK and Qt buttons hold their label as a
        // text child) is already its label; listing it again is noise.
        let repeats_control =
            control.is_some_and(|control| !control.is_empty() && (element.label == control || element.value.as_deref() == Some(control)));
        let child_control = if element.token.is_some() && !matches!(element.role.as_str(), "text" | "heading" | "progress") {
            Some(element.label.clone())
        } else {
            control.map(str::to_owned)
        };
        if is_root || element.role == "window" {
            // The window element carries the bounds the live view marks clicks against.
            if is_root || self.elements.iter().all(|existing| existing.role != "window") {
                self.elements.push(Element { token: None, has_actions: false, role: "window".into(), ..element });
            }
        } else if matches!(element.role.as_str(), "text" | "heading" | "progress") {
            // Text is read, not pressed, even where the platform gives it a ref (a calculator's display).
            if element.rendered && (!element.label.is_empty() || element.value.is_some()) && !below_menu_bar && !repeats_control {
                self.texts.push(Element { token: None, has_actions: false, bounds: None, ..element });
            }
        } else if element.token.is_some() {
            self.elements.push(element);
        } else if element.role == "menubar"
            || element.role == "menu"
            || element.role == "sheet"
            || element.role == "dialog"
            || element.role == "alert"
            || element.role == "popover"
        {
            // Containers keep a row when named, so the digest can show them.
            if !element.label.is_empty() {
                self.elements.push(element);
            }
        }
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            for child in children {
                self.visit(child, depth + 1, below_menu_bar, false, child_control.as_deref());
            }
        }
    }
}

fn states(node: &Value) -> Vec<String> {
    node.get("states")
        .and_then(Value::as_array)
        .map(|states| states.iter().filter_map(Value::as_str).map(|state| state.to_ascii_lowercase()).collect())
        .unwrap_or_default()
}

/// `{x,y,width,height}`, `{x,y,w,h}` or `[x,y,w,h]` → `(x, y, w, h)`.
pub(crate) fn bounds(value: Option<&Value>) -> Option<(f64, f64, f64, f64)> {
    match value? {
        Value::Object(map) => {
            let number = |keys: &[&str]| keys.iter().find_map(|key| map.get(*key).and_then(Value::as_f64));
            Some((number(&["x"])?, number(&["y"])?, number(&["width", "w"])?, number(&["height", "h"])?))
        }
        Value::Array(items) if items.len() == 4 => {
            let number = |index: usize| items[index].as_f64();
            Some((number(0)?, number(1)?, number(2)?, number(3)?))
        }
        _ => None,
    }
}

fn is_glyph_only(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|character| ('\u{E000}'..='\u{F8FF}').contains(&character) || character.is_whitespace())
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Transcribed from the core skill's snapshot example, extended with the
    /// roles a calculator window shows on Windows (UIA names).
    fn calculator() -> Value {
        json!({
            "app": "CalculatorApp.exe", "window": {"id": "w-4521", "title": "Calculator"},
            "ref_count": 4, "snapshot_id": "s8f3k2p9", "complete": true,
            "tree": { "role": "window", "name": "Calculator", "bounds": {"x": 100, "y": 50, "width": 320, "height": 500}, "children": [
                { "role": "menubar", "name": "", "children": [
                    { "ref_id": "@s8f3k2p9:e1", "role": "menuitem", "name": "File", "states": ["enabled"] } ] },
                { "role": "group", "name": "", "children": [
                    { "role": "text", "name": "Display is 0", "value": "0" },
                    { "role": "Heading", "name": "Standard" },
                    { "ref_id": "@s8f3k2p9:e2", "role": "button", "name": "Five", "states": ["enabled", "focused"], "bounds": {"x": 110, "y": 300, "width": 70, "height": 50} },
                    { "ref_id": "@s8f3k2p9:e3", "role": "Button", "name": "Plus", "states": ["disabled"] },
                    { "ref_id": "@s8f3k2p9:e4", "role": "edit", "name": "Search", "value": "abc", "states": ["enabled", "offscreen"] },
                    { "role": "group", "name": "" }
                ] } ] }
        })
    }

    #[test]
    fn controls_texts_and_the_window_come_out_in_document_order() {
        let parsed = parse_snapshot(&calculator());
        let snapshot = &parsed.snapshot;
        assert_eq!(parsed.window_bounds, Some((100.0, 50.0, 320.0, 500.0)));
        assert_eq!(snapshot.title.as_deref(), Some("Calculator"));
        assert_eq!(snapshot.app_name.as_deref(), Some("CalculatorApp.exe"));
        assert!(!snapshot.truncated);
        assert!(snapshot.degraded.is_none());

        let roles: Vec<(&str, &str)> =
            snapshot.elements.iter().map(|(_, element)| (element.role.as_str(), element.label.as_str())).collect();
        assert_eq!(
            roles,
            [("window", "Calculator"), ("menuitem", "File"), ("button", "Five"), ("button", "Plus"), ("textfield", "Search")]
        );
        let tokens: Vec<_> = snapshot.elements.iter().filter_map(|(_, element)| element.token.as_deref()).collect();
        assert_eq!(tokens, ["@s8f3k2p9:e1", "@s8f3k2p9:e2", "@s8f3k2p9:e3", "@s8f3k2p9:e4"]);

        let file = &snapshot.elements.iter().find(|(_, element)| element.label == "File").unwrap().1;
        assert!(file.in_menu_bar);
        let five = &snapshot.elements.iter().find(|(_, element)| element.label == "Five").unwrap().1;
        assert_eq!((five.enabled, five.rendered, five.bounds), (Some(true), true, Some((110.0, 300.0, 70.0, 50.0))));
        let plus = &snapshot.elements.iter().find(|(_, element)| element.label == "Plus").unwrap().1;
        assert_eq!(plus.enabled, Some(false));
        let search = &snapshot.elements.iter().find(|(_, element)| element.label == "Search").unwrap().1;
        assert!(!search.rendered);
        assert_eq!(search.value.as_deref(), Some("abc"));

        let texts: Vec<_> =
            snapshot.texts.iter().map(|(_, element)| (element.role.as_str(), element.label.as_str(), element.value.as_deref())).collect();
        assert_eq!(texts, [("text", "Display is 0", Some("0")), ("heading", "Standard", None)]);
    }

    #[test]
    fn a_real_windows_calculator_tree_reads_like_the_mac_one() {
        let envelope: Value = serde_json::from_str(include_str!("fixtures/windows/snapfull.json")).unwrap();
        let parsed = parse_snapshot(&envelope["data"]);
        let snapshot = &parsed.snapshot;
        assert_eq!(snapshot.app_name.as_deref(), Some("CalculatorApp.exe"));
        assert_eq!(snapshot.title.as_deref(), Some("Calculator"));
        assert_eq!(snapshot.elements[0].1.role, "window");
        let controls = snapshot.elements.iter().filter(|(_, element)| element.token.is_some()).count();
        // 39 refs, minus the display text which is read, not pressed.
        assert_eq!(controls, 38);
        let system = snapshot.elements.iter().find(|(_, element)| element.label == "System" && element.token.is_some()).unwrap();
        assert_eq!(system.1.role, "menuitem");
        assert!(snapshot.elements.iter().any(|(_, element)| element.role == "menubar" && element.in_menu_bar));
        assert!(system.1.in_menu_bar);
        let clear_memory = snapshot.elements.iter().find(|(_, element)| element.label == "Clear all memory").unwrap();
        assert_eq!(clear_memory.1.enabled, Some(false));
        // The display is a text row; icon glyphs and off-screen text are not.
        let texts: Vec<&str> = snapshot.texts.iter().map(|(_, element)| element.label.as_str()).collect();
        assert!(texts.contains(&"Display is 0"), "{texts:?}");
        assert!(!texts.iter().any(|text| text.contains('\u{e81c}')), "{texts:?}");
        assert!(!texts.contains(&"Expression is "), "{texts:?}");
    }

    #[test]
    fn a_real_macos_calculator_tree_has_the_window_bounds_and_its_result_texts() {
        let envelope: Value = serde_json::from_str(include_str!("fixtures/macos/snapshot_calculator.json")).unwrap();
        let parsed = parse_snapshot(&envelope["data"]);
        assert_eq!(parsed.window_bounds, Some((269.0, 416.0, 230.0, 408.0)));
        let snapshot = &parsed.snapshot;
        assert_eq!(snapshot.app_name.as_deref(), Some("Calculator"));
        let buttons: Vec<&str> =
            snapshot.elements.iter().filter(|(_, element)| element.role == "button").map(|(_, element)| element.label.as_str()).collect();
        assert_eq!(buttons.len(), 25);
        assert!(buttons.contains(&"All Clear") && buttons.contains(&"7"));
        let seven = snapshot.elements.iter().find(|(_, element)| element.label == "7").unwrap();
        assert!(seven.1.token.as_deref().unwrap().starts_with("@s3u7gnjn6jgyyw:e"));
        assert!(seven.1.bounds.is_some() && seven.1.rendered);
        // The expression and the result are static text, read rather than pressed.
        let texts: Vec<_> = snapshot.texts.iter().map(|(_, element)| (element.label.as_str(), element.value.as_deref())).collect();
        assert_eq!(texts, [("7 + 5", Some("7 + 5")), ("12", Some("12"))]);
        assert!(snapshot.contains_label("12"));
    }

    #[test]
    fn a_real_gnome_calculator_tree_has_no_bounds_and_no_window_name_loss() {
        let envelope: Value = serde_json::from_str(include_str!("fixtures/linux/snapfull.json")).unwrap();
        let parsed = parse_snapshot(&envelope["data"]);
        assert_eq!(parsed.window_bounds, None);
        let snapshot = &parsed.snapshot;
        assert_eq!(snapshot.title.as_deref(), Some("Calculator"));
        let field = snapshot.elements.iter().find(|(_, element)| element.role == "textfield").unwrap();
        assert_eq!(field.1.token.as_deref(), Some("@sxm12cnavzlhe:e2"));
        let seven = snapshot.elements.iter().find(|(_, element)| element.label == "7").unwrap();
        assert_eq!(seven.1.role, "button");
        assert!(seven.1.rendered);
        // The buttons' inner labels repeat the button name, so they are not text rows.
        assert!(!snapshot.texts.iter().any(|(_, element)| element.label == "7"));
    }

    #[test]
    fn an_incomplete_read_is_truncated_and_an_empty_one_is_degraded() {
        let mut data = calculator();
        data["complete"] = json!(false);
        assert!(parse_snapshot(&data).snapshot.truncated);

        let empty = json!({"app": "Slack", "window": {"id": "w-9", "title": "Slack"}, "complete": true, "tree": {"role": "window", "name": "Slack", "children": []}});
        let parsed = parse_snapshot(&empty);
        assert!(parsed.snapshot.degraded.is_some());
        assert_eq!(parsed.snapshot.elements.len(), 1);
        assert_eq!(parsed.snapshot.elements[0].1.role, "window");
    }

    #[test]
    fn bounds_accept_the_shapes_agent_desktop_prints() {
        assert_eq!(bounds(Some(&json!({"x": 1, "y": 2, "width": 3, "height": 4}))), Some((1.0, 2.0, 3.0, 4.0)));
        assert_eq!(bounds(Some(&json!({"x": 1, "y": 2, "w": 3, "h": 4}))), Some((1.0, 2.0, 3.0, 4.0)));
        assert_eq!(bounds(Some(&json!([1, 2, 3, 4]))), Some((1.0, 2.0, 3.0, 4.0)));
        assert_eq!(bounds(Some(&json!("nope"))), None);
        assert_eq!(bounds(None), None);
    }
}

#[cfg(test)]
mod caption_tests {
    use serde_json::json;

    #[test]
    fn a_buttons_own_caption_is_not_listed_again_as_text() {
        let data = json!({"tree": {"role": "window", "name": "Calculator", "children": [
            {"role": "button", "name": "7", "ref_id": "@s1:e1", "children": [{"role": "label", "name": "7"}]},
            {"role": "statictext", "name": "12"},
        ]}});
        let parsed = super::parse_snapshot(&data);
        let texts: Vec<_> = parsed.snapshot.texts.iter().map(|(_, element)| element.label.clone()).collect();
        assert_eq!(texts, vec!["12".to_owned()]);
        assert!(parsed.snapshot.elements.iter().any(|(_, element)| element.label == "7" && element.token.is_some()));
    }
}
