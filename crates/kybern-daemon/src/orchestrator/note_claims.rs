//! Claims in memory notes: one dated line, optionally citing a commit and files.
//!
//! ```text
//! - 2026-10-25 · As of `abc1234`: login no longer falls back to the pre-launch page (`src/auth/session.ts`). Thread 01a…
//! ```
//!
//! A line is a claim about code when it holds ``As of `<7-40 hex>` `` and at least
//! one backticked path. A superseded claim is wrapped in `~~…~~` and ignored from then on.
//! This module is text only; `note_staleness` checks claims against git.

use anyhow::{Result, bail};

/// One claim that cites a commit, read from a note body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Claim {
    /// The commit the claim is "as of", as written.
    pub sha: String,
    /// Backticked paths on the line, as written.
    pub paths: Vec<String>,
}

/// Split a line into its list marker (with leading space) and the text after it.
fn split_marker(line: &str) -> (&str, &str) {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    let marker = if let Some(rest) = trimmed.strip_prefix(['-', '*', '+']) {
        rest.starts_with(' ').then_some(1)
    } else {
        let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
        (digits > 0 && trimmed[digits..].starts_with(['.', ')']) && trimmed[digits + 1..].starts_with(' ')).then_some(digits + 1)
    };
    match marker {
        Some(len) => {
            let rest = &trimmed[len..];
            let text = rest.trim_start();
            (&line[..indent + len + (rest.len() - text.len())], text)
        }
        None => (&line[..indent], trimmed),
    }
}

/// Whether the line was retired with `supersedes`.
pub(super) fn is_superseded(line: &str) -> bool {
    split_marker(line).1.starts_with("~~")
}

fn is_sha(token: &str) -> bool {
    (7..=40).contains(&token.len()) && token.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_path(token: &str) -> bool {
    if token.is_empty() || token.len() > 300 || token.starts_with(['-', '/']) {
        return false;
    }
    if !token.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '@' | '+' | '~')) {
        return false;
    }
    // `src/a.ts` and `Makefile.in` are paths; a bare word or a version is not.
    token.contains('/') || token.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && ext.chars().any(|c| c.is_alphabetic()))
}

/// The backtick-quoted spans of a line.
fn code_spans(line: &str) -> Vec<&str> {
    line.split('`').skip(1).step_by(2).collect()
}

/// The claims of a note body that cite a commit and a file, superseded lines and
/// fenced blocks left out.
pub(super) fn parse_claims(body: &str) -> Vec<Claim> {
    let mut claims = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || is_superseded(line) {
            continue;
        }
        let Some(at) = line.find("As of `") else { continue };
        let after = &line[at + "As of `".len()..];
        let Some(end) = after.find('`') else { continue };
        let sha = &after[..end];
        if !is_sha(sha) {
            continue;
        }
        let mut paths: Vec<String> = Vec::new();
        for span in code_spans(line).into_iter().filter(|span| *span != sha && is_path(span)) {
            if !paths.iter().any(|path| path == span) {
                paths.push(span.to_owned());
            }
        }
        if !paths.is_empty() {
            claims.push(Claim { sha: sha.to_owned(), paths });
        }
    }
    claims
}

/// `body` with the one line that holds `needle` struck through and marked
/// `(superseded {date})`. Errors say what to do when no line or several lines match.
pub(super) fn supersede(body: &str, needle: &str, date: &str) -> Result<String> {
    let needle = needle.trim();
    if needle.is_empty() {
        bail!("supersedes is empty. Pass an exact piece of the one line you retire, copied from kybern_note_read.");
    }
    if needle.contains('\n') {
        bail!("supersedes spans several lines. Pass a piece of one line only.");
    }
    let lines: Vec<&str> = body.lines().collect();
    let live: Vec<usize> = (0..lines.len()).filter(|&i| lines[i].contains(needle) && !is_superseded(lines[i])).collect();
    match live.as_slice() {
        [index] => {
            let (marker, text) = split_marker(lines[*index]);
            let replaced = format!("{marker}~~{}~~ (superseded {date})", text.trim_end());
            let mut out: Vec<String> = lines.iter().map(|line| (*line).to_owned()).collect();
            out[*index] = replaced;
            let mut joined = out.join("\n");
            if body.ends_with('\n') {
                joined.push('\n');
            }
            Ok(joined)
        }
        [] if lines.iter().any(|line| line.contains(needle)) => {
            bail!("That line is already superseded. Append the new claim without supersedes, or retire a different line.")
        }
        [] => bail!(
            "No line of the note contains that text, so nothing was changed. Read the note with kybern_note_read and pass an exact piece of the line (case matters), or append without supersedes."
        ),
        many => bail!(
            "{} lines of the note contain that text, so nothing was changed. Pass a longer piece that appears in only one line.",
            many.len()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_need_a_sha_and_a_path_and_skip_retired_lines() {
        let body = "# Auth\n\n\
            - 2026-10-25 · As of `abc1234`: login no longer falls back (`src/auth/session.ts`, `src/auth/`). Thread 01a\n\
            - 2026-10-25 · As of `abc1234`: no path here\n\
            - 2026-10-25 · As of `zzz1234`: not a sha (`src/a.ts`)\n\
            - ~~2026-10-01 · As of `def5678`: old (`src/old.ts`)~~ (superseded 2026-10-02)\n\
            ```\nAs of `abc1234` `src/in_fence.ts`\n```\n\
            1. As of `0123456789abcdef0123456789abcdef01234567` (`Makefile.in`, `v1.2`)\n";
        let claims = parse_claims(body);
        assert_eq!(
            claims,
            vec![
                Claim { sha: "abc1234".into(), paths: vec!["src/auth/session.ts".into(), "src/auth/".into()] },
                Claim { sha: "0123456789abcdef0123456789abcdef01234567".into(), paths: vec!["Makefile.in".into()] },
            ]
        );
    }

    #[test]
    fn supersede_strikes_one_line_and_keeps_its_list_marker() {
        let body = "- a: first\n- b: second line\n  - nested: deep\n";
        let out = supersede(body, "second", "2026-10-25").unwrap();
        assert_eq!(out, "- a: first\n- ~~b: second line~~ (superseded 2026-10-25)\n  - nested: deep\n");
        let nested = supersede(body, "deep", "2026-10-25").unwrap();
        assert!(nested.contains("  - ~~nested: deep~~ (superseded 2026-10-25)"));
        // A retired line is no longer a claim, and cannot be retired twice.
        assert!(is_superseded("- ~~b~~ (superseded 2026-10-25)"));
        assert!(supersede(&out, "second", "2026-10-26").unwrap_err().to_string().contains("already superseded"));
    }

    #[test]
    fn supersede_refuses_no_match_and_many_matches_with_the_next_step() {
        let body = "- one thing\n- another thing\n- unrelated\n";
        let none = supersede(body, "missing", "2026-10-25").unwrap_err().to_string();
        assert!(none.contains("No line of the note contains that text") && none.contains("kybern_note_read"), "{none}");
        let many = supersede(body, "thing", "2026-10-25").unwrap_err().to_string();
        assert!(many.contains("2 lines") && many.contains("longer piece"), "{many}");
        assert!(supersede(body, "  ", "2026-10-25").is_err());
        assert!(supersede(body, "a\nb", "2026-10-25").is_err());
    }
}
