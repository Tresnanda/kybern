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
edit("style.rs", "    pub active: Option<Box<StyleDesc>>,\n}", "    pub active: Option<Box<StyleDesc>>,\n    pub drag_over: Option<Box<StyleDesc>>,\n}")
edit("renderer.rs", "    if let Some(active_style) = style.active.as_deref() {\n        el = el.active(|refinement| apply_styles(refinement, active_style));\n    }\n    el\n}",
     "    if let Some(active_style) = style.active.as_deref() {\n        el = el.active(|refinement| apply_styles(refinement, active_style));\n    }\n    if let Some(drag_style) = style.drag_over.as_deref() {\n        let drag_style = drag_style.clone();\n        el = el.drag_over::<gpui::ExternalPaths>(move |refinement, _, _, _| apply_styles(refinement, &drag_style));\n    }\n    el\n}")

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
