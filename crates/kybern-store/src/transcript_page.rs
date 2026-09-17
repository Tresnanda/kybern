use kybern_protocol::{EventSeq, TranscriptEntry};
use std::borrow::Borrow;

fn seq(entry: &TranscriptEntry) -> EventSeq {
    match entry {
        TranscriptEntry::Image { seq, .. }
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
    let Some(limit) = limit else { return (entries.to_vec(), None) };
    // Keep the legacy stable-sort behavior for callers with unordered entries.
    // The common ordered case can page the borrowed slice without allocating
    // and sorting a reference to every historical row on each request.
    if !entries.windows(2).all(|pair| seq(&pair[0]) <= seq(&pair[1])) {
        let (page, cursor) = page_entries(entries.iter().collect(), Some(limit), before);
        return (page.into_iter().cloned().collect(), cursor);
    }

    let end = before.map_or(entries.len(), |before| entries.partition_point(|entry| seq(entry) < before));
    let mut start = end.saturating_sub(limit.max(1) as usize);
    while start > 0 && seq(&entries[start - 1]) == seq(&entries[start]) {
        start -= 1;
    }
    let cursor = (start > 0).then(|| seq(&entries[start]));
    // Unfinished older rows are part of the initial page, even when they fall
    // before its nominal boundary. They must not be discarded to save memory.
    let live_prefix = if before.is_none() { &entries[..start] } else { &[] };
    let page = live_prefix
        .iter()
        .filter(|entry| {
            matches!(entry, TranscriptEntry::Assistant { complete: false, .. } | TranscriptEntry::ToolCall { complete: false, .. })
        })
        .chain(entries[start..end].iter())
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
}
