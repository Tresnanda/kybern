# Native-crate half of shimmer_band_gpui.py (N4): `paintAnimation.highlight` makes a shimmer a true band; `kind: 'hue'`
# is a hue loop on the same passive fills and single-colour leaves as `breathe`. Executed from apply_hooks.py after its main write.
edit('paint_replay.rs', 'if mode != "matrix" && mode != "breathe" && mode != "shimmer" && mode != "rotate" && mode != "pop"', 'if mode != "matrix" && mode != "breathe" && mode != "shimmer" && mode != "rotate" && mode != "pop" && mode != "hue"')
edit('paint_replay.rs', 'pop: mode == "pop", started:', '''pop: mode == "pop",
            band: if mode == "shimmer" { value.get("highlight").and_then(|v| v.as_str()).and_then(crate::color::parse_color_rgba).map(gpui::Hsla::from) } else { None },
            hue: mode == "hue", started:''')
edit('paint_replay.rs', '.and_then(|v| v.as_str()).is_some_and(|k| k == "shimmer" || k == "pop")\n    { return Some(2); }', '.and_then(|v| v.as_str()).is_some_and(|k| k == "shimmer" || k == "pop" || k == "hue")\n    { return Some(2); }')
(src / "paint_replay.rs").write_text(pending["paint_replay.rs"])
