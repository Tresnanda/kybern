# `<textarea codeEditor>` (ADE-61): the file-tab code editor. Implementation in code_editor.rs.
i = "custom_elements/input.rs"
edit(i, 'include!("../input_decorations.rs");', 'include!("../input_decorations.rs");\ninclude!("../code_editor.rs");')

# Element props, forwarded to the editor state on every render.
edit(i, "    key_interceptor: Option<gpui::Subscription>,\n    secure: bool,\n}", "    key_interceptor: Option<gpui::Subscription>,\n    secure: bool,\n    code: CodeEditorProps,\n    theme_generation: u64,\n}")
edit(i, "            key_interceptor: None,\n            secure: false,\n        }", "            key_interceptor: None,\n            secure: false,\n            code: CodeEditorProps::default(),\n            theme_generation: 0,\n        }")
edit(i, '            "value" => self.value = value.as_str().unwrap_or_default().to_string(),', '            key if code_editor_prop(&mut self.code, key, &value) => {}\n            "value" => self.value = value.as_str().unwrap_or_default().to_string(),')
edit(i, '            "theme" => self.theme = Theme::from_prop(Some(&value)),', '            "theme" => {\n                self.theme = Theme::from_prop(Some(&value));\n                self.theme_generation += 1;\n            }')
edit(i, '            "secure",\n            "theme",\n', '            "secure",\n            "theme",\n            "codeEditor",\n            "softWrap",\n            "showLineNumbers",\n            "syntaxDocument",\n            "syntaxRevision",\n            "revealLine",\n')
edit(i, "                state.sync_prop_value(self.value.clone(), cx);\n            }\n", "                state.sync_prop_value(self.value.clone(), cx);\n            }\n            state.apply_code_props(&self.code, &self.theme, self.theme_generation, cx);\n")

# Editor state.
edit(i, "    last_edit: Option<LastEdit>,\n}\n", "    last_edit: Option<LastEdit>,\n    code: CodeEditor,\n}\n")
edit(i, "                    last_edit: None,\n                })", "                    last_edit: None,\n                    code: CodeEditor::default(),\n                })")

# Layout: syntax runs and the text column's wrap width (none without soft wrap).
edit(i, "        let runs = if !is_placeholder && !self.secure { self.decorated_runs(style, color) } else { runs };\n        let wrap_width = self.multiline.then_some(width);",
     "        let code_runs = !is_placeholder && self.code_runs(style, color);\n"
     "        let runs = if code_runs {\n"
     "            std::mem::take(&mut self.code.runs.as_mut().unwrap().runs)\n"
     "        } else if !is_placeholder && !self.secure { self.decorated_runs(style, color) } else { runs };\n"
     "        let wrap_width = self.code_wrap_width(width, style, font_size, window);")
edit(i, "            .shape_text(display, font_size, &runs, wrap_width, None)\n            .map(|lines| lines.into_vec())\n            .unwrap_or_default();",
     "            .shape_text(display, font_size, &runs, wrap_width, None)\n            .map(|lines| lines.into_vec())\n            .unwrap_or_default();\n"
     "        if code_runs {\n            if let Some(cache) = self.code.runs.as_mut() { cache.runs = runs; }\n        }")

# Horizontal scrolling for unwrapped code.
edit(i, "                if !self.multiline {\n                    let cursor_left", "                if !self.multiline || self.code_scrolls_x() {\n                    let cursor_left")
edit(i, "        self.scroll_left = if self.multiline {\n            0.0", "        self.scroll_left = if self.multiline && !self.code_scrolls_x() {\n            0.0")
edit(i, "        let Some(bounds) = self.last_bounds else {\n            return;\n        };\n        let viewport_height = f32::from(bounds.size.height);\n        let max_scroll",
     "        if self.code_scroll_wheel(event, cx) {\n            return;\n        }\n        let Some(bounds) = self.last_bounds else {\n            return;\n        };\n        let viewport_height = f32::from(bounds.size.height);\n        let max_scroll")

# The editor fills its box and scrolls inside it.
edit(i, "            .w_full()\n            .min_w_0()\n            .child(EditorTextElement {", "            .w_full()\n            .min_w_0()\n            .when(self.code.props.enabled, |editor| editor.h_full())\n            .child(EditorTextElement {")
edit(i, "        window: &mut Window,\n        _: &mut App,\n    ) -> (LayoutId, ()) {\n        let mut style = Style::default();\n        style.size.width = relative(1.0).into();",
     "        window: &mut Window,\n        cx: &mut App,\n    ) -> (LayoutId, ()) {\n        let mut style = Style::default();\n        style.size.width = relative(1.0).into();\n"
     "        let code = self.input.read(cx).code.props.enabled;\n        if code {\n            style.size.height = relative(1.0).into();\n        }")
edit(i, "            size(width, px(height))\n        });", "            size(width, if code { known.height.unwrap_or(px(height)) } else { px(height) })\n        });")

# Prepaint and paint use the text column; the gutter paints beside it. Rows outside the viewport are skipped.
edit(i, "        _: &mut (),\n        _: &mut Window,\n        cx: &mut App,\n    ) -> EditorPrepaint {", "        _: &mut (),\n        window: &mut Window,\n        cx: &mut App,\n    ) -> EditorPrepaint {\n        self.input.update(cx, |input, _| input.code_prepare(bounds.size.width, window));")
edit(i, "        self.input.update(cx, |input, _| {\n            input.last_bounds = Some(bounds);", "        let bounds = self.input.read(cx).code_text_bounds(bounds);\n        self.input.update(cx, |input, _| {\n            input.code_apply_reveal();\n            input.last_bounds = Some(bounds);")
# Measure never shapes code: the editor fills its box, and prepaint shapes once at the final width.
edit(i, "                let content_height = input.layout_text(width, &text_style, window);", "                let content_height = if code { f32::from(text_style.line_height_in_pixels(window.rem_size())) } else { input.layout_text(width, &text_style, window) };")
edit(i, "        window.with_content_mask(Some(gpui::ContentMask { bounds, ..Default::default() }), |window| {\n            self.input.read(cx).paint_decoration_backgrounds(bounds, window);",
     "        let full_bounds = bounds;\n        let bounds = self.input.read(cx).code_text_bounds(bounds);\n"
     "        let gutter = self.input.read(cx).code_gutter_rows(full_bounds);\n        paint_code_gutter(gutter, full_bounds, window, cx);\n"
     "        window.with_content_mask(Some(gpui::ContentMask { bounds, ..Default::default() }), |window| {\n            self.input.read(cx).paint_decoration_backgrounds(bounds, window);")
edit(i, "            for line in &lines {\n                let height = line.size(line_height).height;\n                line.paint(",
     "            for line in &lines {\n                let height = line.size(line_height).height;\n"
     "                if y + height < bounds.top() {\n                    y += height;\n                    continue;\n                }\n"
     "                if y > bounds.bottom() {\n                    break;\n                }\n                line.paint(")
