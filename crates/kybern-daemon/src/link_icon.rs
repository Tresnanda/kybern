//! Site icons for reply links: which `<link rel=icon>` a page offers, the light and dark variants a site publishes
//! (a `media="(prefers-color-scheme: dark)"` link, or an SVG whose `<style>` adapts), and how readable each one is.
//!
//! Every icon is decoded once, bounded, scaled to fit `EDGE` and measured in one pass: the alpha-weighted relative
//! luminance of its visible pixels plus the kind of ink they are. Clients compare that with their own background
//! and put the icon on a plate only when it would be hard to see; nothing is refetched when the theme changes.
use image::{DynamicImage, ImageFormat, ImageReader, Limits, RgbaImage};
use serde_json::{Map, Value, json};
use std::io::Cursor;

/// Longest edge of a stored icon: twice the largest slot a client draws (16 pt at 2x), with room to spare.
pub const EDGE: u32 = 64;
/// Largest icon file read, raster or SVG.
pub const MAX_BYTES: usize = 64 * 1024;
/// Largest source image decoded.
const MAX_SOURCE_EDGE: u32 = 1024;
const MAX_DECODE_BYTES: u64 = 16 * 1024 * 1024;
/// SVG `<use>` references allowed: each can clone a subtree, so a small file could otherwise expand without bound.
const MAX_SVG_USES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Light,
    Dark,
}

/// One `<link rel="icon">` (also `shortcut icon`, `alternate icon`; never `apple-touch-icon` or `mask-icon`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconLink {
    pub href: String,
    /// The colour scheme its `media` query names, if any.
    pub scheme: Option<Scheme>,
    pub svg: bool,
    /// The largest edge in `sizes`, when it lists one.
    pub size: Option<u32>,
}

/// Every icon link in a page head, in document order.
pub fn icon_links(html: &str) -> Vec<IconLink> {
    let lower = html.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<link") {
        let start = from + found;
        let Some(len) = lower[start..].find('>') else { break };
        let end = start + len;
        let tag = &html[start..end];
        from = end;
        let rel = crate::previews::probe::attr(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        if !rel.split_ascii_whitespace().any(|word| word == "icon") {
            continue;
        }
        let Some(href) = crate::previews::probe::attr(tag, "href").filter(|href| !href.is_empty()) else { continue };
        let media = crate::previews::probe::attr(tag, "media").map(|media| compact(&media)).unwrap_or_default();
        let scheme = if media.contains("prefers-color-scheme:dark") {
            Some(Scheme::Dark)
        } else if media.contains("prefers-color-scheme:light") {
            Some(Scheme::Light)
        } else {
            None
        };
        let kind = crate::previews::probe::attr(tag, "type").unwrap_or_default().to_ascii_lowercase();
        let path = href.split(['?', '#']).next().unwrap_or_default().to_ascii_lowercase();
        let svg = kind.contains("svg") || path.ends_with(".svg");
        let size = crate::previews::probe::attr(tag, "sizes").and_then(|sizes| {
            sizes.split_ascii_whitespace().filter_map(|size| size.to_ascii_lowercase().split('x').next()?.parse::<u32>().ok()).max()
        });
        out.push(IconLink { href, scheme, svg, size });
    }
    out
}

/// The icons worth trying for the default (light) look and for dark mode, best first. SVG scales and may adapt to the
/// colour scheme itself; among rasters the smallest one at least 32 px wins, then the largest smaller one.
pub fn candidates(links: &[IconLink]) -> (Vec<&IconLink>, Vec<&IconLink>) {
    let rank = |link: &&IconLink| match (link.svg, link.size) {
        (true, _) => (0, 0),
        (false, Some(size)) if size >= 32 => (1, size),
        (false, Some(size)) => (2, u32::MAX - size),
        (false, None) => (3, 0),
    };
    let mut light: Vec<_> = links.iter().filter(|link| link.scheme != Some(Scheme::Dark)).collect();
    light.sort_by_key(rank);
    let mut dark: Vec<_> = links.iter().filter(|link| link.scheme == Some(Scheme::Dark)).collect();
    dark.sort_by_key(rank);
    (light, dark)
}

fn compact(value: &str) -> String {
    value.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase()
}

/// An SVG drawn as the site intends in light and in dark mode: `@media (prefers-color-scheme: …)` blocks are kept
/// (unwrapped) for their scheme and removed for the other. The dark copy is `None` when the SVG does not adapt.
pub fn svg_variants(svg: &str) -> (String, Option<String>) {
    let blocks = scheme_blocks(svg);
    if blocks.iter().all(|block| block.scheme != Scheme::Dark) {
        return (rewrite(svg, &blocks, Scheme::Light), None);
    }
    (rewrite(svg, &blocks, Scheme::Light), Some(rewrite(svg, &blocks, Scheme::Dark)))
}

struct SchemeBlock {
    scheme: Scheme,
    /// The whole at-rule, `@media` to its closing brace.
    outer: std::ops::Range<usize>,
    /// What sits between its braces.
    inner: std::ops::Range<usize>,
}

fn scheme_blocks(svg: &str) -> Vec<SchemeBlock> {
    let lower = svg.to_ascii_lowercase();
    let bytes = svg.as_bytes();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = lower[from..].find("@media") {
        let start = from + found;
        let Some(open) = lower[start..].find('{').map(|at| start + at) else { break };
        let prelude = compact(&svg[start + "@media".len()..open]);
        let scheme = if prelude.contains("prefers-color-scheme:dark") {
            Some(Scheme::Dark)
        } else if prelude.contains("prefers-color-scheme:light") {
            Some(Scheme::Light)
        } else {
            None
        };
        let mut depth = 0usize;
        let mut close = None;
        for (index, byte) in bytes.iter().enumerate().skip(open) {
            match byte {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(index);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(close) = close else { break };
        if let Some(scheme) = scheme {
            out.push(SchemeBlock { scheme, outer: start..close + 1, inner: open + 1..close });
        }
        from = close + 1;
    }
    out
}

fn rewrite(svg: &str, blocks: &[SchemeBlock], keep: Scheme) -> String {
    let mut out = String::with_capacity(svg.len());
    let mut at = 0;
    for block in blocks {
        out.push_str(&svg[at..block.outer.start]);
        if block.scheme == keep {
            out.push_str(&svg[block.inner.clone()]);
        }
        at = block.outer.end;
    }
    out.push_str(&svg[at..]);
    out
}

/// What kind of ink an icon's visible pixels are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ink {
    /// Mostly near-black: hard to see on a dark background.
    Dark,
    /// Mostly light: hard to see on a light background.
    Light,
    /// Both dark and light parts (a mark on its own tile, a two-tone logo): readable on either.
    Mixed,
    /// Mostly saturated mid-tones, told apart from either background by hue.
    Color,
}

impl Ink {
    fn as_str(self) -> &'static str {
        match self {
            Ink::Dark => "dark",
            Ink::Light => "light",
            Ink::Mixed => "mixed",
            Ink::Color => "color",
        }
    }
}

/// How readable an icon is: the relative luminance (WCAG) of its visible pixels, weighted by their alpha, and its ink.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tone {
    pub luminance: f64,
    pub ink: Ink,
}

/// Measure an icon in one pass. Fully transparent pixels are ignored and partly transparent ones count by their
/// alpha, so a single-colour mark on a transparent background is judged by its mark. `None` when nothing is visible.
pub fn tone(image: &RgbaImage) -> Option<Tone> {
    let linear = |channel: u8| {
        let c = f64::from(channel) / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let (mut weight, mut sum, mut dark, mut light, mut color, mut solid) = (0.0f64, 0.0, 0.0, 0.0, 0.0, 0usize);
    for pixel in image.pixels() {
        let [r, g, b, a] = pixel.0;
        if a == 0 {
            continue;
        }
        let alpha = f64::from(a) / 255.0;
        let y = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
        let chroma = f64::from(r.max(g).max(b) - r.min(g).min(b)) / 255.0;
        weight += alpha;
        sum += alpha * y;
        solid += usize::from(a >= 128);
        // 3:1 against black needs Y >= 0.1; against white Y <= 0.3.
        if chroma >= 0.4 && (0.1..=0.5).contains(&y) {
            color += alpha;
        } else if y < 0.1 {
            dark += alpha;
        } else if y > 0.3 {
            light += alpha;
        }
    }
    if weight < 1.0 {
        return None;
    }
    let luminance = sum / weight;
    // About where the contrast with black equals the contrast with white.
    let dark_ink = luminance < 0.18;
    // What stands out from the icon's main ink: light or coloured parts of a dark icon, dark or coloured parts of a light one.
    let feature = if dark_ink { light + color } else { dark + color } / weight;
    // An icon drawn on its own tile (a white glyph in a black circle) is readable by its glyph even where the tile
    // melts into the background. A transparent mark needs a large second ink: a white logo with a small blue accent
    // shows only the accent on white.
    let tile = solid as f64 >= 0.6 * f64::from(image.width() * image.height());
    let ink = if color / weight >= 0.5 {
        Ink::Color
    } else if feature >= 0.4 || (tile && feature >= 0.04) {
        Ink::Mixed
    } else if dark_ink {
        Ink::Dark
    } else {
        Ink::Light
    };
    Some(Tone { luminance: (luminance * 1000.0).round() / 1000.0, ink })
}

/// One icon ready for a client: a PNG no larger than `EDGE` and its tone.
#[derive(Debug, Clone)]
pub struct Icon {
    pub png: Vec<u8>,
    pub tone: Tone,
}

impl Icon {
    pub fn data_url(&self) -> String {
        use base64::Engine as _;
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&self.png))
    }
}

/// Whether bytes are SVG source rather than a raster image.
pub fn is_svg(bytes: &[u8]) -> bool {
    // Raster formats start with binary magic; markup starts with `<` (after a BOM or whitespace).
    let text = String::from_utf8_lossy(bytes);
    text.trim_start_matches('\u{feff}').trim_start().starts_with('<') && text.to_ascii_lowercase().contains("<svg")
}

/// Decode a raster favicon (PNG, ICO, GIF, JPEG, WebP, BMP) or rasterize an SVG one, scale it to fit `EDGE`, and
/// measure it. `None` for anything unreadable, oversized or blank.
pub fn decode(bytes: &[u8]) -> Option<Icon> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return None;
    }
    let image = if is_svg(bytes) { rasterize(std::str::from_utf8(bytes).ok()?)? } else { raster(bytes)? };
    let tone = tone(&image)?;
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image).write_to(&mut png, ImageFormat::Png).ok()?;
    Some(Icon { png: png.into_inner(), tone })
}

fn raster(bytes: &[u8]) -> Option<RgbaImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_EDGE);
    limits.max_image_height = Some(MAX_SOURCE_EDGE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let image = reader.decode().ok()?;
    let image =
        if image.width().max(image.height()) > EDGE { image.resize(EDGE, EDGE, image::imageops::FilterType::Triangle) } else { image };
    Some(image.to_rgba8())
}

/// Rasterize SVG with no external or embedded resources: an `<image>` inside it draws nothing.
pub fn rasterize(svg: &str) -> Option<RgbaImage> {
    use resvg::{tiny_skia, usvg};
    if svg.len() > MAX_BYTES || svg.matches("<use").count() > MAX_SVG_USES {
        return None;
    }
    let options = usvg::Options {
        image_href_resolver: usvg::ImageHrefResolver { resolve_data: Box::new(|_, _, _| None), resolve_string: Box::new(|_, _| None) },
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_str(svg, &options).ok()?;
    let size = tree.size();
    let longest = size.width().max(size.height());
    if !(longest.is_finite() && longest > 0.0) {
        return None;
    }
    let scale = EDGE as f32 / longest;
    let width = ((size.width() * scale).round() as u32).clamp(1, EDGE);
    let height = ((size.height() * scale).round() as u32).clamp(1, EDGE);
    let mut pixmap = tiny_skia::Pixmap::new(width, height)?;
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let mut out = RgbaImage::new(width, height);
    for (pixel, source) in out.pixels_mut().zip(pixmap.pixels()) {
        let color = source.demultiply();
        pixel.0 = [color.red(), color.green(), color.blue(), color.alpha()];
    }
    Some(out)
}

/// A site's icon for the default look and, when it publishes one, for dark mode.
#[derive(Debug, Clone)]
pub struct SiteIcons {
    pub light: Icon,
    pub dark: Option<Icon>,
}

impl SiteIcons {
    /// The `LinkMetadata` fields: `favicon` (unchanged for older clients), its tone, and the dark variant.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        let mut put = |prefix: &str, icon: &Icon| {
            out.insert(prefix.to_string(), json!(icon.data_url()));
            out.insert(format!("{prefix}Luminance"), json!(icon.tone.luminance));
            out.insert(format!("{prefix}Ink"), json!(icon.tone.ink.as_str()));
        };
        put("favicon", &self.light);
        if let Some(dark) = &self.dark {
            put("faviconDark", dark);
        }
        Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(image: &RgbaImage) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image.clone()).write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    /// A centred mark of `color` on a transparent 32×32 tile, covering a quarter of it, with soft edges.
    fn mark(color: [u8; 3]) -> RgbaImage {
        RgbaImage::from_fn(32, 32, |x, y| {
            let inside = (8..24).contains(&x) && (8..24).contains(&y);
            let edge = (7..25).contains(&x) && (7..25).contains(&y);
            image::Rgba([
                color[0],
                color[1],
                color[2],
                if inside {
                    255
                } else if edge {
                    96
                } else {
                    0
                },
            ])
        })
    }

    #[test]
    fn a_black_mark_on_transparency_is_dark_ink_and_a_white_one_light() {
        let black = decode(&png(&mark([0, 0, 0]))).unwrap();
        assert_eq!(black.tone, Tone { luminance: 0.0, ink: Ink::Dark });
        let white = decode(&png(&mark([255, 255, 255]))).unwrap();
        assert_eq!(white.tone, Tone { luminance: 1.0, ink: Ink::Light });
        // The transparent three quarters of the tile do not dilute either measurement.
        let grey = tone(&mark([0x77, 0x77, 0x77])).unwrap();
        assert!((grey.luminance - 0.184).abs() < 0.002, "{grey:?}");
    }

    #[test]
    fn two_tone_and_colourful_icons_are_readable_on_both_backgrounds() {
        // A white glyph on its own black tile.
        let tile =
            RgbaImage::from_fn(
                32,
                32,
                |x, _| if (10..22).contains(&x) { image::Rgba([255, 255, 255, 255]) } else { image::Rgba([0, 0, 0, 255]) },
            );
        assert_eq!(tone(&tile).unwrap().ink, Ink::Mixed);
        // A white glyph covering a twentieth of a black disc that fills its box (the Vercel and Next.js icons).
        let disc = RgbaImage::from_fn(32, 32, |x, y| {
            let (dx, dy) = (x as f32 - 15.5, y as f32 - 15.5);
            if dx * dx + dy * dy > 256.0 {
                image::Rgba([0, 0, 0, 0])
            } else if (12..18).contains(&x) && (13..21).contains(&y) {
                image::Rgba([255, 255, 255, 255])
            } else {
                image::Rgba([0, 0, 0, 255])
            }
        });
        assert_eq!(tone(&disc).unwrap().ink, Ink::Mixed);
        // The same few light pixels on a transparent mark do not make it readable on a dark background.
        let sparse = RgbaImage::from_fn(32, 32, |x, y| match (x, y) {
            (14..18, 14..16) => image::Rgba([255, 255, 255, 255]),
            (8..24, 8..24) => image::Rgba([0, 0, 0, 255]),
            _ => image::Rgba([0, 0, 0, 0]),
        });
        assert_eq!(tone(&sparse).unwrap().ink, Ink::Dark);
        // White brackets around a small blue slash on transparency (htmx's) show only the slash on white.
        let accent = RgbaImage::from_fn(32, 32, |x, y| match (x, y) {
            (14..18, 4..28) => image::Rgba([0x34, 0x65, 0xe0, 255]),
            (4..12 | 20..28, 4..28) => image::Rgba([255, 255, 255, 255]),
            _ => image::Rgba([0, 0, 0, 0]),
        });
        assert_eq!(tone(&accent).unwrap().ink, Ink::Light);
        // A blue and yellow logo (Python's) is readable on both, not "light".
        let python = RgbaImage::from_fn(32, 32, |x, y| match (x, y) {
            (4..16, 4..28) => image::Rgba([0x37, 0x76, 0xab, 255]),
            (16..28, 4..28) => image::Rgba([0xff, 0xd4, 0x3b, 255]),
            _ => image::Rgba([0, 0, 0, 0]),
        });
        assert!(matches!(tone(&python).unwrap().ink, Ink::Mixed | Ink::Color));
        assert_eq!(tone(&mark([0xf7, 0x4c, 0x00])).unwrap().ink, Ink::Color, "a saturated orange");
        assert_eq!(tone(&mark([0x00, 0x00, 0x80])).unwrap().ink, Ink::Dark, "navy is dark however saturated");
        assert_eq!(tone(&mark([0xff, 0xe0, 0x00])).unwrap().ink, Ink::Light, "yellow is light");
    }

    #[test]
    fn blank_or_unreadable_icons_are_refused() {
        assert!(decode(&png(&RgbaImage::from_pixel(16, 16, image::Rgba([0, 0, 0, 0])))).is_none());
        assert!(decode(b"not an image").is_none());
        assert!(decode(&vec![0u8; MAX_BYTES + 1]).is_none());
        let huge = RgbaImage::from_pixel(MAX_SOURCE_EDGE + 1, 4, image::Rgba([0, 0, 0, 255]));
        assert!(decode(&png(&huge)).is_none());
    }

    #[test]
    fn large_icons_are_scaled_to_fit_the_edge() {
        let icon = decode(&png(&RgbaImage::from_pixel(256, 128, image::Rgba([0, 0, 0, 255])))).unwrap();
        let decoded = image::load_from_memory(&icon.png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (EDGE, EDGE / 2));
    }

    const ADAPTIVE: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>path { fill: #000; } @media (prefers-color-scheme: dark) { path { fill: #fff; } }</style><path d="M8 8h16v16H8z"/></svg>"#;

    #[test]
    fn an_adaptive_svg_gives_a_light_and_a_dark_variant() {
        let (light, dark) = svg_variants(ADAPTIVE);
        assert!(!light.contains("@media") && light.contains("fill: #000"));
        let dark = dark.unwrap();
        assert!(!dark.contains("@media") && dark.contains("fill: #fff"));
        let light = decode(light.as_bytes()).unwrap();
        let dark = decode(dark.as_bytes()).unwrap();
        assert_eq!(light.tone.ink, Ink::Dark);
        assert_eq!(dark.tone.ink, Ink::Light);
        let raster = image::load_from_memory(&light.png).unwrap();
        assert_eq!((raster.width(), raster.height()), (EDGE, EDGE));
        // A light-scheme block is kept for light and dropped for dark.
        let (light, dark) = svg_variants(
            "<svg><style>@media (prefers-color-scheme:light){a{b:c}} @media (prefers-color-scheme: dark) { x { y: z } } @media (min-width: 1px) { k { v: w } }</style></svg>",
        );
        assert_eq!(light, "<svg><style>a{b:c}  @media (min-width: 1px) { k { v: w } }</style></svg>");
        assert_eq!(dark.unwrap(), "<svg><style>  x { y: z }  @media (min-width: 1px) { k { v: w } }</style></svg>");
        assert!(svg_variants("<svg><path/></svg>").1.is_none());
    }

    #[test]
    fn svg_never_loads_images_and_refuses_use_bombs() {
        let embedded = r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16"><image href="/etc/passwd" width="16" height="16"/><image xlink:href="data:image/svg+xml;base64,PHN2Zy8+" width="16" height="16"/></svg>"#;
        assert!(decode(embedded.as_bytes()).is_none(), "nothing visible: the images were never resolved");
        let bomb = format!(r#"<svg xmlns="http://www.w3.org/2000/svg">{}</svg>"#, r##"<use href="#a"/>"##.repeat(MAX_SVG_USES + 1));
        assert!(rasterize(&bomb).is_none());
    }

    #[test]
    fn icon_links_name_their_scheme_type_and_size_and_rank_svg_first() {
        let html = r#"<head><link rel="apple-touch-icon" href="/apple.png"><link rel="mask-icon" href="/mask.svg">
            <link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="16x16" href="/16.png">
            <link rel="icon" type="image/png" sizes="32x32" href="/32.png"><link rel="shortcut icon" href="/logo.svg?v=2">
            <link rel="icon" href="/dark.png" media="(prefers-color-scheme: dark)"><link rel="icon" href="/light.png" media="(prefers-color-scheme:light)"></head>"#;
        let links = icon_links(html);
        assert_eq!(
            links.iter().map(|link| link.href.as_str()).collect::<Vec<_>>(),
            ["/favicon.ico", "/16.png", "/32.png", "/logo.svg?v=2", "/dark.png", "/light.png"]
        );
        assert!(
            links[3].svg && links[2].size == Some(32) && links[4].scheme == Some(Scheme::Dark) && links[5].scheme == Some(Scheme::Light)
        );
        let (light, dark) = candidates(&links);
        assert_eq!(
            light.iter().map(|link| link.href.as_str()).collect::<Vec<_>>(),
            ["/logo.svg?v=2", "/32.png", "/16.png", "/favicon.ico", "/light.png"]
        );
        assert_eq!(dark.iter().map(|link| link.href.as_str()).collect::<Vec<_>>(), ["/dark.png"]);
    }

    #[test]
    fn json_keeps_favicon_and_adds_tone_and_the_dark_variant() {
        let light = decode(&png(&mark([0, 0, 0]))).unwrap();
        let dark = decode(&png(&mark([255, 255, 255]))).unwrap();
        let value = SiteIcons { light: light.clone(), dark: Some(dark) }.to_json();
        assert!(value["favicon"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(value["faviconInk"], "dark");
        assert_eq!(value["faviconLuminance"], 0.0);
        assert_eq!(value["faviconDarkInk"], "light");
        assert_eq!(value["faviconDarkLuminance"], 1.0);
        let value = SiteIcons { light, dark: None }.to_json();
        assert!(value.get("faviconDark").is_none());
    }
}
