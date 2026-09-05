//! Canonical addresses shared by desktop setup and CLI discovery. Identity is
//! supplied by daemon.info; an address is only a route to that identity.

use anyhow::{Result, bail};
use url::Url;

pub fn normalize(input: &str) -> Result<String> {
    let input = input.trim();
    let explicit_scheme = input.contains("://");
    let mut url = Url::parse(&if explicit_scheme { input.to_owned() } else { format!("ws://{input}") })?;
    let scheme = match url.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        _ => bail!("Use an http, https, ws, or wss address"),
    };
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Enter a server address without credentials, query parameters, or a fragment");
    }
    url.set_scheme(scheme).map_err(|_| anyhow::anyhow!("Invalid server address"))?;
    // Explicit HTTPS URLs use the standard TLS port, including Tailscale Serve.
    // Bare hostnames retain Kybern's familiar daemon port.
    if !explicit_scheme && url.port().is_none() {
        url.set_port(Some(kybern_protocol::DEFAULT_PORT)).map_err(|_| anyhow::anyhow!("Invalid port"))?;
    }
    let path = url.path().trim_end_matches('/');
    if !path.ends_with("/ws") {
        url.set_path(&format!("{path}/ws"));
    }
    Ok(url.to_string())
}

pub fn http_base(websocket_url: &str) -> Result<String> {
    let mut url = Url::parse(&normalize(websocket_url)?)?;
    let scheme = if url.scheme() == "wss" { "https" } else { "http" };
    url.set_scheme(scheme).map_err(|_| anyhow::anyhow!("Invalid server address"))?;
    let path = url.path().trim_end_matches('/').strip_suffix("/ws").unwrap_or("").to_owned();
    url.set_path(&path);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_secure_origins_and_proxy_paths() {
        assert_eq!(normalize("https://machine.example.ts.net").unwrap(), "wss://machine.example.ts.net/ws");
        assert_eq!(http_base("wss://host.example/kybern/ws").unwrap(), "https://host.example/kybern");
        assert_eq!(normalize("100.64.0.1:4199").unwrap(), "ws://100.64.0.1:4199/ws");
        assert_eq!(normalize("machine").unwrap(), "ws://machine:4173/ws");
        assert_eq!(normalize("[::1]:4199").unwrap(), "ws://[::1]:4199/ws");
    }

    #[test]
    fn rejects_embedded_credentials_and_non_network_urls() {
        for value in ["", "file:///tmp/a", "https://user:secret@host", "https://host?token=secret", "https://host/#secret"] {
            assert!(normalize(value).is_err(), "{value}");
        }
    }
}
