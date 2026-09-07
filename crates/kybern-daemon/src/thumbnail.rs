//! Bounded, static previews. Originals retain their format and animation.
use anyhow::{Context, Result, ensure};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use std::io::Cursor;

pub const WIDTH: u32 = 560;
pub const HEIGHT: u32 = 352;
const MAX_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 96 * 1024 * 1024;

pub fn make(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().context("This format has no static preview; open the original image")?;
    let (width, height) = decoder.dimensions();
    ensure!(
        u64::from(width) * u64::from(height) <= MAX_PIXELS && decoder.total_bytes() <= MAX_DECODE_BYTES,
        "This image is too large for a preview; open the original image"
    );
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let preview = image.thumbnail(WIDTH.min(image.width()), HEIGHT.min(image.height()));
    let mut output = Cursor::new(Vec::new());
    preview.write_to(&mut output, ImageFormat::Png)?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn previews_fit_bounds_preserve_alpha_and_aspect_ratio() {
        for (width, height) in [(1800, 600), (600, 1800), (80, 40)] {
            let source = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(width, height, image::Rgba([32, 64, 128, 128])));
            let mut original = Cursor::new(Vec::new());
            source.write_to(&mut original, ImageFormat::Png).unwrap();
            let bytes = make(original.get_ref()).unwrap();
            let preview = image::load_from_memory(&bytes).unwrap();
            assert!(preview.width() <= WIDTH && preview.height() <= HEIGHT);
            assert!(preview.width() <= width && preview.height() <= height);
            assert!((f64::from(preview.width()) / f64::from(preview.height()) - f64::from(width) / f64::from(height)).abs() < 0.02);
            assert_eq!(preview.to_rgba8().get_pixel(0, 0).0, [32, 64, 128, 128]);
        }
    }
    #[test]
    fn rejects_unsupported_or_invalid_data_without_decoding() {
        assert!(make(b"not an image").is_err());
        assert!(make(b"\0\0\0\x20ftypavif").is_err());
    }
}
