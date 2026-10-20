# Native-crate half of stroke_draw_gpui.py (motion10): `paintAnimation: {kind: 'stroke'}` on an `<svg>` wraps it in
# `stroke_draw::apply`. Executed from apply_hooks.py after the render9 hooks.
edit('lib.rs', 'mod cache_island;', 'mod cache_island;\nmod stroke_draw;')
edit('renderer.rs', '    let built = crate::paint_replay::apply(built, element, style);', '    let built = crate::paint_replay::apply(built, element, style);\n    let built = crate::stroke_draw::apply(built, element);')
edit('renderer.rs', '        crate::subtree_transform::arm(self,window,cx);', '        crate::subtree_transform::arm(self,window,cx);\n        crate::stroke_draw::arm(&self.clock);')
