# Virtual-list cache identity belongs to each retained row. A streamed sibling
# advances the list revision but does not change settled row geometry. Inherited
# styles, topology, available width/scale and measured leaves remain validated
# by scroll_taffy.rs before reuse; prepaint/paint are always fresh.
edit("renderer.rs", "    let layout_revision = element.subtree_revision;\n    let render_item = cx.processor", "    let render_item = cx.processor")
edit("renderer.rs", "        let row = view.build_virtual_child(list_id, index, child_id, inherited.clone(), window, cx);", "        let layout_revision = entry.child_revisions.get(index.saturating_sub(entry.window_start)).copied().unwrap_or(0);\n        let row = view.build_virtual_child(list_id, index, child_id, inherited.clone(), window, cx);")

# Observe logical scroll changes even when every previous rich body is offscreen.
# ListState clones share the native handle; callbacks remain changed-only.
pending["renderer.rs"] = pending.get("renderer.rs", (src / "renderer.rs").read_text()) + """
impl GpuixView {
    pub(crate) fn observed_scrolls(&self) -> std::collections::HashMap<u64, gpui::ListState> {
        self.virtual_lists.iter().map(|(id, entry)| (*id, entry.state.clone())).collect()
    }
}
"""
edit("renderer.rs", "crate::layout_observer::after_paint(self.layout_observers.clone(), self.tree.clone())", "crate::layout_observer::after_paint(self.layout_observers.clone(), self.tree.clone(), self.observed_scrolls())")
edit("layout_observer.rs", "size:gpui::Size<gpui::Pixels>,scale:f32) {", "size:gpui::Size<gpui::Pixels>,scale:f32,scrolls:&HashMap<u64,gpui::ListState>) {")
edit("layout_observer.rs", "tree: std::sync::Arc<std::sync::Mutex<RetainedTree>>) -> impl IntoElement", "tree: std::sync::Arc<std::sync::Mutex<RetainedTree>>,scrolls:HashMap<u64,gpui::ListState>) -> impl IntoElement")
edit("layout_observer.rs", "let observers = observers.clone(); let tree = tree.clone();", "let observers = observers.clone(); let tree = tree.clone(); let scrolls = scrolls.clone();")
edit("layout_observer.rs", "notify(&observers,&tree,size,scale)", "notify(&observers,&tree,size,scale,&scrolls)")
edit("layout_observer.rs", 'json!({"elementId":id,"rect":', 'let scroll_top = id.and_then(|id| scrolls.get(&id)).map(|list| { let top = list.logical_scroll_top(); (top.item_ix, f32::from(top.offset_in_item)) });\n     json!({"elementId":id,"scrollTop":scroll_top,"rect":')
edit("subtree_translation.rs", "window.viewport_size(), window.scale_factor());", "window.viewport_size(), window.scale_factor(), &view.observed_scrolls());")
