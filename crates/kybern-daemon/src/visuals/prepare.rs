use anyhow::{Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::collections::HashMap;
use tokio::io::AsyncReadExt;

pub const MAX_HTML_BYTES: usize = 512_000;
pub const MAX_PAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

fn image_type(path: &str) -> Option<&'static str> {
    Some(match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}
fn absolute(path: &str) -> bool {
    (path.starts_with('/') && !path.starts_with("//"))
        || (path.as_bytes().get(1) == Some(&b':') && matches!(path.as_bytes().get(2), Some(b'/' | b'\\')))
}
/// Whole quoted strings and unquoted CSS url() paths, including JS image strings.
/// One linear scan with bounded path lengths; remote and relative URLs are untouched.
fn references(html: &str) -> Vec<(usize, usize)> {
    let bytes = html.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let (start, end, next) = if matches!(bytes[at], b'"' | b'\'' | b'`') {
            let quote = bytes[at];
            let start = at + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end] != quote && !matches!(bytes[end], b'\n' | b'\r') {
                end += 1;
            }
            (start, end, if end < bytes.len() { end + 1 } else { end })
        } else if bytes[at..].starts_with(b"url(") {
            let mut start = at + 4;
            while bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
                start += 1;
            }
            if matches!(bytes.get(start), Some(b'"' | b'\'' | b'`')) {
                at = start;
                continue;
            }
            let mut end = start;
            while end < bytes.len() && bytes[end] != b')' && !bytes[end].is_ascii_whitespace() {
                end += 1;
            }
            (start, end, end.max(at + 1))
        } else {
            at += 1;
            continue;
        };
        if end > start && end - start <= 2048 && absolute(&html[start..end]) && image_type(&html[start..end]).is_some() {
            out.push((start, end));
        }
        at = next;
    }
    out
}
fn svg_root(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else { return false };
    let mut text = text.trim_start_matches('\u{feff}').trim_start();
    loop {
        if text.starts_with("<?") {
            let Some(end) = text.find("?>") else { return false };
            text = text[end + 2..].trim_start();
        } else if text.starts_with("<!--") {
            let Some(end) = text.find("-->") else { return false };
            text = text[end + 3..].trim_start();
        } else {
            return text.strip_prefix("<svg").is_some_and(|tail| tail.starts_with([' ', '\t', '\r', '\n', '/', '>']));
        }
    }
}
/// Reject a renamed credential/text file instead of copying its contents into a page.
fn is_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || bytes.starts_with(b"\0\0\x01\0")
        || (bytes.starts_with(b"BM") && bytes.get(6..10) == Some(b"\0\0\0\0"))
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"))
        || matches!(bytes.get(4..12), Some(b"ftypavif" | b"ftypavis" | b"ftypmif1"))
        || svg_root(&bytes[..bytes.len().min(4096)])
}

pub async fn prepare(html: &str, tolerate_missing: bool) -> Result<(String, Vec<String>)> {
    ensure!(!html.trim().is_empty() && html.len() <= MAX_HTML_BYTES, "Write a self-contained HTML document of 1–512,000 bytes.");
    let refs = references(html);
    let mut images = HashMap::new();
    let mut missing = Vec::new();
    let mut total = html.len();
    for (start, end) in &refs {
        let path = &html[*start..*end];
        if images.contains_key(path) || missing.iter().any(|p| p == path) {
            continue;
        }
        let file_path = if path.as_bytes().get(1) == Some(&b':') { path.replace("\\\\", "\\") } else { path.to_owned() };
        // Reject directories/devices/FIFOs before opening; only regular image
        // files can be embedded. Canonical symlinks to regular images work.
        if !tokio::fs::metadata(&file_path).await.is_ok_and(|metadata| metadata.is_file()) {
            missing.push(path.to_owned());
            continue;
        }
        let bytes = match tokio::fs::File::open(&file_path).await {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take((MAX_IMAGE_BYTES + 1) as u64).read_to_end(&mut bytes).await?;
                bytes
            }
            Err(_) => {
                missing.push(path.to_owned());
                continue;
            }
        };
        ensure!(bytes.len() <= MAX_IMAGE_BYTES, "Local image {path} exceeds 10 MiB. Use a smaller image.");
        if !is_image(&bytes) {
            missing.push(path.to_owned());
            continue;
        }
        let data = format!("data:{};base64,{}", image_type(path).unwrap(), STANDARD.encode(bytes));
        // Include each occurrence, not just each unique file, before constructing the page.
        let count = refs.iter().filter(|(s, e)| &html[*s..*e] == path).count();
        total = total.saturating_add(data.len().saturating_sub(path.len()).saturating_mul(count));
        ensure!(total <= MAX_PAGE_BYTES, "With embedded images this page exceeds 25 MiB. Use smaller images.");
        images.insert(path.to_owned(), data);
    }
    if !tolerate_missing && !missing.is_empty() {
        bail!("Read these local image files or remove their references: {}", missing.join(", "));
    }
    let mut output = String::with_capacity(total);
    let mut cursor = 0;
    for (start, end) in refs {
        if let Some(data) = images.get(&html[start..end]) {
            output.push_str(&html[cursor..start]);
            output.push_str(data);
            cursor = end;
        }
    }
    output.push_str(&html[cursor..]);
    let output = bootstrap(&output);
    ensure!(output.len() <= MAX_PAGE_BYTES, "With embedded images this page exceeds 25 MiB. Use smaller images.");
    Ok((output, missing))
}

pub fn bootstrap(html: &str) -> String {
    let markup = format!(
        "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style id=\"kybern-visual-theme\">:root{{--background:#191919;--foreground:#eee;--card:#242424;--muted-foreground:#aaa;--border:#444;--accent:#9fa8ff;--chart-1:#9fa8ff;--chart-2:#2dd4bf;--chart-3:#fbbf24;--chart-4:#c084fc;--chart-5:#fb7185;--chart-6:#a3e635;--radius:10px;--font-sans:system-ui,sans-serif;--font-mono:Menlo,monospace}}@media(prefers-color-scheme:light){{:root{{--background:#fff;--foreground:#222;--card:#f5f5f5;--muted-foreground:#666;--border:#ddd}}}}html{{background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans)}}body{{margin:0}}</style><script>{}</script>",
        include_str!("bootstrap.js")
    );
    // Prepend a real head before agent markup, rather than matching inert tags in
    // comments, script strings or templates. HTML's parser merges later head content.
    format!("<!doctype html><html><head>{markup}</head>{html}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_are_bounded_and_remote_urls_are_not_local() {
        let input = r#"<img src="/tmp/a.png"><style>x{background:url(/tmp/b.webp)}</style><script>const s='/tmp/c.svg',r='https://host/a.png',p='//host/a.png'</script>"#;
        let found: Vec<_> = references(input).iter().map(|(s, e)| &input[*s..*e]).collect();
        assert_eq!(found, ["/tmp/a.png", "/tmp/b.webp", "/tmp/c.svg"]);
        assert!(references(&format!("\"/{}.png\"", "a".repeat(3000))).is_empty());
    }
    #[test]
    fn renamed_secrets_are_not_images() {
        assert!(!is_image(b"PASSWORD=secret"));
        assert!(!is_image(b"<not-svg value='<svg/>'>"));
        assert!(is_image(b"<?xml version='1.0'?><!-- image --><svg xmlns='http://www.w3.org/2000/svg'/>"));
        assert!(is_image(b"\x89PNG\r\n\x1a\n"));
    }
    #[tokio::test]
    async fn embedded_images_survive_source_cleanup_and_missing_images_are_reported() {
        let root = std::env::temp_dir().join(format!("kybern-visual-images-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let image = root.join("shot.png");
        let secret = root.join("secret.png");
        tokio::fs::write(&image, b"\x89PNG\r\n\x1a\nimage fixture").await.unwrap();
        tokio::fs::write(&secret, b"PASSWORD=do not embed").await.unwrap();
        let html = format!("<img src=\"{}\"><style>x{{background:url({})}}</style>", image.display(), image.display());
        let (prepared, missing) = prepare(&html, false).await.unwrap();
        assert!(missing.is_empty());
        assert_eq!(prepared.matches("data:image/png;base64,").count(), 2);
        tokio::fs::remove_file(image).await.unwrap();
        assert!(prepared.contains("data:image/png;base64,"));
        let html = format!("<img src=\"{}\">", secret.display());
        assert!(prepare(&html, false).await.is_err());
        let (preview, missing) = prepare(&html, true).await.unwrap();
        assert_eq!(missing.len(), 1);
        assert!(!preview.contains("PASSWORD="));
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
