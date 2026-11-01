//! Compact window digests with stable references.
//!
//! A backend's element tokens are bound to one snapshot. Kybern gives each
//! element a short `@N` reference bound to its identity (role, label and
//! duplicate ordinal) so the model can keep using a reference across
//! observations, and resolves it to the newest backend token when acting.
//! Roles arrive already mapped to the neutral vocabulary of
//! [`super::backend::neutral_role`], so a digest reads the same on every OS.

use std::collections::{BTreeMap, HashMap};

const LABEL_CHARS: usize = 60;
const VALUE_CHARS: usize = 40;
const LONG_VALUE_CHARS: usize = 200;
pub(crate) const DEFAULT_LIMIT: usize = 80;
pub(crate) const MAX_LIMIT: usize = 400;
const MAX_DIFF_LINES: usize = 40;
/// Past this many, removed elements are counted rather than listed: a page
/// that navigated or a window that closed says little through what it lost.
const MAX_REMOVED_LINES: usize = 8;
const DEFAULT_TEXT_ROWS: usize = 12;

/// Roles the model can act on (neutral vocabulary). Static text is listed
/// only with `text:true`.
const ACTIONABLE_ROLES: &[&str] = &[
    "button",
    "checkbox",
    "radio",
    "switch",
    "combobox",
    "menubutton",
    "textfield",
    "password",
    "datefield",
    "link",
    "menuitem",
    "menubaritem",
    "tab",
    "slider",
    "stepper",
    "disclosure",
    "row",
    "cell",
];
const CONTAINER_ROLES: &[&str] = &["sheet", "dialog", "alert", "popover", "menu", "list", "table", "tree", "tablist", "webarea"];

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

pub(crate) fn one_line(text: &str) -> String {
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

/// One read of a window, parsed by the backend.
#[derive(Debug, Clone)]
pub(crate) struct Snapshot {
    /// Indexed (actionable) rows.
    pub elements: Vec<(Identity, Element)>,
    /// Text rows. They carry results such as a calculator display or a
    /// status line.
    pub texts: Vec<(Identity, Element)>,
    pub truncated: bool,
    pub degraded: Option<String>,
    pub title: Option<String>,
    pub app_name: Option<String>,
}

impl Snapshot {
    /// A snapshot from elements a backend already parsed, in document order,
    /// with neutral roles. Identities are assigned here.
    pub(crate) fn new(
        elements: Vec<Element>,
        texts: Vec<Element>,
        truncated: bool,
        degraded: Option<String>,
        title: Option<String>,
        app_name: Option<String>,
    ) -> Self {
        Self { elements: with_identities(elements), texts: with_identities(texts), truncated, degraded, title, app_name }
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

    pub(crate) fn is_empty(&self) -> bool {
        self.by_ref.is_empty()
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
    let removed = lines.iter().filter(|line| line.starts_with('-')).count();
    if removed > MAX_REMOVED_LINES {
        lines.retain(|line| !line.starts_with('-'));
        lines.push(format!("-{removed} elements gone"));
    }
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
pub(crate) mod tests {
    use super::*;

    /// An element as a backend would build it.
    pub(crate) fn el(role: &str, label: &str) -> Element {
        Element {
            token: None,
            role: role.into(),
            label: label.into(),
            value: None,
            enabled: None,
            selected: None,
            has_actions: false,
            rendered: true,
            in_menu_bar: false,
            bounds: None,
        }
    }

    fn token(mut element: Element, token: &str) -> Element {
        element.token = Some(token.into());
        element
    }

    fn snapshot(elements: Vec<Element>) -> Snapshot {
        Snapshot::new(elements, Vec::new(), false, None, None, None)
    }

    fn options(query: Option<&str>, limit: usize) -> DigestOptions<'_> {
        DigestOptions { query, limit, include_text: false }
    }

    #[test]
    fn digest_lists_actionable_elements_with_stable_refs() {
        let mut body = token(el("textfield", "Body"), "s1:2");
        body.value = Some("eggs, milk".into());
        let mut disabled = token(el("button", "Delete"), "s1:4");
        disabled.enabled = Some(false);
        let first = snapshot(vec![
            token(el("window", "Notes"), "s1:0"),
            token(el("button", "New Note"), "s1:1"),
            body,
            disabled,
            token(el("button", "Delete"), "s1:5"),
        ]);
        let mut refs = RefTable::default();
        let (lines, matched, omitted) = render(&first, &mut refs, &options(None, DEFAULT_LIMIT));
        assert_eq!(
            lines,
            vec![
                "@1 button \"New Note\"",
                "@2 textfield \"Body\" = \"eggs, milk\"",
                "@3 button \"Delete\" (disabled)",
                "@4 button \"Delete\""
            ]
        );
        assert_eq!((matched, omitted), (4, 0));

        // Reordered snapshot: references follow identity, not position.
        let second = snapshot(vec![token(el("button", "Share"), "s2:0"), token(el("button", "New Note"), "s2:1")]);
        let (lines, _, _) = render(&second, &mut refs, &options(None, DEFAULT_LIMIT));
        assert_eq!(lines, vec!["@5 button \"Share\"", "@1 button \"New Note\""]);
        let identity = refs.identity(1).unwrap().clone();
        assert_eq!(second.find(&identity).unwrap().token.as_deref(), Some("s2:1"));
    }

    #[test]
    fn closed_menus_and_unrendered_rows_stay_out_of_the_digest() {
        let mut offscreen = el("button", "Offscreen row");
        offscreen.rendered = false;
        let mut hidden = el("menuitem", "Restart…");
        hidden.in_menu_bar = true;
        let snapshot = snapshot(vec![el("button", "Equals"), offscreen, el("menubar", ""), hidden, el("menuitem", "Copy")]);
        let (lines, _, _) = render(&snapshot, &mut RefTable::default(), &options(None, DEFAULT_LIMIT));
        assert_eq!(lines, vec!["@1 button \"Equals\"", "@2 menuitem \"Copy\""]);
    }

    #[test]
    fn every_neutral_actionable_role_is_listed_and_native_words_are_not() {
        for role in ACTIONABLE_ROLES {
            assert!(el(role, "x").listed(), "{role}");
        }
        for old in ["popupbutton", "statictext", "securetextfield", "textarea", "outlinerow", "radiobutton"] {
            assert!(!el(old, "").listed(), "{old} is not a neutral role");
        }
        // A container needs a label; text never lists without actions.
        assert!(el("dialog", "Save As").listed());
        assert!(!el("dialog", "").listed());
        assert!(!el("text", "408").listed());
        let mut custom = el("group", "Custom");
        custom.has_actions = true;
        assert!(custom.listed());
    }

    #[test]
    fn text_rows_show_results_and_changes() {
        let texts = |display: &str| {
            let mut field = el("text", "Edit field");
            field.value = Some(display.into());
            vec![field]
        };
        let build = |display: &str| Snapshot::new(vec![token(el("button", "Equals"), "s:1")], texts(display), false, None, None, None);
        let before = build("12");
        let mut refs = RefTable::default();
        let (lines, _, _) = render(&before, &mut refs, &options(None, DEFAULT_LIMIT));
        assert_eq!(lines, vec!["@1 button \"Equals\"", "text \"Edit field\" = \"12\""]);
        let after = build("408");
        assert!(after.contains_label("408"));
        assert_eq!(diff(&before, &after, &mut refs), vec!["~text \"Edit field\" = \"408\""]);
    }

    #[test]
    fn limit_and_query_report_omissions() {
        let many = snapshot((0..10).map(|i| el("button", &format!("Item {i}"))).collect());
        let mut refs = RefTable::default();
        let (lines, matched, omitted) = render(&many, &mut refs, &options(None, 3));
        assert_eq!((lines.len(), matched, omitted), (3, 10, 7));
        let (lines, matched, _) = render(&many, &mut refs, &options(Some("item 7"), 3));
        assert_eq!(lines, vec!["@4 button \"Item 7\""]);
        assert_eq!(matched, 1);
    }

    #[test]
    fn diff_reports_added_removed_and_changed_values() {
        let mut name = el("textfield", "Name");
        name.value = Some("".into());
        let before = snapshot(vec![name, el("button", "Save")]);
        let mut named = el("textfield", "Name");
        named.value = Some("Report".into());
        let after = snapshot(vec![named, el("sheet", "Save As"), el("button", "Cancel")]);
        let mut refs = RefTable::default();
        render(&before, &mut refs, &options(None, DEFAULT_LIMIT));
        let lines = diff(&before, &after, &mut refs);
        assert_eq!(
            lines,
            vec!["~@1 textfield \"Name\" = \"Report\"", "+@3 sheet \"Save As\"", "+@4 button \"Cancel\"", "-@2 button \"Save\""]
        );
    }

    #[test]
    fn many_removals_are_counted_not_listed() {
        let before = snapshot((0..12).map(|i| el("link", &format!("Result {i}"))).collect());
        let after = snapshot(vec![el("button", "Reload")]);
        let mut refs = RefTable::default();
        render(&before, &mut refs, &options(None, DEFAULT_LIMIT));
        assert_eq!(diff(&before, &after, &mut refs), vec!["+@13 button \"Reload\"", "-12 elements gone"]);
    }

    #[test]
    fn click_points_are_relative_to_the_window() {
        let mut window = el("window", "Calculator");
        window.bounds = Some((100.0, 200.0, 200.0, 400.0));
        let mut equals = el("button", "Equals");
        equals.bounds = Some((240.0, 540.0, 40.0, 40.0));
        let snapshot = snapshot(vec![window, equals]);
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
