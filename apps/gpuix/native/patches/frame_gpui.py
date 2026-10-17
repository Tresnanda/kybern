# Optional presentation-submission timestamps; no work when disabled.
w='crates/gpui/src/window.rs'
edit(w, '        self.platform_window.draw(&self.rendered_frame.scene);', '''        static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        static ORIGIN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        if *TRACE.get_or_init(|| std::env::var_os("KYBERN_FRAME_TIMES").is_some()) {
            let message=format!("[kybern-frame] {:.3}\\n", ORIGIN.get_or_init(std::time::Instant::now).elapsed().as_secs_f64()*1000.0); let _=std::io::Write::write_all(&mut std::io::stderr().lock(),message.as_bytes());
        }
        self.platform_window.draw(&self.rendered_frame.scene);''')

s = 'crates/gpui/src/scene.rs'
pending[s] += """
/// Declarative paint-only loop, evaluated at native display callbacks.
#[derive(Clone, Copy, Debug)]
#[allow(missing_docs)]
pub struct PaintAnimation {
    pub cycle_ms: f64,
    pub delay_ms: f64,
    pub breathe: bool,
    pub started: std::time::Instant,
}
impl PaintAnimation {
    pub(crate) fn same_config(self, other: Self) -> bool {
        self.cycle_ms == other.cycle_ms && self.delay_ms == other.delay_ms && self.breathe == other.breathe
    }
    fn opacity(self, now: std::time::Instant) -> f32 {
        let elapsed = now.saturating_duration_since(self.started).as_secs_f64() * 1000.0 - self.delay_ms;
        if elapsed < 0.0 { return if self.breathe { 1.0 } else { 0.22 }; }
        let phase = (elapsed % self.cycle_ms) / self.cycle_ms;
        fn ease(x: f64) -> f64 {
            let bez = |t: f64, a: f64, b: f64| 3.0*a*t*(1.0-t).powi(2)+3.0*b*t*t*(1.0-t)+t*t*t;
            let (mut lo, mut hi) = (0.0, 1.0);
            for _ in 0..16 { let mid=(lo+hi)*0.5; if bez(mid,0.42,0.58)<x {lo=mid;} else {hi=mid;} }
            bez((lo+hi)*0.5,0.0,1.0)
        }
        (if self.breathe { 1.0 - 0.55*ease(if phase<0.5 {phase*2.0} else {2.0-phase*2.0}) }
        else if phase<0.15 { 0.22 + 0.78*ease(phase/0.15) }
        else if phase<0.45 { 1.0 - 0.78*ease((phase-0.15)/0.3) }
        else { 0.22 }) as f32
    }
}
impl Scene {
    pub(crate) fn animation_for(&self, id: u64) -> Option<PaintAnimation> {
        self.repaint_tags.values().find_map(|&(tag, _, _, animation, _)| if tag == id {animation} else {None})
    }
    pub(crate) fn animate_tagged(&mut self) -> bool {
        let now = std::time::Instant::now();
        // Text contributes a primitive per glyph, but its phase/base tint are
        // shared by the tagged leaf. Evaluate the curve only once per leaf.
        let mut seen = std::collections::HashSet::new();
        let updates: Vec<_> = self.repaint_tags.values().filter_map(|&(id, _, _, animation, color)| {
            if animation.is_none() || !seen.insert(id) { return None; }
            animation.map(|animation| (id, color.opacity(animation.opacity(now))))
        }).collect();
        !updates.is_empty() && self.repaint_tagged_inner(&updates, false)
    }
}
"""
# Native loops request presentation only; never invalidate views or call React.
edit(w, '    pub(crate) needs_present: Rc<Cell<bool>>,', '    pub(crate) needs_present: Rc<Cell<bool>>,\n    paint_animation_scheduled: bool,')
edit(w, '            needs_present,', '            needs_present,\n            paint_animation_scheduled: false,')
edit(w, '        self.platform_window.draw(&self.rendered_frame.scene);', """        let animated = self.rendered_frame.scene.animate_tagged();
        self.platform_window.draw(&self.rendered_frame.scene);
        if *TRACE.get_or_init(|| std::env::var_os("KYBERN_FRAME_TIMES").is_some()) {
            let message=format!("[kybern-submit] {:.3}\\n", ORIGIN.get_or_init(std::time::Instant::now).elapsed().as_secs_f64()*1000.0); let _=std::io::Write::write_all(&mut std::io::stderr().lock(),message.as_bytes());
        }
        if animated && !self.paint_animation_scheduled {
            self.paint_animation_scheduled = true;
            self.on_next_frame(|window, _| {
                window.paint_animation_scheduled = false;
                window.needs_present.set(true);
            });
        }""")

# Wake the embedding JS host when CoreVideo has queued a real display tick.
# Its ordinary input pump remains; animation no longer waits for its 8ms timer.
m = 'crates/gpui_macos/src/gpui_macos.rs'
edit(m, 'pub use platform::MacPlatform;', """pub use platform::MacPlatform;
static EMBEDDED_FRAME_WAKER: std::sync::RwLock<Option<std::sync::Arc<dyn Fn() + Send + Sync>>> = std::sync::RwLock::new(None);
/// Install a nonblocking wake notification for an embedded host's event loop.
pub fn set_embedded_frame_waker(waker: Option<std::sync::Arc<dyn Fn() + Send + Sync>>) {
    *EMBEDDED_FRAME_WAKER.write().unwrap_or_else(std::sync::PoisonError::into_inner) = waker;
}
pub(crate) fn wake_embedded_frame_host() {
    let waker = EMBEDDED_FRAME_WAKER.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    if let Some(waker) = waker { waker(); }
}""")
edit('crates/gpui_macos/src/display_link.rs', '    0\n}\n\nfn subscribe(', '    drop(registry);\n    crate::wake_embedded_frame_host();\n    0\n}\n\nfn subscribe(')
