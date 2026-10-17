# Native-crate half of subtree_transform_gpui.py (render9): `paintTransform` on a host div. Executed from
# apply_hooks.py after subtree_translation_hooks.py; several anchors are lines that file writes.
edit('lib.rs', 'mod subtree_translation;', 'mod subtree_translation;\nmod subtree_transform;')
edit('renderer.rs', 'if !crate::subtree_translation::invalidate(view, _window, cx) {', 'if !crate::subtree_transform::invalidate(view, _window, cx) && !crate::subtree_translation::invalidate(view, _window, cx) {')
edit('renderer.rs', '    let built = if ctx.island_root != Some(id) {crate::subtree_translation::apply(built,id,ctx.tree,ctx.now)} else {built};', '    let built = if ctx.island_root != Some(id) {crate::subtree_translation::apply(built,id,ctx.tree,ctx.now)} else {built};\n    let built = if ctx.island_root != Some(id) {crate::subtree_transform::apply(built,id,ctx.tree,ctx.now)} else {built};')
edit('renderer.rs', '            return crate::subtree_translation::apply(island,id,ctx.tree,ctx.now);', '            return crate::subtree_transform::apply(crate::subtree_translation::apply(island,id,ctx.tree,ctx.now),id,ctx.tree,ctx.now);')
edit('renderer.rs', '        crate::subtree_translation::arm(self,window,cx);', '        crate::subtree_translation::arm(self,window,cx);\n        crate::subtree_transform::sync(&tree,self.clock.now());\n        crate::subtree_transform::arm(self,window,cx);')
edit('renderer.rs', '!matches!(&batch_op, BatchOp::SetCustomProp {key,..} if key == "paintTranslate")', '!matches!(&batch_op, BatchOp::SetCustomProp {key,..} if key == "paintTranslate") && !matches!(&batch_op, BatchOp::SetCustomProp {key,..} if key == "paintTransform")')
rt = 'retained_tree.rs'
edit(rt, '    pub(crate) subtree_translation_updates: HashSet<u64>,', '    pub(crate) subtree_translation_updates: HashSet<u64>,\n    pub(crate) subtree_transform_updates: HashSet<u64>,')
edit(rt, '            subtree_translation_updates: HashSet::new(),', '            subtree_translation_updates: HashSet::new(),\n            subtree_transform_updates: HashSet::new(),')
edit(rt, '            crate::subtree_translation::forget(id);', '            crate::subtree_translation::forget(id);\n            self.subtree_transform_updates.remove(&id);\n            crate::subtree_transform::forget(id);')
edit(rt, '        let had_translation = self.elements.get(&id).is_some_and(|e|e.custom_props.contains_key("paintTranslate"));', '''        let had_translation = self.elements.get(&id).is_some_and(|e|e.custom_props.contains_key("paintTranslate"));
        let is_transform = key == "paintTransform" && crate::subtree_transform::valid(&value) && !value.is_null();
        let had_transform = self.elements.get(&id).is_some_and(|e|e.custom_props.contains_key("paintTransform"));''')
edit(rt, '        if is_translation && had_translation && self.elements.get(&id).is_some_and(|e|e.custom_props.contains_key("paintTranslate")) {self.subtree_translation_updates.insert(id);}', '''        if is_transform && had_transform {self.subtree_transform_updates.insert(id);}
        else if is_translation && had_translation && self.elements.get(&id).is_some_and(|e|e.custom_props.contains_key("paintTranslate")) {self.subtree_translation_updates.insert(id);}''')
# A new scope over cached descendants needs their hitboxes and accessibility nodes recorded inside it.
edit(rt, '            if is_translation && !had_translation {', '            if (is_translation && !had_translation) || (is_transform && !had_transform) {')
