# Opted-in PR virtual lists only; no effect on sidebar drag or other lists.
edit("lib.rs", "mod cache_island;", "mod cache_island;\nmod scroll_layout;")
r = "renderer.rs"
edit(r, "    let render_item = cx.processor(move |view, index: usize, window, cx| {", "    let cache_layout = element.custom_props.get(\"cacheLayout\").and_then(|v|v.as_bool()).unwrap_or(false);\n    let layout_revision = element.subtree_revision;\n    let render_item = cx.processor(move |view, index: usize, window, cx| {")
edit(r, "        view.build_virtual_child(list_id, index, child_id, inherited.clone(), window, cx)", "        let row = view.build_virtual_child(list_id, index, child_id, inherited.clone(), window, cx);\n        if cache_layout { crate::scroll_layout::apply(row, [list_id, child_id, layout_revision]) } else { row }")
d = "custom_elements/diff.rs"
edit(d, "    list_state: Option<gpui::ListState>,", "    list_state: Option<gpui::ListState>,\n    cache_layout: bool,\n    layout_revision: u64,")
edit(d, '            gpui::list(state, move |ix, _window, _app| {\n                render_row(', '            let cache_layout = self.cache_layout;\n            let layout_revision = self.layout_revision;\n            gpui::list(state, move |ix, _window, _app| {\n                let row = render_row(')
edit(d, "                        radius,\n                    },\n                )\n            })", "                        radius,\n                    },\n                );\n                if cache_layout { crate::scroll_layout::apply(row, [element_id, ix as u64, layout_revision]) } else { row }\n            })")
edit(d, '        match key {\n            "patch"', '        self.layout_revision = self.layout_revision.wrapping_add(1);\n        match key {\n            "cacheLayout" => self.cache_layout = value.as_bool().unwrap_or(false),\n            "patch"')
edit(d, '            "patch",\n            "wordDiff",', '            "patch",\n            "cacheLayout",\n            "wordDiff",')

edit(r, '        window.set_window_title(&self.window_title);', """        window.set_window_title(&self.window_title);
        let scroll_targets: Vec<u64> = self.tree.lock().unwrap().elements.iter()
            .filter_map(|(id,element)| if element.element_type != "virtual-list" && element.element_type != "diff" {None} else {element.custom_props.get("cacheLayout").and_then(|v|v.as_bool()).unwrap_or(false).then_some(*id)}).collect();
        window.set_scroll_input_target(move |position| {
            let x=f64::from(f32::from(position.x));let y=f64::from(f32::from(position.y));
            scroll_targets.iter().find_map(|id| {
                let b=crate::automation::get_bounds(*id)?;
                let [cx,cy,cw,ch]=b.clip.unwrap_or([b.x,b.y,b.width,b.height]);
                (x>=b.x.max(cx)&&y>=b.y.max(cy)&&x<(b.x+b.width).min(cx+cw)&&y<(b.y+b.height).min(cy+ch)).then_some(*id)
            })
        });""")
edit(r, '    apply_accessibility(list, &element.custom_props, None).into_any_element()', '    let list = apply_accessibility(list, &element.custom_props, None);\n    let list = if cache_layout { crate::automation::track_own_bounds(list, element.id) } else { list };\n    list.into_any_element()')

edit("cache_island.rs", "    let wrapper = crate::renderer::apply_styles(gpui::div(), &outer)", """    let cached = if element.custom_props.get("cacheLayout").and_then(|v|v.as_bool()).unwrap_or(false) {
        let root_revision = ctx.tree.root_id.and_then(|id|ctx.tree.elements.get(&id)).map(|root|root.subtree_revision).unwrap_or(0);
        cached.independent_scroll_cache(root_revision)
    } else {cached};
    let wrapper = crate::renderer::apply_styles(gpui::div(), &outer)""")

# Opacity/translation are applied during paint, outside GPUI's cache key. Build
# PR viewports inline while native motion runs, including under uncached parents.
edit("cache_island.rs", "    let fill = fills_parent(element);", """    if element.custom_props.get("cacheLayout").and_then(|v|v.as_bool()).unwrap_or(false)
        && ctx.motion_states.values().any(|state|state.is_active(ctx.now)) {
        return None;
    }
    let fill = fills_parent(element);""")

# Test-only phase injection follows the same native Window dispatch as NSEvent.
# Existing automation sends only Moved; this additive API verifies contact/end.
edit(r, "    pub fn zoom_window(&self) -> Result<()> {", """    pub fn simulate_scroll_phase(&self, x:f64, y:f64, delta_x:f64, delta_y:f64, phase:String, modifiers:Option<String>) -> Result<()> {
        let phase=match phase.as_str() {
            "started"=>gpui::TouchPhase::Started,"moved"=>gpui::TouchPhase::Moved,
            "ended"=>gpui::TouchPhase::Ended,"cancelled"=>gpui::TouchPhase::Cancelled,
            _=>return Err(Error::from_reason("Unknown native scroll phase")),
        };
        let modifiers=crate::automation::parse_modifiers(modifiers.as_deref());
        #[cfg(target_os="macos")]
        return update_window_without_view(move |window,cx| {
            window.dispatch_event(gpui::PlatformInput::ScrollWheel(gpui::ScrollWheelEvent {
                position:gpui::point(gpui::px(x as f32),gpui::px(y as f32)),
                delta:gpui::ScrollDelta::Pixels(gpui::point(gpui::px(delta_x as f32),gpui::px(delta_y as f32))),
                modifiers,touch_phase:phase,
            }),cx);
        });
        #[cfg(not(target_os="macos"))]
        {let _=(x,y,delta_x,delta_y,phase,modifiers);Err(Error::from_reason("Phase injection requires macOS"))}
    }
    #[napi]
    pub fn zoom_window(&self) -> Result<()> {""")
