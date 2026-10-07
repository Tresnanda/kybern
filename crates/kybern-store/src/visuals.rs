//! Atomic publication: source and receipt commit together, and cascade on deletion.
use crate::*;
impl Store {
    pub fn visual_publish(&self, thread_id: ThreadId, turn_id: TurnId, visual: &HtmlVisual, html: &str) -> Result<ThreadEvent> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO html_visuals(id,thread_id,title,height,html) VALUES (?1,?2,?3,?4,?5)",
                params![visual.id.to_string(), thread_id.to_string(), visual.title, visual.height, html],
            )?;
            let event = append_event_in_transaction(&tx, thread_id, Some(turn_id), EventPayload::HtmlPublished { visual: visual.clone() })?;
            tx.commit()?;
            Ok(event)
        })
    }
    pub fn tool_call_name(&self, thread_id: ThreadId, call_id: &str) -> Result<Option<String>> {
        self.with(|c| Ok(c.query_row("SELECT json_extract(payload, '$.call.name') FROM events WHERE thread_id=?1 AND kind='tool_call_started' AND json_extract(payload, '$.call.id')=?2 ORDER BY seq DESC LIMIT 1", params![thread_id.to_string(),call_id], |r| r.get(0)).optional()?))
    }
    pub fn visual_latest_turn(&self, thread_id: ThreadId) -> Result<Option<TurnId>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT turn_id FROM events WHERE thread_id=?1 AND kind='turn_started' AND turn_id IS NOT NULL ORDER BY seq DESC LIMIT 1",
                [thread_id.to_string()],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(|id| id.parse())
            .transpose()?)
        })
    }
    pub fn visual_read(&self, thread_id: ThreadId, id: Uuid) -> Result<Option<String>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT html FROM html_visuals WHERE thread_id=?1 AND id=?2",
                params![thread_id.to_string(), id.to_string()],
                |r| r.get(0),
            )
            .optional()?)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Store, ProjectId, ThreadId) {
        let store = Store::open_in_memory().unwrap();
        let project = Uuid::now_v7();
        let thread = Uuid::now_v7();
        store.with(|c| {
            c.execute("INSERT INTO projects(id,name,path,is_git,created_at,updated_at) VALUES(?1,'Visual test','/scratch',0,'2026-10-07T00:00:00Z','2026-10-07T00:00:00Z')", [project.to_string()])?;
            c.execute("INSERT INTO threads(id,project_id,title,provider_kind,provider_instance,permission_mode,status,cwd,created_at,updated_at) VALUES(?1,?2,'Visual test','codex','default','supervised','idle','/scratch','2026-10-07T00:00:00Z','2026-10-07T00:00:00Z')",params![thread.to_string(),project.to_string()])?; Ok(())
        }).unwrap();
        (store, project, thread)
    }
    #[test]
    fn source_receipt_and_projection_are_durable_and_thread_owned() {
        let (store, project, thread) = fixture();
        let turn = Uuid::now_v7();
        store
            .event_append(
                thread,
                Some(turn),
                EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("Show a chart") },
            )
            .unwrap();
        let visual = HtmlVisual { id: Uuid::now_v7(), title: "Usage chart".into(), height: 420 };
        let source = "<button onclick='this.textContent=2'>1</button>";
        let event = store.visual_publish(thread, turn, &visual, source).unwrap();
        assert_eq!(store.visual_read(thread, visual.id).unwrap().as_deref(), Some(source));
        assert!(store.visual_read(Uuid::now_v7(), visual.id).unwrap().is_none());
        assert_eq!(store.visual_latest_turn(thread).unwrap(), Some(turn));
        let rows = project_transcript(&[event]);
        assert!(matches!(&rows[0],TranscriptEntry::Visual { visual: got,turn_id,.. } if got == &visual && *turn_id == turn));
        store.project_delete(project).unwrap();
        assert!(store.visual_read(thread, visual.id).unwrap().is_none());
    }
    #[test]
    fn failed_publication_rolls_back_source_and_event() {
        let (store, _, thread) = fixture();
        let visual = HtmlVisual { id: Uuid::now_v7(), title: "Chart".into(), height: 300 };
        assert!(store.visual_publish(Uuid::now_v7(), Uuid::now_v7(), &visual, "<p>orphan</p>").is_err());
        assert!(store.visual_read(thread, visual.id).unwrap().is_none());
    }
    #[test]
    fn publication_uses_latest_conversation_start_after_old_turn_updates() {
        let (store, _, thread) = fixture();
        let older = Uuid::now_v7();
        let newer = Uuid::now_v7();
        let message = Uuid::now_v7();
        for turn in [older, newer] {
            store
                .event_append(
                    thread,
                    Some(turn),
                    EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("A request") },
                )
                .unwrap();
        }
        store
            .event_append(
                thread,
                Some(older),
                EventPayload::AssistantMessageBlocksRecovered {
                    message_id: message,
                    session_id: "retained-omp".into(),
                    native_entry_id: "old-entry".into(),
                    blocks: vec![RecoveredAssistantBlock {
                        message_id: message,
                        content_index: 0,
                        text: "Old final".into(),
                        thinking: None,
                        before_tool_call_id: None,
                        seq: 1,
                        at: chrono::Utc::now(),
                    }],
                    terminal_message_id: message,
                },
            )
            .unwrap();
        store
            .event_append(
                thread,
                Some(older),
                EventPayload::ProviderNotice { level: NoticeLevel::Info, text: "Old background task finished".into(), data: None },
            )
            .unwrap();
        assert_eq!(store.visual_latest_turn(thread).unwrap(), Some(newer));
        let visual = HtmlVisual { id: Uuid::now_v7(), title: "New visual".into(), height: 300 };
        let event =
            store.visual_publish(thread, store.visual_latest_turn(thread).unwrap().unwrap(), &visual, "<p>New turn chart</p>").unwrap();
        assert_eq!(event.turn_id, Some(newer));
    }
}
