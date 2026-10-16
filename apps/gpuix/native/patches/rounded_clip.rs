// Included in gpui::window. A mask keeps a small, Copy handle; immutable clip
// chains live once per window and are copied once into the submitted scene.
// No render target, stencil pass, depth limit or per-primitive clip array.
#[derive(Default)]
struct RoundedClipPool {
    nodes: Vec<crate::RoundedClip>,
    generations: Vec<u32>,
    keys: std::collections::HashMap<[u32; 10], u32>,
    free: Vec<u32>,
    shapes: Vec<Option<std::sync::Arc<Vec<[f32; 8]>>>>,
}
impl RoundedClipPool {
    fn seed(&self, scene: &mut crate::Scene, scale: f32) {
        scene.rounded_clip_scale = scale;
        scene.rounded_clips.clear();
        scene.rounded_clips.resize(self.nodes.len(), Default::default());
        for id in 0..self.nodes.len() {
            self.sync_node(scene, id as u32, scale);
        }
    }
    fn sync_node(&self, scene: &mut crate::Scene, id: u32, scale: f32) {
        if scene.rounded_clips.len() <= id as usize {
            scene.rounded_clips.resize(id as usize + 1, Default::default());
        }
        let mut node = self.nodes[id as usize];
        for value in node.bounds.iter_mut().chain(node.radii.iter_mut()) {
            *value *= scale;
        }
        scene.rounded_clips[id as usize] = node;
        scene.rounded_clip_scale = scale;
    }
    fn intern(&mut self, bounds: Bounds<Pixels>, radii: Corners<Pixels>, parent: ContentMask<Pixels>) -> (u32, u32) {
        if self.nodes.is_empty() {
            self.nodes.push(Default::default());
            self.generations.push(0);
            self.shapes.push(None);
        }
        let values = [
            bounds.origin.x.as_f32(),
            bounds.origin.y.as_f32(),
            bounds.size.width.as_f32(),
            bounds.size.height.as_f32(),
            radii.top_left.as_f32(),
            radii.top_right.as_f32(),
            radii.bottom_right.as_f32(),
            radii.bottom_left.as_f32(),
        ];
        let mut key = [0; 10];
        for (to, value) in key.iter_mut().zip(values) {
            *to = value.to_bits();
        }
        key[8] = parent.rounded_clip;
        key[9] = parent.clip_generation;
        if let Some(&id) = self.keys.get(&key) {
            return (id, self.generations[id as usize]);
        }
        let id = self.free.pop().unwrap_or_else(|| {
            self.nodes.push(Default::default());
            self.generations.push(0);
            self.shapes.push(None);
            (self.nodes.len() - 1) as u32
        });
        self.generations[id as usize] = self.generations[id as usize].checked_add(1).expect("rounded clip generation exhausted");
        self.nodes[id as usize] = crate::RoundedClip {
            bounds: values[..4].try_into().unwrap(),
            radii: values[4..].try_into().unwrap(),
            parent: parent.rounded_clip,
        };
        let mut shapes = self.shapes[parent.rounded_clip as usize].as_deref().cloned().unwrap_or_default();
        shapes.push(values);
        self.shapes[id as usize] = Some(std::sync::Arc::new(shapes));
        self.keys.insert(key, id);
        (id, self.generations[id as usize])
    }
    fn snapshot(&mut self, frame: &mut Frame, scale: f32) {
        // Cached-view replay has finished. Only the new frame's scene/hitboxes
        // can be replayed next time. A generation prevents an old cache key from
        // matching a recycled slot, even after an element was hidden for a while.
        if self.nodes.is_empty() {
            self.nodes.push(Default::default());
            self.generations.push(0);
            self.shapes.push(None);
        }
        let mut live = vec![false; self.nodes.len()];
        let mut mark = |mut id: u32| {
            while id != 0 && !live[id as usize] {
                live[id as usize] = true;
                id = self.nodes[id as usize].parent;
            }
        };
        for operation in &frame.scene.paint_operations {
            if let crate::scene::PaintOperation::Primitive(p) = operation {
                mark(p.content_mask().rounded_clip);
            }
        }
        for hitbox in &frame.hitboxes {
            mark(hitbox.content_mask.rounded_clip);
        }
        self.keys.retain(|_, id| {
            if live[*id as usize] {
                true
            } else {
                self.free.push(*id);
                self.nodes[*id as usize] = Default::default();
                self.shapes[*id as usize] = None;
                false
            }
        });
        frame.scene.rounded_clips.clear();
        frame.scene.rounded_clips.extend(self.nodes.iter().map(|node| {
            let mut node = *node;
            for value in node.bounds.iter_mut().chain(node.radii.iter_mut()) {
                *value *= scale;
            }
            node
        }));
        frame.scene.rounded_clip_scale = scale;
    }
}
impl Window {
    /// Logical-pixel mask geometry for an embedded native surface. The immutable
    /// chain is shared with cached bounds; ordinary bounds recording only clones
    /// an Arc and never allocates a mask per element or per frame.
    pub fn rounded_content_masks(&self) -> Option<std::sync::Arc<Vec<[f32; 8]>>> {
        self.rounded_clip_pool.shapes.get(self.content_mask().rounded_clip as usize).cloned().flatten()
    }
    /// Paint a custom primitive through a rounded boundary, intersecting the
    /// inherited mask. Used by backdrop paint, which precedes the element fill.
    pub fn with_rounded_content_mask<R>(&mut self, bounds: Bounds<Pixels>, radii: Corners<Pixels>, f: impl FnOnce(&mut Self) -> R) -> R {
        if radii == Corners::default() {
            return f(self);
        }
        let (id, generation) = self.rounded_clip_pool.intern(bounds, radii.clamp_radii_for_quad_size(bounds.size), self.content_mask());
        let scale = self.scale_factor();
        self.rounded_clip_pool.sync_node(&mut self.next_frame.scene, id, scale);
        self.with_content_mask(Some(ContentMask { bounds, rounded_clip: id, clip_generation: generation }), f)
    }
    pub(crate) fn rounded_overflow_mask(&mut self, style: &crate::Style, bounds: Bounds<Pixels>) -> Option<ContentMask<Pixels>> {
        let mut mask = style.overflow_mask(bounds, self.rem_size())?;
        let radii = style.corner_radii.to_pixels(self.rem_size()).clamp_radii_for_quad_size(bounds.size);
        if radii != Corners::default() {
            // CSS clips overflow at the padding edge, inside a visible border.
            let inset = |radius: Pixels, x: Pixels, y: Pixels| (radius - x.max(y)).max(px(0.));
            let left = mask.bounds.origin.x - bounds.origin.x;
            let top = mask.bounds.origin.y - bounds.origin.y;
            let right = bounds.right() - mask.bounds.right();
            let bottom = bounds.bottom() - mask.bounds.bottom();
            let radii = Corners {
                top_left: inset(radii.top_left, left, top),
                top_right: inset(radii.top_right, right, top),
                bottom_right: inset(radii.bottom_right, right, bottom),
                bottom_left: inset(radii.bottom_left, left, bottom),
            }
            .clamp_radii_for_quad_size(mask.bounds.size);
            let (id, generation) = self.rounded_clip_pool.intern(mask.bounds, radii, self.content_mask());
            let scale = self.scale_factor();
            self.rounded_clip_pool.sync_node(&mut self.next_frame.scene, id, scale);
            mask.rounded_clip = id;
            mask.clip_generation = generation;
        }
        Some(mask)
    }
}
