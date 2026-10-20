# Peek without starting a load. Eviction must release decoded pixels AND atlas
# ownership; remove_asset alone only drops the asset task.
a = 'crates/gpui/src/app.rs'
edit(a, '    /// Remove an asset from GPUI\'s cache\n', '''    /// Return an already completed asset without starting or retaining a load.
    pub fn peek_asset<A: Asset>(&self, source: &A::Source) -> Option<A::Output> {
        self.loading_assets.get(&(TypeId::of::<A>(), hash(source)))?
            .downcast_ref::<Shared<Task<A::Output>>>()?.clone().now_or_never()
    }

    /// Remove an asset from GPUI's cache
''')
i = 'crates/gpui/src/elements/img.rs'
edit(i, '    /// Remove this image source from the asset system\n', '''    /// Inspect decoded pixels without triggering I/O or decode.
    pub fn cached_image(&self, cx: &App) -> Option<Arc<RenderImage>> {
        match self {
            Self::Resource(resource) => cx.peek_asset::<ImgResourceLoader>(resource).and_then(Result::ok),
            Self::Image(data) => cx.peek_asset::<AssetLogger<ImageDecoder>>(data).and_then(Result::ok),
            Self::Render(data) => Some(data.clone()),
            Self::Custom(_) => None,
        }
    }

    /// Release the asset task and all windows' decoded image atlas tiles.
    pub fn evict(&self, window: Option<&mut Window>, cx: &mut App) {
        let image = self.cached_image(cx);
        self.remove_asset(cx);
        if let Some(image) = image { cx.drop_image(image, window); }
    }

    /// Remove this image source from the asset system
''')
# Removed atlas regions can be reused by a later upload. Complete the previous
# submission before allowing that reuse; commands retain their texture objects.
m = 'crates/gpui_apple/src/metal_atlas.rs'
edit(m, '    fn remove(&self, key: &AtlasKey) {\n', '    fn remove(&self, key: &AtlasKey) {\n        self.wait_for_pending_submissions();\n')
