# Sparse React windows carry semantic identity separately from disposable hosts.
edit("renderer.rs", "pub(crate) struct VirtualListEntry {", 'include!("sparse_list.rs");\n\npub(crate) struct VirtualListEntry {\n    sparse: SparseList,')
edit("renderer.rs", "        Self {\n            state,\n            config,", "        Self {\n            sparse: Default::default(),\n            state,\n            config,")
edit("renderer.rs", "        logical_index\n            .checked_sub(self.window_start)", "        if self.sparse.active { return self.sparse.children.get(&logical_index).copied(); }\n        logical_index\n            .checked_sub(self.window_start)")
edit("renderer.rs", "        self.child_ids\n            .iter()\n            .position", "        if self.sparse.active { return self.sparse.children.iter().find_map(|(ix,id)| (*id == child_id).then_some(*ix)); }\n        self.child_ids\n            .iter()\n            .position")
edit("renderer.rs", "            entry.get_mut().sync(\n                config,", "            if element.custom_props().contains_key(\"sparseVersion\") {\n                entry.get_mut().sync_sparse(element, config, child_ids.clone(), child_revisions.clone(), &focusable_rows, cx);\n            } else { entry.get_mut().sync(\n                config,")
edit("renderer.rs", "                &focusable_rows,\n                cx,\n            );\n            let entry = entry.into_mut();", "                &focusable_rows,\n                cx,\n            ); }\n            let entry = entry.into_mut();")
edit("renderer.rs", "            if let Some(row_id) = focused_row {", "            if element.custom_props().contains_key(\"sparseVersion\") { entry.sync_sparse(element, config, child_ids.clone(), entry.child_revisions.clone(), &focusable_rows, cx); }\n            if let Some(row_id) = focused_row {")
edit("renderer.rs", "return unmounted_virtual_row(entry.config.estimated_item_height.unwrap_or(1.0));", "return unmounted_virtual_row(entry.sparse.height(index, entry.config.estimated_item_height.unwrap_or(1.0)));")
edit("renderer.rs", "entry.child_revisions.get(index.saturating_sub(entry.window_start)).copied().unwrap_or(0)", "entry.sparse.revisions.get(&index).copied().or_else(||entry.child_revisions.get(index.saturating_sub(entry.window_start)).copied()).unwrap_or(0)")

# build_virtual_child validates against the *physical* child offset as well.
# A sparse owner at logical row 2 must not shift every later row's guard/focus.
edit("renderer.rs", "index\n                        .checked_sub(entry.window_start)", "entry.child_offset(index)")
edit("renderer.rs", """        let window_start = self
            .virtual_lists
            .get(&list_id)
            .map(|entry| entry.window_start)
            .unwrap_or(0);
        let child_matches = tree.elements.get(&list_id).and_then(|list| {
            index
                .checked_sub(window_start)
                .and_then(|offset| list.children.get(offset))
        }) == Some(&expected_child_id);""", """        let row_offset = self.virtual_lists.get(&list_id).and_then(|entry| entry.child_offset(index));
        let child_matches = tree.elements.get(&list_id).and_then(|list| {
            row_offset.and_then(|offset|list.children.get(offset))
        }) == Some(&expected_child_id);""")

# Constructor focus hints are contiguous. Sparse rows install proxies by their
# logical indices in sync_sparse, so no phantom contiguous proxy may be seeded.
edit("renderer.rs", ".map(|id| focusable_rows.contains(id).then(|| cx.focus_handle()))", '.map(|id| (!element.custom_props().contains_key("sparseVersion") && focusable_rows.contains(id)).then(|| cx.focus_handle()))')
