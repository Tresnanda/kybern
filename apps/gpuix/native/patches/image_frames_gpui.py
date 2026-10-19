# A one-frame SmallVec::from_elem clones image::Frame and its pixel Vec.
# Move the decoded buffer into RenderImage; every painter shares its outer Arc.
a = 'crates/gpui/src/assets.rs'
edit(a, 'Some(Self::new(SmallVec::from_elem(Frame::new(buffer), 1)))',
     'Some(Self::new(if image_frame_move_enabled() { SmallVec::from_buf([Frame::new(buffer)]) } else { SmallVec::from_elem(Frame::new(buffer), 1) }))')
edit(a, '        let image = RenderImage::from_bgra(2, 1, bytes.clone()).expect("valid BGRA image");',
     '        let expected = bytes.clone();\n        let buffer_ptr = bytes.as_ptr();\n        let image = RenderImage::from_bgra(2, 1, bytes).expect("valid BGRA image");\n        assert_eq!(image.as_bytes(0).unwrap().as_ptr(), buffer_ptr, "RenderImage must take ownership without copying pixels");')
edit(a, 'assert_eq!(image.as_bytes(0), Some(bytes.as_slice()));',
     'assert_eq!(image.as_bytes(0), Some(expected.as_slice()));')
edit('crates/gpui/src/platform.rs', 'Ok(SmallVec::from_elem(Frame::new(data), 1))',
     'Ok(if crate::assets::image_frame_move_enabled() { SmallVec::from_buf([Frame::new(data)]) } else { SmallVec::from_elem(Frame::new(data), 1) })')

pending[a] += """
// Same-binary allocation-copy control; normal paints share Arc<RenderImage>.
pub(crate) fn image_frame_move_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("KYBERN_IMAGE_FRAME_MOVE").as_deref() != Ok("0"))
}
"""
