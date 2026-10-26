//! The clip recipe of one document, as `native/webview.m` `-[KybernWebHost mask]` builds it: the clip box with its own
//! corner radius, intersected with every rounded ancestor clip, minus every occlusion layer ordered above the document.
//! Occlusions with `dim` shade the document instead of cutting it; `inputOnly` ones only block the pointer. Platform
//! independent so the Windows host (Direct2D path → `CompositionGeometricClip`) and its pointer filter use one model.
//! Coordinates are logical points relative to the clip box's top-left.

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RoundedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Top-left, top-right, bottom-right, bottom-left.
    pub radii: [f64; 4],
}

impl RoundedRect {
    pub fn uniform(x: f64, y: f64, width: f64, height: f64, radius: f64) -> Self {
        Self { x, y, width, height, radii: [radius; 4] }
    }

    pub fn contains(&self, px: f64, py: f64) -> bool {
        if px < self.x || py < self.y || px > self.x + self.width || py > self.y + self.height {
            return false;
        }
        // Each corner: inside unless the point is in the corner square and outside its arc.
        let corners = [
            (self.x, self.y, self.radii[0], 1.0, 1.0),
            (self.x + self.width, self.y, self.radii[1], -1.0, 1.0),
            (self.x + self.width, self.y + self.height, self.radii[2], -1.0, -1.0),
            (self.x, self.y + self.height, self.radii[3], 1.0, -1.0),
        ];
        corners.iter().all(|&(cx, cy, r, sx, sy)| {
            if r <= 0.0 {
                return true;
            }
            let (ox, oy) = (cx + sx * r, cy + sy * r);
            let in_square = (px - cx) * sx < r && (py - cy) * sy < r;
            !in_square || (px - ox).powi(2) + (py - oy).powi(2) <= r * r
        })
    }

    fn intersects(&self, other: &RoundedRect) -> bool {
        self.x < other.x + other.width && other.x < self.x + self.width && self.y < other.y + other.height && other.y < self.y + self.height
    }
}

/// A box in whole device pixels. Composition offsets and sizes are set from it, never from `points × scale`, so the clip
/// edge lands on a pixel at 125, 150 and 175 % and the mask and the pointer filter use the box that is painted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PixelRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl PixelRect {
    /// Each edge rounded on its own, so boxes that touch in points touch in pixels and the size never drifts.
    pub fn snap(x: f64, y: f64, width: f64, height: f64, scale: f64) -> Self {
        let px = |v: f64| (v * scale).round() as i32;
        let (left, top) = (px(x), px(y));
        PixelRect { left, top, right: px(x + width).max(left), bottom: px(y + height).max(top) }
    }

    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    /// The same box in window points (what `Mask::build` and the pointer filter take).
    pub fn points(&self, scale: f64, radius: f64) -> RoundedRect {
        let s = if scale > 0.0 { scale } else { 1.0 };
        RoundedRect::uniform(self.left as f64 / s, self.top as f64 / s, self.width() as f64 / s, self.height() as f64 / s, radius)
    }
}

/// One `occlusion` command (`webHost.occlusion`), in window points.
#[derive(Clone, Copy, Debug)]
pub struct Occlusion {
    pub rect: RoundedRect,
    pub order: i64,
    pub dim: f64,
    pub input_only: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mask {
    /// The paint clip is `base ∩ intersect[..] − subtract[..]`.
    pub base: Option<RoundedRect>,
    pub intersect: Vec<RoundedRect>,
    pub subtract: Vec<RoundedRect>,
    /// Pointer holes: every occlusion above the document, dimming and input-only ones included.
    pub blocked: Vec<RoundedRect>,
    /// Opacity of the black shade over the document (a modal's backdrop above it).
    pub dim: f64,
}

impl Mask {
    /// `clip` is the clip box in window points, `radius` its own corner radius, `rounded_clips` the `place` command's
    /// `roundedClips` (`[x, y, w, h, tl, tr, br, bl]` in window points), `layer` the document's own order.
    pub fn build(clip: RoundedRect, radius: f64, rounded_clips: &[[f64; 8]], occlusions: &[Occlusion], layer: i64) -> Mask {
        let local = |r: RoundedRect| RoundedRect { x: r.x - clip.x, y: r.y - clip.y, ..r };
        let base = RoundedRect::uniform(0.0, 0.0, clip.width, clip.height, radius);
        let intersect = rounded_clips
            .iter()
            .map(|s| local(RoundedRect { x: s[0], y: s[1], width: s[2], height: s[3], radii: [s[4], s[5], s[6], s[7]] }))
            .collect();
        let mut mask = Mask { base: Some(base), intersect, ..Mask::default() };
        for occlusion in occlusions.iter().filter(|o| o.order > layer) {
            let hole = local(occlusion.rect);
            mask.blocked.push(hole);
            if occlusion.input_only {
                continue;
            }
            if occlusion.dim > 0.0 {
                if base.intersects(&hole) {
                    mask.dim = mask.dim.max(occlusion.dim);
                }
                continue;
            }
            mask.subtract.push(hole);
        }
        mask
    }

    /// The pointer filter's hit test (`-[KybernWebClip hitTest:]`): inside the paint clip and outside every hole.
    pub fn hit(&self, x: f64, y: f64) -> bool {
        self.base.is_some_and(|b| b.contains(x, y))
            && self.intersect.iter().all(|r| r.contains(x, y))
            && !self.blocked.iter().any(|r| r.contains(x, y))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boxes_snap_to_whole_device_pixels() {
        for scale in [1.25, 1.5, 1.75] {
            let clip = PixelRect::snap(20.3, 100.1, 560.5, 360.7, scale);
            assert_eq!(clip.left, (20.3 * scale).round() as i32);
            assert_eq!(clip.right, ((20.3 + 560.5) * scale).round() as i32);
            assert_eq!(clip.width(), clip.right - clip.left);
            // Back in points, the box multiplies to the same whole pixels (what the Direct2D path is drawn from).
            let points = clip.points(scale, 0.0);
            assert!(((points.x * scale) - clip.left as f64).abs() < 1e-9, "{scale}");
            assert!(((points.width * scale) - clip.width() as f64).abs() < 1e-9, "{scale}");
            assert!(((points.height * scale) - clip.height() as f64).abs() < 1e-9, "{scale}");
            // Neighbours in points share an edge in pixels: no seam, no overlap.
            let left = PixelRect::snap(0.0, 0.0, 33.3, 10.0, scale);
            let right = PixelRect::snap(33.3, 0.0, 33.3, 10.0, scale);
            assert_eq!(left.right, right.left, "{scale}");
        }
        // 1.5 × 0.5 pt rounds half away from zero on both edges, so the size stays the sum of its parts.
        let odd = PixelRect::snap(0.5, 0.5, 1.0, 1.0, 1.5);
        assert_eq!((odd.left, odd.right, odd.width()), (1, 2, 1));
        assert_eq!(PixelRect::snap(10.0, 10.0, -4.0, 0.0, 1.25).width(), 0, "never negative");
    }

    #[test]
    fn hit_testing_uses_the_snapped_box() {
        let scale = 1.75;
        let snapped = PixelRect::snap(20.2, 100.2, 100.0, 50.0, scale);
        let clip = snapped.points(scale, 0.0);
        let mask = Mask::build(clip, 0.0, &[], &[], 0);
        // The painted box ends at its rounded right edge: a point just inside it hits, just past it misses.
        let right = snapped.width() as f64 / scale;
        assert!(mask.hit(right - 0.01, 10.0));
        assert!(!mask.hit(right + 0.01, 10.0));
    }

    #[test]
    fn corners_and_holes_follow_the_macos_mask() {
        let clip = RoundedRect::uniform(100.0, 100.0, 400.0, 300.0, 0.0);
        let menu = Occlusion { rect: RoundedRect::uniform(300.0, 150.0, 120.0, 80.0, 8.0), order: 5, dim: 0.0, input_only: false };
        let below = Occlusion { rect: RoundedRect::uniform(100.0, 100.0, 400.0, 300.0, 0.0), order: 0, dim: 0.0, input_only: false };
        let modal = Occlusion { rect: RoundedRect::uniform(0.0, 0.0, 1000.0, 800.0, 0.0), order: 9, dim: 0.4, input_only: false };
        let mask = Mask::build(clip, 12.0, &[], &[menu, below], 1);
        assert!(mask.hit(50.0, 50.0));
        assert!(!mask.hit(1.0, 1.0), "outside the rounded corner");
        assert!(!mask.hit(250.0, 100.0), "inside the menu hole");
        assert_eq!(mask.subtract.len(), 1, "an occlusion ordered below the document does not cut it");
        let dimmed = Mask::build(clip, 0.0, &[], &[modal], 1);
        assert!(dimmed.subtract.is_empty());
        assert_eq!(dimmed.dim, 0.4);
        assert!(!dimmed.hit(10.0, 10.0), "a dimming backdrop still blocks the pointer");
        let chained = Mask::build(clip, 0.0, &[[100.0, 100.0, 400.0, 300.0, 0.0, 0.0, 24.0, 24.0]], &[], 1);
        assert!(!chained.hit(399.0, 299.0), "an ancestor's rounded bottom corner clips the document");
        assert!(chained.hit(399.0, 1.0));
    }
}
