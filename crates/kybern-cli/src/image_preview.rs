//! The desktop's display copy, with the same encoder on every OS.
use anyhow::{Result, ensure};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, imageops::FilterType};
use std::path::Path;

pub fn make(input: &Path, output: &Path, width: u32) -> Result<()> {
    ensure!((1..=4096).contains(&width), "display width must be between 1 and 4096");
    let mut reader = ImageReader::open(input)?.with_guessed_format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let height = (u64::from(image.height()) * u64::from(width) / u64::from(image.width())).max(1) as u32;
    let preview = if image.width() > width { image.resize_exact(width, height, FilterType::Lanczos3) } else { image };
    preview.save_with_format(output, ImageFormat::Png)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn display_copy_is_filtered_and_original_stays_full_size() {
        let root = std::env::temp_dir().join(format!("kybern-image-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let input = root.join("original.png");
        let output = root.join("display.tmp");
        let source = image::RgbaImage::from_fn(1600, 900, |x, _| image::Rgba([if x % 2 == 0 { 0 } else { 255 }, 0, 0, 255]));
        source.save(&input).unwrap();
        make(&input, &output, 560).unwrap();
        let preview = ImageReader::open(&output).unwrap().with_guessed_format().unwrap().decode().unwrap();
        assert_eq!((preview.width(), preview.height()), (560, 315));
        assert!((100..=155).contains(&preview.to_rgba8().get_pixel(280, 150)[0]), "fine stripes are filtered, not aliased");
        assert_eq!(image::image_dimensions(&input).unwrap(), (1600, 900));
        std::fs::remove_dir_all(root).unwrap();
    }
}
