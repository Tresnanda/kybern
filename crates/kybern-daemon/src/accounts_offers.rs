//! `accounts.offers`: the cards the app shows when it opens ("Offers, not settings" in the accounts spec).
//!
//! Computed from what every machine holds (the `holdings:<machine>` registers, `network::accounts_sync`), the
//! online ratio this daemon sampled for each machine, and `accounts_shared`, so any daemon answers for the
//! whole network without asking the others. Each offer has a stable id and a fingerprint of its situation;
//! `accounts_shared.offers[id]` holds a dismissal: `never` hides it for good, `later` until the fingerprint
//! changes. Dismissed offers are still listed (with `dismissed`), for the Accounts page.
//!
//! Only what makes sense is offered: a machine is set up only with accounts somebody uses, for harnesses it
//! has installed, never one it may already have; its terminal login only for a harness it has and the user
//! uses. A changed default (the migration clash) is asked about once per machine and harness: any answer
//! settles it, and so does that machine having agreed with the shared default (a later change of the default
//! is the user's own).

use std::collections::{BTreeMap, BTreeSet};

use kybern_protocol::methods::{AccountClash, AccountOffer, AccountOfferKind, AccountStatus, AccountsOffersResult};
use kybern_protocol::{AccountsShared, MachineId, OfferDismissalState, ProviderKind, broker_supports};
use sha2::{Digest, Sha256};

use crate::network::accounts_sync::MachineHoldings;
use crate::state::AppState;

/// "Reliably online": the share of the week a machine must have been seen online.
pub const ALWAYS_ON_RATIO: f32 = 0.9;
/// The migration clashes that are over for good, by offer id.
const SETTLED: &str = "accounts.clash.settled";
/// How long after this machine's own migration an agreeing default counts without any clash to compare
/// with: by then the first syncs have brought the other machines' choices.
const SETTLE_AFTER_HOURS: i64 = 1;

/// One member of the network as the offers see it.
#[derive(Debug, Clone)]
pub struct Machine {
    pub id: MachineId,
    pub name: String,
    pub online_ratio: Option<f32>,
    /// Reachable now (this machine always is).
    pub online: bool,
}

/// Everything the offers are computed from.
#[derive(Debug, Clone, Default)]
pub struct Inputs {
    pub machines: Vec<Machine>,
    pub holdings: BTreeMap<MachineId, MachineHoldings>,
    pub shared: AccountsShared,
    /// The machine that already lends each agent's sign-in (its own lender, else the default), if any.
    pub lenders: BTreeMap<ProviderKind, MachineId>,
    /// Migration clashes that are over, by offer id ([`settling`]).
    pub settled: BTreeSet<String>,
}

fn fingerprint(parts: &[String]) -> String {
    let bytes = Sha256::digest(parts.join("\n").as_bytes());
    bytes.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
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

/// The accounts in use: signed in by a machine itself, as an account added to Kybern or as a terminal login
/// that machine runs threads with.
fn used_keys(holdings: &BTreeMap<MachineId, MachineHoldings>) -> BTreeSet<String> {
    holdings
        .values()
        .flat_map(|machine| {
            machine
                .accounts
                .iter()
                .filter(|holding| holding.usable() && holding.borrowed_from.is_none())
                .filter(|holding| !holding.terminal || machine.threads.as_ref().is_none_or(|kinds| kinds.contains(&holding.kind)))
                .filter_map(|holding| holding.key.clone())
        })
        .collect()
}

/// The harnesses the user uses: an account added to Kybern, a signed-in terminal login or a thread, on any
/// machine.
fn used_kinds(holdings: &BTreeMap<MachineId, MachineHoldings>) -> Vec<ProviderKind> {
    ProviderKind::ALL
        .into_iter()
        .filter(|kind| {
            holdings.values().any(|machine| {
                machine.threads.as_ref().is_some_and(|kinds| kinds.contains(kind))
                    || machine.accounts.iter().any(|holding| holding.kind == *kind && (!holding.terminal || holding.usable()))
            })
        })
        .collect()
}

/// Whether the machine could use `key` and may not have it: the harness is installed, no login of it there
/// is signed in to that account, its terminal login isn't that account, and no signed-in login of the
/// harness there hides whose it is (it may be this one).
fn lacks(machine: &MachineHoldings, key: &str) -> bool {
    let Some(kind) = kind_of(key) else { return false };
    machine.has_installed(kind)
        && !machine.accounts.iter().any(|holding| {
            holding.kind == kind
                && match holding.key.as_deref() {
                    Some(theirs) => theirs == key && (holding.terminal || holding.usable()),
                    None => holding.usable(),
                }
        })
}

fn clash_id(kind: ProviderKind, machine_id: &str) -> String {
    format!("clash:{}:{machine_id}", kind.as_str())
}

/// The machines whose default the migration did not replace, to be remembered: when one agrees with the
/// shared default, a later change of that default is no clash for it. Counted once there is a clash of the
/// harness to compare with (so the other machines' choices have arrived), or `long_migrated`.
pub fn settling(inputs: &Inputs, long_migrated: bool) -> BTreeSet<String> {
    let premigration = || {
        inputs
            .holdings
            .iter()
            .filter(|(id, _)| inputs.machines.iter().any(|machine| machine.id == **id))
            .flat_map(|(id, holdings)| holdings.premigration.iter().map(move |(kind, was)| (id, *kind, was)))
    };
    let clashing: Vec<ProviderKind> = premigration()
        .filter(|(_, kind, was)| inputs.shared.defaults.get(kind).is_some_and(|now| now != *was))
        .map(|(_, kind, _)| kind)
        .collect();
    premigration()
        .filter(|(_, kind, was)| inputs.shared.defaults.get(kind) == Some(*was) && (long_migrated || clashing.contains(kind)))
        .map(|(id, kind, _)| clash_id(kind, id))
        .collect()
}

pub fn compute(inputs: &Inputs) -> Vec<AccountOffer> {
    let mut offers = Vec::new();
    let name_of = |id: &str| {
        inputs.machines.iter().find(|machine| machine.id == id).map_or_else(|| "another machine".to_string(), |m| m.name.clone())
    };
    let known: Vec<&Machine> = inputs.machines.iter().filter(|machine| inputs.holdings.contains_key(&machine.id)).collect();

    // Always on: a reliably online machine with lendable accounts that others lack, of agents it doesn't lend already.
    for machine in &known {
        if machine.online_ratio.is_none_or(|ratio| ratio < ALWAYS_ON_RATIO) {
            continue;
        }
        let lends = |kind: ProviderKind| inputs.lenders.get(&kind).is_some_and(|lender| *lender == machine.id);
        let lendable: BTreeSet<String> = own_keys(&inputs.holdings[&machine.id])
            .into_iter()
            .filter(|key| kind_of(key).is_some_and(|kind| broker_supports(kind) && !lends(kind)))
            .collect();
        let mut keys = BTreeSet::new();
        let mut borrowers = Vec::new();
        for other in known.iter().filter(|other| other.id != machine.id) {
            let lacking: Vec<&String> = lendable.iter().filter(|key| lacks(&inputs.holdings[&other.id], key)).collect();
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

    // New machine: accounts the others use that this one lacks.
    let used = used_keys(&inputs.holdings);
    for machine in known.iter().filter(|machine| machine.online) {
        let mine = &inputs.holdings[&machine.id];
        let mut missing: BTreeMap<String, BTreeSet<MachineId>> = BTreeMap::new();
        for other in known.iter().filter(|other| other.id != machine.id) {
            for key in own_keys(&inputs.holdings[&other.id]) {
                if used.contains(&key) && lacks(mine, &key) {
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

    // Empty terminal login of a harness the machine has and the user uses: sign it in.
    let harnesses = used_kinds(&inputs.holdings);
    for machine in known.iter().filter(|machine| machine.online) {
        let holdings = &inputs.holdings[&machine.id];
        for holding in &holdings.accounts {
            if !holding.terminal
                || !crate::accounts_shared::has_identity(holding.kind)
                || !matches!(holding.status, AccountStatus::SignedOut | AccountStatus::NeedsSignIn)
                || !holdings.has_installed(holding.kind)
                || !harnesses.contains(&holding.kind)
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

    // A default the first run changed, on a machine still in the network, until the user answers.
    for machine in &known {
        for (kind, was) in &inputs.holdings[&machine.id].premigration {
            let id = clash_id(*kind, &machine.id);
            if inputs.shared.offers.contains_key(&id) || inputs.settled.contains(&id) {
                continue;
            }
            let Some(now) = inputs.shared.defaults.get(kind) else { continue };
            if now == was {
                continue;
            }
            offers.push(AccountOffer {
                // The same whatever the default is changed to meanwhile.
                fingerprint: fingerprint(&[id.clone(), was.clone()]),
                id,
                kind: AccountOfferKind::MigrationClash,
                machine_id: machine.id.clone(),
                machine_name: name_of(&machine.id),
                provider: Some(*kind),
                keys: vec![was.clone(), now.clone()],
                machines: Vec::new(),
                clash: Some(AccountClash { kind: *kind, machine_id: machine.id.clone(), was: was.clone(), now: now.clone() }),
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
                    online: *id == me || state.network.peers.status(id).online,
                })
                .collect()
        }
        None => vec![Machine { id: state.environment_id.clone(), name: crate::rpc::hostname(), online_ratio: None, online: true }],
    };
    Inputs {
        machines,
        holdings: crate::network::accounts_sync::all_holdings(state),
        shared: state.settings.get().accounts_shared,
        lenders: state
            .orchestrator
            .login_broker()
            .map(|broker| kybern_protocol::LENDABLE_KINDS.into_iter().filter_map(|kind| Some((kind, broker.lender_for(kind)?))).collect())
            .unwrap_or_default(),
        settled: state.store.meta_get(SETTLED).ok().flatten().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default(),
    }
}

pub fn offers(state: &AppState) -> AccountsOffersResult {
    let mut inputs = inputs(state);
    let long_migrated = state
        .store
        .meta_get(crate::accounts_shared::MIGRATED)
        .ok()
        .flatten()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(&at).ok())
        .is_some_and(|at| chrono::Utc::now().signed_duration_since(at) >= chrono::Duration::hours(SETTLE_AFTER_HOURS));
    let found = settling(&inputs, long_migrated);
    if !found.is_subset(&inputs.settled) {
        inputs.settled.extend(found);
        if let Ok(text) = serde_json::to_string(&inputs.settled) {
            let _ = state.store.meta_set(SETTLED, &text);
        }
    }
    // A legacy lender that isn't always on is reported as not usable for new setups, with the reason.
    let broker = state.orchestrator.login_broker();
    let lender = broker.and_then(|broker| broker.lender_status());
    let lenders_by_kind = broker.map(|broker| broker.lenders_by_kind()).unwrap_or_default();
    AccountsOffersResult { offers: compute(&inputs), lender, lenders_by_kind }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::accounts_sync::Holding;
    use kybern_protocol::OfferDismissal;

    fn holding(kind: ProviderKind, instance: &str, key: Option<&str>, status: AccountStatus) -> Holding {
        Holding { kind, instance: instance.into(), key: key.map(Into::into), terminal: instance == "default", status, borrowed_from: None }
    }

    /// Every harness installed, no threads.
    fn machine_with(accounts: Vec<Holding>) -> MachineHoldings {
        MachineHoldings { accounts, installed: Some(ProviderKind::ALL.to_vec()), threads: Some(Vec::new()), ..Default::default() }
    }

    fn member(id: &str, name: &str, online_ratio: f32) -> Machine {
        Machine { id: id.into(), name: name.into(), online_ratio: Some(online_ratio), online: true }
    }

    fn network() -> Inputs {
        let claude = Some("claude-code:work@example.com");
        let mut holdings = BTreeMap::new();
        holdings.insert(
            "vps".to_string(),
            machine_with(vec![
                holding(ProviderKind::ClaudeCode, "w1", claude, AccountStatus::SignedIn),
                holding(ProviderKind::Cursor, "c1", Some("cursor:work@example.com"), AccountStatus::SignedIn),
                holding(ProviderKind::Codex, "x0", Some("codex:old@example.com"), AccountStatus::SignedOut),
            ]),
        );
        holdings.insert(
            "mac".to_string(),
            MachineHoldings {
                premigration: [(ProviderKind::ClaudeCode, "claude-code:me@home.org".to_string())].into(),
                ..machine_with(vec![holding(ProviderKind::Codex, "default", None, AccountStatus::SignedOut)])
            },
        );
        Inputs {
            machines: vec![
                member("vps", "VPS", 0.99),
                member("mac", "Mac", 0.4),
                // A machine on an older Kybern publishes no holdings and gets no offers.
                member("old", "Old", 1.0),
            ],
            holdings,
            shared: AccountsShared {
                defaults: [(ProviderKind::ClaudeCode, "claude-code:work@example.com".to_string())].into(),
                ..Default::default()
            },
            lenders: BTreeMap::new(),
            settled: BTreeSet::new(),
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
        lent.lenders = kybern_protocol::LENDABLE_KINDS.into_iter().map(|kind| (kind, "vps".to_string())).collect();
        assert!(find(&compute(&lent), "always_on:vps").is_none());
        // Lending only Codex (its own lender), the VPS is still offered for Claude.
        let mut codex_only = network();
        codex_only.lenders = [(ProviderKind::Codex, "vps".to_string())].into();
        assert_eq!(find(&compute(&codex_only), "always_on:vps").unwrap().keys, vec!["claude-code:work@example.com"]);
        // Lending Claude for its agent, nothing else of the VPS is lendable: no offer.
        let mut claude = network();
        claude.lenders = [(ProviderKind::ClaudeCode, "vps".to_string())].into();
        assert!(find(&compute(&claude), "always_on:vps").is_none());
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

    fn keys_of(offers: &[AccountOffer], id: &str) -> Vec<String> {
        find(offers, id).map(|offer| offer.keys.clone()).unwrap_or_default()
    }

    fn mac(inputs: &mut Inputs) -> &mut MachineHoldings {
        inputs.holdings.get_mut("mac").unwrap()
    }

    #[test]
    fn a_machine_is_offered_only_harnesses_it_has_installed() {
        let mut inputs = network();
        mac(&mut inputs).installed = Some(vec![ProviderKind::ClaudeCode]);
        let offers = compute(&inputs);
        assert_eq!(keys_of(&offers, "new_machine:mac"), vec!["claude-code:work@example.com"], "no Cursor there");
        assert!(find(&offers, "terminal_login:mac:codex").is_none(), "no Codex there");
        mac(&mut inputs).installed = Some(Vec::new());
        let offers = compute(&inputs);
        assert!(find(&offers, "new_machine:mac").is_none());
        assert!(find(&offers, "always_on:vps").is_none(), "nothing there could borrow");
        // A daemon that doesn't say what is installed: only what its terminal logins show.
        mac(&mut inputs).installed = None;
        mac(&mut inputs).accounts.push(holding(ProviderKind::ClaudeCode, "default", None, AccountStatus::SignedOut));
        assert_eq!(keys_of(&compute(&inputs), "new_machine:mac"), vec!["claude-code:work@example.com"]);
    }

    #[test]
    fn only_accounts_somebody_uses_are_offered() {
        let mut inputs = network();
        // A terminal login nobody runs threads with.
        let shell = holding(ProviderKind::Codex, "default", Some("codex:shell@example.com"), AccountStatus::SignedIn);
        inputs.holdings.get_mut("vps").unwrap().accounts.push(shell);
        assert!(!keys_of(&compute(&inputs), "new_machine:mac").contains(&"codex:shell@example.com".to_string()));
        inputs.holdings.get_mut("vps").unwrap().threads = Some(vec![ProviderKind::Codex]);
        assert!(keys_of(&compute(&inputs), "new_machine:mac").contains(&"codex:shell@example.com".to_string()));
    }

    #[test]
    fn an_account_the_machine_may_already_have_is_not_offered() {
        // Its terminal login is that account, signed in or out.
        for status in [AccountStatus::SignedIn, AccountStatus::SignedOut] {
            let mut inputs = network();
            let shell = holding(ProviderKind::ClaudeCode, "default", Some("claude-code:work@example.com"), status);
            mac(&mut inputs).accounts.push(shell);
            let offers = compute(&inputs);
            assert_eq!(keys_of(&offers, "new_machine:mac"), vec!["cursor:work@example.com"], "{status:?}");
            assert!(find(&offers, "always_on:vps").is_none(), "{status:?}");
        }
        // A signed-in terminal login whose email isn't known may be it.
        let mut inputs = network();
        mac(&mut inputs).accounts.push(holding(ProviderKind::ClaudeCode, "default", None, AccountStatus::SignedIn));
        assert_eq!(keys_of(&compute(&inputs), "new_machine:mac"), vec!["cursor:work@example.com"]);
    }

    #[test]
    fn terminal_logins_are_offered_only_for_harnesses_the_user_uses() {
        let mut inputs = network();
        // Codex: an account on the VPS (signed out) is a Codex account.
        assert!(find(&compute(&inputs), "terminal_login:mac:codex").is_some());
        inputs.holdings.get_mut("vps").unwrap().accounts.retain(|held| held.kind != ProviderKind::Codex);
        assert!(find(&compute(&inputs), "terminal_login:mac:codex").is_none(), "no Codex account or thread anywhere");
        // A thread somewhere is use too.
        inputs.holdings.get_mut("vps").unwrap().threads = Some(vec![ProviderKind::Codex]);
        assert!(find(&compute(&inputs), "terminal_login:mac:codex").is_some());
    }

    #[test]
    fn an_offline_machine_is_not_asked_to_sign_in() {
        let mut inputs = network();
        inputs.machines[1].online = false;
        let offers = compute(&inputs);
        assert!(find(&offers, "new_machine:mac").is_none());
        assert!(find(&offers, "terminal_login:mac:codex").is_none());
        assert!(find(&offers, "clash:claude-code:mac").is_some(), "the changed default is still news");
    }

    #[test]
    fn any_answer_settles_a_clash_and_its_fingerprint_stays() {
        let mut inputs = network();
        let print = find(&compute(&inputs), "clash:claude-code:mac").unwrap().fingerprint.clone();
        // Another default meanwhile: the same card, not a new one.
        inputs.shared.defaults.insert(ProviderKind::ClaudeCode, "claude-code:third@example.com".into());
        assert_eq!(find(&compute(&inputs), "clash:claude-code:mac").unwrap().fingerprint, print);
        // "Not now", "Never", Keep or Change: answered once is answered.
        for state in [OfferDismissalState::Later, OfferDismissalState::Never] {
            inputs
                .shared
                .offers
                .insert("clash:claude-code:mac".into(), OfferDismissal { state, fingerprint: "from-an-older-daemon".into() });
            assert!(find(&compute(&inputs), "clash:claude-code:mac").is_none(), "{state:?}");
        }
    }

    #[test]
    fn a_removed_machine_has_no_clash() {
        let mut inputs = network();
        inputs.machines.retain(|machine| machine.id != "mac");
        assert!(compute(&inputs).iter().all(|offer| offer.clash.is_none()));
    }

    #[test]
    fn changing_the_default_does_not_move_the_clash_to_a_machine_that_agreed() {
        let mut inputs = network();
        // The VPS's own default was the shared one: the migration replaced nothing there.
        inputs.holdings.get_mut("vps").unwrap().premigration =
            [(ProviderKind::ClaudeCode, "claude-code:work@example.com".to_string())].into();
        inputs.settled.extend(settling(&inputs, false));
        assert_eq!(inputs.settled, BTreeSet::from(["clash:claude-code:vps".to_string()]));
        // "Change" on the Mac's card: its old default everywhere.
        inputs.shared.defaults.insert(ProviderKind::ClaudeCode, "claude-code:me@home.org".into());
        inputs
            .shared
            .offers
            .insert("clash:claude-code:mac".into(), OfferDismissal { state: OfferDismissalState::Never, fingerprint: "answered".into() });
        assert!(compute(&inputs).iter().all(|offer| offer.clash.is_none()));
    }

    #[test]
    fn agreement_counts_only_once_the_other_choices_arrived() {
        let mut inputs = network();
        mac(&mut inputs).premigration = [(ProviderKind::ClaudeCode, "claude-code:work@example.com".to_string())].into();
        // Right after the migration, with nothing to compare: another machine's choice may still be on its way.
        assert!(settling(&inputs, false).is_empty());
        assert_eq!(settling(&inputs, true), BTreeSet::from(["clash:claude-code:mac".to_string()]));
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
