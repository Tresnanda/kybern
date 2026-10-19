"""Keep legacy and reconstructed kernels in distinct Metal fragment functions."""
renderer = (here / "backdrop_renderer.rs").read_text()
def replace_once(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)
renderer = replace_once(renderer, "    scratch: Option<metal::Texture>,", "    scratch: Option<metal::Texture>,\n    optimized: bool,")
renderer = replace_once(renderer, "fn new(device:&metal::Device, format:metal::MTLPixelFormat)", "fn new(device:&metal::Device, format:metal::MTLPixelFormat, optimized:bool)")
renderer = replace_once(renderer, 'lib.get_function("backdrop_fragment",None)', 'lib.get_function(if optimized {"backdrop_kernel_fragment"} else {"backdrop_fragment"},None)')
renderer = replace_once(renderer, "vertical:pipeline(true)?,scratch:None", "vertical:pipeline(true)?,scratch:None,optimized")
anchor = "        let sigma=b.blur.as_f32().max(0.01);"
renderer = replace_once(renderer, anchor, """        static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        let enabled = *ENABLED.get_or_init(|| !std::env::var("KYBERN_BACKDROP_KERNEL").is_ok_and(|v| v == "0"));
        let kernel = if enabled {
            let k = BackdropKernel::new(b.blur.as_f32().max(0.01), true);
            (k.count > 0).then_some(k)
        } else { None };
        let optimized = kernel.is_some();
        static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        if *TRACE.get_or_init(|| std::env::var("KYBERN_GPU_TRACE").is_ok_and(|v| v == "1")) {
            eprintln!("[backdrop-kernel] sigma={:.4} taps={} enabled={}", b.blur.as_f32(), kernel.as_ref().map_or(49, |k| k.count), enabled);
        }
""" + anchor)
renderer = replace_once(renderer, "self.backdrop_resources.is_none()", "self.backdrop_resources.as_ref().is_none_or(|r| r.optimized != optimized)")
renderer = replace_once(renderer, "BackdropResources::new(&self.device,target.pixel_format())", "BackdropResources::new(&self.device,target.pixel_format(),optimized)")
anchor = "            e.set_fragment_buffer(7,Some(&rounded_clips.buffer),rounded_clips.offset as u64);"
renderer = replace_once(renderer, anchor, anchor + """
            if let Some(kernel) = kernel.as_ref() {
                e.set_fragment_bytes(1,mem::size_of::<BackdropKernel>() as u64,kernel as *const _ as *const c_void);
            }""")
renderer += "\n" + (here / "backdrop_kernel.rs").read_text()
legacy = (here / "backdrop.metal").read_text()
optimized_shader = legacy[legacy.index("fragment float4 backdrop_fragment"):]
optimized_shader = replace_once(optimized_shader, "backdrop_fragment(", "backdrop_kernel_fragment(")
optimized_shader = replace_once(optimized_shader, "device const RoundedClipNode *clips [[buffer(7)]])", "device const RoundedClipNode *clips [[buffer(7)]], constant Kernel &weights [[buffer(1)]])")
a = optimized_shader.index("    float sigma=p.values.x;")
b = optimized_shader.index("    if(vertical){", a)
optimized_shader = optimized_shader[:a] + """    float4 c=0;
    for(uint i=0;i<weights.count;i++) {
        float d=weights.taps[i].x;
        float2 at=pos+(vertical?float2(0,d):float2(d,0));
        if(vertical)at=clamp(at,float2(0.5),p.crop.zw-float2(0.5));
        c+=source.sample(s,at)*weights.taps[i].y;
    }
""" + optimized_shader[b:]
# The old entry point stays byte-for-byte unchanged. Only the selected pipeline
# pair is instantiated, so the control uploads no kernel and compiles no new PSO.
shader = legacy + "\nstruct Kernel { uint count; uint padding[3]; float4 taps[49]; };\n" + optimized_shader
(root / 'crates/gpui_apple/src/backdrop_renderer.rs').write_text(renderer)
(root / 'crates/gpui_apple/src/backdrop.metal').write_text(shader)
