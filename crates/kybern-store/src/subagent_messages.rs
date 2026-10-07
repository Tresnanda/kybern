use super::*;

impl Store {
    pub fn subagent_message_get(&self, id: MessageId) -> Result<Option<SubagentMessage>> {
        let conn = self.conn.lock().unwrap();
        let record: Option<String> =
            conn.query_row("SELECT record FROM subagent_messages WHERE id=?1", [id.to_string()], |r| r.get(0)).optional()?;
        record.map(|s| serde_json::from_str(&s).map_err(Into::into)).transpose()
    }

    pub fn subagent_messages(&self, thread_id: ThreadId) -> Result<Vec<SubagentMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut query = conn.prepare("SELECT record FROM subagent_messages WHERE thread_id=?1 ORDER BY rowid DESC LIMIT 100")?;
        let records = query.query_map([thread_id.to_string()], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        records.into_iter().rev().map(|s| serde_json::from_str(&s).map_err(Into::into)).collect()
    }

    pub fn subagent_message_insert(&self, record: &SubagentMessage) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO subagent_messages(id,thread_id,session_instance_id,task_id,status,record) VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                record.id.to_string(),
                record.thread_id.to_string(),
                record.session_instance_id.to_string(),
                record.task_id,
                snake(&record.status)?,
                serde_json::to_string(record)?
            ],
        )?;
        Ok(())
    }

    /// Acknowledgments and failures settle pending only. Late duplicate callbacks
    /// cannot overwrite failure, or turn a delivered message back into pending.
    pub fn subagent_message_settle(
        &self,
        id: MessageId,
        owner: Uuid,
        status: SubagentMessageStatus,
        error: Option<String>,
    ) -> Result<Option<SubagentMessage>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let encoded: Option<String> = tx
            .query_row(
                "SELECT record FROM subagent_messages WHERE id=?1 AND session_instance_id=?2 AND status='pending'",
                params![id.to_string(), owner.to_string()],
                |r| r.get(0),
            )
            .optional()?;
        let Some(encoded) = encoded else { return Ok(None) };
        let mut record: SubagentMessage = serde_json::from_str(&encoded)?;
        record.status = status;
        record.error = error;
        record.updated_at = Utc::now();
        tx.execute(
            "UPDATE subagent_messages SET status=?2,record=?3 WHERE id=?1",
            params![id.to_string(), snake(&record.status)?, serde_json::to_string(&record)?],
        )?;
        tx.commit()?;
        Ok(Some(record))
    }

    /// Lifecycle batches are independent of the newest-message UI window.
    /// Filter by the original child/process so another owner cannot be settled.
    pub fn subagent_messages_pending(&self, thread_id: Option<ThreadId>, owner: Option<Uuid>) -> Result<Vec<SubagentMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from("SELECT record FROM subagent_messages WHERE status='pending'");
        let mut values = Vec::new();
        if let Some(thread_id) = thread_id {
            sql.push_str(" AND thread_id=?");
            values.push(thread_id.to_string());
        }
        if let Some(owner) = owner {
            sql.push_str(" AND session_instance_id=?");
            values.push(owner.to_string());
        }
        sql.push_str(" ORDER BY rowid LIMIT 100");
        let mut query = conn.prepare(&sql)?;
        query
            .query_map(rusqlite::params_from_iter(values), |r| r.get::<_, String>(0))?
            .map(|r| serde_json::from_str(&r?).map_err(Into::into))
            .collect()
    }

    pub fn subagent_message_parent_queued(&self, id: MessageId) -> Result<SubagentMessage> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let encoded: String = tx.query_row("SELECT record FROM subagent_messages WHERE id=?1", [id.to_string()], |r| r.get(0))?;
        let mut record: SubagentMessage = serde_json::from_str(&encoded)?;
        record.parent_queued = true;
        record.updated_at = Utc::now();
        tx.execute("UPDATE subagent_messages SET record=?2 WHERE id=?1", params![id.to_string(), serde_json::to_string(&record)?])?;
        tx.commit()?;
        Ok(record)
    }

    pub fn subagent_message_parent_id(&self, id: MessageId) -> Result<SubagentMessage> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let encoded: String = tx.query_row("SELECT record FROM subagent_messages WHERE id=?1", [id.to_string()], |r| r.get(0))?;
        let mut record: SubagentMessage = serde_json::from_str(&encoded)?;
        if record.parent_message_id.is_none() {
            record.parent_message_id = Some(Uuid::now_v7());
            tx.execute("UPDATE subagent_messages SET record=?2 WHERE id=?1", params![id.to_string(), serde_json::to_string(&record)?])?;
        }
        tx.commit()?;
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message() -> SubagentMessage {
        SubagentMessage {
            id: Uuid::now_v7(),
            thread_id: Uuid::now_v7(),
            root_thread_id: Uuid::now_v7(),
            task_id: "public-child".into(),
            native_task_id: "native-child".into(),
            session_instance_id: Uuid::now_v7(),
            turn_id: Uuid::now_v7(),
            message: UserMessage::text("Keep this exact input."),
            status: SubagentMessageStatus::Pending,
            error: None,
            parent_message_id: None,
            parent_queued: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn pending_batches_reach_old_messages_and_filter_child_and_original_owner() {
        let store = Store::open_in_memory().unwrap();
        let oldest = message();
        store.subagent_message_insert(&oldest).unwrap();
        // Failed sends can push accepted pending messages out of the latest UI page.
        for _ in 0..101 {
            let mut failed = oldest.clone();
            failed.id = Uuid::now_v7();
            failed.status = SubagentMessageStatus::Failed;
            store.subagent_message_insert(&failed).unwrap();
        }
        assert!(!store.subagent_messages(oldest.thread_id).unwrap().iter().any(|m| m.id == oldest.id));
        let mut other_owner = oldest.clone();
        other_owner.id = Uuid::now_v7();
        other_owner.session_instance_id = Uuid::now_v7();
        store.subagent_message_insert(&other_owner).unwrap();
        let mut other_child = oldest.clone();
        other_child.id = Uuid::now_v7();
        other_child.thread_id = Uuid::now_v7();
        store.subagent_message_insert(&other_child).unwrap();
        let exact = store.subagent_messages_pending(Some(oldest.thread_id), Some(oldest.session_instance_id)).unwrap();
        assert_eq!(exact.len(), 1);
        assert_eq!(exact[0].id, oldest.id);
        assert_eq!(store.subagent_messages_pending(Some(oldest.thread_id), None).unwrap().len(), 2);
        assert_eq!(store.subagent_messages_pending(None, Some(oldest.session_instance_id)).unwrap().len(), 2);
        for _ in 0..205 {
            let mut pending = oldest.clone();
            pending.id = Uuid::now_v7();
            store.subagent_message_insert(&pending).unwrap();
        }
        let mut settled = 0;
        loop {
            let batch = store.subagent_messages_pending(Some(oldest.thread_id), Some(oldest.session_instance_id)).unwrap();
            assert!(batch.len() <= 100);
            if batch.is_empty() {
                break;
            }
            for record in batch {
                store
                    .subagent_message_settle(record.id, record.session_instance_id, SubagentMessageStatus::Failed, Some("finished".into()))
                    .unwrap();
                settled += 1;
            }
        }
        assert_eq!(settled, 206);
        assert_eq!(store.subagent_message_get(oldest.id).unwrap().unwrap().status, SubagentMessageStatus::Failed);
        assert_eq!(store.subagent_message_get(other_owner.id).unwrap().unwrap().status, SubagentMessageStatus::Pending);
        assert_eq!(store.subagent_message_get(other_child.id).unwrap().unwrap().status, SubagentMessageStatus::Pending);
    }

    #[test]
    fn only_the_original_owner_can_acknowledge_once_and_failure_is_final() {
        let store = Store::open_in_memory().unwrap();
        let record = message();
        store.subagent_message_insert(&record).unwrap();
        assert!(store.subagent_message_settle(record.id, Uuid::now_v7(), SubagentMessageStatus::Delivered, None).unwrap().is_none());
        assert_eq!(store.subagent_message_get(record.id).unwrap().unwrap().status, SubagentMessageStatus::Pending);
        assert!(
            store.subagent_message_settle(record.id, record.session_instance_id, SubagentMessageStatus::Delivered, None).unwrap().is_some()
        );
        assert!(
            store
                .subagent_message_settle(record.id, record.session_instance_id, SubagentMessageStatus::Failed, Some("late failure".into()))
                .unwrap()
                .is_none()
        );
        assert_eq!(store.subagent_messages(record.thread_id).unwrap()[0].status, SubagentMessageStatus::Delivered);
        let failed = message();
        store.subagent_message_insert(&failed).unwrap();
        store
            .subagent_message_settle(failed.id, failed.session_instance_id, SubagentMessageStatus::Failed, Some("subagent finished".into()))
            .unwrap();
        assert!(
            store.subagent_message_settle(failed.id, failed.session_instance_id, SubagentMessageStatus::Delivered, None).unwrap().is_none()
        );
        let forward = store.subagent_message_parent_id(failed.id).unwrap();
        assert!(!forward.parent_queued);
        assert_eq!(store.subagent_message_parent_id(failed.id).unwrap().parent_message_id, forward.parent_message_id);
        assert!(store.subagent_message_parent_queued(failed.id).unwrap().parent_queued);
    }
}
