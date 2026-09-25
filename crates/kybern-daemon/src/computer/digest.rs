//! Compact window digests with stable references.
//!
//! CuaDriver element tokens are bound to one snapshot. Kybern gives each
//! element a short `@N` reference bound to its identity (role, label and
//! duplicate ordinal) so the model can keep using a reference across
//! observations, and resolves it to the newest driver token when acting.

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

const LABEL_CHARS: usize = 60;
const VALUE_CHARS: usize = 40;
const LONG_VALUE_CHARS: usize = 200;
pub(crate) const DEFAULT_LIMIT: usize = 80;
pub(crate) const MAX_LIMIT: usize = 400;
const MAX_DIFF_LINES: usize = 40;
const DEFAULT_TEXT_ROWS: usize = 12;

/// Roles the model can act on. Static text is listed only with `text:true`.
const ACTIONABLE_ROLES: &[&str] = &[
    "button",
    "checkbox",
    "radiobutton",
    "popupbutton",
    "menubutton",
    "combobox",
    "textfield",
    "securetextfield",
    "textarea",
    "searchfield",
    "link",
    "menuitem",
    "menubaritem",
    "tab",
    "slider",
    "incrementor",
    "stepper",
    "disclosuretriangle",
    "cell",
    "row",
    "outlinerow",
    "colorwell",
    "datefield",
    "switch",
    "toggle",
    "segmentedcontrol",
];
const CONTAINER_ROLES: &[&str] = &["sheet", "dialog", "alert", "popover", "menu", "list", "table", "outline", "tabgroup", "webarea"];

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Element {
    pub token: Option<String>,
    pub role: String,
    pub label: String,
    pub value: Option<String>,
    pub enabled: Option<bool>,
    pub selected: Option<bool>,
    pub has_actions: bool,
    /// On screen with a usable frame. Closed menus report no frame and
    /// virtualized rows report a 1-point frame.
    pub rendered: bool,
    /// Part of the app's menu bar, which `menu` steps reach by path.
    pub in_menu_bar: bool,
    /// Screen rectangle `(x, y, width, height)` in points, when known.
    pub bounds: Option<(f64, f64, f64, f64)>,
}

impl Element {
    fn from_value(value: &Value) -> Option<Self> {
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
        Some(Self {
            token: text("element_token"),
            role: short_role(role),
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

    /// A control worth a reference in the default digest.
    fn listed(&self) -> bool {
        if !self.rendered || self.in_menu_bar || matches!(self.role.as_str(), "window" | "menubar" | "application") {
            return false;
        }
        ACTIONABLE_ROLES.contains(&self.role.as_str())
            || (self.has_actions && !self.label.is_empty())
            || (CONTAINER_ROLES.contains(&self.role.as_str()) && !self.label.is_empty())
    }

    fn matches(&self, query: &str) -> bool {
        format!("{} {} {}", self.role, self.label, self.value.as_deref().unwrap_or("")).to_lowercase().contains(query)
    }
}

/// `AXButton` → `button`, `AXTextField` → `textfield`.
fn short_role(role: &str) -> String {
    role.strip_prefix("AX").unwrap_or(role).to_ascii_lowercase()
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    clipped.push('…');
    clipped
}

/// Identity used for stable references: role, label and the ordinal among
/// identical role/label pairs in document order.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct Identity {
    pub role: String,
    pub label: String,
    pub ordinal: usize,
}

fn with_identities(elements: impl IntoIterator<Item = Element>) -> Vec<(Identity, Element)> {
    let mut counts: HashMap<(String, String), usize> = HashMap::new();
    elements
        .into_iter()
        .map(|element| {
            let key = (element.role.clone(), element.label.clone());
            let ordinal = counts.entry(key).and_modify(|count| *count += 1).or_insert(0);
            (Identity { role: element.role.clone(), label: element.label.clone(), ordinal: *ordinal }, element)
        })
        .collect()
}

/// One parsed `get_window_state` response.
#[derive(Debug, Clone)]
pub(crate) struct Snapshot {
    /// Indexed (actionable) rows from `structuredContent.elements`.
    pub elements: Vec<(Identity, Element)>,
    /// Text rows. The driver lists them only in `tree_markdown`, and they
    /// carry results such as a calculator display or a status line.
    pub texts: Vec<(Identity, Element)>,
    pub truncated: bool,
    pub degraded: Option<String>,
    pub title: Option<String>,
    pub app_name: Option<String>,
}

impl Snapshot {
    pub(crate) fn parse(structured: &Value) -> Self {
        let raw = structured.get("elements").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut parsed: Vec<(Option<i64>, Option<i64>, Element)> = raw
            .iter()
            .filter_map(|value| {
                Element::from_value(value).map(|element| {
                    (value.get("element_index").and_then(Value::as_i64), value.get("parent_index").and_then(Value::as_i64), element)
                })
            })
            .collect();
        // Mark everything below a menu bar; parents precede children.
        let mut menu_bar = std::collections::HashSet::new();
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
        Self {
            elements: with_identities(parsed.into_iter().map(|(_, _, element)| element)),
            texts: with_identities(structured.get("tree_markdown").and_then(Value::as_str).map(markdown_texts).unwrap_or_default()),
            truncated: structured.get("truncated").and_then(Value::as_bool).unwrap_or(false),
            degraded: text("degraded_reason"),
            title: text("window_title"),
            app_name: text("app_name"),
        }
    }

    /// Where an element sits inside its window, from 0 to 1 on each axis,
    /// for marking the latest click on a picture of the window.
    pub(crate) fn point_of(&self, identity: &Identity) -> Option<[f64; 2]> {
        let (wx, wy, ww, wh) =
            self.elements.iter().find(|(_, element)| element.role == "window").and_then(|(_, element)| element.bounds)?;
        let (x, y, w, h) = self.find(identity)?.bounds?;
        if ww <= 1.0 || wh <= 1.0 {
            return None;
        }
        let point = [((x + w / 2.0 - wx) / ww), ((y + h / 2.0 - wy) / wh)];
        point.iter().all(|value| (0.0..=1.0).contains(value)).then_some(point)
    }

    pub(crate) fn find(&self, identity: &Identity) -> Option<&Element> {
        self.elements.iter().find(|(candidate, _)| candidate == identity).map(|(_, element)| element)
    }

    pub(crate) fn contains_label(&self, needle: &str) -> bool {
        let needle = needle.to_lowercase();
        self.elements.iter().chain(&self.texts).any(|(_, element)| {
            element.label.to_lowercase().contains(&needle)
                || element.value.as_deref().is_some_and(|value| value.to_lowercase().contains(&needle))
        })
    }
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
            role: short_role(role),
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

/// Reference numbers for one thread and window. Numbers are never reused
/// while the table lives, so a reference names at most one identity.
#[derive(Debug, Default)]
pub(crate) struct RefTable {
    by_identity: HashMap<Identity, u32>,
    by_ref: BTreeMap<u32, Identity>,
    next: u32,
}

impl RefTable {
    pub(crate) fn assign(&mut self, identity: &Identity) -> u32 {
        if let Some(reference) = self.by_identity.get(identity) {
            return *reference;
        }
        self.next += 1;
        self.by_identity.insert(identity.clone(), self.next);
        self.by_ref.insert(self.next, identity.clone());
        self.next
    }

    pub(crate) fn identity(&self, reference: u32) -> Option<&Identity> {
        self.by_ref.get(&reference)
    }

    pub(crate) fn lookup(&self, identity: &Identity) -> Option<u32> {
        self.by_identity.get(identity).copied()
    }
}

/// Parse `@12` or `12`.
pub(crate) fn parse_ref(text: &str) -> Option<u32> {
    text.trim().trim_start_matches('@').parse().ok().filter(|reference| *reference > 0)
}

pub(crate) struct DigestOptions<'a> {
    pub query: Option<&'a str>,
    pub limit: usize,
    pub include_text: bool,
}

/// Render controls (with references) and then text rows, one line each.
/// Returns the lines, how many rows matched, and how many were left out.
pub(crate) fn render(snapshot: &Snapshot, refs: &mut RefTable, options: &DigestOptions<'_>) -> (Vec<String>, usize, usize) {
    let query = options.query.map(str::to_lowercase).filter(|query| !query.is_empty());
    let wanted = |element: &Element| query.as_ref().is_none_or(|query| element.matches(query));
    let mut lines = Vec::new();
    let mut matched: usize = 0;
    for (identity, element) in &snapshot.elements {
        if !element.listed() || !wanted(element) {
            continue;
        }
        matched += 1;
        if lines.len() < options.limit {
            lines.push(line(Some(refs.assign(identity)), element, options.include_text));
        }
    }
    // Without text:true, a few short text rows still show results and
    // status lines; long content stays behind text:true.
    let text_budget = if options.include_text || query.is_some() { usize::MAX } else { DEFAULT_TEXT_ROWS };
    let mut shown_text = 0;
    for (_, element) in &snapshot.texts {
        if !wanted(element) {
            continue;
        }
        matched += 1;
        if shown_text < text_budget && lines.len() < options.limit {
            lines.push(line(None, element, options.include_text));
            shown_text += 1;
        }
    }
    let omitted = matched.saturating_sub(lines.len());
    (lines, matched, omitted)
}

fn line(reference: Option<u32>, element: &Element, long_values: bool) -> String {
    let mut out = match reference {
        Some(reference) => format!("@{reference} {}", element.role),
        None => element.role.clone(),
    };
    if !element.label.is_empty() {
        out.push_str(&format!(" \"{}\"", clip(&element.label, LABEL_CHARS)));
    }
    if let Some(value) = &element.value
        && value != &element.label
    {
        out.push_str(&format!(" = \"{}\"", clip(value, if long_values { LONG_VALUE_CHARS } else { VALUE_CHARS })));
    }
    if element.enabled == Some(false) {
        out.push_str(" (disabled)");
    }
    if element.selected == Some(true) {
        out.push_str(" (selected)");
    }
    out
}

/// Changes between two snapshots of the same window, keyed by identity.
/// Elements that only moved are not reported.
pub(crate) fn diff(before: &Snapshot, after: &Snapshot, refs: &mut RefTable) -> Vec<String> {
    let mut lines = Vec::new();
    changes(&before.elements, &after.elements, Some(refs), &mut lines);
    changes(&before.texts, &after.texts, None, &mut lines);
    if lines.len() > MAX_DIFF_LINES {
        let extra = lines.len() - MAX_DIFF_LINES;
        lines.truncate(MAX_DIFF_LINES);
        lines.push(format!("… {extra} more changes; observe the window for the full state"));
    }
    lines
}

fn changes(before: &[(Identity, Element)], after: &[(Identity, Element)], mut refs: Option<&mut RefTable>, lines: &mut Vec<String>) {
    let texts = refs.is_none();
    let relevant = |element: &Element| texts || element.listed();
    let before_map: HashMap<&Identity, &Element> = before.iter().map(|(identity, element)| (identity, element)).collect();
    let after_map: HashMap<&Identity, &Element> = after.iter().map(|(identity, element)| (identity, element)).collect();
    for (identity, element) in after {
        if !relevant(element) {
            continue;
        }
        let changed = match before_map.get(identity) {
            None => Some('+'),
            Some(previous)
                if previous.value != element.value || previous.enabled != element.enabled || previous.selected != element.selected =>
            {
                Some('~')
            }
            Some(_) => None,
        };
        if let Some(mark) = changed {
            let reference = refs.as_deref_mut().map(|refs| refs.assign(identity));
            lines.push(format!("{mark}{}", line(reference, element, false)));
        }
    }
    for (identity, element) in before {
        if after_map.contains_key(identity) || !relevant(element) {
            continue;
        }
        let reference =
            refs.as_deref().and_then(|refs| refs.lookup(identity)).map(|reference| format!("@{reference} ")).unwrap_or_default();
        lines.push(format!(
            "-{reference}{} \"{}\"",
            element.role,
            clip(if element.label.is_empty() { element.value.as_deref().unwrap_or("") } else { &element.label }, LABEL_CHARS)
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(elements: Value) -> Snapshot {
        Snapshot::parse(&json!({ "snapshot_id": "s00000001", "elements": elements }))
    }

    fn options(query: Option<&str>, limit: usize) -> DigestOptions<'_> {
        DigestOptions { query, limit, include_text: false }
    }

    #[test]
    fn digest_lists_actionable_elements_with_stable_refs() {
        let first = snapshot(json!([
            {"element_index":0,"element_token":"s1:0","role":"AXWindow","label":"Notes"},
            {"element_index":1,"element_token":"s1:1","role":"AXButton","label":"New Note","actions":["AXPress"]},
            {"element_index":2,"element_token":"s1:2","role":"AXTextArea","label":"Body","value":"eggs,\n milk"},
            {"element_index":4,"element_token":"s1:4","role":"AXButton","label":"Delete","enabled":false},
            {"element_index":5,"element_token":"s1:5","role":"AXButton","label":"Delete"},
        ]));
        let mut refs = RefTable::default();
        let (lines, matched, omitted) = render(&first, &mut refs, &options(None, DEFAULT_LIMIT));
        assert_eq!(
            lines,
            vec![
                "@1 button \"New Note\"",
                "@2 textarea \"Body\" = \"eggs, milk\"",
                "@3 button \"Delete\" (disabled)",
                "@4 button \"Delete\""
            ]
        );
        assert_eq!((matched, omitted), (4, 0));

        // Reordered snapshot: references follow identity, not position.
        let second = snapshot(json!([
            {"element_index":0,"element_token":"s2:0","role":"AXButton","label":"Share"},
            {"element_index":1,"element_token":"s2:1","role":"AXButton","label":"New Note"},
        ]));
        let (lines, _, _) = render(&second, &mut refs, &options(None, DEFAULT_LIMIT));
        assert_eq!(lines, vec!["@5 button \"Share\"", "@1 button \"New Note\""]);
        let identity = refs.identity(1).unwrap().clone();
        assert_eq!(second.find(&identity).unwrap().token.as_deref(), Some("s2:1"));
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
        let (lines, _, _) = render(&snapshot, &mut RefTable::default(), &options(None, DEFAULT_LIMIT));
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
            Snapshot::parse(&json!({
                "elements": [{"element_index":1,"element_token":"s:1","role":"AXButton","label":"Equals","actions":["AXPress"]}],
                "tree_markdown": markdown(display),
            }))
        };
        let before = parse("12");
        assert_eq!(before.texts.len(), 1);
        let mut refs = RefTable::default();
        let (lines, _, _) = render(&before, &mut refs, &options(None, DEFAULT_LIMIT));
        assert_eq!(lines, vec!["@1 button \"Equals\"", "statictext \"Edit field\" = \"12\""]);
        let after = parse("408");
        assert!(after.contains_label("408"));
        assert_eq!(diff(&before, &after, &mut refs), vec!["~statictext \"Edit field\" = \"408\""]);
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
    fn limit_and_query_report_omissions() {
        let many = snapshot(Value::Array((0..10).map(|i| json!({"role":"AXButton","label":format!("Item {i}")})).collect()));
        let mut refs = RefTable::default();
        let (lines, matched, omitted) = render(&many, &mut refs, &options(None, 3));
        assert_eq!((lines.len(), matched, omitted), (3, 10, 7));
        let (lines, matched, _) = render(&many, &mut refs, &options(Some("item 7"), 3));
        assert_eq!(lines, vec!["@4 button \"Item 7\""]);
        assert_eq!(matched, 1);
    }

    #[test]
    fn diff_reports_added_removed_and_changed_values() {
        let before = snapshot(json!([
            {"role":"AXTextField","label":"Name","value":""},
            {"role":"AXButton","label":"Save"},
        ]));
        let after = snapshot(json!([
            {"role":"AXTextField","label":"Name","value":"Report"},
            {"role":"AXSheet","label":"Save As"},
            {"role":"AXButton","label":"Cancel"},
        ]));
        let mut refs = RefTable::default();
        render(&before, &mut refs, &options(None, DEFAULT_LIMIT));
        let lines = diff(&before, &after, &mut refs);
        assert_eq!(
            lines,
            vec!["~@1 textfield \"Name\" = \"Report\"", "+@3 sheet \"Save As\"", "+@4 button \"Cancel\"", "-@2 button \"Save\""]
        );
    }

    #[test]
    fn click_points_are_relative_to_the_window() {
        let snapshot = snapshot(json!([
            {"role":"AXWindow","label":"Calculator","frame":{"x":100,"y":200,"w":200,"h":400}},
            {"role":"AXButton","label":"Equals","frame":{"x":240,"y":540,"w":40,"h":40}},
        ]));
        let identity = Identity { role: "button".into(), label: "Equals".into(), ordinal: 0 };
        assert_eq!(snapshot.point_of(&identity), Some([0.8, 0.9]));
    }

    #[test]
    fn parses_references() {
        assert_eq!(parse_ref("@12"), Some(12));
        assert_eq!(parse_ref(" 3 "), Some(3));
        assert_eq!(parse_ref("@0"), None);
        assert_eq!(parse_ref("save"), None);
    }
}
