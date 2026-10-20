# Diagnostics only: distinguish real frame-layout owners from malloc pages.
p = 'crates/gpui/src/text_system/line_layout.rs'
edit(p, '    pub fn finish_frame(&self) {', '''    pub(crate) fn memory_stats(&self) -> [usize; 4] {
        let prev = self.previous_frame.lock();
        let curr = self.current_frame.read();
        [prev.lines.len() + curr.lines.len(),
         prev.wrapped_lines.len() + curr.wrapped_lines.len(),
         prev.lines_by_hash.len() + curr.lines_by_hash.len(),
         prev.wrapped_lines_by_hash.len() + curr.wrapped_lines_by_hash.len()]
    }

    pub fn finish_frame(&self) {''')
edit('crates/gpui/src/text_system.rs', '    pub(crate) fn finish_frame(&self) {', '''    /// Current and prior frame shaped-layout counts.
    pub fn layout_memory_stats(&self) -> [usize; 4] {
        self.line_layout_cache.memory_stats()
    }

    pub(crate) fn finish_frame(&self) {''')
edit('crates/gpui/src/window.rs', '    pub fn element_arena_memory_bytes(&self) -> usize {', '''    pub fn text_layout_memory_stats(&self) -> [usize; 4] {
        self.text_system().layout_memory_stats()
    }

    pub fn element_arena_memory_bytes(&self) -> usize {''')
edit('crates/gpui/src/app.rs', 'impl App {', '\n'.join(['impl App {', '    /// The actual per-App arena, rather than the fallback thread-local arena.', '    pub fn element_arena_memory_bytes(&self) -> usize {', '        self.element_arena.borrow().capacity()', '    }', '']))

for name, text in pending.items():
    if (root/name).read_text()!=text: (root/name).write_text(text)
