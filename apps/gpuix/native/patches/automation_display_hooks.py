# Automated runs open their windows on the built-in display (automation_display.rs).
edit("lib.rs", "mod automation;\n", "mod automation;\nmod automation_display;\n")
edit("renderer.rs", "gpui::Bounds::centered(\n                None,\n", "crate::automation_display::centered(\n")
edit("renderer.rs", "gpui::Bounds::centered(None, size, cx)", "crate::automation_display::centered(size, cx)")
edit("renderer.rs", "        app_id: options.app_id.clone(),\n        ..Default::default()", "        app_id: options.app_id.clone(),\n        display_id: crate::automation_display::display(),\n        ..Default::default()")
