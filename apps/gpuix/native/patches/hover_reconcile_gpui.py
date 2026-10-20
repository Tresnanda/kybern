# Reconcile real hover after layout, including unchanged cached paint.
w = "crates/gpui/src/window.rs"
edit(w, "        self.next_frame.clear();\n        let current_focus_path", "        self.reconcile_layout_hover(cx);\n        self.next_frame.clear();\n        let current_focus_path")
pending[w] += "\ninclude!(\"hover_reconcile.rs\");\n"
dest = root / "crates/gpui/src/hover_reconcile.rs"
source = (here / "hover_reconcile.rs").read_text()
if not dest.exists() or dest.read_text() != source: dest.write_text(source)
d = "crates/gpui/src/elements/div.rs"
# Native :hover also has to invalidate the owning cached view when the
# hit test changes without a mouse move. Notification is deferred past draw.
anchor = "            window.on_mouse_event(move |_: &MouseMoveEvent, phase, window, cx| {\n                let hovered = hitbox.is_hovered(window);"
edit(d, anchor, '''            window.on_hover_reconcile({
                let hitbox = hitbox.clone();
                let hover_state = hover_state.clone();
                move |event: &crate::window::HoverReconcileEvent, phase, window, cx| {
                    if phase != DispatchPhase::Capture { return; }
                    if event.retired && hover_state.as_ref().is_none_or(|state| !state.borrow().element) { return; }
                    let Some(hovered) = event.hovered(&hitbox, window) else { return };
                    if let Some(state) = &hover_state {
                        if state.borrow().element != hovered {
                            state.borrow_mut().element = hovered;
                            window.defer(cx, move |_, cx| cx.notify(current_view));
                        }
                    }
                }
            });
''' + anchor)
anchor = "                window.on_mouse_event({\n                    let update_hover = update_hover.clone();\n                    let hitbox = hitbox.clone();\n                    move |_: &MouseMoveEvent, phase, window, cx| {"
edit(d, anchor, '''                window.on_hover_reconcile({
                    let update_hover = update_hover.clone();
                    let hitbox = hitbox.clone();
                    let was_hovered = was_hovered.clone();
                    let has_mouse_down = has_mouse_down.clone();
                    move |event: &crate::window::HoverReconcileEvent, phase, window, cx| {
                        if phase != DispatchPhase::Bubble { return; }
                        if event.retired && !*was_hovered.borrow() { return; }
                        let Some(hovered) = event.hovered(&hitbox, window) else { return };
                        let hovered = hovered && has_mouse_down.borrow().is_none() && !cx.has_active_drag();
                        if hovered != *was_hovered.borrow() {
                            let update_hover = update_hover.clone();
                            window.defer(cx, move |window, cx| update_hover(hovered, window, cx));
                        }
                    }
                });
''' + anchor)
# The retained transform APIs already schedule a presentation callback.
# Recheck their updated hitboxes there, without introducing a frame source.
for name in ["subtree_geometry.rs", "subtree_transform_window.rs"]:
    dest = root / "crates/gpui/src" / name
    source = dest.read_text()
    anchor = "self.on_next_frame(|window, _| window.needs_present.set(true));"
    if source.count(anchor) != 1: raise SystemExit(f"hover reconcile: {name} callback anchor moved")
    source = source.replace(anchor, "self.on_next_frame(|window, cx| { window.reconcile_rendered_hover(cx); window.needs_present.set(true); });")
    dest.write_text(source)

for name in [w, d]:
    (root / name).write_text(pending[name])
