# One hover per link in mixed-size inline flow (exec'd from apply_hooks.py,
# after markdown_document_hooks.py). A paragraph with inline code is laid out
# as one fragment per word, and each fragment hit-tested and underlined only
# its own slice of a link, so a multi-word link underlined word by word. The
# flow now finds the hovered link once, from its token geometry, and every
# fragment underlines its slice of that link; one mouse-move listener per flow
# refreshes when the hovered link changes. Clicks stay per fragment.

# text/paint.rs: a fragment can be told which of its bytes to underline.
edit("text/paint.rs", "    pub hover_link_color: Option<Hsla>,\n    pub shared_links:", """    pub hover_link_color: Option<Hsla>,
    /// Bytes of a link hovered anywhere in the same flow, the underline color,
    /// and whether the link continues past this fragment (its underline then
    /// reaches the next fragment, leaving no hairline gap).
    pub hover_range: Option<(Range<usize>, Hsla, bool)>,
    pub shared_links:""")
edit("text/paint.rs", "            hover_link_color: None,\n            shared_links: None,", "            hover_link_color: None,\n            hover_range: None,\n            shared_links: None,")
edit("text/paint.rs", "        shared_links,\n        hover_link_color,\n        on_link,", "        shared_links,\n        hover_link_color,\n        hover_range,\n        on_link,")
edit("text/paint.rs", "            if let Some(color) = hover_link_color {\n                let hit =", """            if let Some((range, color, continues)) = &hover_range {
                let rects = range_rects(&layout, range, 0.0, 0.0);
                let last = rects.len().saturating_sub(1);
                for (index, mut rect) in rects.into_iter().enumerate() {
                    rect.origin.y += rect.size.height - gpui::px(2.0);
                    rect.size.height = gpui::px(1.0);
                    if *continues && index == last { rect.size.width += gpui::px(1.0); }
                    window.paint_quad(quad(rect, gpui::px(0.0), *color, gpui::px(0.0), gpui::transparent_black(), Default::default()));
                }
            }
            if let Some(color) = hover_link_color {
                let hit =""")

# markdown_inline.rs: the flow owns hover.
p = "markdown_inline.rs"
edit(p, "struct InlineFlow {\n    data: Rc<InlineData>,\n    layout: Rc<RefCell<Option<InlineLayout>>>,\n    interaction: InlineInteraction,\n}", """struct InlineFlow {
    data: Rc<InlineData>,
    layout: Rc<RefCell<Option<InlineLayout>>>,
    interaction: InlineInteraction,
    /// The link under the pointer at prepaint.
    hovered: Option<usize>,
}

/// Index of the link under `mouse` in the whole flow. A word wholly inside one
/// link needs no shaping; a partly linked word is shaped once to find the byte.
fn flow_link_at(data: &InlineData, layout: &InlineLayout, bounds: Bounds<Pixels>, mouse: gpui::Point<Pixels>, window: &Window) -> Option<usize> {
    let links = &data.flat.links;
    if links.is_empty() || !bounds.contains(&mouse) {
        return None;
    }
    let (x, y) = (f32::from(mouse.x - bounds.origin.x), f32::from(mouse.y - bounds.origin.y));
    // Positions run in line order: skip to the pointer's line.
    let first_on_line = layout.positions.partition_point(|p| p.y + p.height <= y);
    let position = layout.positions[first_on_line..].iter().take_while(|p| p.y <= y).find(|p| x >= p.x && x < p.x + p.width && y >= p.y && y < p.y + p.height)?;
    let token = &data.tokens[position.index];
    let first = links.partition_point(|(range, _)| range.end <= token.range.start);
    let candidates: Vec<usize> = (first..links.len()).take_while(|&i| links[i].0.start < token.range.end).collect();
    match candidates.as_slice() {
        [] => None,
        [only] if links[*only].0.start <= token.range.start && links[*only].0.end >= token.range.end => Some(*only),
        // A word wrapped inside its own piece: take its link without shaping.
        _ if position.height > data.line + 0.01 => candidates.first().copied(),
        _ => {
            let forced = data.flat.text[token.range.clone()].ends_with('\\n');
            let range = token.range.start..token.range.end - usize::from(forced);
            let size = if token.code { data.size * data.ratio } else { data.size };
            let pad = if token.code { data.padding } else { 0.0 };
            let text: SharedString = data.flat.text[range.clone()].to_string().into();
            let shaped = window.text_system().shape_line(text, px(size), &data.runs(&range), None);
            let ix = range.start + shaped.index_for_x(px(x - position.x - pad))?;
            candidates.into_iter().find(|&i| links[i].0.contains(&ix))
        }
    }
}""")
edit(p, "        let layout = layout.as_ref().unwrap();\n        let clip = window.content_mask().bounds;", """        let layout = layout.as_ref().unwrap();
        self.hovered = interaction.hover_link_color.and_then(|_| flow_link_at(data, layout, bounds, window.mouse_position(), window));
        let hovered = self.hovered.map(|index| &data.flat.links[index].0);
        let clip = window.content_mask().bounds;""")
edit(p, "                hover_link_color: interaction.hover_link_color,\n                on_link:", """                hover_link_color: None,
                hover_range: hovered.zip(interaction.hover_link_color).and_then(|(link, color)| {
                    let a = range.start.max(link.start);
                    let b = range.end.min(link.end);
                    (a < b).then(|| (a - range.start..b - range.start, color, link.end > range.end))
                }),
                on_link:""")
edit(p, """        _: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        children: &mut Vec<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) {
        for child in children {
            child.paint(window, cx)
        }""", """        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        children: &mut Vec<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) {
        for child in children {
            child.paint(window, cx)
        }
        if self.interaction.hover_link_color.is_some() && !self.data.flat.links.is_empty() {
            let (data, layout) = (self.data.clone(), state.clone());
            let hovered = self.hovered;
            window.on_mouse_event(move |event: &gpui::MouseMoveEvent, phase, window, _cx| {
                if phase != gpui::DispatchPhase::Bubble {
                    return;
                }
                let next = layout.borrow().as_ref().and_then(|layout| flow_link_at(&data, layout, bounds, event.position, window));
                if next != hovered {
                    window.refresh();
                }
            });
        }""")
edit(p, "    InlineFlow {data,layout,interaction}.into_any_element()", "    InlineFlow {data,layout,interaction,hovered:None}.into_any_element()")
