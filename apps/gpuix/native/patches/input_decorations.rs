// Included into input.rs. All stored offsets are UTF-8; public offsets are UTF-16.
#[derive(Clone, PartialEq)]
struct InputDecoration {
    range: Range<usize>,
    style: DecorationStyle,
    atomic: bool,
    id: Option<String>,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecorationStyle {
    color: Option<String>,
    background_color: Option<String>,
    font_weight: Option<f32>,
    font_style: Option<String>,
    underline: Option<bool>,
    border_radius: Option<f32>,
    padding_x: Option<f32>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DecorationRequest {
    start: u32,
    end: u32,
    #[serde(default)]
    style: DecorationStyle,
    #[serde(default)]
    atomic: bool,
    id: Option<String>,
}

pub(crate) fn set_input_decorations(id: u64, value: serde_json::Value, expected: String, cx: &mut gpui::App) -> napi::Result<()> {
    let requests: Vec<DecorationRequest> = serde_json::from_value(value).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    if requests.len() > 4096 { return Err(napi::Error::from_reason("At most 4096 decorations are supported")); }
    editor_for(id)?.update(cx, |state, cx| {
        if state.secure || state.marked_range.is_some() { return Err(napi::Error::from_reason("Input is secure or composing")); }
        if state.content != expected { return Err(napi::Error::from_reason("Input changed before decorations")); }
        let mut decorations = Vec::with_capacity(requests.len());
        let mut ids = std::collections::HashSet::new();
        for request in requests {
            let range = checked_range(&state.content, request.start, request.end)?;
            if range.is_empty() { return Err(napi::Error::from_reason("Decoration ranges must be nonempty")); }
            let style = request.style;
            for color in [&style.color, &style.background_color].into_iter().flatten() {
                if crate::color::parse_color(color).is_none() { return Err(napi::Error::from_reason("Invalid decoration color")); }
            }
            if style.font_weight.is_some_and(|v| !v.is_finite() || !(100.0..=900.0).contains(&v)) ||
                style.font_style.as_ref().is_some_and(|v| v != "normal" && v != "italic") {
                return Err(napi::Error::from_reason("Invalid decoration font style"));
            }
            if style.border_radius.is_some_and(|v| v != 0.0) || style.padding_x.is_some_and(|v| v != 0.0) {
                return Err(napi::Error::from_reason("Input runs do not support borderRadius or paddingX"));
            }
            if let Some(id) = &request.id {
                if id.is_empty() || !ids.insert(id.clone()) { return Err(napi::Error::from_reason("Decoration IDs must be unique and nonempty")); }
            }
            decorations.push(InputDecoration { range, style, atomic: request.atomic, id: request.id });
        }
        let atoms: Vec<_> = decorations.iter().filter(|d| d.atomic).collect();
        for (i, atom) in atoms.iter().enumerate() {
            if atoms[..i].iter().any(|other| atom.range.start < other.range.end && other.range.start < atom.range.end) {
                return Err(napi::Error::from_reason("Atomic decoration ranges must not overlap"));
            }
        }
        if state.decorations == decorations { return Ok(()); }
        state.decorations = decorations;
        state.selected_range = state.expand_atoms(state.selected_range.clone());
        cx.notify();
        Ok(())
    })
}

pub(crate) fn hit_test_input_decoration(id: u64, x: f64, y: f64, cx: &gpui::App) -> napi::Result<Option<String>> {
    if !x.is_finite() || !y.is_finite() { return Err(napi::Error::from_reason("Point must be finite")); }
    let editor = editor_for(id)?;
    let state = editor.read(cx);
    let p = point(px(x as f32), px(y as f32));
    if state.secure || state.last_bounds.is_none_or(|b| !b.contains(&p)) { return Ok(None); }
    let index = state.index_for_mouse_position(p);
    Ok(state.decorations.iter().rev().find(|d| d.range.contains(&index) && d.id.is_some()).and_then(|d| d.id.clone()))
}

impl TextEditorState {
    fn snap_atom(&self, offset: usize, forward: bool) -> usize {
        if self.marked_range.is_some() { return offset; }
        self.decorations.iter().find(|d| d.atomic && d.range.start < offset && offset < d.range.end)
            .map(|d| if forward { d.range.end } else { d.range.start }).unwrap_or(offset)
    }
    fn expand_atoms(&self, range: Range<usize>) -> Range<usize> {
        if range.is_empty() { let at = self.snap_atom(range.start, true); return at..at; }
        self.snap_atom(range.start, false)..self.snap_atom(range.end, true)
    }
    // Decorations intersected by editing are discarded; untouched spans retain identity.
    // Insertion at either boundary stays outside the span. Undo restores the exact spans.
    fn rebase_decorations(&mut self, range: &Range<usize>, inserted: usize) {
        self.decorations.retain_mut(|d| {
            if d.range.end <= range.start { return true; }
            if d.range.start >= range.end {
                d.range.start = d.range.start - range.len() + inserted;
                d.range.end = d.range.end - range.len() + inserted;
                return true;
            }
            false
        });
    }
    fn decorated_runs(&self, style: &TextStyle, color: gpui::Hsla) -> Vec<TextRun> {
        let mut edges = vec![0, self.content.len()];
        for d in &self.decorations { edges.extend([d.range.start, d.range.end]); }
        if let Some(marked) = &self.marked_range { edges.extend([marked.start, marked.end]); }
        edges.sort_unstable(); edges.dedup();
        edges.windows(2).filter(|r| r[0] < r[1]).map(|r| {
            let mut run = TextRun { len: r[1] - r[0], font: style.font(), color, background_color: None, underline: None, strikethrough: None };
            for d in self.decorations.iter().filter(|d| d.range.start <= r[0] && r[0] < d.range.end) {
                if let Some(c) = &d.style.color { run.color = crate::color::parse_color_rgba(c).unwrap().into(); }
                if let Some(c) = &d.style.background_color { run.background_color = crate::color::parse_color_rgba(c).map(Into::into); }
                if let Some(weight) = d.style.font_weight { run.font.weight = gpui::FontWeight(weight); }
                if let Some(s) = &d.style.font_style { run.font.style = if s == "italic" { gpui::FontStyle::Italic } else { gpui::FontStyle::Normal }; }
                if let Some(underline) = d.style.underline { run.underline = underline.then_some(UnderlineStyle { color: Some(run.color), thickness: px(1.0), wavy: false }); }
            }
            if self.marked_range.as_ref().is_some_and(|m| m.contains(&r[0])) {
                run.underline = Some(UnderlineStyle { color: Some(run.color), thickness: px(1.0), wavy: false });
            }
            run
        }).collect()
    }
}
