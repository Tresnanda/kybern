# Executed within backdrop_gpui.py's atomic staged edits.
t = "crates/gpui/src/taffy.rs"
edit(t, "struct NodeContext {\n    measure: NodeMeasureFn,", "struct NodeContext {\n    last_measure: Option<ScrollMeasure>,\n    measure: NodeMeasureFn,")
edit(t, "pub struct TaffyLayoutEngine {", "include!(\"scroll_taffy.rs\");\npub struct TaffyLayoutEngine {\n    scroll_layouts: ScrollLayouts,")
edit(t, "            taffy,\n", "            taffy,\n            scroll_layouts: Default::default(),\n")
edit(t, "        self.taffy.clear();", "        self.scroll_layouts.next_frame();\n        self.taffy.clear();")
edit(t, "NodeContext { measure }", "NodeContext { measure, last_measure: None }")
edit(t, "        if !self.computed_layouts.insert(id) {", "        if self.reuse_scroll_layout(id, available_space, window, cx) { return; }\n        let scroll_available = available_space;\n        if !self.computed_layouts.insert(id) {")
edit(t, "                    snap_measured_size_to_device_pixels(measured_size, scale_factor).into()", "                    node_context.last_measure = Some(ScrollMeasure { known: known_dimensions, available: available_space, result: measured_size });\n                    snap_measured_size_to_device_pixels(measured_size, scale_factor).into()")
edit(t, "            .expect(EXPECT_MESSAGE);\n    }\n\n    // Pixel snapping", "            .expect(EXPECT_MESSAGE);\n        self.remember_scroll_layout(id, scroll_available, scale_factor);\n    }\n\n    // Pixel snapping")
w = "crates/gpui/src/window.rs"
edit(w, "    pub fn compute_layout(", "    /// Reuse root-relative layout geometry for a retained, unchanged scroll row.\n    pub fn cache_scroll_layout(&mut self, id: LayoutId, key: [u64; 3]) {\n        static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();\n        if *ENABLED.get_or_init(||std::env::var(\"KYBERN_SCROLL_LAYOUT\").as_deref()!=Ok(\"0\")) {\n            self.layout_engine.as_mut().unwrap().cache_scroll_layout(id, key);\n        }\n    }\n    /// Compute layout within the available space.\n    pub fn compute_layout(")
dest = root / "crates/gpui/src/scroll_taffy.rs"
text = (here / "scroll_taffy.rs").read_text()
if not dest.exists() or dest.read_text() != text: dest.write_text(text)

edit(w, '        self.layout_engine.as_mut().unwrap().clear();', '        if kybern_started.is_some() {\n            let (hits, nodes) = self.layout_engine.as_ref().unwrap().scroll_layout_stats();\n            eprintln!("[scroll-layout-frame] hits={} nodes={}", hits, nodes);\n        }\n        self.layout_engine.as_mut().unwrap().clear();')

# Batch precise native input at the display boundary, before event handlers can
# dirty a test-support window and trigger an immediate flush_effects draw.
edit(w, "    rounded_clip_pool: RoundedClipPool,", "    rounded_clip_pool: RoundedClipPool,\n    scroll_input: ScrollInput,")
edit(w, "            rounded_clip_pool: Default::default(),", "            rounded_clip_pool: Default::default(),\n            scroll_input: Default::default(),")
pending[w] += '\ninclude!("scroll_input.rs");\n'
edit(w, "    pub fn dispatch_event(&mut self, event: PlatformInput, cx: &mut App) -> DispatchEventResult {", """    pub fn dispatch_event(&mut self, event: PlatformInput, cx: &mut App) -> DispatchEventResult {
        if !self.scroll_input.dispatching {
            if let PlatformInput::ScrollWheel(wheel) = &event {
                if self.queue_scroll_input(wheel,cx) {
                    return DispatchEventResult {propagate:false,default_prevented:true};
                }
                self.flush_scroll_input(cx);
                self.record_direct_scroll_input();
            } else {
                // Preserve ordering with clicks, keys, pointer moves and focus.
                self.flush_scroll_input(cx);
            }
        }
""")
edit(w, '        arena_scope.exit(&cx.element_arena)', '        self.scroll_input_painted();\n        arena_scope.exit(&cx.element_arena)')
dest = root / "crates/gpui/src/scroll_input.rs"
text = (here / "scroll_input.rs").read_text()
if not dest.exists() or dest.read_text() != text: dest.write_text(text)

# Experimental only: the addon enables test-support for automation, but normal
# platform-frame scheduling already exists immediately below this test loop.
a = "crates/gpui/src/app.rs"
edit(a, "                        window.invalidator.is_dirty().then_some(window.handle)", "                        (!crate::window::scroll_input_frame_draw_enabled() && window.invalidator.is_dirty()).then_some(window.handle)")

edit(w, "        let caused_invalidation = self.invalidator.update_count() > update_count_before;", """        let caused_invalidation = self.invalidator.update_count() > update_count_before;
        if !self.scroll_input.dispatching && !caused_invalidation && !self.invalidator.is_dirty() {
            self.scroll_input.paint = None;
        }""")

# GPUI normally forces every nested cached view to refresh whenever its cached
# ancestor re-renders. PR scroll viewports have explicit revision notifications
# and can retain clean siblings. Genuine Window::refresh still bypasses caches
# (selection, appearance, etc.); only the parent's internal refresh is ignored.
edit(w, "    pub(crate) refreshing: bool,", "    pub(crate) refreshing: bool,\n    pub(crate) scroll_parent_refresh: bool,")
edit(w, "            refreshing: false,", "            refreshing: false,\n            scroll_parent_refresh: false,")
v = "crates/gpui/src/view.rs"
edit(v, "    cached_style: Option<StyleRefinement>,", "    cached_style: Option<StyleRefinement>,\n    scroll_independent_cache: Option<u64>,")
edit(v, "            cached_style: None,", "            cached_style: None,\n            scroll_independent_cache: None,")
edit(v, "    pub(crate) fn cached(mut self, style: StyleRefinement) -> Self {", """    /// Retain this explicitly invalidated scroll viewport when a cached parent
    /// re-renders. Global refresh, dirty entities and geometry/style changes
    /// still invalidate it. Call only when content changes notify this entity.
    pub fn independent_scroll_cache(mut self, revision: u64) -> Self {
        self.scroll_independent_cache = Some(revision);
        self
    }
    pub(crate) fn cached(mut self, style: StyleRefinement) -> Self {""")
edit(v, "                            && !window.refreshing", "                            && (!window.refreshing || (self.scroll_independent_cache.is_some() && window.scroll_parent_refresh))")
edit(v, "                        let refreshing = mem::replace(&mut window.refreshing, true);\n                        let prepaint_start", "                        let refreshing = mem::replace(&mut window.refreshing, true);\n                        let parent_refresh = window.scroll_parent_refresh;\n                        window.scroll_parent_refresh = parent_refresh || !refreshing;\n                        let prepaint_start")
edit(v, "                        window.refreshing = refreshing;\n\n                        (", "                        window.refreshing = refreshing;\n                        window.scroll_parent_refresh = parent_refresh;\n\n                        (")

# Content changes anywhere in the retained tree and native-motion transitions
# invalidate the explicit boundary, even when only an ancestor's paint changes.
edit(v, "struct ViewElementCacheKey {", "struct ViewElementCacheKey {\n    scroll_revision: Option<u64>,")
edit(v, "                            && element_state.cache_key.text_style == text_style", "                            && element_state.cache_key.text_style == text_style\n                            && element_state.cache_key.scroll_revision == self.scroll_independent_cache")
edit(v, "                                cache_key: ViewElementCacheKey {", "                                cache_key: ViewElementCacheKey {\n                                    scroll_revision: self.scroll_independent_cache,")

# Cache the opted-in viewport's structural layout too. Its ListState offset is
# applied in prepaint; the flex tree has unchanged geometry on a scroll frame.
edit(v, "                            element.layout_as_root(bounds.size.into(), window, cx);", """                            if let Some(revision) = self.scroll_independent_cache {
                                let layout = element.request_layout(window, cx);
                                window.cache_scroll_layout(layout, [entity_id.as_u64(), u64::MAX, revision]);
                            }
                            element.layout_as_root(bounds.size.into(), window, cx);""")

# Zero phase markers are not replacement scroll offsets. Also makes native
# List's existing accumulator safe when ordinary App draws are frame-paced.
edit("crates/gpui/src/elements/list.rs", "                accumulated_scroll_delta = accumulated_scroll_delta.coalesce(event.delta);", """                if event.delta.pixel_delta(px(20.)).y == px(0.) { return; }
                accumulated_scroll_delta = accumulated_scroll_delta.coalesce(event.delta);""")

# List implements InteractiveElement but bypasses Interactivity::paint. Forward
# its paint-bounds callback explicitly so PR coalescing sees the actual viewport.
edit("crates/gpui/src/elements/list.rs", "        let current_view = window.current_view();\n\n        // Register the scroll listener", """        if let Some(listener) = self.interactivity.paint_bounds_listener.take() {
            listener(bounds, window, cx);
        }
        let current_view = window.current_view();

        // Register the scroll listener""")
