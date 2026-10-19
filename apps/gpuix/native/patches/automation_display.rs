//! Automated runs (`GPUIX_BACKGROUND=1`) open their windows on the Mac's
//! built-in display. GPUI otherwise centers a new window on the primary
//! display, which follows the screen the user is focused on, so checks and
//! benchmarks would open in front of the user's work. `KYBERN_TEST_DISPLAY=any`
//! opts out. Without a built-in display (lid closed, desktop Mac) nothing changes.

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGDisplayIsBuiltin(display: u32) -> u32;
}

/// The built-in display for an automated run, else `None` (GPUI's default).
pub(crate) fn display() -> Option<gpui::DisplayId> {
    if std::env::var("GPUIX_BACKGROUND").as_deref() != Ok("1")
        || std::env::var("KYBERN_TEST_DISPLAY").as_deref() == Ok("any")
    {
        return None;
    }
    #[cfg(target_os = "macos")]
    unsafe {
        let mut ids = [0u32; 16];
        let mut count = 0u32;
        if CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) != 0 {
            return None;
        }
        return ids[..count as usize]
            .iter()
            .find(|&&id| CGDisplayIsBuiltin(id) != 0)
            .map(|&id| gpui::DisplayId::new(id as u64));
    }
    #[allow(unreachable_code)]
    None
}

/// `Bounds::centered(None, ..)`, but on the automation display when there is
/// one. The platform window places these bounds relative to that display.
pub(crate) fn centered(size: gpui::Size<gpui::Pixels>, cx: &gpui::App) -> gpui::Bounds<gpui::Pixels> {
    match display().and_then(|id| cx.find_display(id)) {
        Some(screen) => {
            let area = screen.bounds().size;
            let inset = |outer: gpui::Pixels, inner: gpui::Pixels| gpui::px(((outer.as_f32() - inner.as_f32()) / 2.0).max(0.0));
            gpui::Bounds {
                origin: gpui::point(inset(area.width, size.width), inset(area.height, size.height)),
                size,
            }
        }
        None => gpui::Bounds::centered(None, size, cx),
    }
}
