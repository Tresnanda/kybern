# Return temporary layout storage after a large document closes. A normal
# scrolling viewport keeps its warm capacity; no idle frames/timers are added.
a = 'crates/gpui/src/arena.rs'
edit(a, '        self.elements.clear();\n        for chunk_index', '''        let used_elements = self.elements.len();
        let used_chunks = self.current_chunk_index + 1;
        self.elements.clear();
        for chunk_index''')
edit(a, '        self.current_chunk_index = 0;\n    }', '''        self.current_chunk_index = 0;
        static TRIM: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        if *TRIM.get_or_init(|| std::env::var("KYBERN_FRAME_MEMORY").as_deref() != Ok("0")) {
            // Destructors ran and all arena references were invalidated above.
            // Keep 2x the current frame to avoid churning on small fluctuations.
            let large_collapse = self.chunks.len() > 8 && used_chunks.saturating_mul(4) < self.chunks.len();
            if large_collapse {
                self.chunks.truncate(used_chunks.saturating_mul(2).max(2));
            }
            if self.elements.capacity() > 16384 && used_elements.saturating_mul(4) < self.elements.capacity() {
                self.elements.shrink_to(used_elements.saturating_mul(2).max(1024));
            }
        }
    }''')
t = 'crates/gpui/src/taffy.rs'
edit(t, 'pub struct TaffyLayoutEngine {', 'pub struct TaffyLayoutEngine {\n    peak_nodes: usize,')
edit(t, '        TaffyLayoutEngine {', '        TaffyLayoutEngine {\n            peak_nodes: 0,')
edit(t, '        self.taffy.clear();', '''        let nodes = self.taffy.total_node_count();
        self.peak_nodes = self.peak_nodes.max(nodes);
        static TRIM: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        if *TRIM.get_or_init(|| std::env::var("KYBERN_FRAME_MEMORY").as_deref() != Ok("0"))
            && self.peak_nodes > 4096 && nodes.saturating_mul(8) < self.peak_nodes {
            // TaffyTree::clear drops nodes but keeps its SlotMap backing at the
            // largest document ever laid out. No LayoutId survives this clear.
            self.taffy = TaffyTree::with_capacity(nodes.saturating_mul(2).max(256));
            self.taffy.disable_rounding();
            self.peak_nodes = nodes;
            self.absolute_layout_bounds.shrink_to(nodes.saturating_mul(2).max(256));
            self.absolute_outer_origins.shrink_to(nodes.saturating_mul(2).max(256));
            self.computed_layouts.shrink_to(nodes.saturating_mul(2).max(256));
        } else {
            self.taffy.clear();
        }''')
edit(a, '    #[test]\n    fn test_clear_without_scope_is_immediate()', '''    #[test]
    fn large_frame_capacity_returns_after_a_small_frame() {
        let mut arena = Arena::new(1024);
        for _ in 0..40 { arena.alloc(|| [0u8; 900]); }
        let peak = arena.capacity();
        assert!(peak > 32 * 1024);
        arena.clear();
        arena.begin_scope();
        let value = arena.alloc(|| 42u64);
        arena.clear(); // A nested clear must not trim live outer allocations.
        assert_eq!(*value, 42);
        arena.end_scope();
        arena.clear();
        assert!(arena.capacity() <= 2 * 1024);
        let value = arena.alloc(|| 17u64);
        assert_eq!(*value, 17);
    }

    #[test]
    fn test_clear_without_scope_is_immediate()''')

edit(t, '    pub fn clear(&mut self) {', '    pub(crate) fn memory_peak_nodes(&self) -> usize { self.peak_nodes }\n\n    pub fn clear(&mut self) {')
edit('crates/gpui/src/window.rs', '    pub fn element_arena_memory_bytes(&self) -> usize {', '''    /// High water node count of the retained Taffy slot storage.
    pub fn layout_memory_peak_nodes(&self) -> usize {
        self.layout_engine.as_ref().map_or(0, |engine| engine.memory_peak_nodes())
    }

    /// Retained frame arena allocation capacity, after its last safe reset.
    pub fn element_arena_memory_bytes(&self) -> usize {''')
