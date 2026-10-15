# Executed by apply_hooks.py before committing the staged edits.
edit("lib.rs", "mod cache_island;", "mod cache_island;\nmod markdown_style;")
edit("theme.rs", "    pub metrics: Metrics,", "    pub metrics: Metrics,\n    pub markdown: crate::markdown_style::MarkdownStyle,")
edit("theme.rs", "            metrics: Metrics::default(),", "            metrics: Metrics::default(),\n            markdown: Default::default(),", 2)
edit("theme.rs", "    pub metrics: Option<MetricsOverride>,", "    pub metrics: Option<MetricsOverride>,\n    pub markdown: Option<crate::markdown_style::MarkdownStyle>,")
edit("theme.rs", "        if let Some(metrics) = &o.metrics {", "        if let Some(markdown) = &o.markdown { self.markdown = markdown.clone(); }\n        if let Some(metrics) = &o.metrics {")
r = "markdown/render.rs"
edit(r, "use crate::theme::{Metrics, Theme};", "use crate::theme::{Metrics, Theme};\nuse crate::markdown_style::{number, color, tier, heading};\ninclude!(\"../markdown_inline.rs\");")
# Quote colors must change explicit TextRuns, not just the inherited container.
start = pending.get(r, (src / r).read_text())
a = start.index("        Block::BlockQuote { children } => div()")
b = start.index("        Block::List {", a)
edit(r, start[a:b], '''        Block::BlockQuote { children } => {
            let old_text = ctx.theme.text;
            ctx.theme.text = color(&theme.markdown.quote_text, theme.text_muted);
            let children: Vec<_> = children.iter().map(|child| render_block(child, ctx, window)).collect();
            ctx.theme.text = old_text;
            div().border_l(px(number(theme.markdown.quote_border_width, 2.0)))
                .border_color(color(&theme.markdown.quote_border, opacity(theme.accent, 0.6)))
                .bg(color(&theme.markdown.quote_background, opacity(theme.accent, 0.05)))
                .pl(px(number(theme.markdown.quote_padding_left, 12.0)))
                .pr(px(number(theme.markdown.quote_padding_right, 10.0)))
                .py(px(number(theme.markdown.quote_padding_y, 6.0)))
                .flex().flex_col().gap(px(number(theme.markdown.quote_gap, 8.0)))
                .children(children).into_any_element()
        },
''')
edit(r, "let mut list = div().flex().flex_col().gap(px(4.0));", "let mut list = div().flex().flex_col().gap(px(number(theme.markdown.list_item_gap, 4.0)));")
edit(r, ".min_w(px(18.0))", ".w(px((number(theme.markdown.list_indent, 26.0) - number(theme.markdown.list_marker_gap, 8.0)).max(0.0)))", 2)
edit(r, ".text_color(opacity(theme.accent, 0.85))", ".text_right().text_color(color(&theme.markdown.list_marker, opacity(theme.accent, 0.85)))")
edit(r, ".items_center()\n                        .child(", ".items_center().justify_end()\n                        .child(")
edit(r, ".w(px(5.0))\n                                .h(px(5.0))", ".w(px(number(theme.markdown.list_marker_size, 5.0)))\n                                .h(px(number(theme.markdown.list_marker_size, 5.0)))")
edit(r, ".bg(opacity(theme.accent, 0.85))", ".bg(color(&theme.markdown.list_marker, opacity(theme.accent, 0.85)))")
edit(r, "div().flex().flex_row().gap(px(8.0)).child(marker).child(", "div().flex().flex_row().gap(px(number(theme.markdown.list_marker_gap, 8.0))).child(marker).child(")
# Same group keeps source exact when inline boxes are selected across runs.
edit(r, "    let flat = flatten_runs(runs, &ctx.theme, weight);\n    let inner = flat_text_element(&flat, ctx);", "    let flat = flatten_runs(runs, &ctx.theme, weight);\n    let inner = inline_element(&flat, size, line_height, None, ctx);")
# Fenced-code wrap opt-in, default remains a horizontal scroller.
edit(r, "    for (line_ix, line) in code.split('\\n').enumerate() {", "    if theme.markdown.code_wrap { lines = lines.w_full().min_w_0().flex_shrink_1().whitespace_normal(); }\n    for (line_ix, line) in code.split('\\n').enumerate() {")
edit(r, "lines = lines.child(div().h(px(m.code_line_height)).flex_none().child(text));", "let row = div().h(px(m.code_line_height)).flex_none();\n        lines = lines.child(crate::code_wrap::row(row, theme.markdown.code_wrap, m.code_line_height).child(text));")
edit(r, ".bg(ink(&theme, 0.035))\n        .border_1()\n        .border_color(theme.border)", ".bg(color(&theme.markdown.code_background, ink(&theme, 0.035)))\n        .border(px(number(theme.markdown.code_border_width, 1.0)))\n        .border_color(color(&theme.markdown.code_border, theme.border))")
edit(r, "    if let Some(language) = language {", "    if let Some(language) = language.filter(|_| theme.markdown.code_header.unwrap_or(true)) {")
# Grid single shared edges; no doubled cell borders.
edit(r, "    let hairline = hairline(&theme, 0.10);", "    let hairline = color(&theme.markdown.table_border, hairline(&theme, 0.10));\n    let border = number(theme.markdown.table_border_width, 1.0);")
edit(r, "            FontWeight::BOLD", "            FontWeight(number(theme.markdown.table_header_weight, 700.0))")
edit(r, "    let geo = table_columns(&content, m);", "    let mut table_metrics = *m;\n    table_metrics.md_table_cell_padding = number(theme.markdown.table_padding_x, m.md_table_cell_padding);\n    let geo = table_columns(&content, &table_metrics);")
edit(r, "    for (row_ix, row) in flats.iter().enumerate() {", "    if theme.markdown.table_grid { inner = inner.border(px(border)).border_color(hairline); }\n    for (row_ix, row) in flats.iter().enumerate() {")
edit(r, "inner = inner.child(div().flex_none().h(px(TABLE_DIVIDER)).w_full().bg(hairline));", "inner = inner.child(div().flex_none().h(px(if row_ix == 1 && has_header { number(theme.markdown.table_header_rule_width, border) } else { border })).w_full().bg(hairline));")
edit(r, "        let mut row_el = div().flex().flex_row();", "        let mut row_el = div().flex().flex_row();\n        if row_ix == 0 && has_header { row_el = row_el.bg(color(&theme.markdown.table_header_background, gpui::transparent_black())); }")
edit(r, "                .p(px(m.md_table_cell_padding))", "                .px(px(number(theme.markdown.table_padding_x, m.md_table_cell_padding)))\n                .py(px(number(theme.markdown.table_padding_y, m.md_table_cell_padding)))")
edit(r, "            cell = match align.get(col).copied().unwrap_or_default() {", "            if theme.markdown.table_grid && col > 0 { cell = cell.border_l(px(border)).border_color(hairline); }\n            cell = match align.get(col).copied().unwrap_or_default() {")
edit(r, "cell = cell.child(flat_text_element(flat, ctx));", "cell = cell.child(inline_element(flat, m.md_text_size, m.md_line_height, align.get(col).copied(), ctx));")
# Account for heading margins with CSS-like collapsed neighboring block gaps.
a=pending[r].index("    let block_gap = ctx.theme.metrics.md_block_gap;")
b=pending[r].index("\n}\n\npub fn render_block",a)
edit(r,pending[r][a:b],'''    let theme = ctx.theme.clone();
    if theme.markdown.heading_margin_top.is_none() && theme.markdown.heading_margin_bottom.is_none() {
        return div().flex().flex_col().gap(px(theme.metrics.md_block_gap)).children(tree.blocks.iter().map(|block|render_block(block,ctx,window)).collect::<Vec<_>>()).into_any_element();
    }
    let mut children = Vec::new();
    let mut previous_bottom: f32 = 0.0;
    let mut previous_heading = false;
    for (index, block) in tree.blocks.iter().enumerate() {
        let (top, bottom) = if let Block::Heading { level, .. } = block {
            let (size, _) = heading(&theme,*level);
            (number(tier(&theme.markdown.heading_margin_tops,*level).or(theme.markdown.heading_margin_top), 0.0) * size,
             number(theme.markdown.heading_margin_bottom, 0.0) * size)
        } else { (theme.metrics.md_block_gap, theme.metrics.md_block_gap) };
        let gap = if index == 0 { 0.0 } else if previous_heading && !matches!(block,Block::Heading { .. }) { number(theme.markdown.heading_following_gap, previous_bottom.max(top)) } else { previous_bottom.max(top) };
        children.push(div().mt(px(gap)).child(render_block(block, ctx, window)).into_any_element());
        previous_bottom = bottom;
        previous_heading = matches!(block,Block::Heading { .. });
    }
    div().flex().flex_col().children(children).into_any_element()''')

# Inherited text search stays paragraph-wide even when mixed-size boxes split paint.
edit("text/paint.rs", "    Native(Arc<super::search::HighlightContext>),", """    Native(Arc<super::search::HighlightContext>),
    NativeFragment {
        context: Arc<super::search::HighlightContext>, key: Arc<str>, text: SharedString,
        range: Range<usize>,
        washes: std::rc::Rc<std::cell::RefCell<Option<Vec<super::search::Wash>>>>,
    },""")
edit("text/paint.rs", "                None => Vec::new(),", """                Some(HighlightSource::NativeFragment { context, key, text, range, washes }) => {
                    let mut cache = washes.borrow_mut();
                    let all = cache.get_or_insert_with(|| super::search::washes_for_native_run(context, key, text));
                    all.iter().filter_map(|wash| {
                        let a=range.start.max(wash.range.start); let b=range.end.min(wash.range.end);
                        (a<b).then(|| { let mut wash=wash.clone(); wash.range=a-range.start..b-range.start; wash })
                    }).collect()
                },
                None => Vec::new(),""")
edit(r, "const TABLE_DIVIDER: f32 = 1.0;", "")
edit(r, "    next_sub: usize,", "    next_sub: usize,\n    list_depth: usize,")
edit(r, "            next_sub: 0,", "            next_sub: 0,\n            list_depth: 0,")
edit(r, "                let children: Vec<AnyElement> = item", "                ctx.list_depth += 1;\n                let children: Vec<AnyElement> = item")
edit(r, "                list = list.child(", "                ctx.list_depth -= 1;\n                list = list.child(")
edit(r, ".bg(color(&theme.markdown.list_marker, opacity(theme.accent, 0.85))),", """.bg(if ctx.list_depth % 3 == 1 && theme.markdown.nested_list_markers { gpui::transparent_black() } else { color(&theme.markdown.list_marker, opacity(theme.accent, 0.85)) })
                                .border(px(if ctx.list_depth % 3 == 1 && theme.markdown.nested_list_markers { 1.0 } else { 0.0 }))
                                .border_color(color(&theme.markdown.list_marker, opacity(theme.accent, 0.85))),""")
edit(r, "            FontWeight::SEMIBOLD\n        } else {", "            FontWeight(number(theme.markdown.strong_weight, 600.0))\n        } else {")
# Native toolbar is deliberately label-only; app code supplies interactive chrome.
edit(r, "                .border_b_1()\n                .border_color(theme.border)\n                .bg(ink(&theme, 0.02))", "                .border_b(px(number(theme.markdown.code_header_border_width, 1.0)))\n                .border_color(theme.border)\n                .bg(color(&theme.markdown.code_header_background, ink(&theme, 0.02)))\n                .line_height(px(number(theme.markdown.code_header_line_height, m.md_line_height)))")

edit(r, "                            .gap(px(4.0))", "                            .gap(px(number(theme.markdown.list_child_gap, 4.0)))")
edit(r, "                .text_size(px(m.md_code_header_text_size))", "                .font_family(theme.font_mono.clone())\n                .text_size(px(m.md_code_header_text_size))")

edit(r, "            let (size, line) = m.heading(*level);\n            text_element(runs, size, line, FontWeight::SEMIBOLD, ctx)", "            let (size, line) = heading(&theme,*level);\n            text_element(runs, size, line, FontWeight(number(tier(&theme.markdown.heading_weights,*level),600.0)), ctx)")
edit(r, ".rounded_full()", ".rounded(px(if theme.markdown.nested_list_markers && ctx.list_depth % 3 == 2 { 0.0 } else { number(theme.markdown.list_marker_size,5.0)/2.0 }))")
edit(r, ".items_center().justify_end()", ".items_center().when(theme.markdown.list_indent.is_some(), |el|el.justify_end())")
edit(r, ".text_right().text_color(color(&theme.markdown.list_marker", ".when(theme.markdown.list_indent.is_some(), |el|el.text_right()).text_color(color(&theme.markdown.list_marker")
edit(r, "                .bg(color(&theme.markdown.quote_background, opacity(theme.accent, 0.05)))", "                .bg(color(&theme.markdown.quote_background, opacity(theme.accent, 0.05)))\n                .rounded_tr(px(if theme.markdown.quote_background.is_some(){0.0}else{6.0})).rounded_br(px(if theme.markdown.quote_background.is_some(){0.0}else{6.0}))")

# Package 7: link style is independent of byte ranges/click dispatch.
edit(r, "        out.push(TextRun {", "        if run.style.link.is_some() { f.weight = FontWeight(number(theme.markdown.link.weight, f.weight.0).clamp(1.0, 1000.0)); }\n        out.push(TextRun {")
edit(r, "            color: if run.style.code {", "            color: if run.style.link.is_some() { color(&theme.markdown.link.color, theme.text) } else if run.style.code {")
edit(r, "underline: run.style.link.is_some().then_some(UnderlineStyle {", "underline: (run.style.link.is_some() && !matches!(theme.markdown.link.underline.as_deref(), Some(\"none\" | \"hover\"))).then_some(UnderlineStyle {")
edit(r, "                color: Some(theme.text_muted),\n                thickness: px(1.0),", "                color: Some(color(&theme.markdown.link.color, theme.text_muted)),\n                thickness: px(1.0),")
edit(r, "        links: flat.links.clone(),", "        hover_link_color: (ctx.theme.markdown.link.underline.as_deref() == Some(\"hover\")).then(||color(&ctx.theme.markdown.link.color, ctx.theme.text)),\n        links: flat.links.clone(),")
edit("text/paint.rs", "    pub links: Vec<(Range<usize>, String)>,", "    pub hover_link_color: Option<Hsla>,\n    pub links: Vec<(Range<usize>, String)>,")
edit("text/paint.rs", "            links: Vec::new(),", "            hover_link_color: None,\n            links: Vec::new(),")
edit("text/paint.rs", "        links,\n        on_link,", "        links,\n        hover_link_color,\n        on_link,")
edit("text/paint.rs", "            if let Some(on_link) = &on_link {", """            if let Some(color) = hover_link_color {
                let hit = |position| layout.index_for_position(position).ok().and_then(|ix| links.iter().position(|(r,_)|r.contains(&ix)));
                let hovered = hit(window.mouse_position());
                if let Some(index) = hovered {
                    for mut rect in range_rects(&layout, &links[index].0, 0.0, 0.0) {
                        rect.origin.y += rect.size.height - gpui::px(2.0);
                        rect.size.height = gpui::px(1.0);
                        window.paint_quad(quad(rect, gpui::px(0.0), color, gpui::px(0.0), gpui::transparent_black(), Default::default()));
                    }
                }
                let layout=layout.clone(); let links=links.clone();
                window.on_mouse_event(move |event: &gpui::MouseMoveEvent, phase, window, _cx| {
                    if phase != gpui::DispatchPhase::Bubble { return; }
                    let next=layout.index_for_position(event.position).ok().and_then(|ix|links.iter().position(|(r,_)|r.contains(&ix)));
                    if next != hovered { window.refresh(); }
                });
            }
            if let Some(on_link) = &on_link {""")
