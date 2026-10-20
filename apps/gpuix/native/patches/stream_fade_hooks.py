# Native-crate half of stream_fade_gpui.py (render9): the Markdown live answer hands its fading words to the
# scene instead of re-rendering faded run colours every frame. Executed from apply_hooks.py after
# convo9_hooks.py and markdown_hooks.py (anchors include lines they write).
r = 'markdown/render.rs'
edit(r, '    pub icons: Vec<(usize, Arc<gpui::RenderImage>)>,\n}', '    pub icons: Vec<(usize, Arc<gpui::RenderImage>)>,\n    /// Fading words of the live answer: (byte range, birth in epoch ms, fade ms).\n    pub fades: Vec<(Range<usize>, f64, f32)>,\n}')
edit(r, '        icons,\n    }\n}', '        icons,\n        fades: Vec::new(),\n    }\n}')
edit(r, 'include!("../markdown_stream.rs");', 'include!("../markdown_stream.rs");\ninclude!("../stream_fade_md.rs");')
edit('markdown_stream.rs', 'if !stream.born.is_empty() && apply_fade(flat, &stream.born, stream.fade_ms.unwrap_or(350.0) as f64) { ctx.animating = true; }', 'if !stream.born.is_empty() && stream_fade(flat, &stream.born, stream.fade_ms.unwrap_or(350.0) as f64) { ctx.animating = true; }')
edit(r, '    let inner = inline_element(&flat, size, line_height, None, ctx);\n    div()\n        .w_full()', '    let fading = !flat.fades.is_empty();\n    let inner = inline_element(&flat, size, line_height, None, ctx);\n    let inner = if fading { FadeEnd { child: inner }.into_any_element() } else { inner };\n    div()\n        .w_full()')
edit(r, '    let icons = flat.icons.clone();\n    let caret = ctx.caret.take();', '    let icons = flat.icons.clone();\n    let fades = flat.fades.clone();\n    let caret = ctx.caret.take();')
edit(r, 'if code_ranges.is_empty() && icons.is_empty() && caret.is_none()\n    {', 'if code_ranges.is_empty() && icons.is_empty() && caret.is_none() && fades.is_empty()\n    {')
edit(r, '            paint_decorations(layout, window, &icons, 2, caret, text_len, size);\n        }))', '            paint_decorations(layout, window, &icons, 2, caret, text_len, size);\n            push_fade_words(layout, window, &fades);\n        }))')
i = 'markdown_inline.rs'
edit(i, '            let size_here = data.size;\n', '''            let size_here = data.size;
            let fades_here: Vec<(Range<usize>, f64, f32)> = data.flat.fades.iter().filter_map(|(r, born, ms)| {
                let a = range.start.max(r.start);
                let b = range.end.min(r.end);
                (a < b).then(|| (a - range.start..b - range.start, *born, *ms))
            }).collect();
''')
edit(i, 'if is_code || !icon_here.is_empty() || caret_here.is_some() {', 'if is_code || !icon_here.is_empty() || caret_here.is_some() || !fades_here.is_empty() {')
edit(i, '                    paint_decorations(layout, window, &icon_here, len.min(2), caret_here, len, size_here);\n', '                    paint_decorations(layout, window, &icon_here, len.min(2), caret_here, len, size_here);\n                    push_fade_words(layout, window, &fades_here);\n')
edit(i, '                icons: flat.icons.clone(),\n            },', '                icons: flat.icons.clone(),\n                fades: flat.fades.clone(),\n            },')
