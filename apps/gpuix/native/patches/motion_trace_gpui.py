# Opt-in motion latency trace (`KYBERN_MOTION_TRACE=1`, lane gpuix-native): input, renders, retained transform
# ticks and presents on one clock, so input → first visible step can be measured per motion mechanism. Off by
# default: one cached env check per event and per present. Executed last from backdrop_gpui.py.
w = 'crates/gpui/src/window.rs'
pending[w] += '''
/// Kybern: whether `KYBERN_MOTION_TRACE` is on.
pub fn kybern_motion_trace_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("KYBERN_MOTION_TRACE").is_ok_and(|v| v != "0"))
}
/// Kybern: one `[mtrace] <ms> <line>` record on the shared trace clock.
pub fn kybern_motion_trace(line: std::fmt::Arguments) {
    static ORIGIN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let ms = ORIGIN.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0;
    let message = format!("[mtrace] {ms:.3} {line}\\n");
    let _ = std::io::Write::write_all(&mut std::io::stderr().lock(), message.as_bytes());
}
'''
edit(w, '    pub fn dispatch_event(&mut self, event: PlatformInput, cx: &mut App) -> DispatchEventResult {\n', '''    pub fn dispatch_event(&mut self, event: PlatformInput, cx: &mut App) -> DispatchEventResult {
        if kybern_motion_trace_enabled() {
            match &event {
                PlatformInput::MouseDown(_) => kybern_motion_trace(format_args!("input down")),
                PlatformInput::MouseUp(_) => kybern_motion_trace(format_args!("input up")),
                PlatformInput::KeyDown(_) => kybern_motion_trace(format_args!("input key")),
                _ => {}
            }
        }
''')
edit(w, '        if animated && !self.paint_animation_scheduled {\n', '''        if kybern_motion_trace_enabled() {
            // The innermost scope of every retained transform context, with its presented opacity.
            let mut seen = std::collections::HashSet::new();
            let mut scopes = String::new();
            for (_, context) in self.rendered_frame.scene.transform_bases.values() {
                if seen.insert(std::sync::Arc::as_ptr(context) as usize) {
                    if let Some((id, _, value)) = context.scopes.last() {
                        let _ = value;
                        scopes.push_str(&format!(" {id}:{:.3}", context.opacity));
                    }
                }
            }
            kybern_motion_trace(format_args!("present{scopes}"));
        }
        if animated && !self.paint_animation_scheduled {
''')
(root / w).write_text(pending[w])
