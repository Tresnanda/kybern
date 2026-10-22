# ADE-52: let the patched GPUI build and draw on Linux (wgpu) and Windows (Direct3D 11).
# Executed last from backdrop_gpui.py. macOS-only sources are untouched, so this is a
# no-op for the Metal build.
#
# - Backdrop: neither renderer filters, so a backdrop batch draws nothing and the
#   material's own translucent fill (painted as an ordinary quad) is what shows.
wr = 'crates/gpui_wgpu/src/wgpu_renderer.rs'
edit(wr, '            for batch in scene.batches() {\n                match batch {\n',
     '            for batch in scene.batches() {\n                match batch {\n'
     '                    // Kybern: no backdrop filter here; the translucent fill above it still paints.\n'
     '                    PrimitiveBatch::Backdrop(_) => {}\n')
dr = 'crates/gpui_windows/src/directx_renderer.rs'
edit(dr, '            match batch {\n                PrimitiveBatch::Shadows(range) => self.draw_shadows(range.start, range.len()),',
     '            match batch {\n'
     '                // Kybern: no backdrop filter here; the translucent fill above it still paints.\n'
     '                PrimitiveBatch::Backdrop(_) => Ok(()),\n'
     '                PrimitiveBatch::Shadows(range) => self.draw_shadows(range.start, range.len()),')

# - Rounded clip (rounded_clip_gpui.py) on wgpu: `ContentMask` is 24 bytes now
#   (bounds + `rounded_clip` + `clip_generation`), so every WGSL primitive struct
#   declares it, and fragments multiply their coverage by the same analytic
#   chain walk as `shaders.metal`'s `rounded_clip_alpha`, reading the scene's
#   `rounded_clips` from a storage buffer at group 1, binding 1. The WebGL
#   instance transport (no storage buffers) keeps rectangular clips.
import re as _re
ws = 'crates/gpui_wgpu/src/shaders.wgsl'
edit(ws, 'struct Bounds {\n    origin: vec2<f32>,\n    size: vec2<f32>,\n}\n', '''struct Bounds {
    origin: vec2<f32>,
    size: vec2<f32>,
}

// Kybern: gpui's 24-byte ContentMask (rounded_clip_gpui.py).
struct ContentMask {
    bounds: Bounds,
    rounded_clip: u32,
    clip_generation: u32,
}

struct RoundedClipNode {
    bounds: array<f32, 4>,
    radii: array<f32, 4>,
    parent: u32,
}

// Rounded-clip coverage on a fragment colour in this pass's blending convention.
fn apply_rounded_clip(color: vec4<f32>, coverage: f32) -> vec4<f32> {
    if (globals.premultiplied_alpha != 0u) {
        return color * coverage;
    }
    return vec4<f32>(color.rgb, color.a * coverage);
}
''')
for struct, before, after in [
    ('Quad', '    bounds: Bounds,\n    content_mask: Bounds,\n    background: Background,', '    bounds: Bounds,\n    content_mask: ContentMask,\n    background: Background,'),
    ('Shadow', '    corner_radii: Corners,\n    content_mask: Bounds,\n    color: Hsla,', '    corner_radii: Corners,\n    content_mask: ContentMask,\n    color: Hsla,'),
    ('Underline', '    content_mask: Bounds,\n    color: Hsla,\n    thickness: f32,', '    content_mask: ContentMask,\n    color: Hsla,\n    thickness: f32,'),
    ('MonochromeSprite', '    content_mask: Bounds,\n    color: Hsla,\n    tile: AtlasTile,\n    transformation: TransformationMatrix,\n}\n\n\nstruct MonoSpriteVarying', '    content_mask: ContentMask,\n    color: Hsla,\n    tile: AtlasTile,\n    transformation: TransformationMatrix,\n}\n\n\nstruct MonoSpriteVarying'),
    ('PolychromeSprite', '    content_mask: Bounds,\n    corner_radii: Corners,\n    tile: AtlasTile,', '    content_mask: ContentMask,\n    corner_radii: Corners,\n    tile: AtlasTile,'),
]:
    edit(ws, before, after)
edit(ws, '    bounds: Bounds,\n}\n\n\n\nstruct PathRasterizationVarying', '    bounds: Bounds,\n    rounded_clip: u32,\n    pad: u32,\n}\n\n\n\nstruct PathRasterizationVarying')
# Vertex stages: the rectangle is the mask's bounds; the chain handle rides a flat varying.
for name, prim, vary, loc in [('quad', 'quad', 'QuadVarying', 6), ('shadow', 'shadow', 'ShadowVarying', 4),
                              ('underline', 'underline', 'UnderlineVarying', 4), ('mono_sprite', 'sprite', 'MonoSpriteVarying', 4),
                              ('poly_sprite', 'sprite', 'PolySpriteVarying', 4), ('path_rasterization', 'v', 'PathRasterizationVarying', 4)]:
    text = pending.get(ws)
    start = text.index('struct ' + vary + ' {')
    end = text.index('\n}', start)
    text = text[:end] + f'\n    @location({loc}) @interpolate(flat) rounded_clip: u32,' + text[end:]
    vs = text.index('fn vs_' + name + '(')
    ret = text.index('    return out;\n}', vs)
    handle = 'v.rounded_clip' if name == 'path_rasterization' else prim + '.content_mask.rounded_clip'
    text = text[:ret] + f'    out.rounded_clip = {handle};\n' + text[ret:]
    fs = text.index('fn fs_' + name + '(')
    body = text.index('{', fs) + 1
    depth, end = 1, body
    while depth:
        depth += {'{': 1, '}': -1}.get(text[end], 0)
        end += 1
    wrap = 'apply_rounded_clip_premultiplied' if name == 'path_rasterization' else 'apply_rounded_clip'
    # Statement returns only (a comment may say "return"), each wrapped in the clip coverage.
    content = _re.sub(r'^(\s*)return\s+(.+?);', lambda m: f'{m.group(1)}return {wrap}({m.group(2)}, rounded_clip_alpha(input.position.xy, input.rounded_clip));', text[body:end], flags=_re.S | _re.M)
    pending[ws] = text[:body] + content + text[end:]
for prim, tail in [('quad', ')'), ('shadow', ')'), ('underline', ')'), ('sprite', ', sprite.transformation)'), ('sprite', ')')]:
    old = f'{prim}.content_mask{tail};'
    edit(ws, old, f'{prim}.content_mask.bounds{tail};', pending[ws].count(old))
edit(ws, 'fn blend_color(', '''fn apply_rounded_clip_premultiplied(color: vec4<f32>, coverage: f32) -> vec4<f32> {
    return color * coverage;
}

fn blend_color(''')
st = 'crates/gpui_wgpu/src/shaders_storage.wgsl'
pending[st] = pending.get(st, subprocess.check_output(['git', '-C', str(root), 'show', f'HEAD:{st}'], text=True)) + '''
// Kybern: the scene's rounded clip chains (rounded_clip_gpui.py), shared by every pipeline.
@group(1) @binding(1) var<storage, read> b_rounded_clips: array<RoundedClipNode>;

// Coverage of `p` inside rounded chain `id` (0 = rectangular): interior pixels
// take comparisons only; corner pixels evaluate one circle distance per link.
fn rounded_clip_alpha(p: vec2<f32>, chain: u32) -> f32 {
    var id = chain;
    var coverage = 1.0;
    loop {
        if (id == 0u || id >= arrayLength(&b_rounded_clips)) {
            break;
        }
        let n = b_rounded_clips[id];
        let lo = vec2<f32>(n.bounds[0], n.bounds[1]);
        let size = vec2<f32>(n.bounds[2], n.bounds[3]);
        let right = p.x >= lo.x + size.x / 2.0;
        let bottom = p.y >= lo.y + size.y / 2.0;
        var r = n.radii[0];
        if (right && !bottom) { r = n.radii[1]; }
        if (right && bottom) { r = n.radii[2]; }
        if (!right && bottom) { r = n.radii[3]; }
        let c = lo + vec2<f32>(select(r, size.x - r, right), select(r, size.y - r, bottom));
        let q = vec2<f32>(select(c.x - p.x, p.x - c.x, right), select(c.y - p.y, p.y - c.y, bottom));
        let distance = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
        if (any(p < lo) || any(p >= lo + size) || distance >= 0.5) {
            return 0.0;
        }
        coverage = min(coverage, saturate(0.5 - distance));
        id = n.parent;
    }
    return coverage;
}
'''
wg = 'crates/gpui_wgpu/src/shaders_webgl.wgsl'
edit(wg, 'fn read_corners(cursor: ptr<function, InstanceCursor>) -> Corners {', '''fn read_content_mask(cursor: ptr<function, InstanceCursor>) -> ContentMask {
    return ContentMask(read_bounds(cursor), read_word(cursor), read_word(cursor));
}

// Kybern: no storage buffer for the rounded chains here; clips stay rectangular.
fn rounded_clip_alpha(p: vec2<f32>, chain: u32) -> f32 {
    return 1.0;
}

fn read_corners(cursor: ptr<function, InstanceCursor>) -> Corners {''')
for old, new in [
    ('instance_cursor(instance_id * 40u);\n    return Quad(\n        read_word(&cursor),\n        read_word(&cursor),\n        read_bounds(&cursor),\n        read_bounds(&cursor),',
     'instance_cursor(instance_id * 42u);\n    return Quad(\n        read_word(&cursor),\n        read_word(&cursor),\n        read_bounds(&cursor),\n        read_content_mask(&cursor),'),
    ('instance_cursor(instance_id * 28u);\n    return Shadow(\n        read_word(&cursor),\n        read_f32(&cursor),\n        read_bounds(&cursor),\n        read_corners(&cursor),\n        read_bounds(&cursor),',
     'instance_cursor(instance_id * 30u);\n    return Shadow(\n        read_word(&cursor),\n        read_f32(&cursor),\n        read_bounds(&cursor),\n        read_corners(&cursor),\n        read_content_mask(&cursor),'),
    ('instance_cursor(vertex_id * 26u);\n    return PathRasterizationVertex(\n        read_vec2_f32(&cursor),\n        read_vec2_f32(&cursor),\n        read_background(&cursor),\n        read_bounds(&cursor),',
     'instance_cursor(vertex_id * 28u);\n    return PathRasterizationVertex(\n        read_vec2_f32(&cursor),\n        read_vec2_f32(&cursor),\n        read_background(&cursor),\n        read_bounds(&cursor),\n        read_word(&cursor),\n        read_word(&cursor),'),
    ('instance_cursor(instance_id * 16u);\n    return Underline(\n        read_word(&cursor),\n        read_word(&cursor),\n        read_bounds(&cursor),\n        read_bounds(&cursor),',
     'instance_cursor(instance_id * 18u);\n    return Underline(\n        read_word(&cursor),\n        read_word(&cursor),\n        read_bounds(&cursor),\n        read_content_mask(&cursor),'),
    ('instance_cursor(instance_id * 28u);\n    return MonochromeSprite(\n        read_word(&cursor),\n        read_word(&cursor),\n        read_bounds(&cursor),\n        read_bounds(&cursor),',
     'instance_cursor(instance_id * 30u);\n    return MonochromeSprite(\n        read_word(&cursor),\n        read_word(&cursor),\n        read_bounds(&cursor),\n        read_content_mask(&cursor),'),
    ('instance_cursor(instance_id * 24u);\n    return PolychromeSprite(\n        read_word(&cursor),\n        read_word(&cursor),\n        read_word(&cursor),\n        read_f32(&cursor),\n        read_bounds(&cursor),\n        read_bounds(&cursor),',
     'instance_cursor(instance_id * 26u);\n    return PolychromeSprite(\n        read_word(&cursor),\n        read_word(&cursor),\n        read_word(&cursor),\n        read_f32(&cursor),\n        read_bounds(&cursor),\n        read_content_mask(&cursor),'),
]:
    edit(wg, old, new)
sp = 'crates/gpui_wgpu/src/shaders_subpixel.wgsl'
edit(sp, '    bounds: Bounds,\n    content_mask: Bounds,', '    bounds: Bounds,\n    content_mask: ContentMask,')
edit(sp, '    @location(3) clip_distances: vec4<f32>,\n}', '    @location(3) clip_distances: vec4<f32>,\n    @location(4) @interpolate(flat) rounded_clip: u32,\n}')
edit(sp, 'sprite.content_mask, sprite.transformation);\n    return out;', 'sprite.content_mask.bounds, sprite.transformation);\n    out.rounded_clip = sprite.content_mask.rounded_clip;\n    return out;')
edit(sp, 'out.alpha = vec4<f32>(input.color.a * alpha_corrected, 1.0);', 'out.alpha = vec4<f32>(input.color.a * alpha_corrected * rounded_clip_alpha(input.position.xy, input.rounded_clip), 1.0);')
# Renderer: path vertices carry their chain; instance bind groups carry the chain buffer.
edit(wr, '    color: Background,\n    bounds: Bounds<ScaledPixels>,\n}\n\npub struct WgpuSurfaceConfig', '    color: Background,\n    bounds: Bounds<ScaledPixels>,\n    rounded_clip: u32,\n    pad: u32,\n}\n\npub struct WgpuSurfaceConfig')
edit(wr, '                color: path.color,\n                bounds,\n            }));', '                color: path.color,\n                bounds,\n                rounded_clip: path.content_mask.rounded_clip,\n                pad: 0,\n            }));')
edit(wr, '''        let instances = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("instances_layout"),
            entries: &[instance_data_entry],
        });''', '''        // Kybern: the rounded clip chains sit next to every storage instance binding.
        let rounded_clips_entry = wgpu::BindGroupLayoutEntry {
            binding: 1,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let instance_entries = [instance_data_entry, rounded_clips_entry];
        let instances = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("instances_layout"),
            entries: if uses_webgl_instance_data { &instance_entries[..1] } else { &instance_entries[..] },
        });''')
edit(wr, '    path_msaa_view: Option<wgpu::TextureView>,\n}\n\n/// Offscreen render target', '    path_msaa_view: Option<wgpu::TextureView>,\n    /// Kybern: the current `Scene::rounded_clips` (storage transport only).\n    rounded_clips: Option<wgpu::Buffer>,\n    /// Bytes of it this frame uses (the binding size, so `arrayLength` is the chain count).\n    rounded_clips_size: u64,\n}\n\n/// Offscreen render target')
edit(wr, '            path_msaa_texture: None,\n            path_msaa_view: None,\n        };', '            path_msaa_texture: None,\n            path_msaa_view: None,\n            rounded_clips: None,\n            rounded_clips_size: 0,\n        };')
edit(wr, '''    fn record_frame(&mut self, scene: &Scene, frame_view: &wgpu::TextureView) -> Result<()> {
        let mut instance_offset = 0;''', '''    fn record_frame(&mut self, scene: &Scene, frame_view: &wgpu::TextureView) -> Result<()> {
        if !self.uses_webgl_instance_data {
            self.write_rounded_clips(&scene.rounded_clips);
        }
        let mut instance_offset = 0;''')
edit(wr, '''                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: match &resources.instance_data {
                        InstanceData::Storage(buffer) => {
                            wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer,
                                offset,
                                size: NonZeroU64::new(size),
                            })
                        }
                        InstanceData::Texture { view, .. } => {
                            wgpu::BindingResource::TextureView(view)
                        }
                    },
                }],''', '''                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: match &resources.instance_data {
                            InstanceData::Storage(buffer) => {
                                wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                    buffer,
                                    offset,
                                    size: NonZeroU64::new(size),
                                })
                            }
                            InstanceData::Texture { view, .. } => {
                                wgpu::BindingResource::TextureView(view)
                            }
                        },
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: match &resources.rounded_clips {
                            Some(buffer) => wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer,
                                offset: 0,
                                size: NonZeroU64::new(resources.rounded_clips_size),
                            }),
                            None => wgpu::BindingResource::TextureView(match &resources.instance_data {
                                InstanceData::Texture { view, .. } => view,
                                InstanceData::Storage(_) => unreachable!("rounded clips are written before any storage binding"),
                            }),
                        },
                    },
                ][..if resources.rounded_clips.is_some() { 2 } else { 1 }],''')
edit(wr, '    fn write_instance_texture(resources: &WgpuResources, offset: u64, data: &[u8]) {', '''    /// Kybern: upload the scene's rounded clip chains (at least one zero node,
    /// since wgpu rejects empty bindings), growing the buffer by powers of two.
    fn write_rounded_clips(&mut self, clips: &[gpui::RoundedClip]) {
        let zero = [gpui::RoundedClip::default()];
        // `KYBERN_ROUNDED_CLIP=0` keeps every chain but squares its corners: the
        // rectangular clip the app had before this port (the before/after check).
        let square: Vec<gpui::RoundedClip>;
        let clips = if clips.is_empty() {
            &zero[..]
        } else if std::env::var("KYBERN_ROUNDED_CLIP").is_ok_and(|value| value == "0") {
            square = clips.iter().map(|clip| gpui::RoundedClip { radii: [0.0; 4], ..*clip }).collect();
            &square[..]
        } else {
            clips
        };
        let data = unsafe { Self::instance_bytes(clips) };
        let resources = self.resources_mut();
        let fits = resources.rounded_clips.as_ref().is_some_and(|buffer| buffer.size() >= data.len() as u64);
        if !fits {
            resources.rounded_clips = Some(resources.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("rounded_clips"),
                size: (data.len() as u64).next_power_of_two().max(1024),
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
        }
        resources.rounded_clips_size = data.len() as u64;
        let resources = self.resources();
        resources.queue.write_buffer(resources.rounded_clips.as_ref().unwrap(), 0, data);
    }

    fn write_instance_texture(resources: &WgpuResources, offset: u64, data: &[u8]) {''')

# - Rounded clip on Direct3D 11: the same struct and chain walk in HLSL. The
#   chains are a structured buffer bound once per frame at pixel-shader slot t2
#   (slots t0/t1 are the sprite texture and the primitive buffer).
hs = 'crates/gpui_windows/src/shaders.hlsl'
edit(hs, 'struct Bounds {\n    float2 origin;\n    float2 size;\n};\n', """struct Bounds {
    float2 origin;
    float2 size;
};

// Kybern: gpui's 24-byte ContentMask and its rounded chains (rounded_clip_gpui.py).
struct ContentMask {
    Bounds bounds;
    uint rounded_clip;
    uint clip_generation;
};

struct RoundedClipNode {
    float4 bounds;
    float4 radii;
    uint parent;
};

StructuredBuffer<RoundedClipNode> rounded_clips: register(t2);

// Coverage of `p` inside rounded chain `id` (0 = rectangular); see shaders.metal.
// The shaders compile for ps_4_1, which has no structured-buffer GetDimensions:
// every id indexes a chain written this frame, and links are capped at 64.
float rounded_clip_alpha(float2 p, uint id) {
    float coverage = 1.0;
    [loop]
    for (uint link = 0; link < 64 && id != 0; link++) {
        RoundedClipNode n = rounded_clips[id];
        float2 lo = n.bounds.xy;
        float2 size = n.bounds.zw;
        bool right = p.x >= lo.x + size.x / 2.0;
        bool bottom = p.y >= lo.y + size.y / 2.0;
        float r = bottom ? (right ? n.radii.z : n.radii.w) : (right ? n.radii.y : n.radii.x);
        float2 c = lo + float2(right ? size.x - r : r, bottom ? size.y - r : r);
        float2 q = float2(right ? p.x - c.x : c.x - p.x, bottom ? p.y - c.y : c.y - p.y);
        float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
        if (any(p < lo) || any(p >= lo + size) || distance >= 0.5) {
            return 0.0;
        }
        coverage = min(coverage, saturate(0.5 - distance));
        id = n.parent;
    }
    return coverage;
}

float4 apply_rounded_clip(float4 color, float coverage) {
    return float4(color.rgb, color.a * coverage);
}
""")
for struct in ['Quad', 'Shadow', 'Underline', 'MonochromeSprite', 'PolychromeSprite']:
    text = pending[hs]
    start = text.index('struct ' + struct + ' {')
    end = text.index('};', start)
    assert text[start:end].count('    Bounds content_mask;') == 1, struct
    pending[hs] = text[:start] + text[start:end].replace('    Bounds content_mask;', '    ContentMask content_mask;') + text[end:]
for old in ['quad.bounds, quad.content_mask);', 'bounds, shadow.content_mask);', 'underline.content_mask);',
            'sprite.content_mask, sprite.transformation);', 'sprite.bounds,\n                                                    sprite.content_mask);']:
    edit(hs, old, old.replace('content_mask', 'content_mask.bounds'))
# Monochrome and subpixel text read no primitive in the fragment stage: carry the handle.
for struct in ['MonochromeSpriteVertexOutput', 'MonochromeSpriteFragmentInput']:
    edit(hs, 'struct ' + struct + ' {\n    float4 position: SV_Position;\n    float2 tile_position: POSITION;\n    nointerpolation float4 color: COLOR;\n',
         'struct ' + struct + ' {\n    float4 position: SV_Position;\n    float2 tile_position: POSITION;\n    nointerpolation float4 color: COLOR;\n    nointerpolation uint rounded_clip: TEXCOORD1;\n')
edit(hs, '    output.color = color;\n    output.clip_distance = clip_distance;\n    return output;\n}\n\nfloat4 monochrome_sprite_fragment',
     '    output.color = color;\n    output.rounded_clip = sprite.content_mask.rounded_clip;\n    output.clip_distance = clip_distance;\n    return output;\n}\n\nfloat4 monochrome_sprite_fragment')
edit(hs, 'output.alpha = float4(input.color.a * alpha_corrected, 1.0f);', 'output.alpha = float4(input.color.a * alpha_corrected * rounded_clip_alpha(input.position.xy, input.rounded_clip), 1.0f);')
edit(hs, '    Background color;\n    Bounds bounds;\n};\n\nStructuredBuffer<PathRasterizationSprite>', '    Background color;\n    Bounds bounds;\n    uint rounded_clip;\n    uint pad;\n};\n\nStructuredBuffer<PathRasterizationSprite>')
for fragment, handle, wrap in [
    ('quad_fragment', 'quads[input.quad_id].content_mask.rounded_clip', 'apply_rounded_clip'),
    ('shadow_fragment', 'shadows[input.shadow_id].content_mask.rounded_clip', 'apply_rounded_clip'),
    ('underline_fragment', 'underlines[input.underline_id].content_mask.rounded_clip', 'apply_rounded_clip'),
    ('monochrome_sprite_fragment', 'input.rounded_clip', 'apply_rounded_clip'),
    ('polychrome_sprite_fragment', 'poly_sprites[input.sprite_id].content_mask.rounded_clip', 'apply_rounded_clip'),
    ('path_rasterization_fragment', 'path_rasterization_sprites[input.vertex_id].rounded_clip', ''),
]:
    text = pending[hs]
    fs = text.index(' ' + fragment + '(')
    body = text.index('{', fs) + 1
    depth, end = 1, body
    while depth:
        depth += {'{': 1, '}': -1}.get(text[end], 0)
        end += 1
    clip = f'rounded_clip_alpha(input.position.xy, {handle})'
    sub = (lambda m: f'{m.group(1)}return {wrap}({m.group(2)}, {clip});') if wrap else (lambda m: f'{m.group(1)}return ({m.group(2)}) * {clip};')
    pending[hs] = text[:body] + _re.sub(r'^(\s*)return\s+(.+?);', sub, text[body:end], flags=_re.S | _re.M) + text[end:]
edit(dr, '    color: Background,\n    bounds: Bounds<ScaledPixels>,\n}\n\n#[derive(Clone, Copy)]\n#[repr(C)]\nstruct PathSprite',
     '    color: Background,\n    bounds: Bounds<ScaledPixels>,\n    rounded_clip: u32,\n    pad: u32,\n}\n\n#[derive(Clone, Copy)]\n#[repr(C)]\nstruct PathSprite')
edit(dr, '                color: path.color,\n                bounds: path.clipped_bounds(),\n            }));',
     '                color: path.color,\n                bounds: path.clipped_bounds(),\n                rounded_clip: path.content_mask.rounded_clip,\n                pad: 0,\n            }));')
edit(dr, '    skip_draws: bool,\n}\n\n/// Direct3D objects', '    skip_draws: bool,\n    /// Kybern: the scene\'s rounded clip chains (buffer, view, capacity in nodes).\n    rounded_clips: Option<(ID3D11Buffer, Option<ID3D11ShaderResourceView>, usize)>,\n}\n\n/// Direct3D objects')
edit(dr, '            height: 1,\n            skip_draws: false,\n        })', '            height: 1,\n            skip_draws: false,\n            rounded_clips: None,\n        })')
edit(dr, '        self.pipelines = pipelines;\n        self.direct_composition = direct_composition;\n        self.skip_draws = true;',
     '        self.pipelines = pipelines;\n        self.direct_composition = direct_composition;\n        self.rounded_clips = None;\n        self.skip_draws = true;')
edit(dr, '        self.upload_scene_buffers(scene)?;\n', '        self.upload_scene_buffers(scene)?;\n        self.upload_rounded_clips(&scene.rounded_clips)?;\n')
edit(dr, '    fn upload_scene_buffers(&mut self, scene: &Scene) -> Result<()> {', """    /// Kybern: upload the rounded clip chains and bind them at t2 for every pass.
    fn upload_rounded_clips(&mut self, clips: &[gpui::RoundedClip]) -> Result<()> {
        let zero = [gpui::RoundedClip::default()];
        let square: Vec<gpui::RoundedClip>;
        let clips = if clips.is_empty() {
            &zero[..]
        } else if rounded_clips_disabled() {
            square = clips.iter().map(|clip| gpui::RoundedClip { radii: [0.0; 4], ..*clip }).collect();
            &square[..]
        } else {
            clips
        };
        let devices = self.devices.as_ref().context("devices missing")?;
        if self.rounded_clips.as_ref().is_none_or(|(_, _, capacity)| *capacity < clips.len()) {
            let capacity = clips.len().next_power_of_two().max(64);
            let buffer = create_buffer(&devices.device, std::mem::size_of::<gpui::RoundedClip>(), capacity)?;
            let view = create_buffer_view(&devices.device, &buffer)?;
            self.rounded_clips = Some((buffer, view, capacity));
        }
        let (buffer, view, _) = self.rounded_clips.as_ref().unwrap();
        update_buffer(&devices.device_context, buffer, clips)?;
        unsafe { devices.device_context.PSSetShaderResources(2, Some(slice::from_ref(view))) };
        Ok(())
    }

    fn upload_scene_buffers(&mut self, scene: &Scene) -> Result<()> {""")
pending[dr] += """
/// Kybern: `KYBERN_ROUNDED_CLIP=0` squares every rounded clip (the before/after check).
fn rounded_clips_disabled() -> bool {
    static DISABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *DISABLED.get_or_init(|| std::env::var("KYBERN_ROUNDED_CLIP").is_ok_and(|value| value == "0"))
}
"""

# - Compositor loops hand passive loops to Core Animation sublayers, which only the
#   Metal renderer creates; elsewhere the loops stay in the scene at the normal
#   frame rate (the same path as KYBERN_COMPOSITOR_LOOPS=0).
sc = 'crates/gpui/src/scene.rs'
edit(sc, """    *ENABLED.get_or_init(|| std::env::var("KYBERN_COMPOSITOR_LOOPS").as_deref() != Ok("0")""",
     """    *ENABLED.get_or_init(|| cfg!(target_os = "macos") && std::env::var("KYBERN_COMPOSITOR_LOOPS").as_deref() != Ok("0")""")
for name in [wr, dr, ws, st, wg, sp, hs, sc]:
    (root / name).write_text(pending[name])
