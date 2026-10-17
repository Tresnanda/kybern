# Executed by backdrop_gpui.py (editor9 lane, phase 2). Per-run text size inside one
# shaped line: a run whose font carries the feature `kszl` = N is shaped and painted
# at N/1000 of the line's font size. The rich editor uses it for inline code (0.833em)
# and task references (13/15), as the desktop's `.note-prose code` and `.task-ref` do.
# The pseudo feature never reaches CoreText; a scaled font is its own FontId, so
# layout caches and glyph atlases key on it naturally.
m = 'crates/gpui_macos/src/text_system.rs'
edit(m, """    postscript_names_by_font_id: HashMap<FontId, String>,
}""", """    postscript_names_by_font_id: HashMap<FontId, String>,
    /// Kybern: FontIds loaded with the `kszl` size feature, and their scale.
    font_scales: HashMap<FontId, f32>,
    /// Kybern: every FontId per PostScript name, to map shaped runs back to a scaled id.
    font_ids_by_postscript_name_all: HashMap<String, Vec<FontId>>,
}""")
edit(m, """            postscript_names_by_font_id: HashMap::default(),
        }))""", """            postscript_names_by_font_id: HashMap::default(),
            font_scales: HashMap::default(),
            font_ids_by_postscript_name_all: HashMap::default(),
        }))""")
edit(m, """        let mut font_ids = SmallVec::new();
        let mut postscript_names_seen = HashSet::default();""", """        let mut font_ids = SmallVec::new();
        let mut postscript_names_seen = HashSet::default();
        // Kybern: the `kszl` pseudo feature is a size scale, not an OpenType feature.
        let scale = features.0.iter().find(|(tag, _)| tag == "kszl").map(|(_, value)| (*value as f32 / 1000.0).clamp(0.25, 4.0));
        let stripped;
        let features = if scale.is_some() {
            stripped = FontFeatures(std::sync::Arc::new(features.0.iter().filter(|(tag, _)| tag != "kszl").cloned().collect()));
            &stripped
        } else {
            features
        };""")
edit(m, """            let font_id = FontId(self.fonts.len());
            font_ids.push(font_id);
            self.font_ids_by_postscript_name
                .insert(postscript_name.clone(), font_id);""", """            let font_id = FontId(self.fonts.len());
            font_ids.push(font_id);
            if let Some(scale) = scale {
                self.font_scales.insert(font_id, scale);
            }
            self.font_ids_by_postscript_name_all.entry(postscript_name.clone()).or_default().push(font_id);
            if scale.is_none() || !self.font_ids_by_postscript_name.contains_key(&postscript_name) {
                self.font_ids_by_postscript_name
                    .insert(postscript_name.clone(), font_id);
            }""")
edit(m, """    fn id_for_native_font(&mut self, requested_font: CTFont) -> FontId {""", """    /// Kybern: the FontId of a shaped run, matching its point size to a scaled id.
    fn id_for_scaled_native_font(&mut self, requested_font: CTFont, line_size: Pixels) -> FontId {
        let ratio = requested_font.pt_size() as f32 / f32::from(line_size).max(0.01);
        if (ratio - 1.0).abs() > 0.005 {
            if let Some(ids) = self.font_ids_by_postscript_name_all.get(&requested_font.postscript_name()) {
                if let Some(id) = ids.iter().find(|id| self.font_scales.get(id).is_some_and(|s| (s - ratio).abs() < 0.01)) {
                    return *id;
                }
            }
        }
        self.id_for_native_font(requested_font)
    }

    fn id_for_native_font(&mut self, requested_font: CTFont) -> FontId {""")
edit(m, """                let font = &self.fonts[run.font_id.0];

                let font_metrics = font.metrics();
                let font_scale = f32::from(font_size) / font_metrics.units_per_em as f32;""", """                let font = &self.fonts[run.font_id.0];
                let font_size = font_size * self.font_scales.get(&run.font_id).copied().unwrap_or(1.0);

                let font_metrics = font.metrics();
                let font_scale = f32::from(font_size) / font_metrics.units_per_em as f32;""")
edit(m, """            let font_id = self.id_for_native_font(font);""", """            let font_id = self.id_for_scaled_native_font(font, font_size);""")
edit(m, """    fn layout_line(&self, text: &str, font_size: Pixels, font_runs: &[FontRun]) -> LineLayout {
        self.0.write().layout_line(text, font_size, font_runs)
    }""", """    fn layout_line(&self, text: &str, font_size: Pixels, font_runs: &[FontRun]) -> LineLayout {
        self.0.write().layout_line(text, font_size, font_runs)
    }

    fn font_scale(&self, font_id: FontId) -> f32 {
        self.0.read().font_scales.get(&font_id).copied().unwrap_or(1.0)
    }""")
p = 'crates/gpui/src/platform.rs'
edit(p, """    fn layout_line(&self, text: &str, font_size: Pixels, runs: &[FontRun]) -> LineLayout;""", """    fn layout_line(&self, text: &str, font_size: Pixels, runs: &[FontRun]) -> LineLayout;
    /// Kybern: the size scale of a font loaded with the `kszl` feature (1 otherwise).
    fn font_scale(&self, _font_id: FontId) -> f32 {
        1.0
    }""")
t = 'crates/gpui/src/text_system.rs'
edit(t, """impl TextSystem {
    /// Create a new TextSystem with the given platform text system.""", """impl TextSystem {
    /// Kybern: the size scale of a font (`kszl` feature), 1 for ordinary fonts.
    pub fn font_scale(&self, font_id: FontId) -> f32 {
        self.platform_text_system.font_scale(font_id)
    }

    /// Create a new TextSystem with the given platform text system.""")
l = 'crates/gpui/src/text_system/line.rs'
edit(l, """                        window.paint_emoji(
                            glyph_origin + baseline_offset + vertical_offset,
                            run.font_id,
                            glyph.id,
                            layout.font_size,
                        )?;""", """                        window.paint_emoji(
                            glyph_origin + baseline_offset + vertical_offset,
                            run.font_id,
                            glyph.id,
                            layout.font_size * window.text_system().font_scale(run.font_id),
                        )?;""")
edit(l, """                        window.paint_glyph(
                            glyph_origin + baseline_offset + vertical_offset,
                            run.font_id,
                            glyph.id,
                            layout.font_size,
                            color,
                        )?;""", """                        window.paint_glyph(
                            glyph_origin + baseline_offset + vertical_offset,
                            run.font_id,
                            glyph.id,
                            layout.font_size * window.text_system().font_scale(run.font_id),
                            color,
                        )?;""")
