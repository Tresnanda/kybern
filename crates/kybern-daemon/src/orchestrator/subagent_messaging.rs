//! A durable inbox bound to one admitted native process and one child task.
use super::*;

impl Orchestrator {
    pub async fn send_subagent_message(&self, input: methods::QueuedMessage) -> Result<SubagentMessage> {
        let child = self.inner.store.thread_get(input.thread_id)?.ok_or_else(|| anyhow!("Subagent not found."))?;
        let info = child.subagent.as_ref().ok_or_else(|| anyhow!("This is not a native subagent thread."))?;
        if child.provider.kind != ProviderKind::ClaudeCode {
            return Err(anyhow!(subagents::READ_ONLY_ERROR));
        }
        if let Some(record) = self.inner.store.subagent_message_get(input.id)? {
            anyhow::ensure!(
                record.thread_id == child.id && record.message == input.message,
                "Message identity already belongs to another input."
            );
            return Ok(record);
        }
        anyhow::ensure!(info.status.is_active(), "Not delivered — subagent finished.");
        let live = self
            .inner
            .sessions
            .lock()
            .await
            .get(&info.root_thread_id)
            .cloned()
            .ok_or_else(|| anyhow!("Not delivered — native session ended."))?;
        let owner = self.inner.store.meta_get(&format!("subagent_owner:{}", child.id))?;
        anyhow::ensure!(
            owner.as_deref() == Some(&live.session_instance_id.to_string()) && !live.is_released(),
            "Not delivered — native session ended."
        );
        let task = live.tasks.lock().await.get(&info.task_id).cloned().ok_or_else(|| anyhow!("Not delivered — subagent finished."))?;
        anyhow::ensure!(task.kind == RuntimeTaskKind::Agent && task.status.is_active(), "Not delivered — subagent finished.");
        let turn_id = {
            let mut router = self.inner.subagents.lock().unwrap_or_else(|p| p.into_inner());
            self.subagent_ensure_started(&mut router, child.id)?;
            router.message_turn(child.id).ok_or_else(|| anyhow!("Not delivered — subagent finished."))?
        };
        let native_message = self.subagent_provider_message(&input.message, &live)?;
        let record = SubagentMessage {
            id: input.id,
            thread_id: child.id,
            root_thread_id: info.root_thread_id,
            task_id: info.task_id.clone(),
            session_instance_id: live.session_instance_id,
            native_task_id: task.id.clone(),
            turn_id,
            message: input.message,
            status: SubagentMessageStatus::Pending,
            error: None,
            parent_message_id: None,
            parent_queued: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        {
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("Command lock poisoned."))?;
            // Concurrent retries share the stored identity, never insert two messages.
            if let Some(existing) = self.inner.store.subagent_message_get(record.id)? {
                anyhow::ensure!(
                    existing.thread_id == record.thread_id && existing.message == record.message,
                    "Message identity already belongs to another input."
                );
                return Ok(existing);
            }
            self.inner.store.subagent_message_insert(&record)?;
            let published = self
                .emit(child.id, Some(turn_id), EventPayload::MessageSteered { message_id: record.id, message: record.message.clone() })
                .and_then(|_| self.emit_subagent_message(&record));
            if let Err(error) = published {
                self.inner.store.subagent_message_settle(
                    record.id,
                    record.session_instance_id,
                    SubagentMessageStatus::Failed,
                    Some("Not delivered — unable to save the message event. Send it to its parent.".into()),
                )?;
                return Err(error);
            }
        }
        live.touch();
        if let Err(error) = live.session.send_subagent_message(&record.native_task_id, &record.id.to_string(), &native_message).await {
            if let Some(failed) = self.inner.store.subagent_message_settle(
                record.id,
                record.session_instance_id,
                SubagentMessageStatus::Failed,
                Some(format!("Not delivered — {error}")),
            )? {
                self.emit_subagent_message(&failed)?;
            }
        }
        Ok(self.inner.store.subagent_message_get(record.id)?.unwrap_or(record))
    }

    fn subagent_provider_message(&self, message: &UserMessage, live: &LiveSession) -> Result<UserMessage> {
        let expanded = self.provider_message(message, live);
        let mut parts = Vec::with_capacity(expanded.parts.len());
        for part in &expanded.parts {
            match part {
                ContentPart::Attachment { asset_id, name, .. } => {
                    anyhow::ensure!(self.inner.store.asset_get(*asset_id)?.is_some(), "Attachment {name} is missing. Attach it again.");
                    let path = self.inner.paths.assets.join(asset_id.to_string());
                    anyhow::ensure!(path.is_file(), "Attachment {name} is missing. Attach it again.");
                    parts.push(ContentPart::Text { text: format!("Attached file {name} (read with a file tool): {}", path.display()) });
                }
                ContentPart::Image { .. } => {
                    return Err(anyhow!(
                        "Attach an image file so the subagent can read its path. Native hooks deliver file references, not inline images."
                    ));
                }
                _ => parts.push(part.clone()),
            }
        }
        let output = UserMessage { parts };
        anyhow::ensure!(!output.plain_text().trim().is_empty(), "Write a message or attach a file.");
        anyhow::ensure!(output.plain_text().len() <= 64 * 1024, "Subagent message exceeds 64 KiB.");
        Ok(output)
    }

    pub async fn subagent_messages(&self, thread_id: ThreadId) -> Result<Vec<SubagentMessage>> {
        let child = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("Subagent not found."))?;
        let info = child.subagent.as_ref().ok_or_else(|| anyhow!("This is not a native subagent thread."))?;
        let live = self.inner.sessions.lock().await.get(&info.root_thread_id).cloned();
        for record in self.inner.store.subagent_messages(thread_id)? {
            if record.status == SubagentMessageStatus::Pending
                && live.as_ref().is_none_or(|live| live.is_released() || live.session_instance_id != record.session_instance_id)
            {
                if let Some(failed) = self.inner.store.subagent_message_settle(
                    record.id,
                    record.session_instance_id,
                    SubagentMessageStatus::Failed,
                    Some("Not delivered — native session ended before delivery could be confirmed.".into()),
                )? {
                    self.emit_subagent_message(&failed)?;
                }
            }
        }
        self.inner.store.subagent_messages(thread_id)
    }

    pub async fn send_subagent_message_to_parent(&self, action: methods::SubagentMessageActionParams) -> Result<SubagentMessage> {
        let record = self.inner.store.subagent_message_get(action.message_id)?.ok_or_else(|| anyhow!("Message not found."))?;
        anyhow::ensure!(
            record.thread_id == action.thread_id && record.status == SubagentMessageStatus::Failed,
            "Only a message that was not delivered can be sent to its parent."
        );
        let child = self.inner.store.thread_get(record.thread_id)?.ok_or_else(|| anyhow!("Subagent not found."))?;
        anyhow::ensure!(
            child.subagent.as_ref().is_some_and(|info| info.root_thread_id == record.root_thread_id),
            "Subagent parent changed."
        );
        let parent_id = child.parent_thread_id.ok_or_else(|| anyhow!("This subagent has no parent thread."))?;
        let parent = self.inner.store.thread_get(parent_id)?.ok_or_else(|| anyhow!("Parent thread not found."))?;
        let record = self.inner.store.subagent_message_parent_id(record.id)?;
        let forwarded =
            methods::QueuedMessage { id: record.parent_message_id.unwrap(), thread_id: parent.id, message: record.message.clone() };
        if parent.subagent.is_some() {
            let sent = self.send_subagent_message(forwarded).await?;
            anyhow::ensure!(
                sent.status != SubagentMessageStatus::Failed,
                "The parent subagent did not receive the message. Open its thread to review delivery."
            );
        } else {
            self.enqueue(forwarded)?;
        }
        let record = self.inner.store.subagent_message_parent_queued(record.id)?;
        self.emit_subagent_message(&record)?;
        Ok(record)
    }

    pub(super) fn acknowledge_subagent_message(&self, root: ThreadId, owner: Uuid, task_id: &str, id: &str) -> Result<()> {
        let Ok(id) = id.parse() else { return Ok(()) };
        let Some(record) = self.inner.store.subagent_message_get(id)? else { return Ok(()) };
        if record.root_thread_id != root || record.session_instance_id != owner || record.native_task_id != task_id {
            return Ok(());
        }
        if let Some(delivered) = self.inner.store.subagent_message_settle(id, owner, SubagentMessageStatus::Delivered, None)? {
            self.emit_subagent_message(&delivered)?;
        }
        Ok(())
    }

    pub(super) fn fail_subagent_messages(&self, child: ThreadId, reason: &str) -> Result<()> {
        for record in self.inner.store.subagent_messages(child)? {
            if let Some(failed) = self.inner.store.subagent_message_settle(
                record.id,
                record.session_instance_id,
                SubagentMessageStatus::Failed,
                Some(reason.into()),
            )? {
                self.emit_subagent_message(&failed)?;
            }
        }
        Ok(())
    }

    pub(super) fn fail_all_subagent_messages(&self, reason: &str) -> Result<()> {
        for record in self.inner.store.subagent_messages_pending()? {
            if let Some(failed) = self.inner.store.subagent_message_settle(
                record.id,
                record.session_instance_id,
                SubagentMessageStatus::Failed,
                Some(reason.into()),
            )? {
                self.emit_subagent_message(&failed)?;
            }
        }
        Ok(())
    }

    fn emit_subagent_message(&self, message: &SubagentMessage) -> Result<()> {
        self.emit(message.thread_id, Some(message.turn_id), EventPayload::SubagentMessageUpdated { message: message.clone() })?;
        Ok(())
    }
}
