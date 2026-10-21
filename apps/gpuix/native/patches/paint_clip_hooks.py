# paintTransform clip (lane polish1): `clipTop/Right/Bottom/Left` + `clipRadius` round-clip a scope while it scales, so an
# image can morph out of its cropped thumbnail into the preview (value, evaluator and mask: subtree_transform.rs and
# subtree_transform_window.rs). Advertised to JS as `paintClip` so the app keeps the plain zoom on an addon without it.
edit('renderer.rs', 'serde_json::json!({"rotate":true,"physicalSprings":true})', 'serde_json::json!({"rotate":true,"physicalSprings":true,"paintClip":true})')
