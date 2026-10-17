edit('lib.rs','mod paint_replay;','mod paint_replay;\nmod subtree_translation;')
edit('renderer.rs','    layout_observers: crate::layout_observer::Shared,','    pub(crate) layout_observers: crate::layout_observer::Shared,')
edit('renderer.rs','            crate::paint_replay::invalidate(view, _window, cx);','            if !crate::subtree_translation::invalidate(view, _window, cx) { crate::paint_replay::invalidate(view, _window, cx); }')
edit('renderer.rs','    let built = crate::paint_replay::apply(built, element, style);','    let built = crate::paint_replay::apply(built, element, style);\n    let built = if ctx.island_root != Some(id) {crate::subtree_translation::apply(built,id,ctx.tree,ctx.now)} else {built};')
edit('renderer.rs','            return island;','            return crate::subtree_translation::apply(island,id,ctx.tree,ctx.now);')
edit('renderer.rs','        // Build the element tree.','        crate::subtree_translation::sync(&tree,self.clock.now());\n        crate::subtree_translation::arm(self,window,cx);\n        // Build the element tree.')
edit('renderer.rs','if !matches!(&batch_op, BatchOp::SetStyle { .. }) { tree.full_redraw = true; }','if !matches!(&batch_op, BatchOp::SetStyle { .. }) && !matches!(&batch_op, BatchOp::SetCustomProp {key,..} if key == "paintTranslate") { tree.full_redraw = true; }')
edit('retained_tree.rs','    pub(crate) paint_updates: HashSet<u64>,','    pub(crate) paint_updates: HashSet<u64>,\n    pub(crate) subtree_translation_updates: HashSet<u64>,')
edit('retained_tree.rs','            paint_updates: HashSet::new(),','            paint_updates: HashSet::new(),\n            subtree_translation_updates: HashSet::new(),')
edit('retained_tree.rs','        let is_motion = key == "motion";','        let is_motion = key == "motion";\n        let is_translation = key == "paintTranslate" && crate::subtree_translation::valid(&value);\n        let had_translation = self.elements.get(&id).is_some_and(|e|e.custom_props.contains_key("paintTranslate"));')
edit('retained_tree.rs','        self.mark_render_changed(id);\n        let is_declaration','''        if is_translation && had_translation && self.elements.get(&id).is_some_and(|e|e.custom_props.contains_key("paintTranslate")) {self.subtree_translation_updates.insert(id);}
        else {
            // Installing a scope on an already-cached subtree needs one fresh
            // paint so every descendant records its new scope and raw masks.
            if is_translation && !had_translation {
                let mut pending=self.elements.get(&id).map(|e|e.children.clone()).unwrap_or_default();
                while let Some(child)=pending.pop(){if let Some(e)=self.elements.get(&child){pending.extend(&e.children);}self.mark_render_changed(child);}
            }
            self.mark_render_changed(id);
        }
        let is_declaration''')
edit('renderer.rs','    pub fn zoom_window(&self) -> Result<()> {','''    pub fn set_subtree_translation(&self, element_id: u32, translation: serde_json::Value) -> Result<()> {
        let x=translation.get("translateX").and_then(|v|v.as_f64()).unwrap_or(0.);
        let y=translation.get("translateY").and_then(|v|v.as_f64()).unwrap_or(0.);
        if !x.is_finite() || !y.is_finite() || x.abs()>f32::MAX as f64 || y.abs()>f32::MAX as f64 {return Err(Error::from_reason("Translation must fit finite logical pixels"));}
        self.tree.lock().unwrap().set_custom_prop(element_id as u64,"paintTranslate".into(),serde_json::json!({"initial":false,"animate":{"translateX":x,"translateY":y},"transition":{"duration":0}}));
        self.request_invalidate()
    }
    #[napi]
    pub fn zoom_window(&self) -> Result<()> {''')

# Bounds and selection are retained side effects of paint, just like the scene.
edit('automation.rs','fn record_clipped_bounds(id: u64, bounds: Bounds<Pixels>, window: &Window) {','''fn record_clipped_bounds(id: u64, bounds: Bounds<Pixels>, window: &Window) {
    SUBTREE_BOUNDS.with(|map| {let mut map=map.borrow_mut(); if let Some(geometry)=window.subtree_geometry(){map.insert(id,geometry);}else{map.remove(&id);}});''')
edit('automation.rs','            BOUNDS.with(|cell| cell.borrow_mut().clear());','''            SUBTREE_BOUNDS.with(|map|BOUNDS.with(|bounds|map.borrow_mut().retain(|id,_|bounds.borrow().contains_key(id))));
            BOUNDS.with(|cell| cell.borrow_mut().clear());''')
pending['automation.rs'] += '\ninclude!("subtree_bounds.rs");\n'
edit('automation.rs','crate::text::record_start_region(bounds, selectable);','crate::text::record_start_region(bounds, selectable,window.subtree_geometry());')
edit('text/paint.rs','    selectable: bool,\n}','    selectable: bool,\n    geometry: Option<gpui::SubtreeGeometry>,\n}')
edit('text/paint.rs','pub fn record_start_region(bounds: Bounds<gpui::Pixels>, selectable: bool) {','pub fn record_start_region(bounds: Bounds<gpui::Pixels>, selectable: bool,geometry:Option<gpui::SubtreeGeometry>) {')
edit('text/paint.rs','StartRegion { bounds, selectable }','StartRegion { bounds, selectable,geometry }')
pending['text/paint.rs'] += '''
pub(crate) fn translate_subtree_selection(values:&std::collections::HashMap<u64,gpui::Point<gpui::Pixels>>,deltas:&std::collections::HashMap<u64,gpui::Point<gpui::Pixels>>) {
    REGISTRY.with(|r|for run in r.borrow_mut().iter_mut(){if let Some(delta)=run.key.split_once(':').and_then(|(id,_)|id.parse().ok()).and_then(|id|deltas.get(&id)){run.layout.translate(*delta);}});
    START_REGIONS.with(|r|for region in r.borrow_mut().iter_mut(){if let Some(geometry)=&mut region.geometry{region.bounds.origin+=geometry.translate(values);}});
    HIGHLIGHTS.with(|r|for highlight in r.borrow_mut().iter_mut(){if let Some(delta)=deltas.get(&highlight.element_id){for rect in &mut highlight.rects{rect.0+=delta.x.as_f32();rect.1+=delta.y.as_f32();}}});
}
'''
edit('selection_cache.rs','START_REGIONS.with(|r| r.borrow_mut().extend(snapshot.regions.iter().cloned()));','''START_REGIONS.with(|r| {let values=crate::subtree_translation::values();r.borrow_mut().extend(snapshot.regions.iter().cloned().map(|mut region|{if let Some(geometry)=&mut region.geometry{region.bounds.origin+=geometry.translate(&values);}region}));});''')

# Native editor hit testing, selection and IME geometry use last_bounds rather
# than the ordinary text registry. Move that retained state without a notify.
edit('custom_elements/mod.rs',"pub trait CustomElement: 'static {",'''pub trait CustomElement: 'static {
    fn translate_subtree(&mut self,_delta:gpui::Point<gpui::Pixels>,_cx:&mut gpui::Context<crate::renderer::GpuixView>) {}
''')
pending['custom_elements/mod.rs'] += '''
impl CustomElementRegistry {
    pub(crate) fn translate_subtrees(&mut self,deltas:&std::collections::HashMap<u64,gpui::Point<gpui::Pixels>>,cx:&mut gpui::Context<crate::renderer::GpuixView>){
        for (id,delta) in deltas {if let Some(entry)=self.instances.get_mut(id){entry.element.translate_subtree(*delta,cx);}}
    }
}
'''
edit('custom_elements/input.rs','impl CustomElement for TextEditorElement {','''impl CustomElement for TextEditorElement {
    fn translate_subtree(&mut self,delta:Point<Pixels>,cx:&mut Context<crate::renderer::GpuixView>){
        if let Some(state)=&self.state{state.update(cx,|state,_|{if let Some(bounds)=&mut state.last_bounds{bounds.origin+=delta;}});}
    }
''')

# The observer is also used after a scene-only presentation.
o='layout_observer.rs'
edit(o,'pub(crate) fn after_paint(observers: Shared, tree: std::sync::Arc<std::sync::Mutex<RetainedTree>>) -> impl IntoElement {','''pub(crate) fn notify(observers:&Shared,tree:&std::sync::Arc<std::sync::Mutex<RetainedTree>>,size:gpui::Size<gpui::Pixels>,scale:f32) {
''' + (src/o).read_text().split('   let tree = tree.lock().unwrap();')[1].split('\n  });')[0].join(['   let tree = tree.lock().unwrap();','\n}\n']) + '''pub(crate) fn after_paint(observers: Shared, tree: std::sync::Arc<std::sync::Mutex<RetainedTree>>) -> impl IntoElement {''')
body=pending[o].split('  cx.defer(move |_| {')[1].split('\n  });')[0]
edit(o,'  cx.defer(move |_| {'+body+'\n  });','  cx.defer(move |_| notify(&observers,&tree,size,scale));')
