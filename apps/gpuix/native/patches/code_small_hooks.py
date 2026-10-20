# Rust-only allocator dependencies: override/interpose features stay off.
anchor="[target.'cfg(target_os = \"macos\")'.dependencies]"
line='mimalloc = { version = "=0.1.52", default-features = false }\nlibmimalloc-sys = { version = "=0.1.49", default-features = false, features = ["extended"] }'
edit('../Cargo.toml', anchor, anchor+'\n'+line)
edit('large_alloc.rs', 'include!("code_alloc.rs");', 'include!("code_alloc.rs");\ninclude!("code_small.rs");')
for method in ['alloc', 'alloc_zeroed', 'dealloc', 'realloc']:
    edit('large_alloc.rs', f'System.{method}(', f'super::code_small::Small.{method}(')
edit('large_alloc.rs', 'use std::alloc::{GlobalAlloc, Layout, System};', 'use std::alloc::{GlobalAlloc, Layout};')
edit('large_alloc.rs', "// Preserve System's optimized realloc for the common small path.", '// Preserve the selected small allocator\'s aligned realloc fast path.')
edit('large_alloc.rs', 'fn small_and_overaligned_buffers_use_system()', 'fn small_and_overaligned_buffers_use_the_selected_small_allocator()')
edit('large_alloc.rs', '                    CURRENT.fetch_sub(layout.size(), Relaxed);', '                    CURRENT.fetch_sub(layout.size(), Relaxed);\n                    super::code_small::released_mapping(layout.size());')
edit('renderer.rs', '            return Ok(running);\n        }\n\n        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]', '            crate::large_alloc::code_small_collect();\n            return Ok(running);\n        }\n\n        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]')
edit('renderer.rs', '"syntaxCache": ({', '"smallAllocator":crate::large_alloc::code_small_stats(),\n            "syntaxCache": ({')
edit('renderer.rs', '        let app_handle = app.run_embedded(move |cx: &mut gpui::App| {', '        let app_handle = app.run_embedded(move |cx: &mut gpui::App| {\n            gpui::set_code_memory_collector(crate::large_alloc::code_small_after_frame);')
edit('renderer.rs', '''        drop(tree);
        self.request_invalidate()?;
        Ok(destroyed)
    }

    // ── Frame loop''', '''        drop(tree);
        if destroyed.len() >= 64 { crate::large_alloc::code_small_request(); }
        self.request_invalidate()?;
        Ok(destroyed)
    }

    // ── Frame loop''')
for kind in ['syntax','markdown']:
    old=f'        update_window(move |view, _, _| view.{kind}_documents.lock().unwrap().release(&id))'
    edit('renderer.rs',old,f'''        let result = update_window(move |view, _, _| view.{kind}_documents.lock().unwrap().release(&id));
        crate::large_alloc::code_small_request();
        result''')
edit('large_alloc.rs', 'pub(crate) fn snapshot() -> Snapshot {', '''pub(crate) fn code_small_collect() {
    #[cfg(target_os = "macos")]
    code_small::collect_if_needed();
}
pub(crate) fn code_small_request() {
    #[cfg(target_os = "macos")]
    code_small::request();
}
pub(crate) fn code_small_after_frame(contracted: bool) {
    #[cfg(target_os = "macos")]
    code_small::after_frame(contracted);
}
pub(crate) fn code_small_stats() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    { code_small::stats() }
    #[cfg(not(target_os = "macos"))]
    { serde_json::json!({"enabled":false}) }
}

pub(crate) fn snapshot() -> Snapshot {''')
