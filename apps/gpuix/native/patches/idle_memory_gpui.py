# GPUI half of idle_memory.rs. Executed last from backdrop_gpui.py.
#
# Window-state notifications: the embedded host learns about occlusion, key,
# move, screen, appearance and accessibility-display changes from AppKit's own
# callbacks instead of polling NSWindow from JS.
m = 'crates/gpui_macos/src/gpui_macos.rs'
edit(m, 'pub use platform::MacPlatform;', '''pub use platform::MacPlatform;
static WINDOW_STATE_OBSERVER: std::sync::RwLock<Option<std::sync::Arc<dyn Fn() + Send + Sync>>> = std::sync::RwLock::new(None);
/// Install a nonblocking notification for window occlusion, key, move, screen,
/// appearance and accessibility-display changes (embedded hosts re-read state).
pub fn set_window_state_observer(observer: Option<std::sync::Arc<dyn Fn() + Send + Sync>>) {
    if observer.is_some() {
        static ACCESSIBILITY: std::sync::Once = std::sync::Once::new();
        // Reduce transparency, increase contrast and reduce motion change in
        // System Settings while this app may not be key. Registered once; the
        // block lives as long as the process.
        ACCESSIBILITY.call_once(|| unsafe {
            use cocoa::{base::{id, nil}, foundation::NSString};
            use objc::{class, msg_send, sel, sel_impl};
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let center: id = msg_send![workspace, notificationCenter];
            let name = NSString::alloc(nil).init_str("NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification");
            let block = block::ConcreteBlock::new(|_: id| notify_window_state()).copy();
            let _: id = msg_send![center, addObserverForName: name object: nil queue: nil usingBlock: &*block];
            std::mem::forget(block);
        });
    }
    *WINDOW_STATE_OBSERVER.write().unwrap_or_else(std::sync::PoisonError::into_inner) = observer;
}
pub(crate) fn notify_window_state() {
    let observer = WINDOW_STATE_OBSERVER.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    if let Some(observer) = observer { observer(); }
}''')
w = 'crates/gpui_macos/src/window.rs'
edit(w, '''            lock.stop_display_link();
            lock.renderer.release_passive_region_target();
        }
    }
}''', '''            lock.stop_display_link();
            lock.renderer.release_passive_region_target();
        }
    }
    crate::notify_window_state();
}''')
edit(w, 'extern "C" fn window_did_move(this: &Object, _: Sel, _: id) {\n', 'extern "C" fn window_did_move(this: &Object, _: Sel, _: id) {\n    crate::notify_window_state();\n')
edit(w, 'extern "C" fn window_did_change_screen(this: &Object, _: Sel, _: id) {\n', 'extern "C" fn window_did_change_screen(this: &Object, _: Sel, _: id) {\n    crate::notify_window_state();\n')
edit(w, 'extern "C" fn window_did_change_key_status(this: &Object, selector: Sel, _: id) {\n', 'extern "C" fn window_did_change_key_status(this: &Object, selector: Sel, _: id) {\n    crate::notify_window_state();\n')
edit(w, 'extern "C" fn view_did_change_effective_appearance(this: &Object, _: Sel) {\n', 'extern "C" fn view_did_change_effective_appearance(this: &Object, _: Sel) {\n    crate::notify_window_state();\n')

# Idle GPU memory: what a background or hidden window can rebuild on its next
# frame. The window-sized path target becomes resident once any path is drawn
# (21 MiB at 2880x1800) and otherwise stays for the window's lifetime.
r = 'crates/gpui_apple/src/metal_renderer.rs'
edit(r, '    pub fn update_drawable_size(&mut self, size: Size<DevicePixels>) {', '''    /// Kybern: release the path target (recreated when a scene next has
    /// paths), the cached instance buffers (a grown pool restarts at its
    /// default size), the backdrop scratch and the passive region target.
    /// `recreate_queue` also replaces the command queue, whose driver-side
    /// pools otherwise keep their high-water size. In-flight command buffers
    /// retain what they use (and their queue). Returns bytes released.
    pub fn release_idle_resources(&mut self, recreate_queue: bool) -> u64 {
        let texture_bytes = |texture: &Option<metal::Texture>| texture.as_ref().map_or(0, |t| t.width() * t.height() * 4);
        let mut released = texture_bytes(&self.path_intermediate_texture);
        self.path_intermediate_texture = None;
        self.path_intermediate_msaa_texture = None;
        if let Some(resources) = &mut self.backdrop_resources {
            released += texture_bytes(&resources.scratch);
            resources.scratch = None;
        }
        self.release_passive_region_target();
        let mut pool = self.instance_buffer_pool.lock();
        released += pool.buffers.iter().map(|buffer| buffer.length()).sum::<u64>();
        pool.reset(InstanceBufferPool::default().buffer_size);
        drop(pool);
        if recreate_queue {
            self.command_queue = self.device.new_command_queue();
        }
        released
    }

    pub fn update_drawable_size(&mut self, size: Size<DevicePixels>) {''')
edit(r, '    fn draw_with_frame_pool_inner(&mut self, scene: &Scene) {\n', '''    fn draw_with_frame_pool_inner(&mut self, scene: &Scene) {
        if self.path_intermediate_texture.is_none() && !scene.paths.is_empty() {
            if let Some(layer) = &self.layer {
                let drawable: NSSize = unsafe { msg_send![layer.as_ref(), drawableSize] };
                self.update_path_intermediate_textures(size(DevicePixels(drawable.width as i32), DevicePixels(drawable.height as i32)));
            }
        }
''')
p_ = 'crates/gpui/src/platform.rs'
edit(p_, '    fn on_moved(&self, callback: Box<dyn FnMut()>);\n', '    fn on_moved(&self, callback: Box<dyn FnMut()>);\n    /// Kybern: release GPU memory the next frame can rebuild; bytes released.\n    fn release_idle_gpu_memory(&self, _recreate_queue: bool) -> u64 {\n        0\n    }\n')
edit(w, '    fn on_moved(&self, callback: Box<dyn FnMut()>) {\n        self.0.as_ref().lock().moved_callback = Some(callback);\n    }\n', '    fn on_moved(&self, callback: Box<dyn FnMut()>) {\n        self.0.as_ref().lock().moved_callback = Some(callback);\n    }\n\n    fn release_idle_gpu_memory(&self, recreate_queue: bool) -> u64 {\n        self.0.as_ref().lock().renderer.release_idle_resources(recreate_queue)\n    }\n')
g = 'crates/gpui/src/window.rs'
edit(g, '    pub fn element_arena_memory_bytes(&self) -> usize {', '''    /// Kybern: release GPU memory this window's next frame can rebuild.
    pub fn release_idle_gpu_memory(&self, recreate_queue: bool) -> u64 {
        self.platform_window.release_idle_gpu_memory(recreate_queue)
    }

    pub fn element_arena_memory_bytes(&self) -> usize {''')

for name in [m, w, r, p_, g]:
    if (root / name).read_text() != pending[name]: (root / name).write_text(pending[name])
print('GPUI idle-memory hooks applied')
