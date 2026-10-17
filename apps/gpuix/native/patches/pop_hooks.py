# Native-crate half of pop_gpui.py: accept `paintAnimation.kind == "pop"` on a text or SVG leaf.
edit('paint_replay.rs', 'if mode != "matrix" && mode != "breathe" && mode != "shimmer" && mode != "rotate"', 'if mode != "matrix" && mode != "breathe" && mode != "shimmer" && mode != "rotate" && mode != "pop"')
edit('paint_replay.rs', 'rotate: mode == "rotate", started:', 'rotate: mode == "rotate", pop: mode == "pop", started:')
edit('paint_replay.rs', '.and_then(|v| v.as_str()) == Some("shimmer")\n    { return Some(2); }', '.and_then(|v| v.as_str()).is_some_and(|k| k == "shimmer" || k == "pop")\n    { return Some(2); }')
