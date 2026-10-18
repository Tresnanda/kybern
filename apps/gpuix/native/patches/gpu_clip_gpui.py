# Appended after the existing GPUI patches. Keep retained scene/mask identity.
m='crates/gpui_apple/src/metal_renderer.rs'
for field in ['quads', 'underlines', 'polychrome_sprites']:
    edit(m, f'{field}: writer.write(&scene.{field})?,', f'{field}: writer.write_iter(scene.{field}.iter().map(|value| {{ let mut value=*value; value.content_mask=gpu_clip_prune(scene,value.content_mask,value.bounds); value }}))?,')
edit(m, 'monochrome_sprites: writer.write(&scene.monochrome_sprites)?,', '''monochrome_sprites: writer.write_iter(scene.monochrome_sprites.iter().map(|value| {
            let mut value=*value;
            // Native pop, SVG rotation and affine scopes retain their original
            // shader chain. Their transformed raster envelope may exceed bounds.
            if value.transformation == gpui::TransformationMatrix::unit() {
                value.content_mask=gpu_clip_prune(scene,value.content_mask,value.bounds);
            }
            value
        }))?,''')
pending[m] += '\ninclude!("gpu_clip.rs");\n'
for name in ['gpu_clip.rs','gpu_clip_bounds.rs']:
    dest=root/'crates/gpui_apple/src'/name
    text=(here/name).read_text()
    if not dest.exists() or dest.read_text()!=text: dest.write_text(text)
