//! Conservative historical recovery from retained explicit OMP boundaries.
use super::*;
use anyhow::ensure;
use kybern_drivers::sessions::{NativeOmpBlock, NativeOmpMessage};

impl Orchestrator {
    pub async fn recover_omp_answer(
        &self,
        params: methods::ThreadsRecoverOmpAnswerParams,
    ) -> Result<methods::ThreadsRecoverOmpAnswerResult> {
        self.ensure_not_subagent(params.thread_id)?;
        let admission = self.session_admission(params.thread_id).await;
        let _admission = admission.lock().await;
        let thread = self.inner.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        ensure!(
            !matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval),
            "Stop the active turn before recovering historical OMP output."
        );
        let events = self.inner.store.omp_recovery_events(thread.id, params.turn_id)?;
        if let Some(event) = events.iter().find(|event| matches!(event.payload, EventPayload::AssistantMessageBlocksRecovered { .. })) {
            if let EventPayload::AssistantMessageBlocksRecovered { native_entry_id, blocks, .. } = &event.payload {
                return Ok(methods::ThreadsRecoverOmpAnswerResult {
                    recovered: false,
                    native_entry_id: native_entry_id.clone(),
                    block_count: blocks.len() as u32,
                    correction_seq: event.seq,
                });
            }
        }
        let completion = events
            .iter()
            .find(|e| matches!(e.payload, EventPayload::TurnCompleted { stop_reason: StopReason::Completed, .. }))
            .ok_or_else(|| anyhow!("Choose a successfully completed OMP turn with retained native history."))?;
        ensure!(
            events.iter().filter(|e| matches!(e.payload, EventPayload::TurnCompleted { .. })).count() == 1,
            "This turn has multiple completion cycles. Recovery cannot choose a native response safely."
        );
        let owner: ProviderInstance = match self.inner.store.meta_get(&format!("turn_target:{}", params.turn_id))? {
            Some(value) => serde_json::from_str(&value)?,
            None => {
                ensure!(
                    thread.provider.kind == ProviderKind::Omp && thread.provider.instance == "default",
                    "Historical account ownership is unavailable. Restore this turn's original default OMP binding before recovering."
                );
                thread.provider.clone()
            }
        };
        ensure!(owner.kind == ProviderKind::Omp, "This turn belongs to another harness. Choose an OMP turn.");
        let binding = self
            .inner
            .store
            .provider_session_before(thread.id, completion.seq)?
            .ok_or_else(|| anyhow!("The historical native OMP session binding is missing. Restore the original session history."))?;
        let EventPayload::ProviderSessionBound { session_id, .. } = binding.payload else { unreachable!() };
        if self.inner.store.meta_get(&format!("turn_target:{}", params.turn_id))?.is_none() {
            ensure!(
                thread.provider_session_id.as_ref() == Some(&session_id),
                "The legacy turn's native session differs from the current binding. Historical ownership must be restored before recovery."
            );
        }
        let EventPayload::TurnCompleted { terminal_message_id: Some(message_id), .. } = completion.payload else {
            return Err(anyhow!("This turn has no durable terminal message identity. Recovery left the transcript unchanged."));
        };
        let messages = events
            .iter()
            .filter_map(|e| match &e.payload {
                EventPayload::AssistantMessageCompleted { message_id: id, origin, text, thinking }
                    if *id == message_id && origin.is_root() =>
                {
                    Some((e, text, thinking))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        ensure!(messages.len() == 1, "The terminal message is absent or ambiguous. Recovery left the transcript unchanged.");
        let (message_event, text, thinking) = messages[0];
        let project = self.inner.store.project_get(thread.project_id)?.ok_or_else(|| anyhow!("Project not found."))?;
        // Start from the raw config: provider_settings resolves today's global
        // selection, which must never replace the historical turn's account.
        let mut settings = self.inner.settings.get().providers.get(&owner.kind).cloned().unwrap_or_default();
        if owner.instance == "default"
            && let Some(profile) = settings.project_profiles.get(&project.path)
        {
            settings.env.insert("OMP_PROFILE".into(), profile.clone());
        }
        let mut env = crate::provider_accounts::environment(&settings, owner.kind, &owner.instance)?;
        if owner.instance == "default" {
            if let Some(profile) = self.inner.store.meta_get(&format!("omp_profile:{}", thread.id))? {
                env.insert("OMP_PROFILE".into(), profile);
            } else {
                ensure!(
                    kybern_drivers::omp_profile::resolve(&env)?.is_empty(),
                    "The legacy OMP profile binding is missing. Restore its original profile configuration before recovery."
                );
            }
        }
        let context =
            kybern_drivers::ProbeContext { binary: settings.binary.map(PathBuf::from), cwd: Some(PathBuf::from(&thread.cwd)), env };
        let native = kybern_drivers::sessions::recover_omp_message(&context, &session_id, text).await?;
        let payload = recovery_payload(&events, message_event, thinking.as_deref(), &session_id, native)?;
        let EventPayload::AssistantMessageBlocksRecovered { native_entry_id, blocks, .. } = &payload else { unreachable!() };
        let native_entry_id = native_entry_id.clone();
        let block_count = blocks.len() as u32;
        // Admission excludes new sends/turn transitions while native evidence is read.
        let event = self.emit(thread.id, Some(params.turn_id), payload)?;
        Ok(methods::ThreadsRecoverOmpAnswerResult { recovered: true, native_entry_id, block_count, correction_seq: event.seq })
    }
}

fn recovery_payload(
    events: &[ThreadEvent],
    message: &ThreadEvent,
    thinking: Option<&str>,
    session_id: &str,
    native: NativeOmpMessage,
) -> Result<EventPayload> {
    let EventPayload::AssistantMessageCompleted { message_id, text: stored_text, .. } = &message.payload else { unreachable!() };
    let native_text = native
        .blocks
        .iter()
        .filter_map(|b| match b {
            NativeOmpBlock::Text(s) => Some(s.as_str()),
            _ => None,
        })
        .collect::<String>();
    ensure!(&native_text == stored_text, "Native and stored OMP text differ. Recovery left the transcript unchanged.");
    let mut seen_tools = HashSet::new();
    let tools = events
        .iter()
        .filter_map(|event| match &event.payload {
            EventPayload::ToolCallStarted { call, origin } if origin.is_root() && seen_tools.insert(call.id.clone()) => {
                Some((&call.id, event.seq))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let native_tools = native
        .blocks
        .iter()
        .filter_map(|block| match block {
            NativeOmpBlock::ToolCall(id) => Some(id),
            _ => None,
        })
        .collect::<Vec<_>>();
    ensure!(
        native_tools == tools.iter().map(|(id, _)| *id).collect::<Vec<_>>()
            && native_tools.iter().collect::<HashSet<_>>().len() == native_tools.len(),
        "Native and stored OMP tool identities/order differ. Recovery left the transcript unchanged."
    );
    let native_thinking = native
        .blocks
        .iter()
        .filter_map(|b| match b {
            NativeOmpBlock::Thinking(s) => Some(s.as_str()),
            _ => None,
        })
        .collect::<String>();
    ensure!(native_thinking == thinking.unwrap_or(""), "Native and stored OMP reasoning differ. Recovery left the transcript unchanged.");
    ensure!(
        matches!(native.blocks.last(), Some(NativeOmpBlock::Text(text)) if !text.trim().is_empty()),
        "The native OMP entry has no explicit final text block after its work. Recovery left the transcript unchanged."
    );
    ensure!(
        native.blocks.iter().filter(|b| matches!(b, NativeOmpBlock::Text(_))).count() > 1,
        "This OMP message already has a single native text block; no recovery is needed."
    );
    let mut blocks = Vec::new();
    for (index, block) in native.blocks.iter().enumerate() {
        let (text, thinking) = match block {
            NativeOmpBlock::Text(text) => (text.clone(), None),
            NativeOmpBlock::Thinking(thinking) => (String::new(), Some(thinking.clone())),
            NativeOmpBlock::ToolCall(_) => continue,
        };
        let next_tool = native.blocks[index + 1..].iter().find_map(|b| match b {
            NativeOmpBlock::ToolCall(id) => Some(id),
            _ => None,
        });
        let seq = next_tool.and_then(|id| tools.iter().find(|(tool, _)| *tool == id).map(|(_, seq)| *seq)).unwrap_or(message.seq);
        blocks.push(RecoveredAssistantBlock {
            message_id: Uuid::now_v7(),
            content_index: index as u32,
            text,
            thinking,
            before_tool_call_id: next_tool.cloned(),
            seq,
            at: native.at,
        });
    }
    let terminal_message_id = blocks.last().expect("validated native final text").message_id;
    Ok(EventPayload::AssistantMessageBlocksRecovered {
        message_id: *message_id,
        session_id: session_id.into(),
        native_entry_id: native.entry_id,
        blocks,
        terminal_message_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<ThreadEvent> {
        serde_json::from_str(include_str!("../../../../fixtures/transcript/omp-recovered-boundaries.json")).unwrap()
    }

    fn native() -> NativeOmpMessage {
        NativeOmpMessage {
            entry_id: "native-entry".into(),
            at: Utc::now(),
            blocks: vec![
                NativeOmpBlock::Text("I’m checking the retained blocks.\n".into()),
                NativeOmpBlock::Thinking("Inspect native ordering.".into()),
                NativeOmpBlock::ToolCall("tool-1".into()),
                NativeOmpBlock::Text("The tool finished; formatting the result.\n".into()),
                NativeOmpBlock::Text(match &fixture().last().unwrap().payload {
                    EventPayload::AssistantMessageBlocksRecovered { blocks, .. } => blocks.last().unwrap().text.clone(),
                    _ => unreachable!(),
                }),
            ],
        }
    }

    #[test]
    fn recovery_plan_preserves_native_boundaries_and_duplicate_tool_rows() {
        let events = fixture();
        let message = events.iter().find(|e| matches!(e.payload, EventPayload::AssistantMessageCompleted { .. })).unwrap();
        let payload = recovery_payload(&events, message, Some("Inspect native ordering."), "native-session", native()).unwrap();
        let EventPayload::AssistantMessageBlocksRecovered { blocks, terminal_message_id, .. } = payload else { unreachable!() };
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[0].before_tool_call_id.as_deref(), Some("tool-1"));
        assert_eq!(blocks[0].seq, 4);
        assert_eq!(blocks[2].before_tool_call_id, None);
        assert!(blocks[3].text.starts_with("Recovered answer\n\n| Item | Value |"));
        assert_eq!(blocks[3].message_id, terminal_message_id);
        assert_ne!(blocks[2].message_id, terminal_message_id);
        assert!(recovery_payload(&events, message, Some("Different reasoning"), "native-session", native()).is_err());
        let mut wrong_tool = native();
        wrong_tool.blocks[2] = NativeOmpBlock::ToolCall("another-tool".into());
        assert!(recovery_payload(&events, message, Some("Inspect native ordering."), "native-session", wrong_tool).is_err());
        let mut no_final = native();
        no_final.blocks.pop();
        no_final.blocks.push(NativeOmpBlock::Thinking("thinking after text".into()));
        assert!(
            recovery_payload(&events, message, Some("Inspect native ordering.thinking after text"), "native-session", no_final).is_err()
        );
    }
    #[tokio::test]
    async fn recovery_action_is_exact_append_only_and_idempotent_in_scratch_storage() {
        let root = std::env::temp_dir().join(format!("kybern-omp-recovery-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(root.join("native/sessions")).unwrap();
        let paths = Paths::resolve(Some(root.join("data"))).unwrap();
        let settings = SettingsStore::load(&paths.settings).unwrap();
        let mut config = settings.get();
        let provider = config.providers.entry(ProviderKind::Omp).or_default();
        provider.env.insert("HOME".into(), root.join("home").display().to_string());
        provider.env.insert("PI_CODING_AGENT_DIR".into(), root.join("native").display().to_string());
        provider.env.insert("OMP_PROFILE".into(), String::new());
        provider.env.insert("XDG_DATA_HOME".into(), root.join("xdg").display().to_string());
        settings.set(config).unwrap();
        let store = Store::open_in_memory().unwrap();
        let (tx, _) = crate::bounded_broadcast::channel(32, 8 * 1024 * 1024);
        let orchestrator = Orchestrator::new(store.clone(), DriverRegistry::default(), tx, paths, settings);
        let project = orchestrator.add_project(root.display().to_string(), None).unwrap();
        let now = Utc::now();
        let mut events = fixture();
        events.pop();
        let turn_id = events[0].turn_id.unwrap();
        let thread: Thread = serde_json::from_value(serde_json::json!({
            "id":events[0].thread_id,"project_id":project.id,"title":"Historical OMP",
            "provider":{"kind":"codex","instance":"default"},"permission_mode":"supervised","status":"idle",
            "cwd":root.display().to_string(),"provider_session_id":"another-current-session",
            "pinned":false,"created_at":now,"updated_at":now,"last_seq":0
        }))
        .unwrap();
        store.thread_upsert(&thread).unwrap();
        // Explicit historical owner is independent of today's different harness.
        store
            .meta_set(&format!("turn_target:{turn_id}"), &serde_json::to_string(&ProviderInstance::default_for(ProviderKind::Omp)).unwrap())
            .unwrap();
        store.meta_set(&format!("omp_profile:{}", thread.id), "").unwrap();
        store
            .event_append(thread.id, Some(turn_id), EventPayload::ProviderSessionBound { session_id: "native-session".into(), model: None })
            .unwrap();
        for event in events {
            store.event_append(thread.id, Some(turn_id), event.payload).unwrap();
        }
        let original = store.events_for_thread(thread.id).unwrap();
        let record_path = root.join("native/sessions/history.jsonl");
        let fixture = fixture();
        let EventPayload::AssistantMessageBlocksRecovered { blocks, .. } = &fixture.last().unwrap().payload else { unreachable!() };
        let mut content = Vec::new();
        for block in blocks {
            if block.content_index == 3 {
                content.push(serde_json::json!({"type":"toolCall","id":"tool-1"}));
            }
            if let Some(thinking) = &block.thinking {
                content.push(serde_json::json!({"type":"thinking","thinking":thinking}));
            } else {
                content.push(serde_json::json!({"type":"text","text":block.text}));
            }
        }
        let header = serde_json::json!({"type":"session","id":"native-session","cwd":thread.cwd});
        let mut record = serde_json::json!({"type":"message","id":"native-entry","parentId":null,"timestamp":fixture[0].at,
            "message":{"role":"assistant","stopReason":"stop","content":content}});
        let write = |record: &serde_json::Value| std::fs::write(&record_path, format!("{header}\n{record}\n")).unwrap();
        let exact = record["message"]["content"].as_array().unwrap().last().unwrap()["text"].clone();
        record["message"]["content"].as_array_mut().unwrap().last_mut().unwrap()["text"] = serde_json::json!("Different text");
        write(&record);
        let params = methods::ThreadsRecoverOmpAnswerParams { thread_id: thread.id, turn_id };
        assert!(orchestrator.recover_omp_answer(params.clone()).await.is_err());
        assert_eq!(store.events_for_thread(thread.id).unwrap().len(), original.len());
        record["message"]["content"].as_array_mut().unwrap().last_mut().unwrap()["text"] = exact.clone();
        write(&record);
        let recovered = orchestrator.recover_omp_answer(params.clone()).await.unwrap();
        assert!(recovered.recovered);
        let repeated = orchestrator.recover_omp_answer(params).await.unwrap();
        assert!(!repeated.recovered);
        assert_eq!(repeated.correction_seq, recovered.correction_seq);
        assert_eq!(store.events_for_thread(thread.id).unwrap().len(), original.len() + 1);
        assert_eq!(
            serde_json::to_value(store.events_for_thread_through(thread.id, original.last().unwrap().seq).unwrap()).unwrap(),
            serde_json::to_value(original).unwrap()
        );
        let transcript = store.project_transcript_through(thread.id, recovered.correction_seq).unwrap();
        let terminal = transcript
            .iter()
            .find_map(|entry| match entry {
                TranscriptEntry::TurnSummary { terminal_message_id, .. } => *terminal_message_id,
                _ => None,
            })
            .unwrap();
        assert!(
            transcript.iter().any(
                |entry| matches!(entry, TranscriptEntry::Assistant { id, text, .. } if *id==terminal && serde_json::json!(text)==exact)
            )
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
