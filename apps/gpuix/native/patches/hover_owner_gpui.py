# A retained host can move between cached-view and ordinary virtual-row paths.
# Its full GPUI identity (and hover state) changes, but its renderer/host id does
# not. Use that explicit identity only for retiring hover listeners; ordinary
# hit testing, clipping, capture, focus and element-state identities stay intact.
w = "crates/gpui/src/window.rs"
edit(w, "    identity: Option<GlobalElementId>,", "    identity: Option<GlobalElementId>,\n    hover_owner: Option<(EntityId, u64)>,")
edit(w, "            identity,\n            subtree_geometry:", "            identity,\n            hover_owner: None,\n            subtree_geometry:")
anchor = "    pub fn insert_hitbox(&mut self, bounds: Bounds<Pixels>, behavior: HitboxBehavior) -> Hitbox {"
edit(w, anchor, '''    /// Insert a hitbox with a retained host identity independent of cached-view paths.
    pub fn insert_hover_hitbox(
        &mut self, bounds: Bounds<Pixels>, behavior: HitboxBehavior,
        owner: Option<(EntityId, u64)>,
    ) -> Hitbox {
        let mut hitbox = self.insert_hitbox(bounds, behavior);
        hitbox.hover_owner = owner;
        self.next_frame.hitboxes.last_mut().unwrap().hover_owner = owner;
        hitbox
    }

''' + '    /// Insert a rectangular hitbox using the current content mask.\n' + anchor)
d = "crates/gpui/src/elements/div.rs"
edit(d, "pub struct Interactivity {", "pub struct Interactivity {\n    pub(crate) hover_owner: Option<(crate::EntityId, u64)>,")
anchor = "pub trait InteractiveElement: Sized {"
edit(d, anchor, anchor + '''
    /// Keep hover ownership stable when a retained host changes cached-view paths.
    fn hover_owner(mut self, renderer: crate::EntityId, host: u64) -> Self {
        self.interactivity().hover_owner = Some((renderer, host));
        self
    }
''')
edit(d, "Some(window.insert_hitbox(bounds, self.hitbox_behavior))", "Some(window.insert_hover_hitbox(bounds, self.hitbox_behavior, self.hover_owner))")

p = root / "crates/gpui/src/hover_reconcile.rs"
source = p.read_text()
anchor = "        if self.retired {"
replacement = '''        if self.retired {
            if let Some(owner) = hitbox.hover_owner {
                if let Some(live) = window.rendered_frame.hitboxes.iter()
                    .find(|live| live.hover_owner == Some(owner))
                {
                    // New and retired paths can have distinct was_hovered cells.
                    // A queued old leave would run after the new paint's enter.
                    // Suppress it only while the live owner is actually hovered;
                    // a relocated/occluded owner must still deliver its leave.
                    return (!live.is_hovered(window)).then_some(false);
                }
            }'''
if source.count(anchor) != 1:
    raise SystemExit("hover owner: reconciliation anchor moved")
p.write_text(source.replace(anchor, replacement))
for name in [w, d]:
    (root / name).write_text(pending[name])
