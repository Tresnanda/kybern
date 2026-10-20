# Native-crate half of hover_fade_gpui.py (N1): host divs whose hover/active style changes a colour take the nearest
# `hoverTransition` declaration. Executed from apply_hooks.py after its main write.
edit("lib.rs", "mod subtree_transform;", "mod subtree_transform;\nmod hover_fade;")
edit("renderer.rs", "    if let Some(style) = style {\n        el = apply_interactive_styles(el, style);\n", """    if let Some(style) = style {
        el = apply_interactive_styles(el, style);
        if crate::hover_fade::fades(style) {
            if let Some(transition) = crate::hover_fade::transition_for(element, ctx.tree) { el = el.color_transition(transition); }
        }
""")
(src / "lib.rs").write_text(pending["lib.rs"])
(src / "renderer.rs").write_text(pending["renderer.rs"])
