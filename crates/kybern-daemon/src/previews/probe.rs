//! `previews.probe`: one bounded GET against a loopback or private-network
//! address, used before the Preview panel loads a dev server and by port
//! discovery. Public hosts are refused outright (no SSRF surface), redirects
//! are never followed, and at most 64 KB of the body is read.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use kybern_protocol::methods::{PreviewFrameBlock, PreviewProbeError, PreviewProbeResult};

/// Total budget for one probe (spec 5.1).
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
/// Body bytes read for `<title>` and `<link rel=icon>`.
pub const MAX_BODY: usize = 64 * 1024;
/// Largest favicon embedded as a data URL.
pub const MAX_FAVICON: usize = 16 * 1024;

/// The address is not loopback or private-network.
#[derive(Debug, thiserror::Error)]
#[error("invalid_address: preview probes only reach this computer or its private network")]
pub struct InvalidAddress;

/// Everything a probe learned; `result` is what `previews.probe` returns.
#[derive(Debug, Clone)]
pub struct ProbeOutcome {
    pub result: PreviewProbeResult,
    pub content_type: Option<String>,
    pub server: Option<String>,
    pub powered_by: Option<String>,
    /// `href` of the first `<link rel=icon>`, unresolved.
    pub favicon_href: Option<String>,
    /// Whether the body mentions Vite's client.
    pub vite: bool,
    pub resolved: Option<SocketAddr>,
}

fn blank() -> PreviewProbeResult {
    PreviewProbeResult { reachable: false, status: None, error: None, blocked_by: None, title: None, location: None }
}

impl ProbeOutcome {
    pub fn is_html(&self) -> bool {
        self.content_type.as_deref().is_some_and(|value| value.to_ascii_lowercase().contains("text/html"))
    }

    pub fn is_redirect(&self) -> bool {
        self.result.location.is_some() && self.result.status.is_some_and(|status| (300..400).contains(&status))
    }
}

/// Loopback, private (RFC 1918), CGNAT (Tailscale), link-local and unique-local
/// addresses. `0.0.0.0` / `::` reach the local machine and are allowed.
pub fn is_local_or_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let o = ip.octets();
            ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return is_local_or_private_ip(IpAddr::V4(v4));
            }
            let first = ip.segments()[0];
            ip.is_loopback() || ip.is_unspecified() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// Probe `raw_url` with the default 1.5 s budget.
pub async fn probe(raw_url: &str) -> Result<PreviewProbeResult, InvalidAddress> {
    Ok(probe_detailed(raw_url, PROBE_TIMEOUT).await?.result)
}

/// Probe with a caller-chosen budget, keeping headers and body hints.
pub async fn probe_detailed(raw_url: &str, timeout: Duration) -> Result<ProbeOutcome, InvalidAddress> {
    let url = reqwest::Url::parse(raw_url.trim()).map_err(|_| InvalidAddress)?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return Err(InvalidAddress);
    }
    let host = url.host_str().ok_or(InvalidAddress)?.to_string();
    let port = url.port_or_known_default().ok_or(InvalidAddress)?;
    let literal: Option<IpAddr> = host.trim_start_matches('[').trim_end_matches(']').parse().ok();
    let deadline = tokio::time::Instant::now() + timeout;

    let (addr, all) = match literal {
        Some(ip) => {
            if !is_local_or_private_ip(ip) {
                return Err(InvalidAddress);
            }
            (SocketAddr::new(ip, port), vec![SocketAddr::new(ip, port)])
        }
        None => {
            let resolved = match tokio::time::timeout_at(deadline, tokio::net::lookup_host((host.as_str(), port))).await {
                Err(_) => return Ok(failed(PreviewProbeError::TimedOut)),
                Ok(Err(_)) => return Ok(failed(PreviewProbeError::Dns)),
                Ok(Ok(addrs)) => addrs.collect::<Vec<_>>(),
            };
            if resolved.is_empty() {
                return Ok(failed(PreviewProbeError::Dns));
            }
            // Every answer must be local: a name that also resolves to a public address is refused.
            if !resolved.iter().all(|addr| is_local_or_private_ip(addr.ip())) {
                return Err(InvalidAddress);
            }
            (resolved[0], resolved)
        }
    };

    let mut outcome = match tokio::time::timeout_at(deadline, fetch(url, &host, &all, literal.is_none(), timeout)).await {
        Ok(outcome) => outcome,
        Err(_) => failed(PreviewProbeError::TimedOut),
    };
    outcome.resolved = Some(addr);
    Ok(outcome)
}

fn failed(error: PreviewProbeError) -> ProbeOutcome {
    ProbeOutcome {
        result: PreviewProbeResult { error: Some(error), ..blank() },
        content_type: None,
        server: None,
        powered_by: None,
        favicon_href: None,
        vite: false,
        resolved: None,
    }
}

fn client(host: &str, addrs: &[SocketAddr], pin: bool, timeout: Duration) -> Option<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(timeout)
        .user_agent("Kybern-Preview-Probe")
        .pool_max_idle_per_host(0);
    if pin {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    builder.build().ok()
}

async fn fetch(url: reqwest::Url, host: &str, addrs: &[SocketAddr], pin: bool, timeout: Duration) -> ProbeOutcome {
    let Some(client) = client(host, addrs, pin, timeout) else { return failed(PreviewProbeError::NotHttp) };
    let response = match client.get(url).header(reqwest::header::ACCEPT, "text/html").send().await {
        Ok(response) => response,
        Err(error) => return failed(classify(&error)),
    };
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let text = |name: reqwest::header::HeaderName| headers.get(name).and_then(|value| value.to_str().ok()).map(str::to_string);
    let content_type = text(reqwest::header::CONTENT_TYPE);
    let is_html = content_type.as_deref().is_some_and(|value| value.to_ascii_lowercase().contains("text/html"));
    let location = text(reqwest::header::LOCATION);

    let mut body = Vec::new();
    let mut response = response;
    if is_html {
        while body.len() < MAX_BODY {
            match response.chunk().await {
                Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                _ => break,
            }
        }
        body.truncate(MAX_BODY);
    }
    let body_text = String::from_utf8_lossy(&body);

    let mut result = PreviewProbeResult { reachable: true, status: Some(status), location, ..blank() };
    if status >= 500 && !is_html {
        result.reachable = false;
        result.error = Some(PreviewProbeError::HttpStatus);
    }
    result.blocked_by = frame_block(&headers);
    let mut favicon_href = None;
    let mut vite = false;
    if is_html {
        result.title = html_title(&body_text);
        favicon_href = html_icon_href(&body_text);
        vite = body_text.contains("/@vite/client");
    }
    ProbeOutcome {
        result,
        content_type,
        server: text(reqwest::header::SERVER),
        powered_by: text(reqwest::header::HeaderName::from_static("x-powered-by")),
        favicon_href,
        vite,
        resolved: addrs.first().copied(),
    }
}

fn classify(error: &reqwest::Error) -> PreviewProbeError {
    if error.is_timeout() {
        return PreviewProbeError::TimedOut;
    }
    let mut chain = String::new();
    let mut refused = false;
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = source {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            refused |= io.kind() == std::io::ErrorKind::ConnectionRefused;
            if io.kind() == std::io::ErrorKind::TimedOut {
                return PreviewProbeError::TimedOut;
            }
        }
        chain.push_str(&current.to_string().to_ascii_lowercase());
        chain.push(' ');
        source = current.source();
    }
    if refused || chain.contains("connection refused") {
        PreviewProbeError::ConnectionRefused
    } else if chain.contains("certificate") || chain.contains("tls") || chain.contains("ssl") || chain.contains("handshake") {
        PreviewProbeError::Tls
    } else if chain.contains("dns error") || chain.contains("failed to lookup") {
        PreviewProbeError::Dns
    } else if error.is_connect() && !chain.contains("invalid http") {
        PreviewProbeError::ConnectionRefused
    } else {
        PreviewProbeError::NotHttp
    }
}

/// `X-Frame-Options: DENY|SAMEORIGIN` or a CSP whose `frame-ancestors` lacks `*`.
pub fn frame_block(headers: &reqwest::header::HeaderMap) -> Option<PreviewFrameBlock> {
    for value in headers.get_all("x-frame-options") {
        let value = value.to_str().unwrap_or_default().trim();
        let upper = value.to_ascii_uppercase();
        if upper.starts_with("DENY") || upper.starts_with("SAMEORIGIN") || upper.starts_with("ALLOW-FROM") {
            return Some(PreviewFrameBlock { header: "x-frame-options".into(), value: value.to_string() });
        }
    }
    for value in headers.get_all("content-security-policy") {
        let value = value.to_str().unwrap_or_default();
        if let Some(directive) = frame_ancestors(value)
            && !directive.split_ascii_whitespace().skip(1).any(|source| source == "*")
        {
            return Some(PreviewFrameBlock { header: "content-security-policy".into(), value: directive.to_string() });
        }
    }
    None
}

/// The `frame-ancestors ...` directive of one CSP header value, if any.
pub fn frame_ancestors(csp: &str) -> Option<&str> {
    csp.split(';').map(str::trim).find(|directive| {
        directive.split_ascii_whitespace().next().is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors"))
    })
}

fn html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<title") {
        let start = from + found;
        let after = lower.as_bytes().get(start + 6).copied();
        if !matches!(after, Some(b'>' | b' ' | b'\t' | b'\n' | b'\r')) {
            from = start + 6;
            continue;
        }
        let open = start + lower[start..].find('>')? + 1;
        let close = open + lower[open..].find("</title")?;
        let title = decode_entities(html[open..close].split_whitespace().collect::<Vec<_>>().join(" ").as_str());
        return (!title.is_empty()).then(|| title.chars().take(200).collect());
    }
    None
}

fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'").replace("&amp;", "&")
}

fn html_icon_href(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<link") {
        let start = from + found;
        let end = start + lower[start..].find('>')?;
        let tag = &html[start..end];
        let rel = attr(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        if rel.split_ascii_whitespace().any(|word| word == "icon")
            && let Some(href) = attr(tag, "href")
            && !href.is_empty()
        {
            return Some(href);
        }
        from = end;
    }
    None
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let start = from + found;
        from = start + name.len();
        let before_ok = start == 0 || lower.as_bytes()[start - 1].is_ascii_whitespace();
        let rest = tag[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        if !before_ok {
            continue;
        }
        let rest = rest.trim_start();
        return Some(match rest.chars().next()? {
            quote @ ('"' | '\'') => rest[1..].split(quote).next()?.to_string(),
            _ => rest.split(|c: char| c.is_ascii_whitespace() || c == '>').next()?.to_string(),
        });
    }
    None
}

/// Fetch a same-host favicon (<= 16 KB image) as a data URL.
pub async fn favicon_data_url(page_url: &str, href: Option<&str>, addr: SocketAddr, timeout: Duration) -> Option<String> {
    use base64::Engine as _;
    let page = reqwest::Url::parse(page_url).ok()?;
    let target = match href {
        Some(href) => page.join(href).ok()?,
        None => page.join("/favicon.ico").ok()?,
    };
    if target.host_str() != page.host_str() || target.port_or_known_default() != page.port_or_known_default() {
        return None;
    }
    let host = page.host_str()?;
    let client = client(host, &[addr], host.parse::<IpAddr>().is_err(), timeout)?;
    let fetch = async {
        let mut response = client.get(target).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let kind = response.headers().get(reqwest::header::CONTENT_TYPE)?.to_str().ok()?.split(';').next()?.trim().to_ascii_lowercase();
        if !kind.starts_with("image/") {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > MAX_FAVICON {
                return None;
            }
        }
        (!bytes.is_empty()).then(|| format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    };
    tokio::time::timeout(timeout, fetch).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// One-shot-per-connection server answering every request with `response`.
    pub(crate) async fn serve(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = socket.read(&mut buf).await;
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        port
    }

    const HTML: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><head><title> Hello &amp; welcome </title><link rel=\"shortcut icon\" href=\"/f.png\"></head><body>x</body></html>";

    #[tokio::test]
    async fn html_server_reports_title() {
        let port = serve(HTML).await;
        let result = probe(&format!("http://127.0.0.1:{port}/")).await.unwrap();
        assert!(result.reachable);
        assert_eq!(result.status, Some(200));
        assert_eq!(result.title.as_deref(), Some("Hello & welcome"));
        assert!(result.error.is_none() && result.blocked_by.is_none());
    }

    #[tokio::test]
    async fn localhost_name_resolves_locally() {
        let port = serve(HTML).await;
        let result = probe(&format!("http://localhost:{port}/")).await.unwrap();
        assert!(result.reachable);
    }

    #[tokio::test]
    async fn x_frame_options_is_reported() {
        let port = serve("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Frame-Options: SAMEORIGIN\r\nConnection: close\r\n\r\n<title>t</title>").await;
        let result = probe(&format!("http://127.0.0.1:{port}")).await.unwrap();
        let block = result.blocked_by.unwrap();
        assert_eq!((block.header.as_str(), block.value.as_str()), ("x-frame-options", "SAMEORIGIN"));
    }

    #[tokio::test]
    async fn csp_frame_ancestors_is_reported_unless_wildcard() {
        let port = serve("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: default-src 'self'; frame-ancestors 'self'\r\nConnection: close\r\n\r\nx").await;
        let result = probe(&format!("http://127.0.0.1:{port}")).await.unwrap();
        let block = result.blocked_by.unwrap();
        assert_eq!(block.header, "content-security-policy");
        assert_eq!(block.value, "frame-ancestors 'self'");

        let open = serve("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: frame-ancestors *\r\nConnection: close\r\n\r\nx").await;
        assert!(probe(&format!("http://127.0.0.1:{open}")).await.unwrap().blocked_by.is_none());
    }

    #[tokio::test]
    async fn redirects_are_reported_not_followed() {
        let port = serve("HTTP/1.1 302 Found\r\nLocation: /login\r\nConnection: close\r\n\r\n").await;
        let result = probe(&format!("http://127.0.0.1:{port}")).await.unwrap();
        assert_eq!(result.status, Some(302));
        assert_eq!(result.location.as_deref(), Some("/login"));
        assert!(result.reachable);
    }

    #[tokio::test]
    async fn non_http_listener_is_not_http() {
        let port = serve("SSH-2.0-OpenSSH_9.0\r\n").await;
        let result = probe(&format!("http://127.0.0.1:{port}")).await.unwrap();
        assert!(!result.reachable);
        assert_eq!(result.error, Some(PreviewProbeError::NotHttp));
    }

    #[tokio::test]
    async fn server_error_without_html_is_http_status() {
        let port = serve("HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nno").await;
        let result = probe(&format!("http://127.0.0.1:{port}")).await.unwrap();
        assert_eq!((result.reachable, result.status, result.error), (false, Some(503), Some(PreviewProbeError::HttpStatus)));
    }

    #[tokio::test]
    async fn closed_port_is_connection_refused() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let result = probe(&format!("http://127.0.0.1:{port}")).await.unwrap();
        assert!(!result.reachable);
        assert_eq!(result.error, Some(PreviewProbeError::ConnectionRefused));
    }

    #[tokio::test]
    async fn silent_server_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _held = listener.accept().await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let outcome = probe_detailed(&format!("http://127.0.0.1:{port}"), Duration::from_millis(300)).await.unwrap();
        assert_eq!(outcome.result.error, Some(PreviewProbeError::TimedOut));
    }

    #[tokio::test]
    async fn public_hosts_are_refused() {
        for url in ["http://example.com", "http://8.8.8.8/", "https://1.1.1.1", "http://[2001:4860:4860::8888]/", "ftp://127.0.0.1", "http://user:pw@127.0.0.1/", "not a url"] {
            assert!(probe(url).await.is_err(), "{url} must be refused");
        }
    }

    #[test]
    fn local_and_private_classification() {
        for ok in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.5", "100.100.1.1", "169.254.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"] {
            assert!(is_local_or_private_ip(ok.parse().unwrap()), "{ok}");
        }
        for no in ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"] {
            assert!(!is_local_or_private_ip(no.parse().unwrap()), "{no}");
        }
    }

    #[test]
    fn html_scanning() {
        assert_eq!(html_title("<TITLE lang=x>A\n b</TITLE>").as_deref(), Some("A b"));
        assert_eq!(html_title("<titlefoo>x</titlefoo>"), None);
        assert_eq!(html_icon_href("<link rel=stylesheet href=a.css><link href='/i.svg' rel='icon'>").as_deref(), Some("/i.svg"));
        assert_eq!(html_icon_href("<link rel=\"apple-touch-icon\" href=a>"), None);
    }
}
