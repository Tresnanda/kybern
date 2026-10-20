# Preserve the original pixel allocator and its same-binary System control.
edit('large_alloc.rs', 'const THRESHOLD: usize = 4 * 1024 * 1024;', 'const THRESHOLD: usize = 4 * 1024 * 1024;\ninclude!("code_alloc.rs");')
edit('large_alloc.rs', 'layout.size() >= THRESHOLD && enabled()', 'layout.size() >= 64 * 1024 && layout.size() >= allocation_threshold() && enabled()')
edit('large_alloc.rs', '            threshold_bytes: THRESHOLD,', '            threshold_bytes: allocation_threshold(),')
edit('renderer.rs', '"metalGauges":gpui::memory_debug_stats(),', '''"syntaxCache": ({
                let cache = crate::syntax::cache::stats();
                serde_json::json!({"documents":cache.documents,"retainedBytes":cache.retained_bytes,"hits":cache.hits,"misses":cache.misses})
            }),
            "dispatchFrames":window.dispatch_memory_stats(),
            "textLayouts":window.text_layout_memory_stats(),
            "textLayoutCapacities":window.text_layout_capacity_stats(),
            "appElementArenaBytes":cx.element_arena_memory_bytes(),
            "metalGauges":gpui::memory_debug_stats(),''')
