p="crates/gpui/src/window.rs"
edit(p, "pub struct Window {", "pub struct Window {\n    kybern_motion_frame_epoch: u64,")
edit(p, "        Ok(Window {", "        Ok(Window {\n            kybern_motion_frame_epoch: 0,")
edit(p, "    /// Produces a new frame and assigns it to `rendered_frame`.", "    pub fn kybern_motion_frame_epoch(&self) -> u64 { self.kybern_motion_frame_epoch }\n\n    /// Produces a new frame and assigns it to `rendered_frame`.")
edit(p, "    pub fn draw(&mut self, cx: &mut App) -> ArenaClearNeeded {", "    pub fn draw(&mut self, cx: &mut App) -> ArenaClearNeeded {\n        self.kybern_motion_frame_epoch = self.kybern_motion_frame_epoch.wrapping_add(1);")
