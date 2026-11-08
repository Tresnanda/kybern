// The idle-compaction rules, as a pure function of the facts and an injected time.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, TimeZone, Utc};
use kybern_protocol::*;
use uuid::Uuid;

use super::{Facts, IDLE_COMPACTION_TOKENS, Plan, Skip, estimated_ttl_seconds, plan, still_due};

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 8, 14, 0, 0).unwrap()
}

fn turn() -> TurnId {
    Uuid::from_u128(7)
}

fn session() -> (ProviderInstance, String) {
    (ProviderInstance::default_for(ProviderKind::ClaudeCode), "session-1".into())
}

/// An idle Claude thread of 250 000 tokens whose 1-hour cache was written now.
fn facts() -> Facts {
    Facts {
        mode: IdleCompaction::BeforeCacheExpires,
        kind: ProviderKind::ClaudeCode,
        status: ThreadStatus::Idle,
        excluded: false,
        latest_turn: Some((turn(), false)),
        waiting_on_user: false,
        background_work: false,
        session: Some(session()),
        context_tokens: Some(250_000),
        cache_expires_at: Some(now() + Duration::hours(1)),
        cache_ttl_seconds: Some(3600),
    }
}

#[test]
fn a_long_idle_thread_is_compacted_two_minutes_before_its_cache_expires() {
    let planned = plan(&facts(), now()).unwrap();
    assert_eq!(
        planned,
        Plan {
            turn_id: turn(),
            session: session(),
            fire_at: now() + Duration::minutes(58),
            cache_expires_at: now() + Duration::hours(1),
            cache_ttl_seconds: Some(3600),
            context_tokens: 250_000,
        }
    );
    // A 5-minute cache: three minutes after the turn.
    let short = Facts { cache_expires_at: Some(now() + Duration::minutes(5)), ..facts() };
    assert_eq!(plan(&short, now()).unwrap().fire_at, now() + Duration::minutes(3));
    // Exactly at the threshold counts.
    assert!(plan(&Facts { context_tokens: Some(IDLE_COMPACTION_TOKENS), ..facts() }, now()).is_ok());
}

#[test]
fn inside_the_last_two_minutes_it_compacts_at_once_and_after_the_last_chance_not_at_all() {
    let expires = now() + Duration::hours(1);
    let late = expires - Duration::seconds(90);
    assert_eq!(plan(&facts(), late).unwrap().fire_at, late, "a restart inside the window compacts now");
    assert_eq!(plan(&facts(), expires - Duration::seconds(30)), Err(Skip::Missed));
    assert_eq!(plan(&facts(), expires + Duration::minutes(5)), Err(Skip::Missed), "expired: left to the harness");
}

#[test]
fn every_skip_rule_holds() {
    let cases: Vec<(&str, Facts, Skip)> = vec![
        ("when you return", Facts { mode: IdleCompaction::WhenYouReturn, ..facts() }, Skip::Off),
        ("never", Facts { mode: IdleCompaction::Never, ..facts() }, Skip::Off),
        ("grok build cannot compact", Facts { kind: ProviderKind::GrokBuild, ..facts() }, Skip::Unsupported),
        ("antigravity cannot compact", Facts { kind: ProviderKind::Antigravity, ..facts() }, Skip::Unsupported),
        ("cursor reports no cache", Facts { kind: ProviderKind::Cursor, ..facts() }, Skip::Unsupported),
        ("subagent or coordinator", Facts { excluded: true, ..facts() }, Skip::Excluded),
        ("archived", Facts { status: ThreadStatus::Archived, ..facts() }, Skip::Archived),
        ("a newer turn is running", Facts { status: ThreadStatus::Running, ..facts() }, Skip::Busy),
        ("an approval is pending", Facts { status: ThreadStatus::AwaitingApproval, ..facts() }, Skip::Busy),
        ("no turn yet", Facts { latest_turn: None, ..facts() }, Skip::NoTurn),
        ("the last turn compacted", Facts { latest_turn: Some((turn(), true)), ..facts() }, Skip::AlreadyCompacted),
        ("a question waits", Facts { waiting_on_user: true, ..facts() }, Skip::WaitingOnUser),
        ("tasks or agents will report", Facts { background_work: true, ..facts() }, Skip::BackgroundWork),
        ("below 200K", Facts { context_tokens: Some(IDLE_COMPACTION_TOKENS - 1), ..facts() }, Skip::Small),
        ("size unknown", Facts { context_tokens: None, ..facts() }, Skip::Small),
        ("no session", Facts { session: None, ..facts() }, Skip::NoSession),
        ("expiry unknown", Facts { cache_expires_at: None, ..facts() }, Skip::ExpiryUnknown),
        ("expiry past", Facts { cache_expires_at: Some(now() - Duration::seconds(1)), ..facts() }, Skip::Missed),
    ];
    for (case, facts, skip) in cases {
        assert_eq!(plan(&facts, now()), Err(skip), "{case}");
    }
    for kind in [ProviderKind::ClaudeCode, ProviderKind::Codex, ProviderKind::Opencode, ProviderKind::Pi, ProviderKind::Omp] {
        assert!(plan(&Facts { kind, ..facts() }, now()).is_ok(), "{kind} compacts on Kybern's schedule");
    }
}

#[test]
fn at_fire_time_a_newer_turn_or_another_session_cancels_the_plan() {
    let planned = plan(&facts(), now()).unwrap();
    let due = planned.fire_at;
    assert_eq!(still_due(&planned, &facts(), due), Ok(()));
    let newer = Facts { latest_turn: Some((Uuid::from_u128(8), false)), ..facts() };
    assert_eq!(still_due(&planned, &newer, due), Err(Skip::NewerTurn));
    let other = Facts { session: Some((session().0, "session-2".into())), ..facts() };
    assert_eq!(still_due(&planned, &other, due), Err(Skip::OtherSession));
    let account = Facts {
        session: Some((ProviderInstance { kind: ProviderKind::ClaudeCode, instance: "work".into() }, "session-1".into())),
        ..facts()
    };
    assert_eq!(still_due(&planned, &account, due), Err(Skip::OtherSession));
    // The rules that hold when planning hold again when it is due.
    assert_eq!(still_due(&planned, &Facts { status: ThreadStatus::Archived, ..facts() }, due), Err(Skip::Archived));
    assert_eq!(still_due(&planned, &Facts { mode: IdleCompaction::Never, ..facts() }, due), Err(Skip::Off));
    assert_eq!(still_due(&planned, &Facts { waiting_on_user: true, ..facts() }, due), Err(Skip::WaitingOnUser));
    // A timer that fired late, past the last chance, does nothing.
    assert_eq!(still_due(&planned, &facts(), planned.cache_expires_at), Err(Skip::Missed));
}

#[test]
fn harnesses_without_a_reported_ttl_get_their_documented_one() {
    let env = |pairs: &[(&str, &str)]| pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect::<BTreeMap<_, _>>();
    let none = env(&[]);
    assert_eq!(estimated_ttl_seconds(ProviderKind::ClaudeCode, None, &none), None, "Claude reports its own");
    assert_eq!(estimated_ttl_seconds(ProviderKind::Codex, None, &none), Some(30 * 60));
    assert_eq!(estimated_ttl_seconds(ProviderKind::Opencode, Some("anthropic/claude-sonnet-5-5"), &none), Some(300));
    assert_eq!(estimated_ttl_seconds(ProviderKind::Opencode, Some("openai/gpt-5.6"), &none), Some(300));
    assert_eq!(estimated_ttl_seconds(ProviderKind::Opencode, Some("google/gemini-3"), &none), None);
    assert_eq!(estimated_ttl_seconds(ProviderKind::Opencode, None, &none), None);
    // OMP's `auto`: 1 h on a subscription sign-in, 5 min with an API key.
    let model = Some("anthropic/claude-opus-5-5");
    let key = env(&[("ANTHROPIC_API_KEY", "sk-ant-test")]);
    if std::env::var_os("ANTHROPIC_API_KEY").is_none() && std::env::var_os("PI_CACHE_RETENTION").is_none() {
        assert_eq!(estimated_ttl_seconds(ProviderKind::Omp, model, &none), Some(3600));
        assert_eq!(estimated_ttl_seconds(ProviderKind::Pi, model, &none), Some(300), "Pi defaults to short");
    }
    assert_eq!(estimated_ttl_seconds(ProviderKind::Omp, model, &key), Some(300));
    assert_eq!(estimated_ttl_seconds(ProviderKind::Omp, model, &env(&[("PI_CACHE_RETENTION", "long")])), Some(3600));
    assert_eq!(estimated_ttl_seconds(ProviderKind::Pi, model, &env(&[("PI_CACHE_RETENTION", "long")])), Some(3600));
    assert_eq!(estimated_ttl_seconds(ProviderKind::Omp, model, &env(&[("PI_CACHE_RETENTION", "short")])), Some(300));
    assert_eq!(estimated_ttl_seconds(ProviderKind::Omp, model, &env(&[("PI_CACHE_RETENTION", "none")])), None);
    assert_eq!(estimated_ttl_seconds(ProviderKind::Omp, Some("openai-codex/gpt-5.6"), &none), Some(30 * 60));
    for kind in [ProviderKind::Cursor, ProviderKind::Antigravity, ProviderKind::GrokBuild] {
        assert_eq!(estimated_ttl_seconds(kind, model, &none), None, "{kind} shows no countdown");
    }
}
