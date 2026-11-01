//! CuaDriver's `get_window_state` response, parsed into the neutral
//! [`Snapshot`] the tools read. Roles leave here already mapped by
//! [`neutral_role`], so the digest knows nothing of `AX…` names.

use std::collections::HashSet;

use serde_json::Value;

use crate::computer::backend::neutral_role;
use crate::computer::digest::{Element, Snapshot, one_line};

fn element_from_value(value: &Value) -> Option<Element> {
    let role = value.get("role").and_then(Value::as_str)?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
    let label = text("label").or_else(|| text("title")).or_else(|| text("description")).or_else(|| text("help")).unwrap_or_default();
    let bounds = value.get("frame").and_then(Value::as_object).and_then(|frame| {
        let number = |key: &str| frame.get(key).and_then(Value::as_f64);
        Some((number("x")?, number("y")?, number("w")?, number("h")?))
    });
    let rendered = match value.get("frame") {
        None => true,
        Some(Value::Object(frame)) => {
            let size = |key: &str| frame.get(key).and_then(Value::as_f64).unwrap_or(0.0);
            size("w") > 1.0 && size("h") > 1.0
        }
        Some(_) => false,
    };
    Some(Element {
        token: text("element_token"),
        role: neutral_role(role),
        label: one_line(&label),
        value: match value.get("value") {
            Some(Value::String(text)) if !text.trim().is_empty() => Some(one_line(text)),
            Some(Value::Number(number)) => Some(number.to_string()),
            Some(Value::Bool(flag)) => Some(flag.to_string()),
            _ => None,
        },
        enabled: value.get("enabled").and_then(Value::as_bool),
        selected: value.get("selected").and_then(Value::as_bool),
        has_actions: value.get("actions").and_then(Value::as_array).is_some_and(|actions| !actions.is_empty()),
        rendered,
        in_menu_bar: false,
        bounds,
    })
}

pub(super) fn parse_snapshot(structured: &Value) -> Snapshot {
    let raw = structured.get("elements").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut parsed: Vec<(Option<i64>, Option<i64>, Element)> = raw
        .iter()
        .filter_map(|value| {
            element_from_value(value).map(|element| {
                (value.get("element_index").and_then(Value::as_i64), value.get("parent_index").and_then(Value::as_i64), element)
            })
        })
        .collect();
    // Mark everything below a menu bar; parents precede children.
    let mut menu_bar = HashSet::new();
    for (index, parent, element) in &mut parsed {
        let below = parent.is_some_and(|parent| menu_bar.contains(&parent));
        if below || element.role == "menubar" {
            element.in_menu_bar = true;
            if let Some(index) = index {
                menu_bar.insert(*index);
            }
        }
    }
    let text = |key: &str| structured.get(key).and_then(Value::as_str).map(str::to_owned);
    Snapshot::new(
        parsed.into_iter().map(|(_, _, element)| element).collect(),
        structured.get("tree_markdown").and_then(Value::as_str).map(markdown_texts).unwrap_or_default(),
        structured.get("truncated").and_then(Value::as_bool).unwrap_or(false),
        text("degraded_reason"),
        text("window_title"),
        text("app_name"),
    )
}

/// Unindexed rows of `tree_markdown` that carry text, e.g.
/// `    - AXStaticText = "408" (Edit field)`. Menu bar rows are skipped.
fn markdown_texts(markdown: &str) -> Vec<Element> {
    let mut rows = Vec::new();
    let mut menu_bar_indent: Option<usize> = None;
    for line in markdown.lines() {
        let indent = line.len() - line.trim_start().len();
        let Some(rest) = line.trim_start().strip_prefix("- ") else { continue };
        if menu_bar_indent.is_some_and(|menu| indent <= menu) {
            menu_bar_indent = None;
        }
        let rest = match rest.strip_prefix('[') {
            Some(indexed) => {
                // Indexed rows come from structured elements; only track the menu bar.
                if indexed.split_once("] ").is_some_and(|(_, row)| row.starts_with("AXMenuBar ") || row == "AXMenuBar") {
                    menu_bar_indent = Some(indent);
                }
                continue;
            }
            None => rest,
        };
        if menu_bar_indent.is_some() {
            continue;
        }
        let (role, mut rest) = rest.split_once(' ').unwrap_or((rest, ""));
        if !role.starts_with("AX")
            || !matches!(role, "AXStaticText" | "AXHeading" | "AXText" | "AXValueIndicator" | "AXLevelIndicator" | "AXProgressIndicator")
        {
            continue;
        }
        let mut title = None;
        let mut value = None;
        let mut description = None;
        rest = rest.trim_start();
        if rest.starts_with('"') {
            let (text, remainder) = quoted(rest);
            title = Some(text);
            rest = remainder.trim_start();
        }
        if let Some(after) = rest.strip_prefix("= ") {
            if after.starts_with('"') {
                let (text, remainder) = quoted(after);
                value = Some(text);
                rest = remainder.trim_start();
            } else {
                let end = after.find(" (").unwrap_or(after.len());
                value = Some(after[..end].to_owned());
                rest = after[end..].trim_start();
            }
        }
        if let Some(after) = rest.strip_prefix('(')
            && let Some(end) = after.rfind(')')
        {
            description = Some(after[..end].to_owned());
        }
        let label = description.clone().or(title.clone()).unwrap_or_default();
        let value = value.or(if description.is_some() { title } else { None });
        if label.trim().is_empty() && value.as_deref().is_none_or(|value| value.trim().is_empty()) {
            continue;
        }
        rows.push(Element {
            token: None,
            role: neutral_role(role),
            label: one_line(&label),
            value: value.map(|value| one_line(&value)).filter(|value| !value.is_empty()),
            enabled: None,
            selected: None,
            has_actions: false,
            rendered: true,
            in_menu_bar: false,
            bounds: None,
        });
    }
    rows
}

/// Split a leading JSON-style quoted string from the rest of the line.
fn quoted(text: &str) -> (String, &str) {
    let mut out = String::new();
    let mut escaped = false;
    for (index, character) in text.char_indices().skip(1) {
        if escaped {
            out.push(match character {
                'n' => '\n',
                't' => '\t',
                other => other,
            });
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            return (out, &text[index + 1..]);
        } else {
            out.push(character);
        }
    }
    (out, "")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::computer::digest::{DEFAULT_LIMIT, DigestOptions, RefTable, diff, render};

    fn snapshot(elements: Value) -> Snapshot {
        parse_snapshot(&json!({ "snapshot_id": "s00000001", "elements": elements }))
    }

    fn options() -> DigestOptions<'static> {
        DigestOptions { query: None, limit: DEFAULT_LIMIT, include_text: false }
    }

    #[test]
    fn ax_roles_reach_the_digest_in_the_neutral_vocabulary() {
        let first = snapshot(json!([
            {"element_index":0,"element_token":"s1:0","role":"AXWindow","label":"Notes"},
            {"element_index":1,"element_token":"s1:1","role":"AXButton","label":"New Note","actions":["AXPress"]},
            {"element_index":2,"element_token":"s1:2","role":"AXTextArea","label":"Body","value":"eggs,\n milk"},
            {"element_index":3,"element_token":"s1:3","role":"AXPopUpButton","label":"Sort"},
            {"element_index":4,"element_token":"s1:4","role":"AXSecureTextField","label":"Password"},
        ]));
        let (lines, _, _) = render(&first, &mut RefTable::default(), &options());
        assert_eq!(
            lines,
            vec!["@1 button \"New Note\"", "@2 textfield \"Body\" = \"eggs, milk\"", "@3 combobox \"Sort\"", "@4 password \"Password\""]
        );
        assert_eq!(first.elements[1].1.token.as_deref(), Some("s1:1"));
    }

    #[test]
    fn closed_menus_and_unrendered_rows_stay_out_of_the_digest() {
        let snapshot = snapshot(json!([
            {"element_index":0,"role":"AXButton","label":"Equals","frame":{"x":1,"y":1,"w":48,"h":48}},
            {"element_index":1,"role":"AXButton","label":"Offscreen row","frame":{"x":1,"y":1,"w":200,"h":1}},
            {"element_index":2,"role":"AXMenuBar","frame":{"x":0,"y":0,"w":1440,"h":30}},
            {"element_index":3,"role":"AXMenuBarItem","label":"Apple","parent_index":2,"frame":null},
            {"element_index":4,"role":"AXMenuItem","label":"Restart…","parent_index":3,"frame":{"x":1,"y":1,"w":200,"h":20}},
            {"element_index":5,"role":"AXMenuItem","label":"Copy","frame":{"x":1,"y":1,"w":200,"h":20}},
        ]));
        let (lines, _, _) = render(&snapshot, &mut RefTable::default(), &options());
        assert_eq!(lines, vec!["@1 button \"Equals\"", "@2 menuitem \"Copy\""]);
    }

    #[test]
    fn markdown_text_rows_show_results_and_changes() {
        let markdown = |display: &str| {
            format!(
                "- [0] AXWindow \"Calculator\" [id=main actions=[raise]]\n    - AXStaticText = \"{display}\" (Edit field)\n    - [1] AXButton (Equals) [id=Equals actions=[press]]\n    - AXGroup\n- [2] AXMenuBar [actions=[cancel]]\n  - AXStaticText = \"hidden\"\n"
            )
        };
        let parse = |display: &str| {
            parse_snapshot(&json!({
                "elements": [{"element_index":1,"element_token":"s:1","role":"AXButton","label":"Equals","actions":["AXPress"]}],
                "tree_markdown": markdown(display),
            }))
        };
        let before = parse("12");
        assert_eq!(before.texts.len(), 1);
        let mut refs = RefTable::default();
        let (lines, _, _) = render(&before, &mut refs, &options());
        assert_eq!(lines, vec!["@1 button \"Equals\"", "text \"Edit field\" = \"12\""]);
        let after = parse("408");
        assert!(after.contains_label("408"));
        assert_eq!(diff(&before, &after, &mut refs), vec!["~text \"Edit field\" = \"408\""]);
    }

    #[test]
    fn quoted_strings_unescape() {
        assert_eq!(quoted(r#""say \"hi\"" rest"#), ("say \"hi\"".to_owned(), " rest"));
        let rows = markdown_texts("  - AXHeading \"Inbox\"\n  - AXStaticText = \"3 unread\"\n");
        assert_eq!(
            rows.iter().map(|row| (row.label.as_str(), row.value.as_deref())).collect::<Vec<_>>(),
            vec![("Inbox", None), ("", Some("3 unread"))]
        );
    }

    #[test]
    fn frames_become_bounds_for_the_live_view_marker() {
        let snapshot = snapshot(json!([
            {"role":"AXWindow","label":"Calculator","frame":{"x":100,"y":200,"w":200,"h":400}},
            {"role":"AXButton","label":"Equals","frame":{"x":240,"y":540,"w":40,"h":40}},
        ]));
        let identity = crate::computer::digest::Identity { role: "button".into(), label: "Equals".into(), ordinal: 0 };
        assert_eq!(snapshot.point_of(&identity), Some([0.8, 0.9]));
    }
}
