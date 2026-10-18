"""Fold the existing narrow Gaussian into equivalent hardware-linear taps."""
renderer = (here / "backdrop_renderer.rs").read_text()
anchor = "        let sigma=b.blur.as_f32().max(0.01);"
assert renderer.count(anchor) == 1
renderer = renderer.replace(anchor, """        static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        let enabled = *ENABLED.get_or_init(|| std::env::var("KYBERN_BACKDROP_KERNEL").is_ok_and(|v| v != "0"));
        let kernel = BackdropKernel::new(b.blur.as_f32().max(0.01), enabled);
        static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        if *TRACE.get_or_init(|| std::env::var("KYBERN_GPU_TRACE").is_ok_and(|v| v == "1")) {
            eprintln!("[backdrop-kernel] sigma={:.4} taps={} enabled={}", b.blur.as_f32(), if kernel.count > 0 { kernel.count } else { 49 }, enabled);
        }
""" + anchor)
anchor = "            e.set_fragment_buffer(7,Some(&rounded_clips.buffer),rounded_clips.offset as u64);"
assert renderer.count(anchor) == 1
renderer = renderer.replace(anchor, anchor + "\n            e.set_fragment_bytes(1,mem::size_of::<BackdropKernel>() as u64,&kernel as *const _ as *const c_void);")
renderer += "\n" + (here / "backdrop_kernel.rs").read_text()
shader = (here / "backdrop.metal").read_text()
anchor = "struct RoundedClipNode"
assert shader.count(anchor) == 1
shader = shader.replace(anchor, "struct Kernel { uint count; uint padding[3]; float4 taps[25]; };\n" + anchor)
anchor = "device const RoundedClipNode *clips [[buffer(7)]])"
assert shader.count(anchor) == 1
shader = shader.replace(anchor, "device const RoundedClipNode *clips [[buffer(7)]], constant Kernel &kernel [[buffer(1)]])")
anchor = "    for(int i=-24;i<=24;i++) {"
assert shader.count(anchor) == 1
shader = shader.replace(anchor, """    if(kernel.count > 0) {
        for(uint i=0;i<kernel.count;i++) {
            float d=kernel.taps[i].x;
            float2 at=pos+(vertical?float2(0,d):float2(d,0));
            if(vertical)at=clamp(at,float2(0.5),p.crop.zw-float2(0.5));
            sum+=source.sample(s,at)*kernel.taps[i].y;
        }
        total=1.0;
    } else for(int i=-24;i<=24;i++) {""")
# Appended hook runs after the base patch has copied its renderer and shader.
(root / 'crates/gpui_apple/src/backdrop_renderer.rs').write_text(renderer)
(root / 'crates/gpui_apple/src/backdrop.metal').write_text(shader)
