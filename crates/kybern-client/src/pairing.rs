//! Human-readable pairing output shared by the headless daemon and CLI.

use anyhow::Result;
use kybern_protocol::methods::PairingCreateResult;
use serde::Serialize;
use std::net::IpAddr;
use url::Url;

#[derive(Debug, Serialize)]
pub struct PairingAddress {
    pub address: String,
    pub kind: &'static str,
    pub invitation: String,
}

#[derive(Debug, Serialize)]
pub struct PairingReport {
    pub code: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub environment_id: String,
    pub addresses: Vec<PairingAddress>,
}

fn kind(url: &Url) -> &'static str {
    let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
    if host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()) {
        return "Local only / SSH tunnel";
    }
    if url.scheme() == "https" {
        return "HTTPS";
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) if ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1]) => "Private overlay (Tailscale / CGNAT)",
        Ok(IpAddr::V4(ip)) if ip.is_private() => "Private network",
        Ok(IpAddr::V6(ip)) if ip.segments()[0] == 0xfd7a && ip.segments()[1] == 0x115c && ip.segments()[2] == 0xa1e0 => "Tailscale",
        Ok(IpAddr::V6(ip)) if ip.is_unique_local() => "Private network",
        Ok(_) => "Public interface — use HTTPS or an encrypted tunnel",
        Err(_) => "Configured address — use HTTPS or an encrypted tunnel",
    }
}

impl PairingReport {
    pub fn new(pairing: &PairingCreateResult, environment_id: &str) -> Result<Self> {
        let mut addresses = Vec::new();
        for endpoint in &pairing.endpoints {
            let address = crate::address::http_base(endpoint)?;
            if addresses.iter().any(|item: &PairingAddress| item.address == address) {
                continue;
            }
            let kind = kind(&Url::parse(&address)?);
            let mut invitation = Url::parse("kybern://pair")?;
            invitation
                .query_pairs_mut()
                .append_pair("url", &crate::address::normalize(endpoint)?)
                .append_pair("code", &pairing.code)
                .append_pair("environment", environment_id);
            addresses.push(PairingAddress { address, kind, invitation: invitation.into() });
        }
        Ok(Self { code: pairing.code.clone(), expires_at: pairing.expires_at, environment_id: environment_id.into(), addresses })
    }

    pub fn render(&self) -> String {
        use std::fmt::Write;
        let mut out = String::new();
        writeln!(out, "\nPair a device\n").unwrap();
        writeln!(out, "Pairing code: {}", self.code).unwrap();
        writeln!(out, "Use once before {} (10 minutes).\n", self.expires_at.format("%Y-%m-%d %H:%M:%S UTC")).unwrap();
        writeln!(out, "On your desktop, choose Switch environment → Add environment.").unwrap();
        writeln!(out, "Paste an address and the code, or paste its complete invitation.\n").unwrap();
        for item in &self.addresses {
            writeln!(out, "{}\n  Address: {}\n  Invitation: {}\n", item.kind, item.address, item.invitation).unwrap();
        }
        if self.addresses.iter().all(|item| item.kind == "Local only / SSH tunnel") {
            writeln!(out, "No remote address detected. Loopback addresses reach this server only through an SSH tunnel.").unwrap();
            writeln!(out, "Configure Tailscale Serve or an HTTPS proxy, then create a new invitation.").unwrap();
            writeln!(out, "For a custom proxy address, use --advertise-url when starting kybernd.\n").unwrap();
        }
        writeln!(out, "Detected addresses still depend on your firewall and the receiving device's network.").unwrap();
        writeln!(out, "Pairing does not open ports or configure a proxy. Keep the daemon running.").unwrap();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invitations_preserve_identity_code_ipv6_and_proxy_paths() {
        let pairing = PairingCreateResult {
            code: "000123".into(),
            expires_at: chrono::Utc::now(),
            endpoints: vec!["wss://vps.example/kybern/ws".into(), "ws://[2001:db8::1]:4173/ws".into()],
        };
        let report = PairingReport::new(&pairing, "environment-one").unwrap();
        assert_eq!(report.addresses[0].address, "https://vps.example/kybern");
        assert_eq!(report.addresses[1].address, "http://[2001:db8::1]:4173");
        let url = Url::parse(&report.addresses[0].invitation).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(query["code"], "000123");
        assert_eq!(query["environment"], "environment-one");
        assert_eq!(query["url"], pairing.endpoints[0]);
        assert!(!report.render().contains("No remote address detected"));
    }
    #[test]
    fn local_only_output_explains_next_step_and_never_claims_remote_access() {
        let pairing =
            PairingCreateResult { code: "123456".into(), expires_at: chrono::Utc::now(), endpoints: vec!["ws://127.0.0.1:4173/ws".into()] };
        let output = PairingReport::new(&pairing, "host").unwrap().render();
        assert!(output.contains("No remote address detected"));
        assert!(output.contains("SSH tunnel"));
        assert!(output.contains("UTC"));
    }
}
