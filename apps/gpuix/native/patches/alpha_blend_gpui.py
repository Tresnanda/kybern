# Source-over alpha for the quad and sprite pipelines. Zed sets the destination alpha factor to `One`, so stacking two
# translucent fills adds their alphas (0.9 + 0.3 reads as 1.0, not 0.93): invisible on an opaque window, wrong on glass,
# where the alpha is what lets the desktop through. The colour channels already blend as premultiplied source-over; only the
# alpha channel needs `OneMinusSourceAlpha`, as the surface pipeline already has.
m = 'crates/gpui_apple/src/metal_renderer.rs'
edit(m, '''    color_attachment.set_source_rgb_blend_factor(metal::MTLBlendFactor::SourceAlpha);
    color_attachment.set_source_alpha_blend_factor(metal::MTLBlendFactor::One);
    color_attachment.set_destination_rgb_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);
    color_attachment.set_destination_alpha_blend_factor(metal::MTLBlendFactor::One);''', '''    color_attachment.set_source_rgb_blend_factor(metal::MTLBlendFactor::SourceAlpha);
    color_attachment.set_source_alpha_blend_factor(metal::MTLBlendFactor::One);
    color_attachment.set_destination_rgb_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);
    color_attachment.set_destination_alpha_blend_factor(if std::env::var("KYBERN_ADDITIVE_ALPHA").as_deref() == Ok("1") { metal::MTLBlendFactor::One } else { metal::MTLBlendFactor::OneMinusSourceAlpha });''')
edit(m, '''    color_attachment.set_source_rgb_blend_factor(metal::MTLBlendFactor::One);
    color_attachment.set_source_alpha_blend_factor(metal::MTLBlendFactor::One);
    color_attachment.set_destination_rgb_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);
    color_attachment.set_destination_alpha_blend_factor(metal::MTLBlendFactor::One);''', '''    color_attachment.set_source_rgb_blend_factor(metal::MTLBlendFactor::One);
    color_attachment.set_source_alpha_blend_factor(metal::MTLBlendFactor::One);
    color_attachment.set_destination_rgb_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);
    color_attachment.set_destination_alpha_blend_factor(if std::env::var("KYBERN_ADDITIVE_ALPHA").as_deref() == Ok("1") { metal::MTLBlendFactor::One } else { metal::MTLBlendFactor::OneMinusSourceAlpha });''')
