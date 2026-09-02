//! Pairing codes and token management. A code is six digits, lives ten
//! minutes, and is exchanged once at `POST /pair` for a client-scoped token.

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{Result, anyhow};
use chrono::{DateTime, Duration, Utc};
use kybern_protocol::Scope;
use kybern_store::Store;
use rand::RngExt;
use uuid::Uuid;

struct Pending {
    label: String,
    expires_at: DateTime<Utc>,
}

#[derive(Default)]
pub struct Pairing {
    codes: Mutex<HashMap<String, Pending>>,
}

impl Pairing {
    pub fn create(&self, label: Option<String>) -> (String, DateTime<Utc>) {
        let mut codes = self.codes.lock().unwrap();
        codes.retain(|_, p| p.expires_at > Utc::now());
        let code = loop {
            let n: u32 = rand::rng().random_range(0..1_000_000);
            let code = format!("{n:06}");
            if !codes.contains_key(&code) {
                break code;
            }
        };
        let expires_at = Utc::now() + Duration::minutes(10);
        codes.insert(code.clone(), Pending { label: label.unwrap_or_else(|| "paired device".into()), expires_at });
        (code, expires_at)
    }

    /// Exchange a code for a new token. Returns the raw token and its scopes.
    pub fn redeem(&self, store: &Store, code: &str, device_name: Option<String>) -> Result<(String, Vec<Scope>)> {
        let pending = {
            let mut codes = self.codes.lock().unwrap();
            codes.retain(|_, p| p.expires_at > Utc::now());
            codes.remove(code.trim()).ok_or_else(|| anyhow!("pairing code is invalid or expired"))?
        };
        let token = crate::auth::generate();
        let label = device_name.unwrap_or(pending.label);
        store.token_insert(Uuid::now_v7(), &crate::auth::hash(&token), &label, &Scope::CLIENT)?;
        Ok((token, Scope::CLIENT.to_vec()))
    }
}

/// Addresses a phone on the same network could use, loopback first.
pub fn advertised_endpoints(port: u16) -> Vec<String> {
    let mut out = vec![format!("ws://127.0.0.1:{port}/ws")];
    if let Ok(output) = std::process::Command::new("ifconfig").output() {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("inet ") {
                let ip = rest.split_whitespace().next().unwrap_or("");
                if !ip.is_empty() && ip != "127.0.0.1" && !ip.starts_with("169.254.") {
                    out.push(format!("ws://{ip}:{port}/ws"));
                }
            }
        }
    }
    out
}
