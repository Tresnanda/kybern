# Notify only after the drawn App's element arena has actually cleared.
# Event arenas and deferred nested clears are not frame-completion boundaries.
edit('crates/gpui/src/gpui.rs', 'mod code_frame;', 'mod code_frame;\npub use code_frame::set_code_memory_collector;')
p='crates/gpui/src/arena.rs'
edit(p, '                self.chunks.truncate(used_chunks.saturating_mul(2).max(2));', """                // Keep the chunks this frame used after a large close.
                let keep = if crate::code_frame::post_memory_enabled() { used_chunks } else { used_chunks.saturating_mul(2).max(2) };
                self.chunks.truncate(keep);""")
edit(p, '    pub fn clear(&mut self) {', '    pub(crate) fn has_active_scope(&self) -> bool { self.scope_depth != 0 }\n\n    pub fn clear(&mut self) {')
edit('crates/gpui/src/window.rs', '        cx.element_arena.borrow_mut().clear();', """        let (completed, contracted) = {
            let mut arena = cx.element_arena.borrow_mut();
            let completed = !arena.has_active_scope();
            let before = arena.capacity();
            arena.clear();
            (completed, arena.capacity() < before)
        };
        if completed { crate::code_frame::memory_released(contracted); }""")
for name,text in pending.items():
    if (root/name).read_text()!=text:(root/name).write_text(text)
