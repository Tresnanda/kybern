# Additive retained geometry hooks; evaluated after rounded_clip_gpui.py.
w='crates/gpui/src/window.rs'
s='crates/gpui/src/scene.rs'
edit(w,'    rounded_clip_pool: RoundedClipPool,','    rounded_clip_pool: RoundedClipPool,\n    subtree_tags: Vec<(u64, Point<Pixels>)>,\n    subtree_masks: Vec<SubtreeMask>,')
edit(w,'            rounded_clip_pool: Default::default(),','            rounded_clip_pool: Default::default(),\n            subtree_tags: Vec::new(),\n            subtree_masks: Vec::new(),')
edit(w,'    subtree_tags: Vec<(u64, Point<Pixels>)>,','    subtree_tags: Vec<(u64, Point<Pixels>)>,\n    subtree_a11y: std::collections::HashMap<accesskit::NodeId,SubtreeGeometry>,')
edit(w,'            subtree_tags: Vec::new(),','            subtree_tags: Vec::new(),\n            subtree_a11y: Default::default(),')
edit(w,'            self.a11y.begin_frame();','            self.subtree_a11y.clear();\n            self.a11y.begin_frame();')
edit('crates/gpui/src/element.rs','                            window.a11y.node_bounds.insert(node_id, bounds);','                            window.a11y.node_bounds.insert(node_id, bounds);\n                            window.record_subtree_a11y(node_id);')
a='crates/gpui/src/window/a11y.rs'
edit(a,'    pub(crate) node_bounds: FxHashMap<NodeId, Bounds<Pixels>>,','    pub(crate) node_bounds: FxHashMap<NodeId, Bounds<Pixels>>,\n    subtree_last_update: Option<TreeUpdate>,')
edit(a,'            node_bounds: FxHashMap::default(),','            node_bounds: FxHashMap::default(),\n            subtree_last_update: None,')
edit(a,'        let update = self.nodes.finalize();','        let update = self.nodes.finalize();\n        self.subtree_last_update = Some(update.clone());')
pending[a] += '\ninclude!("../subtree_a11y.rs");\n'
edit(w,'    identity: Option<GlobalElementId>,','    identity: Option<GlobalElementId>,\n    subtree_geometry: Option<SubtreeGeometry>,')
edit(w,'            identity,\n        };','            identity,\n            subtree_geometry: self.subtree_geometry(),\n        };')
edit(w,'        if let Some(mask) = mask {\n            let mask = mask.intersect(&self.content_mask());','        if let Some(mask) = mask {\n            self.push_subtree_mask(mask);\n            let mask = mask.intersect(&self.content_mask());')
edit(w,'            self.content_mask_stack.pop();','            self.content_mask_stack.pop();\n            self.pop_subtree_mask();')
edit(w,'        if !quad.background.is_transparent() {','        if !self.subtree_tags.is_empty() {self.next_frame.scene.insert_primitive(quad);return;}\n        if !quad.background.is_transparent() {')
edit(w,'        let clipped_bounds = bounds.intersect(&content_mask.bounds);','        let clipped_bounds = if self.subtree_tags.is_empty(){bounds.intersect(&content_mask.bounds)}else{bounds};')
pending[w] += '\ninclude!("subtree_geometry.rs");\n'
edit(s,'    pub(crate) paint_operations: Vec<PaintOperation>,','    pub(crate) paint_operations: Vec<PaintOperation>,\n    pub(crate) active_subtree_geometry: Option<crate::window::SubtreeGeometry>,\n    pub(crate) subtree_geometries: std::collections::HashMap<usize, crate::window::SubtreeGeometry>,')
edit(s,'        self.paint_operations.clear();','        self.paint_operations.clear();\n        self.subtree_geometries.clear();\n        self.active_subtree_geometry = None;')
edit(s,'        if clipped_bounds.is_empty() {','        if clipped_bounds.is_empty() && self.active_subtree_geometry.is_none() {')
edit(s,'            .unwrap_or_else(|| self.primitive_bounds.insert(clipped_bounds));','            .unwrap_or_else(|| self.primitive_bounds.insert(if clipped_bounds.is_empty() { *primitive.bounds() } else { clipped_bounds }));')
edit(s,'        self.paint_operations\n            .push(PaintOperation::Primitive(primitive));','        if let Some(geometry) = &self.active_subtree_geometry { self.subtree_geometries.insert(self.paint_operations.len(),geometry.clone()); }\n        self.paint_operations\n            .push(PaintOperation::Primitive(primitive));')
edit(s,'        self.paint_operations\n            .push(PaintOperation::StartLayer(bounds));','        if let Some(geometry) = &self.active_subtree_geometry { self.subtree_geometries.insert(self.paint_operations.len(),geometry.clone()); }\n        self.paint_operations\n            .push(PaintOperation::StartLayer(bounds));')
edit(s,'        let previous_tag = self.active_repaint_tag;','        let previous_geometry = self.active_subtree_geometry.clone();\n        let previous_tag = self.active_repaint_tag;')
edit(s,'            let operation = &prev_scene.paint_operations[index];','            self.active_subtree_geometry = prev_scene.subtree_geometries.get(&index).cloned().or_else(|| previous_geometry.clone());\n            let operation = &prev_scene.paint_operations[index];')
edit(s,'        self.active_repaint_tag = previous_tag;','        self.active_repaint_tag = previous_tag;\n        self.active_subtree_geometry = previous_geometry;')
pending[s] += '\ninclude!("subtree_scene.rs");\n'
for name in ['subtree_geometry.rs','subtree_scene.rs','subtree_a11y.rs']:
    dest=root/'crates/gpui/src'/name
    text=(here/name).read_text()
    if not dest.exists() or dest.read_text()!=text: dest.write_text(text)
edit('crates/gpui/src/elements/text.rs','    /// The bounds of this layout.','''    /// Translate retained selection/link geometry alongside a painted subtree.
    pub fn translate(&self, delta: Point<Pixels>) {
        if let Some(layout)=self.0.borrow_mut().as_mut() {if let Some(bounds)=layout.bounds.as_mut(){bounds.origin+=delta;}}
    }
    /// The bounds of this layout.''')
