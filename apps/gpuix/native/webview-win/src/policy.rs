//! The rules `native/webview.m` applies to URLs and paths, and the small decoders the Windows host needs. Platform
//! independent so they are unit-tested on any host.

use std::path::{Component, Path};

/// The wrapper's origin and path. The daemon's preview `frame-ancestors` already lists `http://tauri.localhost`
/// (`previews/files.rs` `FRAME_ANCESTORS`), the origin Tauri serves its own pages from on Windows. A
/// `WebResourceRequested` filter answers every URL under it, so nothing there reaches the network.
pub const WRAPPER_PREFIX: &str = "http://tauri.localhost/embedded/";

/// `http://tauri.localhost/embedded/<id>`, with the id escaped as a path segment (macOS: `URLPathAllowedCharacterSet`).
pub fn wrapper_url(id: &str) -> String {
    let mut url = String::from(WRAPPER_PREFIX);
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@".contains(&byte) {
            url.push(byte as char);
        } else {
            url.push_str(&format!("%{byte:02X}"));
        }
    }
    url
}

/// `scheme://host[:port]` of an http(s) URL, lowercased, without a default port; `None` for other schemes and for URLs
/// with credentials (macOS: `-[KybernWebHost allowsURL:]`).
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') || authority.is_empty() {
        return None;
    }
    let authority = authority.to_ascii_lowercase();
    let default = if scheme == "http" { ":80" } else { ":443" };
    let authority = authority.strip_suffix(default).unwrap_or(&authority);
    Some(format!("{scheme}://{authority}"))
}

/// Whether a frame may load `url`: an http(s) URL on one of the document's origins, or `about:`.
pub fn frame_allows(url: &str, allowed: &[String]) -> bool {
    if url.starts_with("about:") {
        return true;
    }
    origin_of(url).is_some_and(|origin| allowed.iter().any(|a| a.eq_ignore_ascii_case(&origin)))
}

/// `snapshotRect` writes only PNGs under the temp folder (macOS: `NSTemporaryDirectory()`), never through `..`.
pub fn snapshot_path_allowed(path: &str, temp: &Path) -> bool {
    let candidate = Path::new(path);
    candidate.is_absolute()
        && candidate.starts_with(temp)
        && !candidate.components().any(|c| matches!(c, Component::ParentDir))
        && candidate.extension().is_some_and(|e| e.eq_ignore_ascii_case("png"))
}

/// Standard base64 (CDP `Page.captureScreenshot` data). Invalid characters are skipped.
pub fn base64_decode(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let digits: Vec<u8> = text.bytes().filter_map(value).collect();
    let mut out = Vec::with_capacity(digits.len() * 3 / 4);
    for chunk in digits.chunks(4) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, d)| n | (*d as u32) << (18 - 6 * i));
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&bytes[..chunk.len().saturating_sub(1)]);
    }
    out
}

/// Width and height from a PNG's IHDR.
pub fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(png[20..24].try_into().ok()?);
    Some((width, height))
}

/// A JSON string literal, which is also a valid JavaScript string literal.
pub fn js_string(text: &str) -> String {
    serde_json::Value::String(text.to_owned()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_follow_the_macos_rule() {
        assert_eq!(origin_of("http://127.0.0.1:4199/preview-files/x?y#z").as_deref(), Some("http://127.0.0.1:4199"));
        assert_eq!(origin_of("HTTPS://Example.COM:443/").as_deref(), Some("https://example.com"));
        assert_eq!(origin_of("http://example.com:80").as_deref(), Some("http://example.com"));
        assert_eq!(origin_of("http://[::1]:5173/").as_deref(), Some("http://[::1]:5173"));
        assert_eq!(origin_of("http://user:pw@example.com/"), None, "no credentials");
        assert_eq!(origin_of("file:///C:/x"), None);
        assert_eq!(origin_of("javascript:alert(1)"), None);
        let allowed = vec!["http://127.0.0.1:4199".to_owned()];
        assert!(frame_allows("http://127.0.0.1:4199/a", &allowed));
        assert!(frame_allows("about:blank", &allowed));
        assert!(!frame_allows("http://127.0.0.1:4200/a", &allowed));
        assert!(!frame_allows("data:text/html,x", &allowed));
    }

    #[test]
    fn wrapper_ids_are_one_path_segment() {
        assert_eq!(wrapper_url("visual-1"), "http://tauri.localhost/embedded/visual-1");
        assert_eq!(wrapper_url("a/b?c#d e"), "http://tauri.localhost/embedded/a%2Fb%3Fc%23d%20e");
    }

    #[test]
    fn snapshot_paths_stay_in_the_temp_folder() {
        let temp = std::env::temp_dir();
        let inside = temp.join("kybern-pick-1.png");
        assert!(snapshot_path_allowed(inside.to_str().unwrap(), &temp));
        assert!(!snapshot_path_allowed(temp.join("x.jpg").to_str().unwrap(), &temp));
        assert!(!snapshot_path_allowed(temp.join("..").join("x.png").to_str().unwrap(), &temp));
        assert!(!snapshot_path_allowed("relative.png", &temp));
    }

    #[test]
    fn decoders() {
        assert_eq!(base64_decode("aGVsbG8="), b"hello");
        assert_eq!(base64_decode("aGVsbG8h"), b"hello!");
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&600u32.to_be_bytes());
        png.extend_from_slice(&400u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((600, 400)));
        assert_eq!(js_string("a\"b</script>"), r#""a\"b</script>""#);
    }
}
