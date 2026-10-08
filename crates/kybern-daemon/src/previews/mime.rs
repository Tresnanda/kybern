//! Static extension to media type map for the preview file route. No sniffing:
//! responses always carry `X-Content-Type-Options: nosniff`.

use std::path::Path;

pub fn content_type(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "xhtml" => "application/xhtml+xml; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "pdf" => "application/pdf",
        "csv" => "text/csv; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Documents that receive the navigation bridge. SVG is deliberately excluded.
pub fn is_html(path: &Path) -> bool {
    matches!(path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("html" | "htm" | "xhtml"))
}

/// Extensions accepted as the entry document of a preview.
pub fn is_entry_document(path: &Path) -> bool {
    matches!(path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("html" | "htm" | "svg" | "xhtml"))
}
