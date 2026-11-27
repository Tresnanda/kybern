//! `accounts.offers`: the cards the app shows when it opens ("Offers, not settings" in the accounts spec).
//!
//! Computed from what every machine holds (the `holdings:<machine>` registers, `network::accounts_sync`), the
//! online ratio this daemon sampled for each machine, and `accounts_shared`, so any daemon answers for the
//! whole network without asking the others. Each offer has a stable id and a fingerprint of its situation;
//! `accounts_shared.offers[id]` holds a dismissal: `never` hides it for good, `later` until the fingerprint
//! changes. Dismissed offers are still listed (with `dismissed`), for the Accounts page.

use std::collections::{BTreeMap, BTreeSet};

use kybern_protocol::methods::{AccountClash, AccountOffer, AccountOfferKind, AccountStatus, AccountsOffersResult};
use kybern_protocol::{AccountsShared, MachineId, OfferDismissalState, ProviderKind, broker_supports};
use sha2::{Digest, Sha256};

use crate::network::accounts_sync::MachineHoldings;
use crate::state::AppState;

/// "Reliably online": the share of the week a machine must have been seen online.
pub const ALWAYS_ON_RATIO: f32 = 0.9;

/// One member of the network as the offers see it.
#[derive(Debug, Clone)]
pub struct Machine {
    pub id: MachineId,
    pub name: String,
    pub online_ratio: Option<f32>,
}

/// Everything the offers are computed from.
#[derive(Debug, Clone, Default)]
pub struct Inputs {
    pub machines: Vec<Machine>,
    pub holdings: BTreeMap<MachineId, MachineHoldings>,
    pub shared: AccountsShared,
    /// The machine that already lends its sign-ins, if any.
    pub lender: Option<MachineId>,
}

fn fingerprint(parts: &[String]) -> String {
    let bytes = Sha256::digest(parts.join("\n").as_bytes());
    bytes.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// The keys a machine can use now: signed in, by itself or through a lender.
fn usable_keys(holdings: &MachineHoldings) -> BTreeSet<String> {
    holdings.accounts.iter().filter(|holding| holding.usable()).filter_map(|holding| holding.key.clone()).collect()
}

/// The keys a machine signed in itself (not borrowed), so it could lend them.
fn own_keys(holdings: &MachineHoldings) -> BTreeSet<String> {
    holdings
        .accounts
        .iter()
        .filter(|holding| holding.usable() && holding.borrowed_from.is_none())
        .filter_map(|holding| holding.key.clone())
        .collect()
}

fn kind_of(key: &str) -> Option<ProviderKind> {
    crate::accounts_shared::parse_key(key).map(|(kind, _)| kind)
}

pub fn compute(inputs: &Inputs) -> Vec<AccountOffer> {
    let mut offers = Vec::new();
    let name_of = |id: &str| {
        inputs.machines.iter().find(|machine| machine.id == id).map_or_else(|| "another machine".to_string(), |m| m.name.clone())
    };
    let known: Vec<&Machine> = inputs.machines.iter().filter(|machine| inputs.holdings.contains_key(&machine.id)).collect();

    // Always on: a reliably online machine with lendable accounts that others lack.
    for machine in &known {
        if inputs.lender.as_deref() == Some(machine.id.as_str()) || machine.online_ratio.is_none_or(|ratio| ratio < ALWAYS_ON_RATIO) {
            continue;
        }
        let lendable: BTreeSet<String> =
            own_keys(&inputs.holdings[&machine.id]).into_iter().filter(|key| kind_of(key).is_some_and(broker_supports)).collect();
        let mut keys = BTreeSet::new();
        let mut borrowers = Vec::new();
        for other in known.iter().filter(|other| other.id != machine.id) {
            let theirs = usable_keys(&inputs.holdings[&other.id]);
            let lacking: Vec<&String> = lendable.iter().filter(|key| !theirs.contains(*key)).collect();
            if !lacking.is_empty() {
                keys.extend(lacking.into_iter().cloned());
                borrowers.push(other.id.clone());
            }
        }
        if keys.is_empty() {
            continue;
        }
        let keys: Vec<String> = keys.into_iter().collect();
        let print = fingerprint(&[keys.join(","), borrowers.join(",")]);
        offers.push(AccountOffer {
            id: format!("always_on:{}", machine.id),
            kind: AccountOfferKind::AlwaysOn,
            fingerprint: print,
            machine_id: machine.id.clone(),
            machine_name: machine.name.clone(),
            provider: None,
            keys,
            machines: borrowers,
            clash: None,
            dismissed: None,
        });
    }

    // New machine: accounts the others have that this one lacks.
    for machine in &known {
        let mine = usable_keys(&inputs.holdings[&machine.id]);
        let mut missing: BTreeMap<String, BTreeSet<MachineId>> = BTreeMap::new();
        for other in known.iter().filter(|other| other.id != machine.id) {
            for key in own_keys(&inputs.holdings[&other.id]) {
                if !mine.contains(&key) {
                    missing.entry(key).or_default().insert(other.id.clone());
                }
            }
        }
        if missing.is_empty() {
            continue;
        }
        let holders: BTreeSet<MachineId> = missing.values().flatten().cloned().collect();
        let keys: Vec<String> = missing.into_keys().collect();
        offers.push(AccountOffer {
            id: format!("new_machine:{}", machine.id),
            kind: AccountOfferKind::NewMachine,
            fingerprint: fingerprint(&[keys.join(",")]),
            machine_id: machine.id.clone(),
            machine_name: machine.name.clone(),
            provider: None,
            keys,
            machines: holders.into_iter().collect(),
            clash: None,
            dismissed: None,
        });
    }

    // Empty terminal login: sign it in.
    for machine in &known {
        for holding in &inputs.holdings[&machine.id].accounts {
            if !holding.terminal
                || !crate::accounts_shared::has_identity(holding.kind)
                || !matches!(holding.status, AccountStatus::SignedOut | AccountStatus::NeedsSignIn)
            {
                continue;
            }
            offers.push(AccountOffer {
                id: format!("terminal_login:{}:{}", machine.id, holding.kind.as_str()),
                kind: AccountOfferKind::TerminalLogin,
                fingerprint: fingerprint(&[holding.kind.as_str().to_string()]),
                machine_id: machine.id.clone(),
                machine_name: machine.name.clone(),
                provider: Some(holding.kind),
                keys: Vec::new(),
                machines: Vec::new(),
                clash: None,
                dismissed: None,
            });
        }
    }

    // A default the first run changed.
    for (machine_id, holdings) in &inputs.holdings {
        for (kind, was) in &holdings.premigration {
            let Some(now) = inputs.shared.defaults.get(kind) else { continue };
            if now == was {
                continue;
            }
            offers.push(AccountOffer {
                id: format!("clash:{}:{machine_id}", kind.as_str()),
                kind: AccountOfferKind::MigrationClash,
                fingerprint: fingerprint(&[was.clone(), now.clone()]),
                machine_id: machine_id.clone(),
                machine_name: name_of(machine_id),
                provider: Some(*kind),
                keys: vec![was.clone(), now.clone()],
                machines: Vec::new(),
                clash: Some(AccountClash { kind: *kind, machine_id: machine_id.clone(), was: was.clone(), now: now.clone() }),
                dismissed: None,
            });
        }
    }

    for offer in &mut offers {
        offer.dismissed = inputs.shared.offers.get(&offer.id).and_then(|dismissal| match dismissal.state {
            OfferDismissalState::Never => Some(OfferDismissalState::Never),
            OfferDismissalState::Later => (dismissal.fingerprint == offer.fingerprint).then_some(OfferDismissalState::Later),
        });
    }
    offers
}

fn inputs(state: &AppState) -> Inputs {
    let now = chrono::Utc::now();
    let membership = state.network.membership().filter(|membership| membership.self_is_member());
    let machines = match membership {
        Some(membership) => {
            let me = membership.machine_id();
            membership
                .projection()
                .members()
                .map(|(id, entry)| Machine {
                    id: id.clone(),
                    name: entry.descriptor.name.clone(),
                    online_ratio: crate::network::online::ratio(&state.store, id, &me, now),
                })
                .collect()
        }
        None => vec![Machine { id: state.environment_id.clone(), name: crate::rpc::hostname(), online_ratio: None }],
    };
    Inputs {
        machines,
        holdings: crate::network::accounts_sync::all_holdings(state),
        shared: state.settings.get().accounts_shared,
        lender: state.orchestrator.login_broker().and_then(|broker| broker.broker_id()),
    }
}

pub fn offers(state: &AppState) -> AccountsOffersResult {
    AccountsOffersResult { offers: compute(&inputs(state)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::accounts_sync::Holding;
    use kybern_protocol::OfferDismissal;

    fn holding(kind: ProviderKind, instance: &str, key: Option<&str>, status: AccountStatus) -> Holding {
        Holding { kind, instance: instance.into(), key: key.map(Into::into), terminal: instance == "default", status, borrowed_from: None }
    }

    fn network() -> Inputs {
        let claude = Some("claude-code:work@example.com");
        let mut holdings = BTreeMap::new();
        holdings.insert(
            "vps".to_string(),
            MachineHoldings {
                accounts: vec![
                    holding(ProviderKind::ClaudeCode, "w1", claude, AccountStatus::SignedIn),
                    holding(ProviderKind::Cursor, "c1", Some("cursor:work@example.com"), AccountStatus::SignedIn),
                ],
                premigration: BTreeMap::new(),
            },
        );
        holdings.insert(
            "mac".to_string(),
            MachineHoldings {
                accounts: vec![holding(ProviderKind::Codex, "default", None, AccountStatus::SignedOut)],
                premigration: [(ProviderKind::ClaudeCode, "claude-code:me@home.org".to_string())].into(),
            },
        );
        Inputs {
            machines: vec![
                Machine { id: "vps".into(), name: "VPS".into(), online_ratio: Some(0.99) },
                Machine { id: "mac".into(), name: "Mac".into(), online_ratio: Some(0.4) },
                // A machine on an older Kybern publishes no holdings and gets no offers.
                Machine { id: "old".into(), name: "Old".into(), online_ratio: Some(1.0) },
            ],
            holdings,
            shared: AccountsShared {
                defaults: [(ProviderKind::ClaudeCode, "claude-code:work@example.com".to_string())].into(),
                ..Default::default()
            },
            lender: None,
        }
    }

    fn find<'a>(offers: &'a [AccountOffer], id: &str) -> Option<&'a AccountOffer> {
        offers.iter().find(|offer| offer.id == id)
    }

    #[test]
    fn each_situation_has_its_offer() {
        let offers = compute(&network());
        let always = find(&offers, "always_on:vps").expect("the VPS lends Claude");
        assert_eq!(always.keys, vec!["claude-code:work@example.com"], "Cursor can't be lent");
        assert_eq!(always.machines, vec!["mac"]);
        assert!(find(&offers, "always_on:mac").is_none(), "not reliably online");
        let new = find(&offers, "new_machine:mac").unwrap();
        assert_eq!(new.keys, vec!["claude-code:work@example.com", "cursor:work@example.com"]);
        assert_eq!(new.machines, vec!["vps"]);
        assert!(find(&offers, "new_machine:vps").is_none());
        assert_eq!(find(&offers, "terminal_login:mac:codex").unwrap().provider, Some(ProviderKind::Codex));
        let clash = find(&offers, "clash:claude-code:mac").unwrap().clash.clone().unwrap();
        assert_eq!((clash.was.as_str(), clash.now.as_str()), ("claude-code:me@home.org", "claude-code:work@example.com"));
        assert!(offers.iter().all(|offer| offer.machine_id != "old"));
        assert!(offers.iter().all(|offer| offer.dismissed.is_none()));
        // A machine already lending gets no always-on offer.
        let mut lent = network();
        lent.lender = Some("vps".into());
        assert!(find(&compute(&lent), "always_on:vps").is_none());
    }

    #[test]
    fn later_holds_until_the_situation_changes_and_never_holds_for_good() {
        let mut inputs = network();
        let print = find(&compute(&inputs), "new_machine:mac").unwrap().fingerprint.clone();
        inputs.shared.offers.insert("new_machine:mac".into(), OfferDismissal { state: OfferDismissalState::Later, fingerprint: print });
        inputs
            .shared
            .offers
            .insert("terminal_login:mac:codex".into(), OfferDismissal { state: OfferDismissalState::Never, fingerprint: "x".into() });
        let offers = compute(&inputs);
        assert_eq!(find(&offers, "new_machine:mac").unwrap().dismissed, Some(OfferDismissalState::Later));
        assert_eq!(find(&offers, "terminal_login:mac:codex").unwrap().dismissed, Some(OfferDismissalState::Never));
        // Another account appears on the VPS: the situation is new, the "later" no longer hides it.
        inputs.holdings.get_mut("vps").unwrap().accounts.push(holding(
            ProviderKind::Codex,
            "x1",
            Some("codex:work@example.com"),
            AccountStatus::SignedIn,
        ));
        let offers = compute(&inputs);
        assert_eq!(find(&offers, "new_machine:mac").unwrap().dismissed, None);
        assert_eq!(find(&offers, "terminal_login:mac:codex").unwrap().dismissed, Some(OfferDismissalState::Never));
    }

    #[test]
    fn a_borrowed_account_counts_as_usable_but_not_as_lendable() {
        let mut inputs = network();
        let mac = inputs.holdings.get_mut("mac").unwrap();
        let mut borrowed = holding(ProviderKind::ClaudeCode, "b1", Some("claude-code:work@example.com"), AccountStatus::SignedIn);
        borrowed.borrowed_from = Some("vps".into());
        mac.accounts.push(borrowed);
        let offers = compute(&inputs);
        assert!(find(&offers, "always_on:vps").is_none(), "the Mac already borrows it");
        assert_eq!(find(&offers, "new_machine:mac").unwrap().keys, vec!["cursor:work@example.com"]);
    }
}
