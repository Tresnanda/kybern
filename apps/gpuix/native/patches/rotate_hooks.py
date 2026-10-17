# Native-crate half of rotate_gpui.py: accept `paintAnimation.kind == "rotate"` on an SVG leaf.
edit('paint_replay.rs', 'if mode != "matrix" && mode != "breathe" && mode != "shimmer"', 'if mode != "matrix" && mode != "breathe" && mode != "shimmer" && mode != "rotate"')
edit('paint_replay.rs', 'shimmer: mode == "shimmer", started:', 'shimmer: mode == "shimmer", rotate: mode == "rotate", started:')
