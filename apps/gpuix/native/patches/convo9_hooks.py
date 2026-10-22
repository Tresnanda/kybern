# Executed by apply_hooks.py after the other hook files (convo9 lane, phase 2).
# Transcript Markdown rhythm and the file drag-over style. Additive: every new
# control is optional and defaults to the previous rendering.
r = "markdown/render.rs"
# A rule keeps its own margin (desktop `.chat-markdown hr { margin: 1.5rem 0 }`).
edit(r, "        } else { (theme.metrics.md_block_gap, theme.metrics.md_block_gap) };",
        "        } else if matches!(block, Block::Rule) { let rule = number(theme.markdown.rule_margin, theme.metrics.md_block_gap); (rule, rule) } else { (theme.metrics.md_block_gap, theme.metrics.md_block_gap) };")
# A nested list's bottom margin collapses with the next item's gap (`ul ul { margin: .65rem 0 }`).
edit(r, "            for (item_ix, item) in items.iter().enumerate() {\n                // Ordered numbers",
        "            for (item_ix, item) in items.iter().enumerate() {\n                let after_list = item_ix > 0 && matches!(items[item_ix - 1].last(), Some(Block::List { .. }));\n                // Ordered numbers")
edit(r, "                    div().flex().flex_row().gap(px(number(theme.markdown.list_marker_gap, 8.0))).child(marker).child(",
        "                    div().when(after_list, |el| el.mt(px((number(theme.markdown.list_child_gap, 4.0) - number(theme.markdown.list_item_gap, 4.0)).max(0.0)))).flex().flex_row().gap(px(number(theme.markdown.list_marker_gap, 8.0))).child(marker).child(")
# Bullet discs have their own gap, so `1.` and a disc can sit where WebKit puts them.
edit(r, "                                .ml(px(1.0))\n                                .w(px(number(theme.markdown.list_marker_size, 5.0)))",
        "                                .ml(px(1.0))\n                                .mr(px((number(theme.markdown.list_bullet_gap, number(theme.markdown.list_marker_gap, 8.0)) - number(theme.markdown.list_marker_gap, 8.0)).max(0.0)))\n                                .w(px(number(theme.markdown.list_marker_size, 5.0)))")
# `dragOver`: a style applied while a Finder file drag hovers the element.
edit("style.rs", "    pub active: Option<Box<StyleDesc>>,\n    /// While focused after keyboard input", "    pub active: Option<Box<StyleDesc>>,\n    pub drag_over: Option<Box<StyleDesc>>,\n    /// While focused after keyboard input")
edit("renderer.rs", "    if let Some(active_style) = style.active.as_deref() {\n        el = el.active(|refinement| apply_styles(refinement, active_style));\n    }\n    // `focusVisible` needs",
     "    if let Some(active_style) = style.active.as_deref() {\n        el = el.active(|refinement| apply_styles(refinement, active_style));\n    }\n    if let Some(drag_style) = style.drag_over.as_deref() {\n        let drag_style = drag_style.clone();\n        el = el.drag_over::<gpui::ExternalPaths>(move |refinement, _, _, _| apply_styles(refinement, &drag_style));\n    }\n    // `focusVisible` needs")

# Automation: a Finder drag that enters and hovers without dropping, so `dragOver`
# styles can be checked. `phase`: "enter" (Entered + Pending), "move" (Pending), "exit" (Ended).
edit("renderer.rs", "    pub fn simulate_file_drop(&self, x: f64, y: f64, paths: Vec<String>) -> Result<()> {",
'''    pub fn simulate_file_drag(&self, x: f64, y: f64, paths: Vec<String>, phase: String) -> Result<()> {
        if !x.is_finite() || !y.is_finite() { return Err(Error::from_reason("Expected a finite position")); }
        update_window_without_view(move |window, cx| {
            use gpui::InputEvent;
            let position=gpui::point(gpui::px(x as f32),gpui::px(y as f32));
            match phase.as_str() {
                "enter" => {
                    let paths=gpui::ExternalPaths(paths.into_iter().map(std::path::PathBuf::from).collect());
                    window.dispatch_event(gpui::FileDropEvent::Entered { position, paths }.to_platform_input(),cx);
                    window.dispatch_event(gpui::FileDropEvent::Pending { position }.to_platform_input(),cx);
                }
                "move" => { window.dispatch_event(gpui::FileDropEvent::Pending { position }.to_platform_input(),cx); }
                _ => { window.dispatch_event(gpui::FileDropEvent::Ended.to_platform_input(),cx); }
            }
        })
    }
    #[napi]
    pub fn simulate_file_drop(&self, x: f64, y: f64, paths: Vec<String>) -> Result<()> {''')

# ---- link icons, live-answer caret and fade (markdown), composer token icons ----
edit("lib.rs", "mod cache_island;", "mod cache_island;\nmod kybern_icon;")
edit(r, 'include!("../markdown_inline.rs");', 'include!("../markdown_inline.rs");\ninclude!("../markdown_stream.rs");')
edit(r, "    pub code_ranges: Vec<Range<usize>>,\n}", "    pub code_ranges: Vec<Range<usize>>,\n    /// `(byte index, image)` for links that lead with an icon; the two placeholder characters at the index reserve its room.\n    pub icons: Vec<(usize, Arc<gpui::RenderImage>)>,\n}")
edit(r, "    let mut code_ranges: Vec<Range<usize>> = Vec::new();\n\n    for run in runs {", "    let mut code_ranges: Vec<Range<usize>> = Vec::new();\n    let mut icons: Vec<(usize, Arc<gpui::RenderImage>)> = Vec::new();\n\n    for run in runs {")
edit(r, "        let start = text.len();\n        text.push_str(&run.text);\n",
"""        let mut link_from = None;
        if let Some(url) = &run.style.link {
            let continues = links.last().is_some_and(|(range, last)| range.end == text.len() && last == url);
            if !continues {
                if let Some(image) = theme.markdown.link_icons.iter().find(|icon| url.starts_with(&icon.prefix)).and_then(|icon| crate::kybern_icon::image(&icon.svg, &icon.color)) {
                    link_from = Some(text.len());
                    icons.push((text.len(), image));
                    text.push_str("  ");
                    out.push(TextRun { len: 2, font: font(theme.font_mono.clone()), color: gpui::transparent_black(), background_color: None, underline: None, strikethrough: None });
                }
            }
        }
        let start = text.len();
        text.push_str(&run.text);
""")
edit(r, "                _ => links.push((start..text.len(), url.clone())),", "                _ => links.push((link_from.unwrap_or(start)..text.len(), url.clone())),")
edit(r, "        links,\n        code_ranges,\n    }\n}", "        links,\n        code_ranges,\n        icons,\n    }\n}")
edit(r, "    list_depth: usize,\n    /// Called with the URL", "    list_depth: usize,\n    text_total: usize,\n    text_seen: usize,\n    stream_final: bool,\n    animating: bool,\n    caret: Option<Hsla>,\n    /// Called with the URL")
edit(r, "            list_depth: 0,\n            on_link,", "            list_depth: 0,\n            text_total: 0,\n            text_seen: 0,\n            stream_final: false,\n            animating: false,\n            caret: None,\n            on_link,")
edit(r, "pub fn render_tree(tree: &BlockTree, ctx: &mut MdContext, window: &Window) -> AnyElement {",
"""pub fn render_tree(tree: &BlockTree, ctx: &mut MdContext, window: &Window) -> AnyElement {
    ctx.text_total = count_text(&tree.blocks);
    ctx.text_seen = 0;
    ctx.stream_final = ctx.theme.markdown.stream.is_some() && ends_with_text(&tree.blocks);
    let out = render_tree_inner(tree, ctx, window);
    // The newest words are still fading in: another frame, until they have settled.
    if ctx.animating { window.request_animation_frame(); }
    out
}

fn render_tree_inner(tree: &BlockTree, ctx: &mut MdContext, window: &Window) -> AnyElement {""")
edit(r, "    let flat = flatten_runs(runs, &ctx.theme, weight);\n    let inner = inline_element(&flat, size, line_height, None, ctx);",
        "    let mut flat = flatten_runs(runs, &ctx.theme, weight);\n    ctx.text_seen += 1;\n    if ctx.stream_final && ctx.text_seen == ctx.text_total { stream_prepare(&mut flat, ctx); }\n    let inner = inline_element(&flat, size, line_height, None, ctx);")
edit(r, "fn flat_text_element(flat: &FlatText, ctx: &mut MdContext) -> AnyElement {", "fn flat_text_element(flat: &FlatText, size: f32, ctx: &mut MdContext) -> AnyElement {")
edit(r, "    let code_ranges = flat.code_ranges.clone();\n    let wash = ctx.theme.code_wash;", "    let code_ranges = flat.code_ranges.clone();\n    let icons = flat.icons.clone();\n    let caret = ctx.caret.take();\n    let text_len = flat.text.len();\n    let wash = ctx.theme.code_wash;")
edit(r, "    let extra: Option<Box<dyn Fn(&gpui::TextLayout, &mut gpui::Window)>> = if code_ranges.is_empty()\n    {", "    let extra: Option<Box<dyn Fn(&gpui::TextLayout, &mut gpui::Window)>> = if code_ranges.is_empty() && icons.is_empty() && caret.is_none()\n    {")
edit(r, "            }\n        }))\n    };\n\n    // Selection and link interaction are independent", "            }\n            paint_decorations(layout, window, &icons, 2, caret, text_len, size);\n        }))\n    };\n\n    // Selection and link interaction are independent")
edit("custom_elements/markdown.rs", "        _cx: &mut gpui::Context<crate::renderer::GpuixView>,\n    ) -> gpui::AnyElement {\n        use gpui::prelude::*;\n", "        cx: &mut gpui::Context<crate::renderer::GpuixView>,\n    ) -> gpui::AnyElement {\n        use gpui::prelude::*;\n        crate::kybern_icon::set_renderer(cx.svg_renderer());\n")

# A chip's label has its own colour and weight.
edit(r, "        if run.style.link.is_some() { f.weight = FontWeight(number(theme.markdown.link.weight, f.weight.0).clamp(1.0, 1000.0)); }",
"""        if run.style.link.is_some() { f.weight = FontWeight(number(theme.markdown.link.weight, f.weight.0).clamp(1.0, 1000.0)); }
        let chip = run.style.link.as_ref().and_then(|url| theme.markdown.link_icons.iter().find(|icon| url.starts_with(&icon.prefix)));
        if let Some(weight) = chip.and_then(|icon| icon.weight) { f.weight = FontWeight(weight); }
        let link_color = chip.and_then(|icon| icon.text_color.clone()).or_else(|| theme.markdown.link.color.clone());""")
edit(r, "            color: if run.style.link.is_some() { color(&theme.markdown.link.color, theme.text) } else if run.style.code {", "            color: if run.style.link.is_some() { color(&link_color, theme.text) } else if run.style.code {")
