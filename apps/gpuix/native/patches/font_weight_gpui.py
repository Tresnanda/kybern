# Variable font weights (render9). Executed at the end of backdrop_gpui.py; `font_weight.rs` holds the code.
# A face with a `wght` axis renders the requested CSS weight on that axis (WebKit does the same for SF Pro),
# and CoreText runs of such an instance map back to it by a PostScript-name + wght key.
t = 'crates/gpui_macos/src/text_system.rs'
edit(t, '            let font_id = candidates[ix];\n', '            let font_id = candidates[ix];\n            let font_id = lock.weight_variation(font_id, font.weight.0);\n')
edit(t, '    fn id_for_native_font(&mut self, requested_font: CTFont) -> FontId {\n        let postscript_name = requested_font.postscript_name();', '    fn id_for_native_font(&mut self, requested_font: CTFont) -> FontId {\n        if let Some(font_id) = self.same_face(&requested_font) { return font_id; }\n        let postscript_name = native_font_key(&requested_font);')
pending[t] += '\ninclude!("font_weight.rs");\n'
dest = root / 'crates/gpui_macos/src/font_weight.rs'
text = (here / 'font_weight.rs').read_text()
if not dest.exists() or dest.read_text() != text: dest.write_text(text)
