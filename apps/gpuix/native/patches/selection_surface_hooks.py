# Custom content must register the same explicit userSelect start region as
# host div/text nodes. Otherwise an opt-in code/Markdown/diff child still
# hits its select-none app ancestor when a drag begins.
edit("renderer.rs", "fn selection_start_flag(style: Option<&StyleDesc>)", "pub(crate) fn selection_start_flag(style: Option<&StyleDesc>)")
edit("custom_elements/mod.rs", "el = crate::automation::track_host_bounds(el, ctx.id, None, None);", "el = crate::automation::track_host_bounds(el, ctx.id, crate::renderer::selection_start_flag(ctx.style), None);")
for name in ["renderer.rs", "custom_elements/mod.rs"]:
    (src / name).write_text(pending[name])
