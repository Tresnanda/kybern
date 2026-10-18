# Only topology changes touch O(changed range); scrolling uses the SumTree.
p = "crates/gpui/src/elements/list.rs"
edit(p, "    /// The number of items in this list.", """    /// Measured height retained independently of whether a React host is mounted.
    pub fn kybern_item_height(&self, ix: usize) -> Option<Pixels> {
        let state = self.0.borrow();
        let mut cursor = state.items.cursor::<Count>(());
        cursor.seek(&Count(ix), Bias::Right);
        cursor.item().and_then(|item| item.size()).map(|size| size.height)
    }

    /// Replace only changed logical identities, with stable-key height hints.
    pub fn kybern_splice_hinted(&self, range: Range<usize>, heights: &[f32]) {
        self.splice(range.clone(), heights.len());
        let state = &mut *self.0.borrow_mut();
        let mut cursor = state.items.cursor::<Count>(());
        let mut items = cursor.slice(&Count(range.start), Bias::Right);
        cursor.seek_forward(&Count(range.start + heights.len()), Bias::Right);
        items.extend(heights.iter().map(|height| ListItem::Unmeasured {
            size_hint: Some(Size { width: px(0.), height: px(height.max(0.)) }), focus_handle: None,
        }), ());
        items.append(cursor.suffix(), ());
        drop(cursor);
        state.items = items;
    }

    /// Focus changes must preserve the measured height and logical anchor.
    pub fn kybern_item_focus(&self, ix: usize, focus: Option<FocusHandle>) {
        let state = &mut *self.0.borrow_mut();
        let mut cursor = state.items.cursor::<Count>(());
        let mut items = cursor.slice(&Count(ix), Bias::Right);
        let Some(mut item) = cursor.item().cloned() else { return; };
        match &mut item { ListItem::Measured { focus_handle, .. } | ListItem::Unmeasured { focus_handle, .. } => *focus_handle = focus }
        items.push(item, ());
        cursor.seek_forward(&Count(ix + 1), Bias::Right);
        items.append(cursor.suffix(), ());
        drop(cursor);
        state.items = items;
    }

    /// The number of items in this list.""")
