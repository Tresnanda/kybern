# Global motion scans must not repeat for every virtual row in one draw.
edit("renderer.rs", "fn sync_motion_states(", 'include!("motion_frame.rs");\n\nfn sync_motion_states(')
edit("renderer.rs", "    pub(crate) motion_states: HashMap<u64, crate::motion::MotionState>,", "    motion_sync: MotionFrameSync,\n    pub(crate) motion_states: HashMap<u64, crate::motion::MotionState>,")
edit("renderer.rs", "            motion_states: HashMap::new(),", "            motion_sync: Default::default(),\n            motion_states: HashMap::new(),")
# Two callers: root render and deferred virtual-row rendering.
edit("renderer.rs", "sync_motion_states(&tree, &mut self.motion_states, now)", "sync_motion_frame(&tree, &mut self.motion_states, &mut self.motion_sync, window, now)", count=2)
edit("retained_tree.rs", "impl RetainedTree {", "impl RetainedTree {\n    pub(crate) fn kybern_motion_revision(&self) -> u64 { self.next_revision }")
