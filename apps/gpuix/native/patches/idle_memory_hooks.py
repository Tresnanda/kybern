# Native-crate half of idle_memory.rs: the per-tick autorelease pool and the
# window-state callback. Executed last from apply_hooks.py.
edit("lib.rs", "mod cache_island;", "mod cache_island;\nmod idle_memory;")
edit("renderer.rs", """        #[cfg(target_os = "macos")]
        {
            let running = EMBEDDED_PLATFORM.with(|p| {""", """        #[cfg(target_os = "macos")]
        {
            crate::idle_memory::tick_pool();
            let running = EMBEDDED_PLATFORM.with(|p| {""")
edit("renderer.rs", "    pub fn zoom_window(&self) -> Result<()> {", '''    pub fn set_window_state_callback(&self, callback: Option<ThreadsafeFunction<serde_json::Value>>) {
        crate::idle_memory::set_window_state_callback(callback);
    }
    #[napi]
    pub fn acknowledge_window_state(&self) { crate::idle_memory::acknowledge_window_state(); }
    /// Release what this window's next frame can rebuild (path target, cached
    /// instance buffers, backdrop scratch, passive region target; with
    /// `{ queue: true }` also the command queue) and collect the private
    /// small-allocation heap at the next frame boundary.
    #[napi]
    pub fn release_idle_memory(&self, options: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let recreate_queue = options.as_ref().and_then(|o| o.get("queue")).and_then(serde_json::Value::as_bool).unwrap_or(false);
        let gpu_bytes = update_window(move |_, window, _| window.release_idle_gpu_memory(recreate_queue))?;
        crate::large_alloc::code_small_request();
        Ok(serde_json::json!({ "gpuBytes": gpu_bytes }))
    }
    #[napi]
    pub fn zoom_window(&self) -> Result<()> {''')
edit("renderer.rs", '"smallAllocator":crate::large_alloc::code_small_stats(),', '"smallAllocator":crate::large_alloc::code_small_stats(),\n            "tickPool":crate::idle_memory::tick_pool_stats(),')
for name in ["lib.rs", "renderer.rs"]:
    (src / name).write_text(pending[name])
