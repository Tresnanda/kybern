//! Host-side endpoint discovery. Never infer reachability from an outbound IP:
//! only advertise interfaces covered by the listener or an actual Serve proxy.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;

async fn output(program: &str, args: &[&str]) -> Option<String> {
    let output =
        tokio::time::timeout(Duration::from_secs(2), Command::new(program).args(args).kill_on_drop(true).output()).await.ok()?.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn tailscale(args: &[&str]) -> Option<String> {
    if let Some(text) = output("tailscale", args).await {
        return Some(text);
    }
    // The macOS GUI installation does not always put its CLI on PATH.
    #[cfg(target_os = "macos")]
    return output("/Applications/Tailscale.app/Contents/MacOS/Tailscale", args).await;
    #[cfg(not(target_os = "macos"))]
    None
}

async fn interfaces() -> Vec<IpAddr> {
    #[cfg(target_os = "windows")]
    {
        return output(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-NetIPAddress | Where-Object { $_.AddressState -eq 'Preferred' } | Select-Object -ExpandProperty IPAddress",
            ],
        )
        .await
        .map(|text| text.lines().filter_map(|line| line.trim().parse().ok()).collect())
        .unwrap_or_default();
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(text) = output("ip", &["-j", "address", "show", "up"]).await
            && let Ok(value) = serde_json::from_str::<Value>(&text)
        {
            return linux_addresses(&value);
        }
        let text = match output("ifconfig", &[]).await {
            Some(text) => Some(text),
            None => output("/sbin/ifconfig", &[]).await,
        };
        text.map(|text| ifconfig_addresses(&text)).unwrap_or_default()
    }
}

#[cfg(any(not(target_os = "windows"), test))]
fn linux_addresses(value: &Value) -> Vec<IpAddr> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|interface| interface["flags"].as_array().is_some_and(|flags| flags.iter().any(|flag| flag == "UP")))
        .flat_map(|interface| interface["addr_info"].as_array().into_iter().flatten())
        .filter(|address| address["tentative"] != true && address["dadfailed"] != true && address["deprecated"] != true)
        .filter_map(|address| address["local"].as_str()?.parse().ok())
        .collect()
}

#[cfg(any(not(target_os = "windows"), test))]
fn ifconfig_addresses(text: &str) -> Vec<IpAddr> {
    let mut up = false;
    let mut addresses = vec![];
    for line in text.lines() {
        if !line.starts_with(char::is_whitespace) {
            up = line
                .split_once('<')
                .and_then(|(_, flags)| flags.split_once('>'))
                .is_some_and(|(flags, _)| flags.split(',').any(|flag| flag == "UP"));
        }
        if !up || line.contains("tentative") || line.contains("deprecated") {
            continue;
        }
        let mut words = line.split_whitespace();
        if matches!(words.next(), Some("inet" | "inet6"))
            && let Some(ip) = words.next().and_then(|word| word.parse().ok())
        {
            addresses.push(ip);
        }
    }
    addresses
}

fn usable(ip: IpAddr) -> bool {
    if ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    match ip {
        IpAddr::V4(ip) => !ip.is_link_local() && !ip.is_broadcast() && ip.octets()[0] != 0,
        IpAddr::V6(ip) => !ip.is_unicast_link_local() && ip.to_ipv4_mapped().is_none(),
    }
}

fn listens_on(bound: SocketAddr, ip: IpAddr) -> bool {
    // Do not assume that an IPv6 wildcard listener accepts IPv4 on every OS.
    bound.ip() == ip || (bound.ip().is_unspecified() && bound.is_ipv4() == ip.is_ipv4())
}

fn proxy_matches(proxy: &str, bound: SocketAddr) -> bool {
    let candidate = if let Ok(port) = proxy.parse::<u16>() {
        format!("http://127.0.0.1:{port}")
    } else if !proxy.contains("://") {
        format!("http://{proxy}")
    } else {
        proxy.to_owned()
    };
    let Ok(base) = kybern_client::address::http_base(&candidate) else {
        return false;
    };
    if candidate.strip_prefix("http://").is_none_or(|authority| authority.trim_end_matches('/').contains('/')) {
        return false;
    }
    // Serve must target this listener, with no upstream path rewrite or TLS.
    let targets = [bound.ip().to_string(), "127.0.0.1".into(), "::1".into(), "localhost".into()];
    targets.iter().any(|host| {
        let ips: Vec<IpAddr> = if host == "localhost" {
            vec!["127.0.0.1".parse().unwrap(), "::1".parse().unwrap()]
        } else {
            host.parse().ok().into_iter().collect()
        };
        let host = if host.contains(':') { format!("[{host}]") } else { host.clone() };
        ips.into_iter().any(|ip| !ip.is_unspecified() && listens_on(bound, ip))
            && kybern_client::address::http_base(&format!("http://{host}:{}", bound.port())).is_ok_and(|expected| base == expected)
    })
}

fn serve_endpoints(config: &Value, bound: SocketAddr, dns_name: &str) -> Vec<String> {
    let mut endpoints = vec![];
    if let Some(web) = config["Web"].as_object() {
        for (host_port, server) in web {
            let Some((host, port)) = host_port.rsplit_once(':') else {
                continue;
            };
            if !host.eq_ignore_ascii_case(dns_name) || port.parse::<u16>().is_err() {
                continue;
            }
            if config["TCP"][port]["HTTPS"] != true {
                continue;
            }
            // Root proxies cover all Kybern HTTP routes and WebSocket upgrades.
            // Custom mounts require an explicit --advertise-url.
            if server["Handlers"]["/"]["Proxy"].as_str().is_some_and(|proxy| proxy_matches(proxy, bound)) {
                let port = if port == "443" { String::new() } else { format!(":{port}") };
                endpoints.push(format!("wss://{host}{port}/ws"));
            }
        }
    }
    if let Some(foreground) = config["Foreground"].as_object() {
        for child in foreground.values() {
            // Foreground configs cannot themselves contain another Foreground.
            let mut child = child.clone();
            if let Some(object) = child.as_object_mut() {
                object.remove("Foreground");
            }
            endpoints.extend(serve_endpoints(&child, bound, dns_name));
        }
    }
    endpoints
}

fn collect(bound: SocketAddr, mut interfaces: Vec<IpAddr>, status: &Value, serve: &Value) -> Vec<String> {
    let running = status["BackendState"] == "Running" && status["Self"]["Online"] == true;
    let mut out = vec![];
    if running {
        let dns = status["Self"]["DNSName"].as_str().unwrap_or("").trim_end_matches('.');
        if !dns.is_empty() {
            out.extend(serve_endpoints(serve, bound, dns));
        }
        // Userspace Tailscale addresses are not host interfaces. Only use the IP
        // route if interface enumeration confirms it is bound by this daemon.
    }
    if bound.ip().is_unspecified() {
        interfaces.push(if bound.is_ipv4() { "127.0.0.1".parse().unwrap() } else { "::1".parse().unwrap() });
    } else {
        interfaces.push(bound.ip());
    }
    let tailscale_ips: Vec<IpAddr> = if running {
        status["TailscaleIPs"].as_array().into_iter().flatten().filter_map(|value| value.as_str()?.parse().ok()).collect()
    } else {
        vec![]
    };
    interfaces.retain(|ip| usable(*ip) && listens_on(bound, *ip));
    interfaces.sort_by_key(|ip| (ip.is_loopback(), !tailscale_ips.contains(ip), ip.is_ipv6(), *ip));
    interfaces.dedup();
    out.extend(interfaces.into_iter().map(|ip| format!("ws://{}/ws", SocketAddr::new(ip, bound.port()))));
    out
}

/// Run on explicit pairing requests so network changes are picked up without
/// restarting the daemon, and ordinary desktop boot never waits on discovery.
/// Listeners on a real network come before loopback so an invitation leads
/// with an address another device can use.
pub async fn endpoints(bounds: &[SocketAddr]) -> Vec<String> {
    let (interfaces, status, serve) =
        tokio::join!(interfaces(), tailscale(&["status", "--json", "--peers=false"]), tailscale(&["serve", "status", "--json"]));
    let status = status.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null);
    let serve = serve.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null);
    let mut ordered: Vec<SocketAddr> = bounds.to_vec();
    ordered.sort_by_key(|bound| bound.ip().is_loopback());
    let mut out: Vec<String> = vec![];
    for bound in ordered {
        for endpoint in collect(bound, interfaces.clone(), &status, &serve) {
            if !out.contains(&endpoint) {
                out.push(endpoint);
            }
        }
    }
    out
}

/// The Tailscale IPv4 address this host can bind: Tailscale must be running
/// and the address must belong to a real interface (userspace networking
/// mode has none).
pub async fn tailscale_ip() -> Option<IpAddr> {
    let (interfaces, status) = tokio::join!(interfaces(), tailscale(&["status", "--json", "--peers=false"]));
    let status: Value = status.and_then(|text| serde_json::from_str(&text).ok())?;
    if status["BackendState"] != "Running" {
        return None;
    }
    status["TailscaleIPs"]
        .as_array()?
        .iter()
        .filter_map(|value| value.as_str()?.parse::<IpAddr>().ok())
        .find(|ip| ip.is_ipv4() && interfaces.contains(ip))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn status() -> Value {
        json!({"BackendState":"Running", "Self":{"Online":true,"DNSName":"vps.example.ts.net."}, "TailscaleIPs":["100.101.102.103"]})
    }
    fn serve(port: u16) -> Value {
        json!({"TCP":{"443":{"HTTPS":true}}, "Web":{"vps.example.ts.net:443":{"Handlers":{"/":{"Proxy":format!("http://127.0.0.1:{port}")}}}}})
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn missing_or_stalled_discovery_tools_do_not_block_pairing() {
        assert!(output("kybern-nonexistent-discovery-test-command", &[]).await.is_none());
        assert!(output("sh", &["-c", "exec sleep 10"]).await.is_none());
    }

    #[test]
    fn loopback_only_never_advertises_public_or_tailscale_interfaces() {
        let ips = vec!["203.0.113.4".parse().unwrap(), "100.101.102.103".parse().unwrap()];
        assert_eq!(collect("127.0.0.1:4173".parse().unwrap(), ips, &status(), &Value::Null), ["ws://127.0.0.1:4173/ws"]);
    }
    #[test]
    fn prefers_matching_https_serve_and_rejects_unrelated_proxies() {
        let bound = "127.0.0.1:4173".parse().unwrap();
        assert_eq!(collect(bound, vec![], &status(), &serve(4173)), ["wss://vps.example.ts.net/ws", "ws://127.0.0.1:4173/ws"]);
        assert_eq!(collect(bound, vec![], &status(), &serve(9999)), ["ws://127.0.0.1:4173/ws"]);
        let mut offline = status();
        offline["BackendState"] = json!("Stopped");
        assert_eq!(collect(bound, vec![], &offline, &serve(4173)), ["ws://127.0.0.1:4173/ws"]);
    }
    #[test]
    fn wildcard_includes_public_and_private_addresses_with_tailscale_first() {
        let ips =
            ["203.0.113.4", "100.101.102.103", "192.168.1.2", "169.254.1.1", "::1", "203.0.113.4"].map(|ip| ip.parse().unwrap()).to_vec();
        assert_eq!(
            collect("0.0.0.0:4199".parse().unwrap(), ips, &status(), &Value::Null),
            ["ws://100.101.102.103:4199/ws", "ws://192.168.1.2:4199/ws", "ws://203.0.113.4:4199/ws", "ws://127.0.0.1:4199/ws"]
        );
    }
    #[test]
    fn specific_binding_and_ipv6_are_preserved() {
        assert_eq!(collect("[2001:db8::1]:4173".parse().unwrap(), vec![], &Value::Null, &Value::Null), ["ws://[2001:db8::1]:4173/ws"]);
        let ips = ["192.168.1.2", "100.101.102.103"].map(|ip| ip.parse().unwrap()).to_vec();
        assert_eq!(collect("100.101.102.103:4173".parse().unwrap(), ips, &status(), &serve(4173)), ["ws://100.101.102.103:4173/ws"]);
    }
    #[test]
    fn parsers_ignore_down_tentative_and_malformed_addresses() {
        let linux = json!([
            {"flags":["UP"], "addr_info":[{"local":"203.0.113.4"},{"local":"2001:db8::1"},{"local":"192.168.1.3","tentative":true}]},
            {"flags":[],"addr_info":[{"local":"192.168.1.2"}]}
        ]);
        assert_eq!(linux_addresses(&linux), ["203.0.113.4".parse::<IpAddr>().unwrap(), "2001:db8::1".parse().unwrap()]);
        assert_eq!(
            ifconfig_addresses(
                "en0: flags=8863<UP,BROADCAST,RUNNING>\n\tinet 192.168.1.2 netmask 0xffffff00\n\tinet6 fe80::1%en0 prefixlen 64\nen1: flags=2<BROADCAST>\n\tinet 10.0.0.1 netmask 0xffffff00"
            ),
            ["192.168.1.2".parse::<IpAddr>().unwrap()]
        );
    }
    #[test]
    fn foreground_serve_is_supported_but_custom_mounts_and_paths_are_not_guessed() {
        let bound = "127.0.0.1:4173".parse().unwrap();
        assert_eq!(
            serve_endpoints(&json!({"Foreground":{"session":serve(4173)}}), bound, "vps.example.ts.net"),
            ["wss://vps.example.ts.net/ws"]
        );
        let mut config = serve(4173);
        config["Web"]["vps.example.ts.net:443"]["Handlers"]["/"]["Proxy"] = json!("http://127.0.0.1:4173/other");
        assert!(serve_endpoints(&config, bound, "vps.example.ts.net").is_empty());
    }
}
