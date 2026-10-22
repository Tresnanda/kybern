use kybern_protocol::{EventSeq, TranscriptEntry, TurnId};
use std::borrow::Borrow;

fn seq(entry: &TranscriptEntry) -> EventSeq {
    match entry {
        TranscriptEntry::Visual { seq, .. }
        | TranscriptEntry::Image { seq, .. }
        | TranscriptEntry::User { seq, .. }
        | TranscriptEntry::Assistant { seq, .. }
        | TranscriptEntry::ToolCall { seq, .. }
        | TranscriptEntry::Approval { seq, .. }
        | TranscriptEntry::TurnSummary { seq, .. }
        | TranscriptEntry::RuntimeTask { seq, .. }
        | TranscriptEntry::Notice { seq, .. }
        | TranscriptEntry::Reverted { seq, .. } => *seq,
    }
}

/// Page the completed projection, not the raw events: a tool's launch and its
/// completion may be far apart. Keep equal-sequence entries together so a cursor
/// can never skip a row. The initial page also includes unfinished older rows so
/// live deltas always have their beginning. Full-history callers retain ordering.
pub fn transcript_page(
    entries: Vec<TranscriptEntry>,
    limit: Option<u32>,
    before: Option<EventSeq>,
) -> (Vec<TranscriptEntry>, Option<EventSeq>) {
    page_entries(entries, limit, before)
}

/// A cached projection only clones the requested rows, not the entire history.
pub fn transcript_page_ref(
    entries: &[TranscriptEntry],
    limit: Option<u32>,
    before: Option<EventSeq>,
) -> (Vec<TranscriptEntry>, Option<EventSeq>) {
    transcript_page_ref_with(entries, limit, before, false)
}

/// The most rows a page may grow by to reach the start of its oldest turn.
/// A turn of an agent that ran thousands of tools is still one page (~600 B
/// per row without tool output); past this the page starts mid-turn and the
/// client asks again.
pub const WHOLE_TURN_EXTRA_ENTRIES: usize = 4000;

/// Like [`transcript_page_ref`]; `whole_turns` widens the page to the first row
/// of its oldest turn (up to [`WHOLE_TURN_EXTRA_ENTRIES`] more rows). Clients
/// render one row per turn: a page of 120 tool calls from the middle of a long
/// turn added nothing to the screen, and a reader scrolled through up to 17 such
/// pages before the next prompt appeared.
pub fn transcript_page_ref_with(
    entries: &[TranscriptEntry],
    limit: Option<u32>,
    before: Option<EventSeq>,
    whole_turns: bool,
) -> (Vec<TranscriptEntry>, Option<EventSeq>) {
    let Some(limit) = limit else { return (entries.to_vec(), None) };
    // Keep the legacy stable-sort behavior for callers with unordered entries.
    // The common ordered case can page the borrowed slice without allocating
    // and sorting a reference to every historical row on each request.
    if !entries.windows(2).all(|pair| seq(&pair[0]) <= seq(&pair[1])) {
        let mut sorted: Vec<&TranscriptEntry> = entries.iter().collect();
        sorted.sort_by_key(|entry| seq(entry));
        return page_sorted(&sorted, limit, before, whole_turns);
    }
    page_sorted(entries, limit, before, whole_turns)
}

fn turn(entry: &TranscriptEntry) -> TurnId {
    match entry {
        TranscriptEntry::Visual { turn_id, .. }
        | TranscriptEntry::Image { turn_id, .. }
        | TranscriptEntry::User { turn_id, .. }
        | TranscriptEntry::Assistant { turn_id, .. }
        | TranscriptEntry::ToolCall { turn_id, .. }
        | TranscriptEntry::Approval { turn_id, .. }
        | TranscriptEntry::TurnSummary { turn_id, .. }
        | TranscriptEntry::RuntimeTask { turn_id, .. }
        | TranscriptEntry::Notice { turn_id, .. }
        | TranscriptEntry::Reverted { turn_id, .. } => *turn_id,
    }
}

fn page_sorted<T: Borrow<TranscriptEntry>>(
    entries: &[T],
    limit: u32,
    before: Option<EventSeq>,
    whole_turns: bool,
) -> (Vec<TranscriptEntry>, Option<EventSeq>) {
    let at = |index: usize| entries[index].borrow();
    let end = before.map_or(entries.len(), |before| entries.partition_point(|entry| seq(entry.borrow()) < before));
    let mut start = end.saturating_sub(limit.max(1) as usize);
    let same_seq_start = |mut start: usize| {
        while start > 0 && seq(at(start - 1)) == seq(at(start)) {
            start -= 1;
        }
        start
    };
    start = same_seq_start(start);
    if whole_turns && start < end {
        let floor = start.saturating_sub(WHOLE_TURN_EXTRA_ENTRIES);
        let oldest = turn(at(start));
        while start > floor && turn(at(start - 1)) == oldest {
            start -= 1;
        }
        start = same_seq_start(start);
    }
    let cursor = (start > 0).then(|| seq(at(start)));
    // Unfinished older rows are part of the initial page, even when they fall
    // before its nominal boundary. They must not be discarded to save memory.
    let live_prefix = if before.is_none() { &entries[..start] } else { &[] };
    let page = live_prefix
        .iter()
        .map(Borrow::borrow)
        .filter(|entry| {
            matches!(entry, TranscriptEntry::Assistant { complete: false, .. } | TranscriptEntry::ToolCall { complete: false, .. })
        })
        .chain(entries[start..end].iter().map(Borrow::borrow))
        .cloned()
        .collect();
    (page, cursor)
}

fn page_entries<T: Borrow<TranscriptEntry>>(
    mut entries: Vec<T>,
    limit: Option<u32>,
    before: Option<EventSeq>,
) -> (Vec<T>, Option<EventSeq>) {
    let Some(limit) = limit else { return (entries, None) };
    if let Some(before) = before {
        entries.retain(|entry| seq(entry.borrow()) < before);
    }
    entries.sort_by_key(|entry| seq(entry.borrow()));
    let mut start = entries.len().saturating_sub(limit.max(1) as usize);
    while start > 0 && seq(entries[start - 1].borrow()) == seq(entries[start].borrow()) {
        start -= 1;
    }
    let cursor = (start > 0).then(|| seq(entries[start].borrow()));
    let mut page = entries.split_off(start);
    if before.is_none() {
        entries.retain(|entry| {
            matches!(entry.borrow(), TranscriptEntry::Assistant { complete: false, .. } | TranscriptEntry::ToolCall { complete: false, .. })
        });
        entries.append(&mut page);
        page = entries;
    }
    (page, cursor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use kybern_protocol::{NoticeLevel, TurnId};

    fn entries(sequences: &[EventSeq]) -> Vec<TranscriptEntry> {
        sequences
            .iter()
            .map(|&seq| TranscriptEntry::Notice {
                turn_id: TurnId::nil(),
                seq,
                level: NoticeLevel::Info,
                text: format!("entry {seq}"),
                at: Utc::now(),
            })
            .collect()
    }

    #[test]
    fn older_pages_preserve_every_entry_including_equal_sequence_boundaries() {
        let sequences = [1, 2, 3, 3, 4, 5, 6];
        let (latest, cursor) = transcript_page(entries(&sequences), Some(3), None);
        assert_eq!(latest.iter().map(seq).collect::<Vec<_>>(), [4, 5, 6]);
        assert_eq!(cursor, Some(4));
        let (middle, cursor) = transcript_page(entries(&sequences), Some(2), cursor);
        assert_eq!(middle.iter().map(seq).collect::<Vec<_>>(), [3, 3]);
        assert_eq!(cursor, Some(3));
        let (oldest, cursor) = transcript_page(entries(&sequences), Some(2), cursor);
        assert_eq!(oldest.iter().map(seq).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(cursor, None);
    }

    #[test]
    fn empty_and_legacy_calls_have_no_cursor() {
        assert!(transcript_page(vec![], Some(60), None).0.is_empty());
        let (all, cursor) = transcript_page(entries(&[3, 1, 2]), None, None);
        assert_eq!(all.iter().map(seq).collect::<Vec<_>>(), [3, 1, 2]);
        assert_eq!(cursor, None);
        assert!(transcript_page(entries(&[1, 2]), Some(60), Some(1)).0.is_empty());
    }

    #[test]
    fn initial_page_keeps_the_beginning_of_older_live_rows() {
        let mut all = entries(&[2, 3, 4]);
        all.insert(
            0,
            TranscriptEntry::Assistant {
                id: kybern_protocol::MessageId::nil(),
                turn_id: TurnId::nil(),
                seq: 1,
                origin: Default::default(),
                segment: 0,
                text: "Beginning of the live response".into(),
                thinking: None,
                thinking_complete: false,
                at: Utc::now(),
                complete: false,
            },
        );
        let (page, cursor) = transcript_page(all.clone(), Some(2), None);
        assert_eq!(page.iter().map(seq).collect::<Vec<_>>(), [1, 3, 4]);
        assert_eq!(cursor, Some(3));
        let (older, cursor) = transcript_page(all, Some(2), cursor);
        assert_eq!(older.iter().map(seq).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(cursor, None);
    }

    #[test]
    fn borrowed_pages_match_owned_pages_for_sorted_and_unordered_inputs() {
        let mut random = 0x4b79_6265_726e_u64;
        for len in 0..64 {
            let mut sequences = Vec::new();
            for _ in 0..len {
                random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                sequences.push(((random >> 32) % 13) as EventSeq - 3);
            }
            for sorted in [false, true] {
                let mut all = entries(&sequences);
                if sorted {
                    all.sort_by_key(seq);
                }
                for limit in [None, Some(0), Some(1), Some(3), Some(60)] {
                    for before in [None, Some(-4), Some(0), Some(8), Some(EventSeq::MAX)] {
                        let expected = transcript_page(all.clone(), limit, before);
                        let actual = transcript_page_ref(&all, limit, before);
                        assert_eq!(
                            serde_json::to_value(actual).unwrap(),
                            serde_json::to_value(expected).unwrap(),
                            "len={len}, sorted={sorted}, limit={limit:?}, before={before:?}",
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn borrowed_initial_pages_preserve_live_rows_and_equal_sequence_groups() {
        let mut all = entries(&[1, 2, 2, 3, 4, 4, 5]);
        all[0] = TranscriptEntry::Assistant {
            id: kybern_protocol::MessageId::nil(),
            turn_id: TurnId::nil(),
            seq: 1,
            origin: Default::default(),
            segment: 0,
            text: "Still running".into(),
            thinking: None,
            thinking_complete: false,
            at: Utc::now(),
            complete: false,
        };
        for limit in [None, Some(0), Some(1), Some(2), Some(3), Some(60)] {
            for before in [None, Some(1), Some(2), Some(4), Some(6)] {
                assert_eq!(
                    serde_json::to_value(transcript_page_ref(&all, limit, before)).unwrap(),
                    serde_json::to_value(transcript_page(all.clone(), limit, before)).unwrap(),
                );
            }
        }
    }

    /// Rows `(turn, seq)`, shaped like a thread whose middle turn ran
    /// thousands of subagent tools between two prompts.
    fn turn_entries(rows: &[(u128, EventSeq)]) -> Vec<TranscriptEntry> {
        rows.iter()
            .map(|&(turn, seq)| TranscriptEntry::Notice {
                turn_id: uuid::Uuid::from_u128(turn),
                seq,
                level: NoticeLevel::Info,
                text: format!("turn {turn} row {seq}"),
                at: Utc::now(),
            })
            .collect()
    }

    fn walk(all: &[TranscriptEntry], limit: u32, whole_turns: bool) -> Vec<Vec<EventSeq>> {
        let (first, mut cursor) = transcript_page_ref_with(all, Some(limit), None, whole_turns);
        let mut pages = vec![first.iter().map(seq).collect::<Vec<_>>()];
        while let Some(before) = cursor {
            let (page, next) = transcript_page_ref_with(all, Some(limit), Some(before), whole_turns);
            assert!(next.is_none_or(|next| next < before), "cursor must move back");
            pages.push(page.iter().map(seq).collect());
            cursor = next;
        }
        pages
    }

    #[test]
    fn whole_turn_pages_start_where_their_oldest_turn_starts() {
        let mut rows = vec![(1, 1), (1, 2), (1, 3)];
        rows.extend((4..=1_500).map(|seq| (2, seq)));
        rows.extend((1_501..=1_510).map(|seq| (3, seq)));
        let all = turn_entries(&rows);

        // The newest 120 rows reach into turn 2, so the first page completes it.
        let pages = walk(&all, 120, true);
        assert_eq!(pages.iter().map(|page| (page[0], page.len())).collect::<Vec<_>>(), [(4, 1_507), (1, 3)]);
        assert_eq!(in_order(pages), (1..=1_510).collect::<Vec<_>>());
        // A page that ends exactly at a turn boundary does not take the turn before it.
        let pages = walk(&all, 10, true);
        assert_eq!(pages.iter().map(|page| (page[0], page.len())).collect::<Vec<_>>(), [(1_501, 10), (4, 1_497), (1, 3)]);

        // Row pages still split the long turn; the default is unchanged.
        let rows_only = walk(&all, 120, false);
        assert_eq!(rows_only.len(), 13);
        assert_eq!(in_order(rows_only), (1..=1_510).collect::<Vec<_>>());
    }

    /// Pages arrive newest first; every row must appear exactly once.
    fn in_order(pages: Vec<Vec<EventSeq>>) -> Vec<EventSeq> {
        pages.into_iter().rev().flatten().collect()
    }

    #[test]
    fn whole_turn_pages_are_bounded_and_still_cover_every_row() {
        let longest = 120 + WHOLE_TURN_EXTRA_ENTRIES as EventSeq + 500;
        let mut rows = vec![(1, 1)];
        rows.extend((2..=longest + 1).map(|seq| (2, seq)));
        rows.extend([(3, longest + 2), (3, longest + 2), (3, longest + 3)]);
        let all = turn_entries(&rows);
        let pages = walk(&all, 3, true);
        assert!(pages.iter().all(|page| page.len() <= 3 + WHOLE_TURN_EXTRA_ENTRIES + 1));
        assert_eq!(pages[0], [longest + 2, longest + 2, longest + 3]);
        assert_eq!(pages.len(), 4, "the oversized turn takes two bounded pages");
        assert_eq!(pages[1].len(), 3 + WHOLE_TURN_EXTRA_ENTRIES);
        let mut expected = vec![1];
        expected.extend(2..=longest + 1);
        expected.extend([longest + 2, longest + 2, longest + 3]);
        assert_eq!(in_order(pages), expected);
    }

    #[test]
    fn whole_turn_pages_keep_equal_sequences_and_live_rows_and_match_unordered_input() {
        let mut all = turn_entries(&[(1, 1), (1, 2), (2, 2), (2, 3), (3, 4), (3, 5), (4, 6)]);
        all[0] = TranscriptEntry::Assistant {
            id: kybern_protocol::MessageId::nil(),
            turn_id: uuid::Uuid::from_u128(1),
            seq: 1,
            origin: Default::default(),
            segment: 0,
            text: "Still running".into(),
            thinking: None,
            thinking_complete: false,
            at: Utc::now(),
            complete: false,
        };
        // Turn 2 begins at seq 2, which turn 1 shares: the cursor must not split it.
        let (page, cursor) = transcript_page_ref_with(&all, Some(1), Some(4), true);
        assert_eq!(page.iter().map(seq).collect::<Vec<_>>(), [2, 2, 3]);
        assert_eq!(cursor, Some(2));
        // The initial page still carries the unfinished older row.
        let (page, cursor) = transcript_page_ref_with(&all, Some(1), None, true);
        assert_eq!(page.iter().map(seq).collect::<Vec<_>>(), [1, 6]);
        assert_eq!(cursor, Some(6));
        // Unordered, but rows sharing a sequence keep their relative order
        // (the stable sort preserves it, and it decides turn adjacency).
        let mut shuffled = all.clone();
        shuffled.rotate_left(3);
        for before in [None, Some(2), Some(4), Some(6), Some(7)] {
            assert_eq!(
                serde_json::to_value(transcript_page_ref_with(&shuffled, Some(2), before, true)).unwrap(),
                serde_json::to_value(transcript_page_ref_with(&all, Some(2), before, true)).unwrap(),
                "before={before:?}",
            );
        }
    }
}
