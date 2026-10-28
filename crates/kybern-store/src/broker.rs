//! Login broker loans (design §9.4, store migration "broker_loans").
//!
//! A row records who borrowed which account from whom, never a token: the broker re-reads its
//! credential from the harness, and a borrower that restarts borrows again.

use anyhow::Result;
use chrono::{DateTime, Utc};
use kybern_protocol::{EventPayload, MessageId, ProviderKind, ThreadId, TurnId, UserMessage};
use rusqlite::{OptionalExtension, params};

use crate::{Store, parse_time};

/// Which end of a loan this machine is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoanRole {
    Lender,
    Borrower,
}

impl LoanRole {
    fn as_str(self) -> &'static str {
        match self {
            LoanRole::Lender => "lender",
            LoanRole::Borrower => "borrower",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoanRow {
    pub loan_id: String,
    pub role: LoanRole,
    /// The other machine: the borrower for a lender row, the broker for a borrower row.
    pub peer: String,
    pub provider: ProviderKind,
    /// The broker's account instance.
    pub account: String,
    /// The borrower's local account instance.
    pub local_instance: Option<String>,
    /// How many credentials this loan has been issued (the first borrow counts).
    pub generation: u32,
    pub expires_at: Option<DateTime<Utc>>,
    pub last_pushed_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
}

const SELECT: &str = "SELECT loan_id, role, peer, provider, account, local_instance, generation, expires_at, last_pushed_at, last_error,
    created_at FROM broker_loans";

fn provider_text(kind: ProviderKind) -> String {
    serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn row_to_loan(r: &rusqlite::Row<'_>) -> rusqlite::Result<LoanRow> {
    let role: String = r.get(1)?;
    let provider: String = r.get(3)?;
    let provider = serde_json::from_value(serde_json::Value::String(provider)).map_err(crate::other)?;
    Ok(LoanRow {
        loan_id: r.get(0)?,
        role: if role == "lender" { LoanRole::Lender } else { LoanRole::Borrower },
        peer: r.get(2)?,
        provider,
        account: r.get(4)?,
        local_instance: r.get(5)?,
        generation: r.get(6)?,
        expires_at: r.get::<_, Option<String>>(7)?.map(parse_time).transpose()?,
        last_pushed_at: r.get::<_, Option<String>>(8)?.map(parse_time).transpose()?,
        last_error: r.get(9)?,
        created_at: parse_time(r.get::<_, String>(10)?)?,
    })
}

impl Store {
    /// Open a loan, or reopen the one with this id (a renewal keeps its id).
    pub fn loan_open(&self, loan: &LoanRow) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO broker_loans(loan_id, role, peer, provider, account, local_instance, generation, expires_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(loan_id) DO UPDATE SET generation = excluded.generation, expires_at = excluded.expires_at,
                   released_at = NULL, last_error = NULL",
                params![
                    loan.loan_id,
                    loan.role.as_str(),
                    loan.peer,
                    provider_text(loan.provider),
                    loan.account,
                    loan.local_instance,
                    loan.generation,
                    loan.expires_at.map(|t| t.to_rfc3339()),
                    loan.created_at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    pub fn loan_get(&self, loan_id: &str) -> Result<Option<LoanRow>> {
        self.with(|c| {
            Ok(c.query_row(&format!("{SELECT} WHERE loan_id = ?1 AND released_at IS NULL"), params![loan_id], row_to_loan).optional()?)
        })
    }

    /// Open loans of one role, oldest first.
    pub fn loans_open(&self, role: LoanRole) -> Result<Vec<LoanRow>> {
        self.with(|c| {
            let mut statement = c.prepare(&format!("{SELECT} WHERE role = ?1 AND released_at IS NULL ORDER BY created_at"))?;
            let rows = statement.query_map(params![role.as_str()], row_to_loan)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// A rotated credential reached (or failed to reach) the borrower.
    pub fn loan_pushed(&self, loan_id: &str, at: DateTime<Utc>, expires_at: Option<DateTime<Utc>>, error: Option<&str>) -> Result<()> {
        self.with(|c| {
            match error {
                None => c.execute(
                    "UPDATE broker_loans SET generation = generation + 1, last_pushed_at = ?2, expires_at = ?3, last_error = NULL WHERE loan_id = ?1",
                    params![loan_id, at.to_rfc3339(), expires_at.map(|t| t.to_rfc3339())],
                )?,
                Some(error) => c.execute("UPDATE broker_loans SET last_error = ?2 WHERE loan_id = ?1", params![loan_id, error])?,
            };
            Ok(())
        })
    }

    pub fn loan_release(&self, loan_id: &str) -> Result<bool> {
        self.with(|c| {
            Ok(c.execute(
                "UPDATE broker_loans SET released_at = ?2 WHERE loan_id = ?1 AND released_at IS NULL",
                params![loan_id, Utc::now().to_rfc3339()],
            )? > 0)
        })
    }

    /// Release every open loan of a role; returns how many.
    pub fn loans_release_all(&self, role: LoanRole) -> Result<usize> {
        self.with(|c| {
            Ok(c.execute(
                "UPDATE broker_loans SET released_at = ?2 WHERE role = ?1 AND released_at IS NULL",
                params![role.as_str(), Utc::now().to_rfc3339()],
            )?)
        })
    }

    /// Every account this machine ever lent, released loans included: what a broker that is being replaced
    /// signs out of, after its borrowers have already let their loans go.
    pub fn accounts_ever_lent(&self) -> Result<Vec<(ProviderKind, String)>> {
        self.with(|c| {
            let mut statement =
                c.prepare("SELECT DISTINCT provider, account FROM broker_loans WHERE role = 'lender' ORDER BY provider, account")?;
            let rows = statement.query_map([], |r| {
                let provider: String = r.get(0)?;
                let provider = serde_json::from_value(serde_json::Value::String(provider)).map_err(crate::other)?;
                Ok((provider, r.get::<_, String>(1)?))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// The message a turn started with, so a turn that failed on a rotated login can be sent again.
    pub fn turn_started_message(&self, thread_id: ThreadId, turn_id: TurnId) -> Result<Option<(MessageId, UserMessage)>> {
        self.with(|c| {
            let payload: Option<String> = c
                .query_row(
                    "SELECT payload FROM events WHERE thread_id = ?1 AND turn_id = ?2 AND kind = 'turn_started' ORDER BY seq LIMIT 1",
                    params![thread_id.to_string(), turn_id.to_string()],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(match payload.map(|text| serde_json::from_str::<EventPayload>(&text)).transpose()? {
                Some(EventPayload::TurnStarted { message_id, message }) => Some((message_id, message)),
                _ => None,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loan(id: &str, role: LoanRole) -> LoanRow {
        LoanRow {
            loan_id: id.into(),
            role,
            peer: "m2".into(),
            provider: ProviderKind::ClaudeCode,
            account: "default".into(),
            local_instance: Some("work".into()),
            generation: 1,
            expires_at: None,
            last_pushed_at: None,
            last_error: None,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn loans_open_push_and_release() {
        let store = Store::open_in_memory().unwrap();
        store.loan_open(&loan("a", LoanRole::Lender)).unwrap();
        store.loan_open(&loan("b", LoanRole::Borrower)).unwrap();
        assert_eq!(store.loans_open(LoanRole::Lender).unwrap().len(), 1);
        store.loan_pushed("a", Utc::now(), None, None).unwrap();
        let pushed = store.loan_get("a").unwrap().unwrap();
        assert_eq!((pushed.generation, pushed.provider), (2, ProviderKind::ClaudeCode));
        assert!(pushed.last_pushed_at.is_some());
        store.loan_pushed("a", Utc::now(), None, Some("offline")).unwrap();
        assert_eq!(store.loan_get("a").unwrap().unwrap().last_error.as_deref(), Some("offline"));
        assert!(store.loan_release("a").unwrap());
        assert!(!store.loan_release("a").unwrap());
        assert_eq!(store.loan_get("a").unwrap(), None);
        // A renewal under the same id reopens it.
        store.loan_open(&loan("a", LoanRole::Lender)).unwrap();
        assert!(store.loan_get("a").unwrap().is_some());
        assert_eq!(store.loans_release_all(LoanRole::Borrower).unwrap(), 1);
        assert!(store.loans_open(LoanRole::Borrower).unwrap().is_empty());
        // The history of what was lent outlives the loans.
        store.loan_release("a").unwrap();
        assert_eq!(store.accounts_ever_lent().unwrap(), vec![(ProviderKind::ClaudeCode, "default".to_string())]);
    }
}
