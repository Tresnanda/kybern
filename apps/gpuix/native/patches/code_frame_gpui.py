# Dispatch nodes carry frame-local indices, never stable element addresses.
# Unlike clearing values, returning a large spare Vec releases its VM mapping.
edit('crates/gpui/src/gpui.rs', 'mod key_dispatch;', 'mod key_dispatch;\nmod code_frame;')
edit('crates/gpui/src/key_dispatch.rs', '    pub fn len(&self) -> usize {', '''    pub(crate) fn memory_bytes(&self) -> usize {
        self.nodes.capacity() * std::mem::size_of::<DispatchNode>()
    }

    pub(crate) fn trim_memory(&mut self, used_hint: usize) {
        if let Some(target) = crate::code_frame::target(self.nodes.capacity(), used_hint.max(self.nodes.len())) {
            if crate::code_frame::enabled() { self.nodes.shrink_to(target); }
        }
    }

    pub fn len(&self) -> usize {''')
edit('crates/gpui/src/window.rs', '        mem::swap(&mut self.rendered_frame, &mut self.next_frame);\n        self.next_frame.clear();', '''        mem::swap(&mut self.rendered_frame, &mut self.next_frame);
        self.next_frame.clear();
        let dispatch_nodes = self.rendered_frame.dispatch_tree.len();
        self.rendered_frame.dispatch_tree.trim_memory(dispatch_nodes);
        self.next_frame.dispatch_tree.trim_memory(dispatch_nodes);''')
edit('crates/gpui/src/window.rs', '    pub fn text_layout_memory_stats(&self) -> [usize; 4] {', '''    /// Live dispatch nodes and the two frames' allocated node-buffer bytes.
    pub fn dispatch_memory_stats(&self) -> [usize; 3] {
        [self.rendered_frame.dispatch_tree.len(), self.rendered_frame.dispatch_tree.memory_bytes(), self.next_frame.dispatch_tree.memory_bytes()]
    }

    /// Current and prior frame shaped-layout counts.
    pub fn text_layout_memory_stats(&self) -> [usize; 4] {''')
for name, text in pending.items():
    if (root/name).read_text()!=text: (root/name).write_text(text)
dest=root/'crates/gpui/src/code_frame.rs'
text=(here/'code_frame.rs').read_text()
if not dest.exists() or dest.read_text()!=text:dest.write_text(text)

# The shaped-layout values already die at frame completion, but their cleared
# hash tables / used-key Vecs otherwise retain the whole document's capacity.
p='crates/gpui/src/text_system/line_layout.rs'
edit(p, '#[derive(Clone, Default)]\npub(crate) struct LineLayoutIndex', '''impl FrameCache {
    fn memory_hint(&self) -> [usize; 8] {
        [self.lines.len(), self.wrapped_lines.len(), self.lines_by_hash.len(), self.wrapped_lines_by_hash.len(),
         self.used_lines.len(), self.used_wrapped_lines.len(), self.used_lines_by_hash.len(), self.used_wrapped_lines_by_hash.len()]
    }
    fn trim_memory(&mut self, hint: [usize; 8]) {
        macro_rules! trim {
            ($field:ident, $index:expr) => {
                if let Some(target) = crate::code_frame::target(self.$field.capacity(), hint[$index].max(self.$field.len())) {
                    self.$field.shrink_to(target);
                }
            }
        }
        trim!(lines, 0); trim!(wrapped_lines, 1); trim!(lines_by_hash, 2); trim!(wrapped_lines_by_hash, 3);
        trim!(used_lines, 4); trim!(used_wrapped_lines, 5); trim!(used_lines_by_hash, 6); trim!(used_wrapped_lines_by_hash, 7);
    }
}

#[derive(Clone, Default)]
pub(crate) struct LineLayoutIndex''')
edit(p, '''        curr_frame.used_wrapped_lines_by_hash.clear();
    }

    pub fn layout_wrapped_line''', '''        curr_frame.used_wrapped_lines_by_hash.clear();
        if crate::code_frame::enabled() {
            let hint = prev_frame.memory_hint();
            prev_frame.trim_memory(hint);
            curr_frame.trim_memory(hint);
        }
    }

    pub fn layout_wrapped_line''')
edit(p, '    pub(crate) fn memory_stats(&self) -> [usize; 4] {', '''    pub(crate) fn capacity_stats(&self) -> [usize; 8] {
        let prev = self.previous_frame.lock(); let curr = self.current_frame.read();
        [prev.lines.capacity() + curr.lines.capacity(), prev.wrapped_lines.capacity() + curr.wrapped_lines.capacity(),
         prev.lines_by_hash.capacity() + curr.lines_by_hash.capacity(), prev.wrapped_lines_by_hash.capacity() + curr.wrapped_lines_by_hash.capacity(),
         prev.used_lines.capacity() + curr.used_lines.capacity(), prev.used_wrapped_lines.capacity() + curr.used_wrapped_lines.capacity(),
         prev.used_lines_by_hash.capacity() + curr.used_lines_by_hash.capacity(), prev.used_wrapped_lines_by_hash.capacity() + curr.used_wrapped_lines_by_hash.capacity()]
    }

    pub(crate) fn memory_stats(&self) -> [usize; 4] {''')
# Keep separate getters so the original four count fields remain stable.
edit('crates/gpui/src/text_system.rs', '    pub(crate) fn finish_frame(&self) {', '''    /// Allocated capacities of the current and previous frame layout tables.
    pub fn layout_capacity_stats(&self) -> [usize; 8] { self.line_layout_cache.capacity_stats() }

    pub(crate) fn finish_frame(&self) {''')
edit('crates/gpui/src/window.rs', '    pub fn text_layout_memory_stats(&self) -> [usize; 4] {', '''    /// Allocated capacities of the two frame layout caches.
    pub fn text_layout_capacity_stats(&self) -> [usize; 8] { self.text_system().layout_capacity_stats() }

    /// Current and prior frame shaped-layout counts.
    pub fn text_layout_memory_stats(&self) -> [usize; 4] {''')
for name, text in pending.items():
    if (root/name).read_text()!=text: (root/name).write_text(text)
