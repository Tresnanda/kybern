# Staged atomic hooks: styles do not change upstream defaults.
edit("lib.rs", "mod cache_island;", "mod cache_island;\nmod diff_style;")
edit("theme.rs", "    pub metrics: Metrics,", "    pub metrics: Metrics,\n    pub diff: crate::diff_style::DiffStyle,")
edit("theme.rs", "            metrics: Metrics::default(),", "            metrics: Metrics::default(),\n            diff: Default::default(),", 2)
edit("theme.rs", "    pub metrics: Option<MetricsOverride>,", "    pub metrics: Option<MetricsOverride>,\n    pub diff: Option<crate::diff_style::DiffStyle>,")
edit("theme.rs", "        if let Some(metrics) = &o.metrics {", "        if let Some(diff) = &o.diff { self.diff = diff.clone(); }\n        if let Some(metrics) = &o.metrics {")
r="custom_elements/diff.rs"
edit(r, "use crate::theme::Theme;", "use crate::theme::Theme;\nuse crate::markdown_style::{number, color};\ninclude!(\"../diff_layout.rs\");")
edit(r, "        let highlights = files.iter().map(file_highlight).collect();", "        let highlights = files.iter().map(|f| if self.theme.diff.syntax_highlight.unwrap_or(true) { file_highlight(f) } else { None }).collect();")
edit(r, "        let rows = flatten_rows(&files, |path| collapsed.contains(path), self.max_lines);", """        let mut rows = flatten_rows(&files, |path| collapsed.contains(path), self.max_lines);
        rows.retain(|r| match r {
            DiffRow::FileHeader { .. } => self.theme.diff.file_headers.unwrap_or(true),
            DiffRow::Notice { .. } => self.theme.diff.notices.unwrap_or(true),
            _ => true,
        });""")
edit(r, "        self.patch.hash(&mut hasher);", """        self.patch.hash(&mut hasher);
        self.theme.diff.file_headers.hash(&mut hasher);
        self.theme.diff.notices.hash(&mut hasher);
        self.theme.diff.syntax_highlight.hash(&mut hasher);""")
# Preserve virtualization and no-wrap horizontal reachability. Width is measured
# once per patch/font/size, with only the longest candidate shaped (bounded work).
edit(r, "    list_metrics: Option<u64>,", "    list_metrics: Option<u64>,\n    content_width: Option<(u64, f32)>,\n    horizontal_scroll: gpui::ScrollHandle,\n    viewport_width: std::rc::Rc<std::cell::Cell<f32>>, ")
edit(r, "        let row_theme = theme.clone();", """        let row_theme = theme.clone();
        let content_width = if theme.diff.horizontal_scroll {
            use std::hash::{Hash, Hasher};
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            self.fingerprint.hash(&mut hash); theme.font_mono.hash(&mut hash);
            metrics.diff_text_size.to_bits().hash(&mut hash);
            metrics.hash_diff_layout_into(&mut hash);
            let key = hash.finish();
            if self.content_width.map(|c|c.0) != Some(key) {
                let longest = data.files.iter().flat_map(|f|f.hunks.iter()).flat_map(|h|h.lines.iter())
                    .max_by_key(|l|l.text.chars().count()).map(|l|l.text.clone()).unwrap_or_default();
                let runs = runs_for_spans(&longest, &[], &gpui::font(theme.font_mono.clone()), theme.text);
                let shaped = _window.text_system().shape_line(longest.into(), px(metrics.diff_text_size), &runs, None);
                let gutters = data.files.iter().map(|f| {let g=diff_gutters(f,&theme);g.0+g.1}).fold(0.0, f32::max);
                self.content_width = Some((key,f32::from(shaped.width()) + gutters + metrics.diff_marker_width + 36.0));
            }
            self.content_width.unwrap().1
        } else { 0.0 };""")
edit(r, "            .flex_1()\n            .into_any_element()", "            .flex_1()\n            .min_w(px(content_width))\n            .into_any_element()")
edit(r, "let mut column = gpui::div().flex().flex_col();", "let mut column = gpui::div().flex().flex_col().min_w(px(content_width));")
edit(r, "        if self.scroll {\n            container = container.min_h_0();", "        if theme.diff.horizontal_scroll { container = container.min_w_0(); }\n        if self.scroll {\n            container = container.min_h_0();")
# Table hunk chrome matches the desktop's two gutters followed by its label.
edit(r, "            gpui::div()\n                .h(px(m.diff_hunk_header_height))", """            if theme.diff.table_layout {
                let label = header.split("@@").nth(2).unwrap_or("").trim();
                let label = if !label.is_empty() { label.to_string() } else {
                    let range = header.split("@@").nth(1).unwrap_or("").split_whitespace().find(|s|s.starts_with('+')).unwrap_or("+0,0");
                    let mut numbers = range[1..].split(',');
                    let start = numbers.next().and_then(|s|s.parse::<u32>().ok()).unwrap_or(0);
                    let count = numbers.next().and_then(|s|s.parse::<u32>().ok()).unwrap_or(1);
                    format!("Lines {}–{}",start,start.saturating_add(count.saturating_sub(1)))
                };
                let gutters = data.files.get(file as usize).map(|f|diff_gutters(f,theme)).unwrap_or((m.diff_gutter_width,m.diff_gutter_width));
                return gpui::div().h(px(m.diff_hunk_header_height + if hunk>0 {1.0} else {0.0})).border_t(px(if hunk>0 {1.0} else {0.0})).border_color(theme.border).w_full().flex_none().flex().items_center()
                    .bg(theme.diff_hunk_bg).font_family(theme.font_sans.clone()).text_size(px(11.0)).text_color(theme.text_muted)
                    .child(gpui::div().w(px(gutters.0+gutters.1)).flex_none().pr(px(8.0)).flex().justify_end().text_size(px(m.diff_text_size)).text_color(color(&theme.diff.number_color,theme.text_faint)).child(crate::text::chrome_text("⋯".into(),None)))
                    .child(gpui::div().pl(px(number(theme.diff.gutter_digit_width,m.diff_text_size*0.62415)*11.0/m.diff_text_size*1.25)).child(crate::text::chrome_text(label.into(),None))).into_any_element();
            }
            gpui::div()
                .h(px(m.diff_hunk_header_height))""")
edit(r, "    let (marker, marker_color, row_bg, accent, number_color) = match line.kind {", "    let (marker, marker_color, row_bg, accent, number_color) = match line.kind {")
edit(r, "            Some(add_bg),", "            Some(color(&theme.diff.add_background, add_bg)),")
edit(r, "            Some(del_bg),", "            Some(color(&theme.diff.delete_background, del_bg)),")
edit(r, '            "−",', '            theme.diff.delete_marker.as_deref().unwrap_or("−"),')
edit(r, '            "·",', '            theme.diff.context_marker.as_deref().unwrap_or("·"),')
edit(r, "    let gutter = |no: Option<u32>, color: Hsla| {", """    let gutter = |no: Option<u32>, fallback: Hsla| {
        let background = match line.kind {
            LineKind::Add => color(&theme.diff.add_gutter_background,gpui::transparent_black()),
            LineKind::Del => color(&theme.diff.delete_gutter_background,gpui::transparent_black()),
            _ => gpui::transparent_black(),
        };""")
edit(r, "            .w(px(gutter_px))\n            .flex_none()\n            .font_family(theme.font_mono.clone())\n            .text_size(px(11.0))\n            .text_color(color)", """            .w(px(gutter_px)).h_full().items_center().bg(background)
            .flex_none()
            .font_family(theme.diff.gutter_font.clone().unwrap_or(theme.font_mono.clone()))
            .text_size(px(number(theme.diff.gutter_text_size,11.0)))
            .text_color(color(&theme.diff.number_color,fallback))""")
edit(r, "            .pr(px(8.0))", "            .pr(px(number(theme.diff.gutter_padding_right,8.0)))")
edit(r, "opacity(theme.text, 0.92));", "color(&theme.diff.text_color,opacity(theme.text, 0.92)));")
edit(r, "                .pl(px(12.0))\n                .font_family(theme.font_mono.clone())", "                .pl(px(number(theme.diff.content_padding_left,12.0)))\n                .font_family(theme.font_mono.clone())")
# Align markers immediately before source; table content inset belongs before it.
edit(r, "                .w(px(m.diff_marker_width))", "                .w(px(m.diff_marker_width + if theme.diff.table_layout {m.diff_marker_width / 1.5 * 1.25} else {0.0}))\n                .pl(px(if theme.diff.table_layout {m.diff_marker_width / 1.5 * 1.25} else {0.0}))")

edit(r,"        let theme = self.theme.clone();", """        let mut theme = self.theme.clone();
        if theme.diff.table_layout && theme.diff.gutter_digit_width.is_none() {
            let mut font=gpui::font(theme.diff.gutter_font.clone().unwrap_or(theme.font_sans.clone()));
            font.features=gpui::FontFeatures(std::sync::Arc::new(vec![("tnum".into(),1)]));
            let runs=runs_for_spans("0",&[],&font,theme.text);
            theme.diff.gutter_digit_width=Some(f32::from(_window.text_system().shape_line("0".into(),px(number(theme.diff.gutter_text_size,theme.metrics.diff_text_size)),&runs,None).width()));
        }""")
edit(r,"                gutter_width(file_diff, m),","                diff_gutters(file_diff, theme),")
edit(r,"    gutter_px: f32,","    gutters: (f32,f32),")
edit(r,"                + 2.0 * gutter_px","                + gutters.0 + gutters.1")
edit(r,"    let gutter = |no: Option<u32>, fallback: Hsla| {","    let gutter = |no: Option<u32>, fallback: Hsla, old: bool| {")
edit(r,".w(px(gutter_px)).h_full()",".w(px(if old {gutters.0} else {gutters.1})).h_full()")
edit(r,".pr(px(number(theme.diff.gutter_padding_right,8.0)))",".pr(px(if theme.diff.table_layout && old {4.0} else {number(theme.diff.gutter_padding_right,8.0)}))\n            .font_features(if theme.diff.table_layout {gpui::FontFeatures(std::sync::Arc::new(vec![(\"tnum\".into(),1)]))} else {Default::default()})")
edit(r,"        .child(gutter(\n            line.old_no,", "        .child(gutter(\n            line.old_no,")
edit(r,"                opacity(theme.text_faint, 0.8)\n            },\n        ))", "                opacity(theme.text_faint, 0.8)\n            },\n            true,\n        ))",2)
# Second gutter is the new side.
text=pending[r];a=text.index(".child(gutter(\n            line.new_no,");b=text.index("        .child(",a+5)
edit(r,text[a:b],text[a:b].replace("            true,","            false,"))
edit(r,"        super::custom_surface(container, &ctx)\n            .child(body)\n            .into_any_element()", """        if theme.diff.horizontal_scroll {
            let viewport=self.viewport_width.clone();let view=_cx.entity().downgrade();
            let observer=gpui::canvas(move |bounds,_,cx| {
                let width=f32::from(bounds.size.width);
                if (viewport.get()-width).abs()>0.1 {
                    viewport.set(width);let view=view.clone();cx.defer(move |cx|{let _=view.update(cx,|_,cx|cx.notify());});
                }
            },|_,_,_,_|{}).absolute().size_full();
            let mut scrolling=gpui::div().id(SharedString::from(format!("__gpuix_diff_scroll_{}",ctx.id)))
                .w_full().min_w_0().flex().flex_col().overflow_x_scroll().track_scroll(&self.horizontal_scroll).child(body);
            if self.scroll {scrolling=scrolling.flex_1().min_h_0();}
            let height=number(theme.diff.scrollbar_height,0.0);
            let show=height>0.0 && self.viewport_width.get()>0.0 && content_width>self.viewport_width.get();
            let mut surface=super::custom_surface(container,&ctx).child(observer).child(scrolling);
            if show {surface=surface.child(diff_scrollbar(self.horizontal_scroll.clone(),height,color(&theme.diff.scrollbar_color,ink(&theme,0.1)),ctx.id));}
            return surface.into_any_element();
        }
        super::custom_surface(container, &ctx).child(body).into_any_element()""")

# Match bounded expansion copy without changing the event's remaining count.
edit(r,"    let label = if remaining == 1 {", "    let displayed = theme.diff.show_more_batch.filter(|n|*n>0).map(|n|remaining.min(n)).unwrap_or(remaining);\n    let label = if displayed == 1 {")
edit(r,'format!("Show {remaining} more lines")','format!("Show {displayed} more lines")')
# The native row callback remains useful for row clicks. A gutter click has an
# explicit side, including context lines present on both sides; stop bubbling.
edit(r,"        gpui::div()\n            .w(px(if old {gutters.0} else {gutters.1}))", """        let mut gutter = gpui::div().id(SharedString::from(format!("__gpuix_diff_gutter_{}_{}_{}",ctx.element_id,ix,old)))
            .w(px(if old {gutters.0} else {gutters.1}))""")
edit(r,"                None,\n            ))\n    };\n\n    let mono:", """                None,
            ));
        if ctx.wants_line_click && no.is_some() {
            let callback=ctx.callback.clone();let element_id=ctx.element_id;let text=line.text.clone();
            gutter=gutter.cursor_pointer().on_click(move |_,_,cx| {
                cx.stop_propagation();
                emit_event_full(&callback,element_id,"lineClick",|p|{
                    p.value=Some(text.clone());p.old_line=if old {no.map(f64::from)} else {None};
                    p.new_line=if old {None} else {no.map(f64::from)};
                });
            });
        }
        gutter
    };

    let mono:""")

edit(r,"                .justify_center()\n                .text_size(px(m.diff_text_size))", "                .when(theme.diff.table_layout,|s|s.justify_start()).when(!theme.diff.table_layout,|s|s.justify_center())\n                .text_size(px(m.diff_text_size))")
