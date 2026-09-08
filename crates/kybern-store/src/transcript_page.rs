use kybern_protocol::{EventSeq, TranscriptEntry};

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
    mut entries: Vec<TranscriptEntry>,
    limit: Option<u32>,
    before: Option<EventSeq>,
) -> (Vec<TranscriptEntry>, Option<EventSeq>) {
    let Some(limit) = limit else { return (entries, None) };
    if let Some(before) = before {
        entries.retain(|entry| seq(entry) < before);
    }
    entries.sort_by_key(seq);
    let mut start = entries.len().saturating_sub(limit.max(1) as usize);
    while start > 0 && seq(&entries[start - 1]) == seq(&entries[start]) {
        start -= 1;
    }
    let cursor = (start > 0).then(|| seq(&entries[start]));
    let mut page = entries.split_off(start);
    if before.is_none() {
        entries.retain(|entry| {
            matches!(entry, TranscriptEntry::Assistant { complete: false, .. } | TranscriptEntry::ToolCall { complete: false, .. })
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
}
