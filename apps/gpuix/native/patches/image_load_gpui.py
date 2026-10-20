# Native `<img onLoad>` (lane gpuix-native, for P2.12's reveal on decode): whether an image source has finished loading,
# from the same asset cache `Img` paints from. Executed from backdrop_gpui.py.
i = 'crates/gpui/src/elements/img.rs'
pending[i] = pending.get(i, subprocess.check_output(['git', '-C', str(root), 'show', f'HEAD:{i}'], text=True)) + '''
impl ImageSource {
    /// Kybern: `Some(true)` once the source has decoded, `Some(false)` if it failed, `None` while it loads (this
    /// registers the window for a redraw when it lands, like `Img` does).
    pub fn kybern_loaded(&self, window: &mut Window, cx: &mut App) -> Option<bool> {
        self.use_data(None, window, cx).map(|result| result.is_ok())
    }
}
'''
(root / i).write_text(pending[i])
