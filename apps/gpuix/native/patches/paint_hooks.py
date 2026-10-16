# Native hooks for fixed-geometry paint replay. Executed by apply_hooks.py.
edit("lib.rs", "mod cache_island;", "mod cache_island;\nmod paint_replay;")
edit("renderer.rs", "crate::cache_island::notify_changed_islands(view, cx);\n            cx.notify();", "crate::paint_replay::invalidate(view, _window, cx);")
edit("renderer.rs", "    ctx.inherited = parent_inherited;", "    let built = crate::paint_replay::apply(built, element, style);\n    ctx.inherited = parent_inherited;")
t = "retained_tree.rs"
edit(t, "    next_revision: u64,", "    next_revision: u64,\n    pub(crate) paint_updates: HashSet<u64>,\n    pub(crate) full_redraw: bool,\n    pub(crate) paint_replay_enabled: bool,")
edit(t, "            next_revision: 1,", "            next_revision: 1,\n            paint_updates: HashSet::new(),\n            full_redraw: true,\n            paint_replay_enabled: false,")
edit(t, "    fn mark_changed_detail(&mut self, id: u64, search: bool) {", "    pub(crate) fn mark_paint_fallback(&mut self, id: u64) { self.mark_render_changed(id); }\n\n    fn mark_changed_detail(&mut self, id: u64, search: bool) {\n        self.full_redraw = true;")
edit(t, "    pub fn set_style(&mut self, id: u64, style: Arc<StyleDesc>) {\n        let mut changed = false;", "    pub fn set_style(&mut self, id: u64, style: Arc<StyleDesc>) {\n        let paint_only = self.paint_replay_enabled && self.elements.get(&id).is_some_and(|element| crate::paint_replay::paint_only(element, &style));\n        let mut changed = false;")
edit(t, "        if changed {\n            self.mark_render_changed(id);\n        }\n    }\n\n    pub fn set_text", "        if changed {\n            if paint_only { self.paint_updates.insert(id); }\n            else { self.mark_render_changed(id); }\n        }\n    }\n\n    pub fn set_text")

# Any non-style operation keeps normal batch semantics, including listener/root changes.
edit("renderer.rs", "    for batch_op in parsed {\n        match batch_op {", "    for batch_op in parsed {\n        if !matches!(&batch_op, BatchOp::SetStyle { .. }) { tree.full_redraw = true; }\n        match batch_op {")
