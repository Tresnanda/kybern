# Native-crate half of motion_trace_gpui.py (`KYBERN_MOTION_TRACE=1`): renders, batches and the opacity of every
# layout-tween (`motion`) element at render time. Executed last from apply_hooks.py.
edit("renderer.rs", "        crate::subtree_transform::arm(self,window,cx);\n", """        crate::subtree_transform::arm(self,window,cx);
        if gpui::kybern_motion_trace_enabled() { gpui::kybern_motion_trace(format_args!("render")); }
""")
edit("renderer.rs", "        let theme = Theme::dark();\n        let now = self.clock.now();\n        let (motion_active, motion_settled) =\n            sync_motion_frame(&tree, &mut self.motion_states, &mut self.motion_sync, window, now);\n", """        let theme = Theme::dark();
        let now = self.clock.now();
        let (motion_active, motion_settled) =
            sync_motion_frame(&tree, &mut self.motion_states, &mut self.motion_sync, window, now);
        if gpui::kybern_motion_trace_enabled() {
            let mut line = String::new();
            for (id, state) in &self.motion_states {
                if let Some(opacity) = state.visible_style(now).and_then(|s| s.opacity) { line.push_str(&format!(" {id}:{opacity:.3}")); }
            }
            gpui::kybern_motion_trace(format_args!("motion{line}"));
        }
""")
edit("renderer.rs", "            if !crate::subtree_transform::invalidate(view, _window, cx) && !crate::subtree_translation::invalidate(view, _window, cx) { crate::paint_replay::invalidate(view, _window, cx); }", "            if gpui::kybern_motion_trace_enabled() { gpui::kybern_motion_trace(format_args!(\"batch\")); }\n            if !crate::subtree_transform::invalidate(view, _window, cx) && !crate::subtree_translation::invalidate(view, _window, cx) { crate::paint_replay::invalidate(view, _window, cx); }")
(src / "renderer.rs").write_text(pending["renderer.rs"])
