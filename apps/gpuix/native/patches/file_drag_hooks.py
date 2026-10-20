# `onFileDragChange` (render9, file_drag.rs). Executed from apply_hooks.py after subtree_transform_hooks.py.
edit('lib.rs', 'mod subtree_transform;', 'mod subtree_transform;\nmod file_drag;')
edit('renderer.rs', '''            "fileDrop" => {
                el = el.on_drop(move |dropped: &gpui::ExternalPaths, window, _cx| {''', '''            "fileDragChange" => {
                el = crate::file_drag::attach(el, id, callback);
            }
            "fileDrop" => {
                el = el.on_drop(move |dropped: &gpui::ExternalPaths, window, _cx| {''')
edit('renderer.rs', '        crate::subtree_transform::arm(self,window,cx);', '        crate::subtree_transform::arm(self,window,cx);\n        crate::file_drag::sweep(window,cx);')
edit('retained_tree.rs', '            crate::subtree_transform::forget(id);', '            crate::subtree_transform::forget(id);\n            crate::file_drag::forget(id);')
