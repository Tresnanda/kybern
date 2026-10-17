# Executed by apply_hooks.py after the other hook files (editor9 lane, phase 2).
# `<rich-editor>`: one native editor for formatted documents (notes, task
# descriptions, the dock's Notes tab). The element and its model are new files
# (`rich_editor.rs`, `rich_doc.rs`); these edits only register them.
edit("lib.rs", "mod cache_island;", "mod cache_island;\nmod rich_doc;\nmod rich_editor;")
edit("custom_elements/mod.rs", "        registry.register(Box::new(markdown::MarkdownFactory));",
     "        registry.register(Box::new(markdown::MarkdownFactory));\n        registry.register(Box::new(crate::rich_editor::RichEditorFactory));")
# Like inputs, the editor always takes keyboard focus.
edit("renderer.rs", 'matches!(element.element_type.as_str(), "input" | "textarea")', 'matches!(element.element_type.as_str(), "input" | "textarea" | "rich-editor")', count=2)
edit("renderer.rs", "    pub fn zoom_window(&self) -> Result<()> {", """    pub fn rich_editor_command(&self, element_id: f64, command: serde_json::Value) -> Result<serde_json::Value> {
        let id = to_element_id(element_id)?;
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |window, cx| crate::rich_editor::command(id, command, window, cx))?;
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("The rich editor is currently macOS-only"))
    }

    #[napi]
    pub fn set_rich_editor_image(&self, src: String, bytes: Buffer) -> Result<()> {
        let bytes = bytes.to_vec();
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |_, cx| crate::rich_editor::set_image(src, bytes, cx))?;
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("The rich editor is currently macOS-only"))
    }

    #[napi]
    pub fn zoom_window(&self) -> Result<()> {""")
