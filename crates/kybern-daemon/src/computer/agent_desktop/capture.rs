//! Pictures: scaling, the geometry `click_at` and `zoom` need, and the
//! live-view pause (design §6).

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;

use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat};

use super::super::backend::{Image, Region};
use super::envelope::AdError;

/// How many windows keep their last picture for `zoom`.
const KEPT_CAPTURES: usize = 8;
/// Never upscale a zoom past this many times its native pixels.
const MAX_ZOOM_UPSCALE: f64 = 2.0;

/// A rectangle in screen points: x, y, width, height.
pub(crate) type Rect = (f64, f64, f64, f64);

/// The latest full picture of one window: where the window was and how big
/// the picture handed to the tools is.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Geometry {
    pub width: u32,
    pub height: u32,
    pub window: Option<Rect>,
}

/// The latest zoom: the region of the full picture it shows, and its size.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ZoomGeometry {
    pub region: Region,
    pub width: u32,
    pub height: u32,
}

struct Kept {
    /// The full-resolution picture as PNG.
    png: Vec<u8>,
    geometry: Geometry,
    zoom: Option<ZoomGeometry>,
    stamp: u64,
}

#[derive(Default)]
struct Store {
    kept: HashMap<(String, u64), Kept>,
    clock: u64,
}

/// Per (session, window) memory of the latest capture.
#[derive(Default)]
pub(crate) struct Captures {
    inner: Mutex<Store>,
}

impl Captures {
    pub(crate) fn remember(&self, session: &str, window: u64, png: Vec<u8>, geometry: Geometry) {
        let mut guard = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.clock += 1;
        let stamp = guard.clock;
        guard.kept.insert((session.to_owned(), window), Kept { png, geometry, zoom: None, stamp });
        while guard.kept.len() > KEPT_CAPTURES {
            let Some(oldest) = guard.kept.iter().min_by_key(|(_, kept)| kept.stamp).map(|(key, _)| key.clone()) else { break };
            guard.kept.remove(&oldest);
        }
    }

    pub(crate) fn png(&self, session: &str, window: u64) -> Option<(Vec<u8>, Geometry)> {
        let guard = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.kept.get(&(session.to_owned(), window)).map(|kept| (kept.png.clone(), kept.geometry.clone()))
    }

    pub(crate) fn remember_zoom(&self, session: &str, window: u64, zoom: ZoomGeometry) {
        let mut guard = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(kept) = guard.kept.get_mut(&(session.to_owned(), window)) {
            kept.zoom = Some(zoom);
        }
    }

    /// Update the window rectangle of the latest picture (a later read saw it move).
    pub(crate) fn update_window(&self, session: &str, window: u64, rect: Rect) {
        let mut guard = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(kept) = guard.kept.get_mut(&(session.to_owned(), window)) {
            kept.geometry.window = Some(rect);
        }
    }

    pub(crate) fn geometry(&self, session: &str, window: u64) -> Option<(Geometry, Option<ZoomGeometry>)> {
        let guard = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.kept.get(&(session.to_owned(), window)).map(|kept| (kept.geometry.clone(), kept.zoom.clone()))
    }
}

/// Fit a picture inside `edge` × `edge` without enlarging it; returns the
/// PNG for the tools.
pub(crate) fn scaled(png: &[u8], edge: u32) -> Result<Image> {
    let decoded = image::load_from_memory(png).context("agent-desktop returned a picture that is not an image")?;
    let fitted = fit(decoded, edge);
    encode(&fitted)
}

fn fit(image: DynamicImage, edge: u32) -> DynamicImage {
    if edge == 0 || image.width().max(image.height()) <= edge { image } else { image.resize(edge, edge, FilterType::Triangle) }
}

fn encode(image: &DynamicImage) -> Result<Image> {
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, ImageFormat::Png).context("encode the picture")?;
    Ok(Image { mime: "image/png".into(), data: STANDARD.encode(bytes.into_inner()), width: image.width(), height: image.height() })
}

/// Pixels of a decoded picture, for geometry.
pub(crate) fn dimensions(png: &[u8]) -> Result<(u32, u32)> {
    let decoded = image::load_from_memory(png).context("agent-desktop returned a picture that is not an image")?;
    Ok((decoded.width(), decoded.height()))
}

/// Crop `region` (pixels of the picture the tools saw, which is `shown_*`
/// wide) out of the full-resolution `png`, scaled to `edge`.
pub(crate) fn crop(png: &[u8], shown_width: u32, shown_height: u32, region: Region, edge: u32) -> Result<(Image, ZoomGeometry)> {
    let full = image::load_from_memory(png).context("agent-desktop returned a picture that is not an image")?;
    let (shown_width, shown_height) = (shown_width.max(1) as f64, shown_height.max(1) as f64);
    let (left, right) = (region[0].min(region[2]).clamp(0.0, shown_width), region[0].max(region[2]).clamp(0.0, shown_width));
    let (top, bottom) = (region[1].min(region[3]).clamp(0.0, shown_height), region[1].max(region[3]).clamp(0.0, shown_height));
    anyhow::ensure!(right - left >= 1.0 && bottom - top >= 1.0, "the region is empty or outside the picture");
    let (scale_x, scale_y) = (full.width() as f64 / shown_width, full.height() as f64 / shown_height);
    let (x, y) = ((left * scale_x).floor() as u32, (top * scale_y).floor() as u32);
    let width = (((right - left) * scale_x).round() as u32).clamp(1, full.width().saturating_sub(x).max(1));
    let height = (((bottom - top) * scale_y).round() as u32).clamp(1, full.height().saturating_sub(y).max(1));
    let cropped = full.crop_imm(x, y, width, height);
    let native_long = width.max(height) as f64;
    let target = (edge as f64).min(native_long * MAX_ZOOM_UPSCALE).max(1.0).round() as u32;
    let resized = if target == width.max(height) { cropped } else { cropped.resize(target, target, FilterType::Lanczos3) };
    let image = encode(&resized)?;
    let geometry = ZoomGeometry { region: [left, top, right, bottom], width: image.width, height: image.height };
    Ok((image, geometry))
}

/// Capture pixels → screen points: where `click_at` aims. `x`, `y` are pixels
/// of the picture the agent saw; with `from_zoom` they are pixels of the
/// latest zoom of it.
pub(crate) fn screen_point(geometry: &Geometry, zoom: Option<&ZoomGeometry>, x: f64, y: f64, from_zoom: bool) -> Option<(f64, f64)> {
    let (window_x, window_y, window_width, window_height) = geometry.window?;
    if geometry.width == 0 || geometry.height == 0 || window_width <= 0.0 || window_height <= 0.0 {
        return None;
    }
    let (px, py) = if from_zoom {
        let zoom = zoom?;
        if zoom.width == 0 || zoom.height == 0 {
            return None;
        }
        (
            zoom.region[0] + x * (zoom.region[2] - zoom.region[0]) / zoom.width as f64,
            zoom.region[1] + y * (zoom.region[3] - zoom.region[1]) / zoom.height as f64,
        )
    } else {
        (x, y)
    };
    if px < 0.0 || py < 0.0 || px > geometry.width as f64 || py > geometry.height as f64 {
        return None;
    }
    Some((window_x + px * window_width / geometry.width as f64, window_y + py * window_height / geometry.height as f64))
}

/// Why pictures are off for this daemon run.
#[derive(Default)]
pub(crate) struct Pause {
    reason: Mutex<Option<String>>,
}

impl Pause {
    pub(crate) fn get(&self) -> Option<String> {
        self.reason.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    pub(crate) fn set(&self, reason: String) {
        *self.reason.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(reason);
    }

    pub(crate) fn clear(&self) {
        *self.reason.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

/// The pause reason a failed capture earns, if any (design §6): a declined or
/// unanswered consent dialog, or a missing Screen Recording grant.
pub(crate) fn pause_reason(error: &AdError, wayland: bool) -> Option<String> {
    let consent = matches!(error.code.as_str(), "PERM_DENIED" | "TIMEOUT");
    let screen_recording = error.code == "PERM_DENIED"
        && format!("{} {}", error.message, error.suggestion.as_deref().unwrap_or("")).to_lowercase().contains("screen recording");
    if !(consent && wayland || screen_recording) {
        return None;
    }
    let detail = error.suggestion.as_deref().filter(|text| !text.is_empty()).unwrap_or(&error.message);
    let first = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    let first: String = first.chars().take(240).collect();
    Some(if wayland {
        format!("Screenshots are off: the desktop's screenshot permission was declined or not answered ({}: {first})", error.code)
    } else {
        format!("Screenshots are off: {first}")
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image::RgbImage::from_pixel(width, height, image::Rgb([200, 30, 30])))
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    fn geometry() -> Geometry {
        // A 2x retina window of 400 x 300 points captured at 800 x 600 and shown at 400 x 300.
        Geometry { width: 400, height: 300, window: Some((100.0, 50.0, 400.0, 300.0)) }
    }

    #[test]
    fn pictures_fit_the_requested_edge_without_enlarging() {
        let image = scaled(&png(1600, 1000), 800).unwrap();
        assert_eq!((image.width, image.height), (800, 500));
        assert_eq!(image.mime, "image/png");
        let small = scaled(&png(300, 200), 800).unwrap();
        assert_eq!((small.width, small.height), (300, 200));
        assert_eq!(dimensions(&STANDARD.decode(&image.data).unwrap()).unwrap(), (800, 500));
    }

    #[test]
    fn click_at_maps_pixels_to_screen_points() {
        let geometry = Geometry { width: 800, height: 600, window: Some((100.0, 50.0, 400.0, 300.0)) };
        // A picture twice the window's point size (retina): halve, then offset.
        assert_eq!(screen_point(&geometry, None, 200.0, 100.0, false), Some((200.0, 100.0)));
        assert_eq!(screen_point(&geometry, None, 0.0, 0.0, false), Some((100.0, 50.0)));
        assert_eq!(screen_point(&geometry, None, 801.0, 10.0, false), None);
        let no_window = Geometry { window: None, ..geometry.clone() };
        assert_eq!(screen_point(&no_window, None, 1.0, 1.0, false), None);
        // A zoom is needed for from_zoom.
        assert_eq!(screen_point(&geometry, None, 1.0, 1.0, true), None);
    }

    #[test]
    fn click_at_maps_a_zoom_back_through_its_region() {
        let geometry = geometry();
        // Region 100..200 x 50..150 of the picture, shown at 400 x 400.
        let zoom = ZoomGeometry { region: [100.0, 50.0, 200.0, 150.0], width: 400, height: 400 };
        // The zoom's centre is the region's centre (150, 100) → window (100 + 150, 50 + 100).
        assert_eq!(screen_point(&geometry, Some(&zoom), 200.0, 200.0, true), Some((250.0, 150.0)));
        assert_eq!(screen_point(&geometry, Some(&zoom), 0.0, 0.0, true), Some((200.0, 100.0)));
        // Without from_zoom the same numbers address the full picture.
        assert_eq!(screen_point(&geometry, Some(&zoom), 200.0, 200.0, false), Some((300.0, 250.0)));
    }

    #[test]
    fn zoom_crops_the_full_resolution_picture() {
        // Full picture 800 x 600 shown at 400 x 300: the region is in shown pixels.
        let (image, zoom) = crop(&png(800, 600), 400, 300, [100.0, 50.0, 200.0, 150.0], 400).unwrap();
        assert_eq!(zoom.region, [100.0, 50.0, 200.0, 150.0]);
        // Native crop is 200 x 200; the zoom may double it but not beyond the edge.
        assert_eq!((image.width, image.height), (400, 400));
        let (small, _) = crop(&png(800, 600), 400, 300, [100.0, 50.0, 200.0, 150.0], 100).unwrap();
        assert_eq!((small.width, small.height), (100, 100));
        assert!(crop(&png(800, 600), 400, 300, [10.0, 10.0, 10.0, 10.0], 100).is_err());
        // Reversed corners and out-of-range values clamp.
        let (_, clamped) = crop(&png(800, 600), 400, 300, [500.0, 400.0, 350.0, 250.0], 100).unwrap();
        assert_eq!(clamped.region, [350.0, 250.0, 400.0, 300.0]);
    }

    #[test]
    fn captures_keep_the_latest_per_window_and_cap_their_number() {
        let captures = Captures::default();
        for window in 0..12u64 {
            captures.remember("s", window, png(4, 4), geometry());
        }
        assert!(captures.png("s", 0).is_none());
        assert!(captures.png("s", 11).is_some());
        assert!(captures.png("other", 11).is_none());
        captures.remember_zoom("s", 11, ZoomGeometry { region: [0.0, 0.0, 2.0, 2.0], width: 4, height: 4 });
        assert!(captures.geometry("s", 11).unwrap().1.is_some());
        captures.update_window("s", 11, (1.0, 2.0, 3.0, 4.0));
        assert_eq!(captures.geometry("s", 11).unwrap().0.window, Some((1.0, 2.0, 3.0, 4.0)));
        // A new capture drops the old zoom.
        captures.remember("s", 11, png(4, 4), geometry());
        assert!(captures.geometry("s", 11).unwrap().1.is_none());
    }

    fn error(code: &str, message: &str, suggestion: Option<&str>) -> AdError {
        AdError {
            code: code.into(),
            message: message.into(),
            suggestion: suggestion.map(str::to_owned),
            delivery: Some("not_delivered".into()),
            details: Value::Null,
        }
    }

    #[test]
    fn a_wayland_consent_failure_pauses_pictures_until_resumed() {
        let pause = Pause::default();
        assert!(pause.get().is_none());
        let denied = error("PERM_DENIED", "Screenshot request was denied", Some("Allow screenshots in the desktop's privacy settings"));
        let reason = pause_reason(&denied, true).unwrap();
        assert!(reason.contains("PERM_DENIED") && reason.contains("privacy settings"), "{reason}");
        pause.set(reason);
        assert!(pause.get().is_some());
        pause.clear();
        assert!(pause.get().is_none());

        let timeout = error("TIMEOUT", "The portal did not answer", Some("Answer the dialog"));
        assert!(pause_reason(&timeout, true).is_some());
        // Elsewhere a timeout is just a slow capture, and other errors never pause.
        assert!(pause_reason(&timeout, false).is_none());
        assert!(pause_reason(&error("ACTION_FAILED", "x", None), true).is_none());
        let mac = error("PERM_DENIED", "Screen Recording permission not granted", None);
        assert!(pause_reason(&mac, false).unwrap().starts_with("Screenshots are off: "));
        let _ = json!(null);
    }
}
