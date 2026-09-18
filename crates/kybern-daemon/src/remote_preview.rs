//! Bounded previews of remote `http(s)` images. The renderer must not `fetch`
//! those bytes into a canvas; this path fetches on the daemon, thumbnails to
//! 560×352, and never proxies the original raster.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::Duration;

use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use reqwest::Url;
use url::Host;

use crate::self_update::CURRENT_VERSION;
use crate::thumbnail;

const MAX_BYTES: usize = 50 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;

#[derive(Debug, PartialEq, Eq)]
pub enum RemotePreviewError {
    Invalid,
    Forbidden,
    Unavailable,
    TooLarge,
    Unsupported,
}

impl RemotePreviewError {
    fn response(self) -> (StatusCode, &'static str) {
        match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "This image URL cannot be previewed. Open the original image."),
            Self::Forbidden => (StatusCode::FORBIDDEN, "This image URL cannot be previewed. Open the original image."),
            Self::Unavailable => (StatusCode::UNPROCESSABLE_ENTITY, "Preview unavailable for this image. Open the original image."),
            Self::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "images are limited to 50 MB"),
            Self::Unsupported => (StatusCode::UNSUPPORTED_MEDIA_TYPE, "use a PNG, JPEG, GIF, WebP, or AVIF image"),
        }
    }
}

pub async fn response(raw: &str) -> Response {
    match load(raw, false).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "image/png"),
                (header::CACHE_CONTROL, "private, no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Err(error) => error.response().into_response(),
    }
}

fn parse_remote_preview_url(raw: &str, allow_loopback: bool) -> Result<Url, RemotePreviewError> {
    let url = Url::parse(raw).map_err(|_| RemotePreviewError::Invalid)?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(RemotePreviewError::Invalid);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(RemotePreviewError::Forbidden);
    }
    match url.host() {
        Some(Host::Domain(host)) => {
            if host_is_forbidden(host) {
                return Err(RemotePreviewError::Forbidden);
            }
        }
        Some(Host::Ipv4(ip)) => {
            if ip_is_forbidden(IpAddr::V4(ip), allow_loopback) {
                return Err(RemotePreviewError::Forbidden);
            }
        }
        Some(Host::Ipv6(ip)) => {
            if ip_is_forbidden(IpAddr::V6(ip), allow_loopback) {
                return Err(RemotePreviewError::Forbidden);
            }
        }
        None => return Err(RemotePreviewError::Invalid),
    }
    Ok(url)
}

fn host_is_forbidden(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host == "local"
        || host == "internal"
        || host == "arpa"
        || host == "onion"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".arpa")
        || host.ends_with(".onion")
}

fn ip_is_forbidden(ip: IpAddr, allow_loopback: bool) -> bool {
    if allow_loopback && ip.is_loopback() {
        return false;
    }
    match ip {
        IpAddr::V4(ip) => v4_is_forbidden(ip),
        IpAddr::V6(ip) => v6_is_forbidden(ip),
    }
}

fn v4_is_forbidden(ip: Ipv4Addr) -> bool {
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || matches!(ip.octets(), [0, ..] | [100, 64..=127, ..] | [198, 18..=19, ..])
}

fn v6_is_forbidden(ip: Ipv6Addr) -> bool {
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.to_ipv4_mapped().is_some()
}

async fn ensure_public(url: &Url, allow_loopback: bool) -> Result<(), RemotePreviewError> {
    parse_remote_preview_url(url.as_str(), allow_loopback)?;
    let Some(Host::Domain(host)) = url.host() else {
        return Ok(());
    };
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = tokio::net::lookup_host((host, port)).await.map_err(|_| RemotePreviewError::Unavailable)?;
    let mut found = false;
    for addr in addrs {
        found = true;
        if ip_is_forbidden(addr.ip(), allow_loopback) {
            return Err(RemotePreviewError::Forbidden);
        }
    }
    if found { Ok(()) } else { Err(RemotePreviewError::Unavailable) }
}

fn client() -> Result<&'static reqwest::Client, RemotePreviewError> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let built = reqwest::Client::builder()
        .user_agent(format!("kybernd/{CURRENT_VERSION}"))
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| RemotePreviewError::Unavailable)?;
    Ok(CLIENT.get_or_init(|| built))
}

pub async fn load(raw: &str, allow_loopback: bool) -> Result<Vec<u8>, RemotePreviewError> {
    static FETCHES: LazyLock<Arc<tokio::sync::Semaphore>> = LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(4)));
    static DECODES: LazyLock<Arc<tokio::sync::Semaphore>> = LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(2)));
    let _fetch = FETCHES.acquire().await.map_err(|_| RemotePreviewError::Unavailable)?;
    let mut url = parse_remote_preview_url(raw, allow_loopback)?;
    let client = client()?;
    for _ in 0..=MAX_REDIRECTS {
        ensure_public(&url, allow_loopback).await?;
        let response = client.get(url.clone()).send().await.map_err(|_| RemotePreviewError::Unavailable)?;
        if response.status().is_redirection() {
            let location =
                response.headers().get(header::LOCATION).and_then(|value| value.to_str().ok()).ok_or(RemotePreviewError::Unavailable)?;
            url = url.join(location).map_err(|_| RemotePreviewError::Invalid)?;
            continue;
        }
        if !response.status().is_success() {
            return Err(RemotePreviewError::Unavailable);
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| RemotePreviewError::Unavailable)?;
            if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
                return Err(RemotePreviewError::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        if crate::http::image_mime(&bytes).is_none() {
            return Err(RemotePreviewError::Unsupported);
        }
        let permit = DECODES.clone().acquire_owned().await.map_err(|_| RemotePreviewError::Unavailable)?;
        return tokio::task::spawn_blocking(move || {
            let _permit = permit;
            thumbnail::make(&bytes).map_err(|_| RemotePreviewError::Unavailable)
        })
        .await
        .map_err(|_| RemotePreviewError::Unavailable)?;
    }
    Err(RemotePreviewError::Forbidden)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::routing::get;
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
    use std::io::Cursor;
    use std::sync::Arc;

    #[test]
    fn public_https_urls_parse_and_private_targets_do_not() {
        assert!(parse_remote_preview_url("https://example.com/a.png", false).is_ok());
        assert!(parse_remote_preview_url("http://example.com/a.png", false).is_ok());
        assert_eq!(parse_remote_preview_url("https://user:secret@example.com/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://127.0.0.1/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://localhost/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://10.0.0.1/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://169.254.169.254/latest", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://[::1]/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://[::ffff:127.0.0.1]/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://[::ffff:8.8.8.8]/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://[fc00::1]/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://[fe80::1]/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://192.168.0.1/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://foo.local/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("http://metadata.google.internal/a.png", false), Err(RemotePreviewError::Forbidden));
        assert_eq!(parse_remote_preview_url("file:///tmp/a.png", false), Err(RemotePreviewError::Invalid));
        assert_eq!(parse_remote_preview_url("javascript:alert(1)", false), Err(RemotePreviewError::Invalid));
        assert!(parse_remote_preview_url("http://127.0.0.1/a.png", true).is_ok());
        assert!(parse_remote_preview_url("http://[::1]/a.png", true).is_ok());
        assert!(ip_is_forbidden(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)), false));
        assert!(!ip_is_forbidden(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), false));
        assert!(!ip_is_forbidden(IpAddr::V4(Ipv4Addr::LOCALHOST), true));
        assert!(!ip_is_forbidden(IpAddr::V6(Ipv6Addr::LOCALHOST), true));
    }

    #[tokio::test]
    async fn redirects_to_private_targets_are_rejected() {
        let app =
            Router::new().route("/photo.png", get(|| async { (StatusCode::FOUND, [(header::LOCATION, "http://10.0.0.1/secret.png")]) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let error = load(&format!("http://{addr}/photo.png"), true).await.expect_err("private redirect");
        assert_eq!(error, RemotePreviewError::Forbidden);
        server.abort();
    }

    #[tokio::test]
    async fn loopback_preview_fits_the_daemon_pixel_budget() {
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(1800, 600, Rgba([32, 64, 128, 255]))).write_to(&mut png, ImageFormat::Png).unwrap();
        let body = Arc::new(png.into_inner());
        let serve = body.clone();
        let app = Router::new().route(
            "/photo.png",
            get(move || {
                let serve = serve.clone();
                async move { ([(header::CONTENT_TYPE, "image/png")], serve.as_ref().clone()) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let bytes = load(&format!("http://{addr}/photo.png"), true).await.expect("loopback preview");
        let preview = image::load_from_memory(&bytes).unwrap();
        assert!(preview.width() <= thumbnail::WIDTH && preview.height() <= thumbnail::HEIGHT);
        assert!(preview.width() <= 1800 && preview.height() <= 600);
        assert!((f64::from(preview.width()) / f64::from(preview.height()) - 1800.0 / 600.0).abs() < 0.02);
        server.abort();
    }
}
