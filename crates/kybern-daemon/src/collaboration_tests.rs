use chrono::Utc;
use kybern_drivers::registry::DriverRegistry;
use kybern_protocol::methods::{CollaborationAssignmentsCancelParams, CollaborationAssignmentsCompleteParams};
use kybern_protocol::*;
use kybern_store::Store;
use uuid::Uuid;

use crate::config::Paths;
use crate::orchestrator::Orchestrator;
use crate::settings::SettingsStore;

struct Fixture {
    root: std::path::PathBuf,
    store: Store,
    orchestrator: Orchestrator,
    group: CollaborationGroup,
    coordinator: Thread,
    worker: Thread,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("kybern-collaboration-test-{}", Uuid::now_v7()));
        let paths = Paths::resolve(Some(root.clone())).unwrap();
        let settings = SettingsStore::load(&paths.settings).unwrap();
        let store = Store::open_in_memory().unwrap();
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: "collaboration fixture".into(),
            path: root.to_string_lossy().into_owned(),
            is_git: false,
            worktrees_default: None,
            created_at: now,
            updated_at: now,
        };
        store.project_insert(&project).unwrap();
        let thread = |title: &str, status| Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: title.into(),
            provider: ProviderInstance::default_for(ProviderKind::Codex),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status,
            worktree: None,
            cwd: project.path.clone(),
            provider_session_id: Some(format!("{title}-session")),
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            collaboration_group_id: None,
        };
        let coordinator = thread("Coordinator", ThreadStatus::Idle);
        let worker = thread("Worker", ThreadStatus::Idle);
        store.thread_upsert(&coordinator).unwrap();
        store.thread_upsert(&worker).unwrap();
        let group = CollaborationGroup {
            id: Uuid::now_v7(),
            project_id: project.id,
            coordinator_thread_id: coordinator.id,
            objective: "Ship a durable collaboration".into(),
            success_criteria: vec!["Lifecycle survives restart".into()],
            status: GroupStatus::Active,
            coordinator_mode: CoordinatorMode::Ordinary,
            policy: CollaborationPolicy::default(),
            revision: 1,
            created_at: now,
            updated_at: now,
        };
        store.collaboration_group_put(&group).unwrap();
        for (thread_id, role) in [(coordinator.id, GroupMemberRole::Coordinator), (worker.id, GroupMemberRole::Worker)] {
            store.collaboration_member_put(&GroupMember { group_id: group.id, thread_id, role, active: true, joined_at: now }).unwrap();
        }
        let (events, _) = crate::bounded_broadcast::channel(128, 1024 * 1024);
        let orchestrator = Orchestrator::new(store.clone(), DriverRegistry::default(), events, paths, settings);
        Self { root, store, orchestrator, group, coordinator, worker }
    }

    fn assignment(
        &self,
        parent_assignment_id: Option<AssignmentId>,
        owner_thread_id: Option<ThreadId>,
        status: AssignmentStatus,
    ) -> CollaborationAssignment {
        let now = Utc::now();
        CollaborationAssignment {
            id: Uuid::now_v7(),
            group_id: self.group.id,
            parent_assignment_id,
            owner_thread_id,
            requested_child: None,
            created_by_thread_id: Some(self.coordinator.id),
            title: "Fixture assignment".into(),
            instructions: "Exercise the lifecycle".into(),
            kind: AssignmentKind::Research,
            status,
            dispatch_message_id: None,
            base_revision: None,
            depth: u32::from(parent_assignment_id.is_some()),
            result: None,
            uncertainty: None,
            revision: 1,
            created_at: now,
            updated_at: now,
        }
    }

    fn put_assignment(&self, assignment: &CollaborationAssignment) {
        self.store.collaboration_assignment_put(assignment).unwrap();
    }

    async fn create_project_coordinator(&self, initial_goal: Option<&str>) -> ProjectCoordinator {
        self.orchestrator
            .project_coordinator_get_or_create(methods::CollaborationCoordinatorGetOrCreateParams {
                operation_id: Uuid::now_v7(),
                project_id: self.coordinator.project_id,
                provider: ProviderInstance::default_for(ProviderKind::Codex),
                model: Some("coordinator-model".into()),
                effort: Some("medium".into()),
                permission_mode: Some(PermissionMode::Supervised),
                coordinator_mode: Some(CoordinatorMode::Ordinary),
                initial_goal: initial_goal.map(str::to_owned),
            })
            .await
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn restart_marks_acknowledged_working_assignment_attention_needed() {
    let fixture = Fixture::new();
    let mut worker = fixture.worker.clone();
    worker.status = ThreadStatus::Running;
    fixture.store.thread_upsert(&worker).unwrap();
    let mut assignment = fixture.assignment(None, Some(worker.id), AssignmentStatus::Working);
    assignment.dispatch_message_id = Some(Uuid::now_v7());
    fixture.put_assignment(&assignment);

    fixture.orchestrator.recover_after_restart().await.unwrap();

    let recovered = fixture.store.collaboration_assignment_get(assignment.id).unwrap().unwrap();
    assert_eq!(recovered.status, AssignmentStatus::AttentionNeeded);
    assert!(recovered.uncertainty.as_deref().is_some_and(|text| text.contains("restarted")));
    assert_eq!(fixture.store.thread_get(worker.id).unwrap().unwrap().status, ThreadStatus::Failed);
}

#[tokio::test]
async fn cancelling_parent_cancels_active_descendants_but_not_siblings() {
    let fixture = Fixture::new();
    let parent = fixture.assignment(None, Some(fixture.worker.id), AssignmentStatus::Working);
    let child = fixture.assignment(Some(parent.id), None, AssignmentStatus::Pending);
    let grandchild = fixture.assignment(Some(child.id), None, AssignmentStatus::Blocked);
    let sibling = fixture.assignment(None, None, AssignmentStatus::Pending);
    for assignment in [&parent, &child, &grandchild, &sibling] {
        fixture.put_assignment(assignment);
    }

    fixture
        .orchestrator
        .collaboration_assignment_cancel(
            CollaborationAssignmentsCancelParams {
                operation_id: Uuid::now_v7(),
                assignment_id: parent.id,
                reason: Some("Parent scope cancelled".into()),
            },
            None,
            None,
        )
        .await
        .unwrap();

    for id in [parent.id, child.id, grandchild.id] {
        let cancelled = fixture.store.collaboration_assignment_get(id).unwrap().unwrap();
        assert_eq!(cancelled.status, AssignmentStatus::Cancelled);
        assert_eq!(cancelled.uncertainty.as_deref(), Some("Parent scope cancelled"));
    }
    assert_eq!(fixture.store.collaboration_assignment_get(sibling.id).unwrap().unwrap().status, AssignmentStatus::Pending);
}

#[tokio::test]
async fn cancellation_authority_allows_delegator_and_rejects_peers_and_observers() {
    let fixture = Fixture::new();
    let mut delegator = fixture.worker.clone();
    delegator.id = Uuid::now_v7();
    delegator.title = "Delegator".into();
    let mut peer = delegator.clone();
    peer.id = Uuid::now_v7();
    peer.title = "Peer".into();
    let mut observer = delegator.clone();
    observer.id = Uuid::now_v7();
    observer.title = "Observer".into();
    for thread in [&delegator, &peer, &observer] {
        fixture.store.thread_upsert(thread).unwrap();
    }
    for (thread_id, role) in
        [(delegator.id, GroupMemberRole::Worker), (peer.id, GroupMemberRole::Worker), (observer.id, GroupMemberRole::Observer)]
    {
        fixture
            .store
            .collaboration_member_put(&GroupMember { group_id: fixture.group.id, thread_id, role, active: true, joined_at: Utc::now() })
            .unwrap();
    }
    let mut assignment = fixture.assignment(None, Some(fixture.worker.id), AssignmentStatus::Working);
    assignment.created_by_thread_id = Some(delegator.id);
    fixture.put_assignment(&assignment);
    let cancel = |operation_id| CollaborationAssignmentsCancelParams {
        operation_id,
        assignment_id: assignment.id,
        reason: Some("delegated scope cancelled".into()),
    };

    for unauthorized in [peer.id, observer.id] {
        let error =
            fixture.orchestrator.collaboration_assignment_cancel(cancel(Uuid::now_v7()), Some(unauthorized), None).await.unwrap_err();
        assert!(error.to_string().contains("coordinator, assignment owner, or delegating parent"));
        assert_eq!(fixture.store.collaboration_assignment_get(assignment.id).unwrap().unwrap().status, AssignmentStatus::Working);
    }

    let cancelled = fixture.orchestrator.collaboration_assignment_cancel(cancel(Uuid::now_v7()), Some(delegator.id), None).await.unwrap();
    assert_eq!(cancelled.status, AssignmentStatus::Cancelled);
}

#[test]
fn parent_cannot_complete_while_a_child_is_active() {
    let fixture = Fixture::new();
    let parent = fixture.assignment(None, Some(fixture.worker.id), AssignmentStatus::Working);
    let child = fixture.assignment(Some(parent.id), None, AssignmentStatus::Pending);
    fixture.put_assignment(&parent);
    fixture.put_assignment(&child);

    let error = fixture
        .orchestrator
        .collaboration_assignment_complete(
            CollaborationAssignmentsCompleteParams {
                operation_id: Uuid::now_v7(),
                assignment_id: parent.id,
                result: AssignmentResult {
                    outcome: AssignmentOutcome::Success,
                    summary: "Parent finished".into(),
                    changes: Vec::new(),
                    checks: Vec::new(),
                    artifacts: Vec::new(),
                    unresolved: Vec::new(),
                    completed_at: Utc::now(),
                },
            },
            None,
        )
        .unwrap_err();

    assert!(error.to_string().contains("child assignments"));
    assert_eq!(fixture.store.collaboration_assignment_get(parent.id).unwrap().unwrap().status, AssignmentStatus::Working);
}

#[tokio::test]
async fn restart_requeues_result_when_only_prior_delivery_is_uncertain() {
    let fixture = Fixture::new();
    let mut assignment = fixture.assignment(None, Some(fixture.worker.id), AssignmentStatus::Completed);
    assignment.result = Some(AssignmentResult {
        outcome: AssignmentOutcome::Success,
        summary: "Recovered result".into(),
        changes: Vec::new(),
        checks: vec!["fixture".into()],
        artifacts: Vec::new(),
        unresolved: Vec::new(),
        completed_at: Utc::now(),
    });
    fixture.put_assignment(&assignment);
    let now = Utc::now();
    let uncertain = CollaborationMessage {
        id: Uuid::now_v7(),
        operation_id: Uuid::now_v7(),
        group_id: fixture.group.id,
        assignment_id: Some(assignment.id),
        from_thread_id: Some(fixture.worker.id),
        to_thread_id: fixture.coordinator.id,
        external_recipient: false,
        purpose: CollaborationMessagePurpose::Result,
        reply_to: None,
        body: "Original result notification".into(),
        state: CollaborationDeliveryState::Uncertain,
        delivery_turn_id: None,
        wakeup_count: 1,
        created_at: now,
        updated_at: now,
    };
    fixture.store.collaboration_message_put(&uncertain, Some(uncertain.id)).unwrap();

    fixture.orchestrator.recover_after_restart().await.unwrap();

    let messages = fixture.store.collaboration_messages(fixture.group.id).unwrap();
    assert_eq!(messages.iter().filter(|message| message.purpose == CollaborationMessagePurpose::Result).count(), 2);
    let replacement = messages.iter().find(|message| message.id != uncertain.id).expect("replacement result notification");
    assert_eq!(replacement.state, CollaborationDeliveryState::Queued);
    assert_eq!(replacement.assignment_id, Some(assignment.id));
    assert!(fixture.store.queue_is_pending(replacement.id).unwrap());
}

#[test]
fn external_threads_keep_membership_permissions_and_can_reply_across_projects() {
    let fixture = Fixture::new();
    let now = Utc::now();
    let other_project = Project {
        id: Uuid::now_v7(),
        name: "other project".into(),
        path: fixture.root.join("other").to_string_lossy().into_owned(),
        is_git: false,
        worktrees_default: None,
        created_at: now,
        updated_at: now,
    };
    fixture.store.project_insert(&other_project).unwrap();
    let mut recipient = fixture.worker.clone();
    recipient.id = Uuid::now_v7();
    recipient.project_id = other_project.id;
    recipient.permission_mode = PermissionMode::Supervised;
    recipient.cwd = other_project.path.clone();
    recipient.collaboration_group_id = None;
    fixture.store.thread_upsert(&recipient).unwrap();
    let other_group = CollaborationGroup {
        id: Uuid::now_v7(),
        project_id: other_project.id,
        coordinator_thread_id: recipient.id,
        objective: "Keep separate ownership".into(),
        success_criteria: Vec::new(),
        status: GroupStatus::Active,
        coordinator_mode: CoordinatorMode::Ordinary,
        policy: CollaborationPolicy::default(),
        revision: 1,
        created_at: now,
        updated_at: now,
    };
    fixture.store.collaboration_group_put(&other_group).unwrap();
    fixture
        .store
        .collaboration_member_put(&GroupMember {
            group_id: other_group.id,
            thread_id: recipient.id,
            role: GroupMemberRole::Coordinator,
            active: true,
            joined_at: now,
        })
        .unwrap();

    let question = fixture
        .orchestrator
        .collaboration_message_send(
            methods::CollaborationMessagesSendParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                assignment_id: None,
                from_thread_id: None,
                to_thread_id: recipient.id,
                purpose: CollaborationMessagePurpose::Question,
                reply_to: None,
                body: "What did the old thread learn?".into(),
            },
            Some(fixture.coordinator.id),
        )
        .unwrap();
    assert!(question.external_recipient);
    assert_eq!(question.state, CollaborationDeliveryState::Queued);
    assert_eq!(fixture.store.collaboration_group_for_thread(recipient.id).unwrap(), Some(other_group.id));
    let unchanged = fixture.store.thread_get(recipient.id).unwrap().unwrap();
    assert_eq!(unchanged.permission_mode, PermissionMode::Supervised);
    assert_eq!(unchanged.cwd, other_project.path);

    let reply = fixture
        .orchestrator
        .collaboration_message_send(
            methods::CollaborationMessagesSendParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                assignment_id: None,
                from_thread_id: None,
                to_thread_id: fixture.coordinator.id,
                purpose: CollaborationMessagePurpose::Reply,
                reply_to: Some(question.id),
                body: "The persisted answer".into(),
            },
            Some(recipient.id),
        )
        .unwrap();
    assert_eq!(reply.from_thread_id, Some(recipient.id));
    assert!(!reply.external_recipient);
    assert_eq!(fixture.store.collaboration_group_for_thread(recipient.id).unwrap(), Some(other_group.id));

    let mut limited = fixture.group.clone();
    limited.policy.max_wakeups_per_assignment = 2;
    fixture.store.collaboration_group_put(&limited).unwrap();
    let loop_denied = fixture.orchestrator.collaboration_message_send(
        methods::CollaborationMessagesSendParams {
            operation_id: Uuid::now_v7(),
            group_id: limited.id,
            assignment_id: None,
            from_thread_id: None,
            to_thread_id: recipient.id,
            purpose: CollaborationMessagePurpose::Question,
            reply_to: None,
            body: "loop again".into(),
        },
        Some(fixture.coordinator.id),
    );
    assert!(loop_denied.unwrap_err().to_string().contains("automatic wakeup limit"));

    fixture
        .store
        .event_append(
            fixture.coordinator.id,
            Some(Uuid::now_v7()),
            EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("Start a separate user task") },
        )
        .unwrap();
    let reset_question = fixture
        .orchestrator
        .collaboration_message_send(
            methods::CollaborationMessagesSendParams {
                operation_id: Uuid::now_v7(),
                group_id: limited.id,
                assignment_id: None,
                from_thread_id: None,
                to_thread_id: recipient.id,
                purpose: CollaborationMessagePurpose::Question,
                reply_to: None,
                body: "new user task question".into(),
            },
            Some(fixture.coordinator.id),
        )
        .unwrap();
    assert_eq!(reset_question.state, CollaborationDeliveryState::Queued);
    fixture.store.collaboration_group_put(&fixture.group).unwrap();

    let mut archived = recipient.clone();
    archived.id = Uuid::now_v7();
    archived.status = ThreadStatus::Archived;
    fixture.store.thread_upsert(&archived).unwrap();
    let archived_denied = fixture.orchestrator.collaboration_message_send(
        methods::CollaborationMessagesSendParams {
            operation_id: Uuid::now_v7(),
            group_id: fixture.group.id,
            assignment_id: None,
            from_thread_id: None,
            to_thread_id: archived.id,
            purpose: CollaborationMessagePurpose::Question,
            reply_to: None,
            body: "wake archived".into(),
        },
        Some(fixture.coordinator.id),
    );
    assert!(archived_denied.unwrap_err().to_string().contains("open or unarchive"));

    let mut privileged = recipient.clone();
    privileged.id = Uuid::now_v7();
    privileged.permission_mode = PermissionMode::FullAccess;
    fixture.store.thread_upsert(&privileged).unwrap();
    let denied = fixture.orchestrator.collaboration_message_send(
        methods::CollaborationMessagesSendParams {
            operation_id: Uuid::now_v7(),
            group_id: fixture.group.id,
            assignment_id: None,
            from_thread_id: None,
            to_thread_id: privileged.id,
            purpose: CollaborationMessagePurpose::Question,
            reply_to: None,
            body: "use broader authority".into(),
        },
        Some(fixture.coordinator.id),
    );
    assert!(denied.unwrap_err().to_string().contains("conservative subset"));

    let mut isolated = fixture.coordinator.clone();
    isolated.id = Uuid::now_v7();
    isolated.permission_mode = PermissionMode::FullAccess;
    isolated.worktree = Some(WorktreeInfo { path: fixture.root.join("isolated").to_string_lossy().into_owned(), branch: "test".into() });
    isolated.cwd = isolated.worktree.as_ref().unwrap().path.clone();
    fixture.store.thread_upsert(&isolated).unwrap();
    fixture
        .store
        .collaboration_member_put(&GroupMember {
            group_id: fixture.group.id,
            thread_id: isolated.id,
            role: GroupMemberRole::Worker,
            active: true,
            joined_at: now,
        })
        .unwrap();
    let isolated_denied = fixture.orchestrator.collaboration_message_send(
        methods::CollaborationMessagesSendParams {
            operation_id: Uuid::now_v7(),
            group_id: fixture.group.id,
            assignment_id: None,
            from_thread_id: None,
            to_thread_id: recipient.id,
            purpose: CollaborationMessagePurpose::Question,
            reply_to: None,
            body: "touch main checkout".into(),
        },
        Some(isolated.id),
    );
    assert!(isolated_denied.unwrap_err().to_string().contains("isolated worker"));

    let mut requester = fixture.coordinator.clone();
    requester.id = Uuid::now_v7();
    requester.permission_mode = PermissionMode::FullAccess;
    fixture.store.thread_upsert(&requester).unwrap();
    fixture
        .store
        .collaboration_member_put(&GroupMember {
            group_id: fixture.group.id,
            thread_id: requester.id,
            role: GroupMemberRole::Worker,
            active: true,
            joined_at: now,
        })
        .unwrap();
    let mut isolated_responder = recipient.clone();
    isolated_responder.id = Uuid::now_v7();
    isolated_responder.worktree =
        Some(WorktreeInfo { path: fixture.root.join("isolated-responder").to_string_lossy().into_owned(), branch: "response".into() });
    isolated_responder.cwd = isolated_responder.worktree.as_ref().unwrap().path.clone();
    fixture.store.thread_upsert(&isolated_responder).unwrap();
    let directed = fixture
        .orchestrator
        .collaboration_message_send(
            methods::CollaborationMessagesSendParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                assignment_id: None,
                from_thread_id: None,
                to_thread_id: isolated_responder.id,
                purpose: CollaborationMessagePurpose::Question,
                reply_to: None,
                body: "read and answer".into(),
            },
            Some(requester.id),
        )
        .unwrap();
    let directed_reply = fixture
        .orchestrator
        .collaboration_message_send(
            methods::CollaborationMessagesSendParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                assignment_id: None,
                from_thread_id: None,
                to_thread_id: requester.id,
                purpose: CollaborationMessagePurpose::Reply,
                reply_to: Some(directed.id),
                body: "information only".into(),
            },
            Some(isolated_responder.id),
        )
        .unwrap();
    assert_eq!(directed_reply.to_thread_id, requester.id);
    let unrelated_reverse = fixture.orchestrator.collaboration_message_send(
        methods::CollaborationMessagesSendParams {
            operation_id: Uuid::now_v7(),
            group_id: fixture.group.id,
            assignment_id: None,
            from_thread_id: None,
            to_thread_id: requester.id,
            purpose: CollaborationMessagePurpose::Question,
            reply_to: None,
            body: "unrelated reverse wake".into(),
        },
        Some(isolated_responder.id),
    );
    assert!(unrelated_reverse.is_err(), "the correlated reply must not grant independent reverse-wake authority");

    let mut recipient_paused = other_group.clone();
    recipient_paused.status = GroupStatus::Paused;
    fixture.store.collaboration_group_put(&recipient_paused).unwrap();
    let held = fixture
        .orchestrator
        .collaboration_message_send(
            methods::CollaborationMessagesSendParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                assignment_id: None,
                from_thread_id: None,
                to_thread_id: recipient.id,
                purpose: CollaborationMessagePurpose::Question,
                reply_to: None,
                body: "hold for recipient".into(),
            },
            Some(fixture.coordinator.id),
        )
        .unwrap();
    assert_eq!(held.state, CollaborationDeliveryState::Persisted);
    recipient_paused.status = GroupStatus::Stopped;
    fixture.store.collaboration_group_put(&recipient_paused).unwrap();
    let recipient_stopped = fixture.orchestrator.collaboration_message_send(
        methods::CollaborationMessagesSendParams {
            operation_id: Uuid::now_v7(),
            group_id: fixture.group.id,
            assignment_id: None,
            from_thread_id: None,
            to_thread_id: recipient.id,
            purpose: CollaborationMessagePurpose::Question,
            reply_to: None,
            body: "do not deliver".into(),
        },
        Some(fixture.coordinator.id),
    );
    assert!(recipient_stopped.unwrap_err().to_string().contains("recipient collaboration group"));
    recipient_paused.status = GroupStatus::Active;
    fixture.store.collaboration_group_put(&recipient_paused).unwrap();

    let mut paused = fixture.group.clone();
    paused.status = GroupStatus::Paused;
    fixture.store.collaboration_group_put(&paused).unwrap();
    let paused_message = fixture
        .orchestrator
        .collaboration_message_send(
            methods::CollaborationMessagesSendParams {
                operation_id: Uuid::now_v7(),
                group_id: paused.id,
                assignment_id: None,
                from_thread_id: None,
                to_thread_id: recipient.id,
                purpose: CollaborationMessagePurpose::Question,
                reply_to: None,
                body: "Persist while paused".into(),
            },
            Some(fixture.coordinator.id),
        )
        .unwrap();
    assert_eq!(paused_message.state, CollaborationDeliveryState::Persisted);
    paused.status = GroupStatus::Stopped;
    fixture.store.collaboration_group_put(&paused).unwrap();
    let stopped = fixture.orchestrator.collaboration_message_send(
        methods::CollaborationMessagesSendParams {
            operation_id: Uuid::now_v7(),
            group_id: paused.id,
            assignment_id: None,
            from_thread_id: None,
            to_thread_id: recipient.id,
            purpose: CollaborationMessagePurpose::Question,
            reply_to: None,
            body: "stop".into(),
        },
        Some(fixture.coordinator.id),
    );
    assert!(stopped.unwrap_err().to_string().contains("not accepting messages"));
}

#[tokio::test]
async fn ordinary_threads_get_one_lazy_group_without_manual_enablement() {
    let fixture = Fixture::new();
    let mut standalone = fixture.worker.clone();
    standalone.id = Uuid::now_v7();
    standalone.title = "Standalone chat".into();
    standalone.collaboration_group_id = None;
    fixture.store.thread_upsert(&standalone).unwrap();
    let (first, second) = tokio::join!(
        fixture.orchestrator.ensure_ordinary_collaboration_group(standalone.id),
        fixture.orchestrator.ensure_ordinary_collaboration_group(standalone.id),
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first, second);
    let group = fixture.store.collaboration_group_get(first).unwrap().unwrap();
    assert_eq!(group.coordinator_mode, CoordinatorMode::Ordinary);
    assert_eq!(group.coordinator_thread_id, standalone.id);
    assert_eq!(fixture.store.thread_get(standalone.id).unwrap().unwrap().collaboration_group_id, Some(first));
}

#[tokio::test]
async fn project_coordinator_is_retry_safe_and_reports_actual_mode() {
    let fixture = Fixture::new();
    let operation_id = Uuid::now_v7();
    let params = methods::CollaborationCoordinatorGetOrCreateParams {
        operation_id,
        project_id: fixture.coordinator.project_id,
        provider: ProviderInstance::default_for(ProviderKind::Codex),
        model: None,
        effort: None,
        permission_mode: Some(PermissionMode::Supervised),
        coordinator_mode: None,
        initial_goal: None,
    };
    let first = fixture.orchestrator.project_coordinator_get_or_create(params.clone()).await.unwrap();
    assert!(first.created);
    assert_eq!(first.group.coordinator_mode, CoordinatorMode::Ordinary);
    assert_eq!(first.thread.coordinator_project_id, Some(fixture.coordinator.project_id));
    let retry = fixture.orchestrator.project_coordinator_get_or_create(params).await.unwrap();
    assert_eq!(retry.thread.id, first.thread.id);
    assert_eq!(retry.group.id, first.group.id);
    let discovered = fixture.orchestrator.project_coordinator_get(fixture.coordinator.project_id).unwrap().unwrap();
    assert!(!discovered.created);
    assert_eq!(discovered.thread.id, first.thread.id);
    let complete = fixture
        .orchestrator
        .collaboration_group_control(methods::CollaborationGroupsControlParams {
            operation_id: Uuid::now_v7(),
            group_id: first.group.id,
            action: methods::CollaborationGroupControlAction::Complete,
        })
        .await;
    assert!(complete.unwrap_err().to_string().contains("pause it instead"));

    let mut legacy_completed = first.group.clone();
    legacy_completed.status = GroupStatus::Completed;
    fixture.store.collaboration_group_put(&legacy_completed).unwrap();
    let reopened = fixture
        .orchestrator
        .project_coordinator_get_or_create(methods::CollaborationCoordinatorGetOrCreateParams {
            operation_id: Uuid::now_v7(),
            project_id: fixture.coordinator.project_id,
            provider: ProviderInstance::default_for(ProviderKind::Codex),
            model: None,
            effort: None,
            permission_mode: None,
            coordinator_mode: None,
            initial_goal: None,
        })
        .await
        .unwrap();
    assert_eq!(reopened.thread.id, first.thread.id);
    assert_eq!(reopened.group.id, first.group.id);
    assert_eq!(reopened.group.status, GroupStatus::Active);

    let unsupported = fixture
        .orchestrator
        .project_coordinator_get_or_create(methods::CollaborationCoordinatorGetOrCreateParams {
            operation_id: Uuid::now_v7(),
            project_id: fixture.coordinator.project_id,
            provider: ProviderInstance::default_for(ProviderKind::Cursor),
            model: None,
            effort: None,
            permission_mode: None,
            coordinator_mode: Some(CoordinatorMode::Dedicated),
            initial_goal: None,
        })
        .await
        .unwrap();
    assert_eq!(unsupported.thread.id, first.thread.id, "an existing coordinator wins without creating a duplicate");
}

#[tokio::test]
async fn partial_coordinator_reservation_reconciles_exact_ids_and_rejects_changed_retry() {
    let fixture = Fixture::new();
    let mut project = fixture.store.project_get(fixture.coordinator.project_id).unwrap().unwrap();
    project.id = Uuid::now_v7();
    project.name = "reserved project".into();
    project.path = fixture.root.join("reserved").to_string_lossy().into_owned();
    fixture.store.project_insert(&project).unwrap();
    let params = methods::CollaborationCoordinatorGetOrCreateParams {
        operation_id: Uuid::now_v7(),
        project_id: project.id,
        provider: ProviderInstance::default_for(ProviderKind::Codex),
        model: None,
        effort: None,
        permission_mode: Some(PermissionMode::Supervised),
        coordinator_mode: None,
        initial_goal: None,
    };
    let reserved = fixture.store.project_coordinator_reserve(project.id, params.operation_id, &params).unwrap();
    let mut changed = params.clone();
    changed.operation_id = Uuid::now_v7();
    changed.model = Some("different".into());
    let error = fixture.orchestrator.project_coordinator_get_or_create(changed).await.unwrap_err();
    assert!(error.to_string().contains("reserved by a different request"));

    let created = fixture.orchestrator.project_coordinator_get_or_create(params).await.unwrap();
    assert_eq!(created.thread.id, reserved.0);
    assert_eq!(created.group.id, reserved.1);
    assert_eq!(fixture.store.project_coordinator(project.id).unwrap(), Some(reserved));
}

#[tokio::test]
async fn restart_marks_busy_external_delivery_uncertain_instead_of_stranding_queue() {
    let fixture = Fixture::new();
    let mut recipient = fixture.worker.clone();
    recipient.id = Uuid::now_v7();
    recipient.status = ThreadStatus::Running;
    recipient.provider_session_id = Some("busy-external".into());
    fixture.store.thread_upsert(&recipient).unwrap();
    let message = fixture
        .orchestrator
        .collaboration_message_send(
            methods::CollaborationMessagesSendParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                assignment_id: None,
                from_thread_id: None,
                to_thread_id: recipient.id,
                purpose: CollaborationMessagePurpose::Question,
                reply_to: None,
                body: "queued while busy".into(),
            },
            Some(fixture.coordinator.id),
        )
        .unwrap();
    assert_eq!(message.state, CollaborationDeliveryState::Queued);
    assert!(fixture.store.queue_is_pending(message.id).unwrap());
    fixture.orchestrator.recover_after_restart().await.unwrap();
    assert_eq!(fixture.store.collaboration_message_get(message.id).unwrap().unwrap().state, CollaborationDeliveryState::Uncertain);
    assert!(!fixture.store.queue_is_pending(message.id).unwrap());
}

#[tokio::test]
async fn project_coordinator_initial_goal_is_authoritative_without_starting_a_turn() {
    let fixture = Fixture::new();
    let coordinator = fixture.create_project_coordinator(Some("Ship the routing coordinator safely")).await;

    assert_eq!(coordinator.group.objective, "Ship the routing coordinator safely");
    let brief = fixture.store.collaboration_context_by_key(coordinator.group.id, "project.brief").unwrap().unwrap();
    assert_eq!(brief.kind, ContextEntryKind::Brief);
    assert!(brief.user_authored);
    assert_eq!(brief.author_thread_id, None);
    assert_eq!(brief.body, coordinator.group.objective);
    assert!(
        fixture
            .store
            .events_for_thread(coordinator.thread.id)
            .unwrap()
            .iter()
            .all(|event| !matches!(event.payload, EventPayload::TurnStarted { .. }))
    );
}

#[tokio::test]
async fn coordinator_harness_switch_preserves_identity_history_workers_and_knowledge() {
    let fixture = Fixture::new();
    let coordinator = fixture.create_project_coordinator(Some("Preserve project continuity")).await;
    let history_turn = Uuid::now_v7();
    let history_message = Uuid::now_v7();
    fixture
        .store
        .event_append(
            coordinator.thread.id,
            Some(history_turn),
            EventPayload::TurnStarted { message_id: history_message, message: UserMessage::text("existing coordinator history") },
        )
        .unwrap();
    let before_members = fixture.store.collaboration_members(coordinator.group.id).unwrap();
    let operation_id = Uuid::now_v7();
    let params = methods::CollaborationCoordinatorSwitchHarnessParams {
        operation_id,
        project_id: coordinator.group.project_id,
        provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
        model: Some("switched-model".into()),
        effort: Some("high".into()),
        permission_mode: Some(PermissionMode::Supervised),
    };

    let switched = fixture.orchestrator.project_coordinator_switch_harness(params.clone()).await.unwrap();
    assert_eq!(switched.thread.id, coordinator.thread.id);
    assert_eq!(switched.group.id, coordinator.group.id);
    assert_eq!(switched.thread.provider.kind, ProviderKind::ClaudeCode);
    assert_eq!(fixture.store.thread_get(switched.thread.id).unwrap().unwrap().provider.kind, ProviderKind::ClaudeCode);
    assert_eq!(switched.group.coordinator_mode, CoordinatorMode::Dedicated);
    assert_eq!(switched.thread.model.as_deref(), Some("switched-model"));
    assert_eq!(switched.thread.provider_session_id, None);
    assert_eq!(fixture.store.collaboration_members(switched.group.id).unwrap(), before_members);
    assert!(fixture.store.turn_started_receipt(history_message).unwrap().is_some());
    assert!(fixture.store.collaboration_context_by_key(switched.group.id, "project.brief").unwrap().is_some());
    let retry = fixture.orchestrator.project_coordinator_switch_harness(params).await.unwrap();
    assert_eq!(retry.thread.id, switched.thread.id);
    assert_eq!(retry.thread.provider, switched.thread.provider);
    assert_eq!(retry.thread.model, switched.thread.model);
    assert_eq!(retry.thread.last_seq, switched.thread.last_seq);
    let same_provider = fixture
        .orchestrator
        .project_coordinator_switch_harness(methods::CollaborationCoordinatorSwitchHarnessParams {
            operation_id: Uuid::now_v7(),
            project_id: switched.group.project_id,
            provider: switched.thread.provider.clone(),
            model: Some("same-provider-new-model".into()),
            effort: switched.thread.effort.clone(),
            permission_mode: Some(switched.thread.permission_mode),
        })
        .await
        .unwrap();
    assert_eq!(same_provider.thread.id, switched.thread.id);
    assert_eq!(same_provider.thread.model.as_deref(), Some("same-provider-new-model"));
    assert_eq!(same_provider.thread.provider_session_id, None);
    let back_to_advisory = fixture
        .orchestrator
        .project_coordinator_switch_harness(methods::CollaborationCoordinatorSwitchHarnessParams {
            operation_id: Uuid::now_v7(),
            project_id: switched.group.project_id,
            provider: ProviderInstance::default_for(ProviderKind::Codex),
            model: Some("codex-coordinator".into()),
            effort: Some("medium".into()),
            permission_mode: Some(PermissionMode::Supervised),
        })
        .await
        .unwrap();
    assert_eq!(back_to_advisory.thread.id, switched.thread.id);
    assert_eq!(back_to_advisory.group.id, switched.group.id);
    assert_eq!(back_to_advisory.group.coordinator_mode, CoordinatorMode::Ordinary);
    let persisted = fixture.store.thread_get(back_to_advisory.thread.id).unwrap().unwrap();
    assert_eq!(persisted.provider, ProviderInstance::default_for(ProviderKind::Codex));
    assert_eq!(persisted.model.as_deref(), Some("codex-coordinator"));
    fixture
        .orchestrator
        .send_client_message(methods::ThreadsSendParams {
            thread_id: persisted.id,
            message: UserMessage::text("continue after the harness switch"),
            message_id: Some(Uuid::now_v7()),
        })
        .await
        .unwrap();
    assert_eq!(fixture.store.thread_get(persisted.id).unwrap().unwrap().provider.kind, ProviderKind::Codex);
    let changed = methods::CollaborationCoordinatorSwitchHarnessParams {
        operation_id,
        model: Some("different-model".into()),
        project_id: switched.group.project_id,
        provider: switched.thread.provider.clone(),
        effort: switched.thread.effort.clone(),
        permission_mode: Some(switched.thread.permission_mode),
    };
    assert!(fixture.orchestrator.project_coordinator_switch_harness(changed).await.unwrap_err().to_string().contains("operation id"));
}

#[tokio::test]
async fn busy_project_coordinator_rejects_harness_switch_without_mutation() {
    let fixture = Fixture::new();
    let coordinator = fixture.create_project_coordinator(None).await;
    let mut busy = coordinator.thread.clone();
    busy.status = ThreadStatus::Running;
    fixture.store.thread_upsert(&busy).unwrap();
    let error = fixture
        .orchestrator
        .project_coordinator_switch_harness(methods::CollaborationCoordinatorSwitchHarnessParams {
            operation_id: Uuid::now_v7(),
            project_id: coordinator.group.project_id,
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: None,
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("must be idle"));
    assert_eq!(fixture.store.thread_get(busy.id).unwrap().unwrap().provider, busy.provider);

    busy.status = ThreadStatus::Failed;
    fixture.store.thread_upsert(&busy).unwrap();
    let recovered = fixture
        .orchestrator
        .project_coordinator_switch_harness(methods::CollaborationCoordinatorSwitchHarnessParams {
            operation_id: Uuid::now_v7(),
            project_id: coordinator.group.project_id,
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: None,
        })
        .await
        .unwrap();
    assert_eq!(recovered.thread.status, ThreadStatus::Idle);
}

#[tokio::test]
async fn project_knowledge_crosses_ordinary_groups_and_user_correction_wins() {
    let fixture = Fixture::new();
    let legacy = fixture
        .orchestrator
        .collaboration_context_put(
            methods::CollaborationContextPutParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                entry_id: None,
                key: "legacy.note".into(),
                kind: ContextEntryKind::Decision,
                body: "Saved before the project coordinator existed".into(),
                author_thread_id: None,
                user_authored: true,
                expected_revision: None,
                source_refs: vec!["user:earlier-task".into()],
            },
            None,
        )
        .unwrap();
    let coordinator = fixture.create_project_coordinator(Some("Keep durable project knowledge")).await;
    let before_authored = fixture.store.events_head_seq().unwrap();
    let authored = fixture
        .orchestrator
        .collaboration_context_put(
            methods::CollaborationContextPutParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                entry_id: None,
                key: "tests.command".into(),
                kind: ContextEntryKind::Research,
                body: "cargo test -p kybern-daemon".into(),
                author_thread_id: Some(fixture.worker.id),
                user_authored: false,
                expected_revision: None,
                source_refs: vec![format!("thread:{}", fixture.worker.id)],
            },
            Some(fixture.worker.id),
        )
        .unwrap();
    assert_eq!(authored.group_id, coordinator.group.id);
    let visible = fixture
        .orchestrator
        .collaboration_context_list(methods::CollaborationContextListParams {
            group_id: fixture.group.id,
            keys: vec!["tests.command".into()],
            kinds: Vec::new(),
            cursor: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(visible.entries, vec![authored.clone()]);
    let legacy_visible = fixture
        .orchestrator
        .collaboration_context_list(methods::CollaborationContextListParams {
            group_id: fixture.group.id,
            keys: vec![legacy.key.clone()],
            kinds: Vec::new(),
            cursor: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(legacy_visible.entries, vec![legacy]);
    let change = fixture
        .orchestrator
        .collaboration_wait(methods::CollaborationWaitParams {
            group_id: fixture.group.id,
            assignment_ids: Vec::new(),
            cursor: Some(format!("{}:{before_authored}", fixture.group.id)),
            timeout_ms: 1,
        })
        .await
        .unwrap();
    assert!(change.context_entries.iter().any(|entry| entry.id == authored.id));

    let corrected = fixture
        .orchestrator
        .collaboration_context_put(
            methods::CollaborationContextPutParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                entry_id: Some(authored.id),
                key: authored.key.clone(),
                kind: ContextEntryKind::Instruction,
                body: "Use cargo test -p kybern-daemon --lib".into(),
                author_thread_id: None,
                user_authored: true,
                expected_revision: Some(authored.revision),
                source_refs: vec!["user:correction".into()],
            },
            None,
        )
        .unwrap();
    assert!(corrected.user_authored);
    let overwrite = fixture.orchestrator.collaboration_context_put(
        methods::CollaborationContextPutParams {
            operation_id: Uuid::now_v7(),
            group_id: fixture.group.id,
            entry_id: Some(corrected.id),
            key: corrected.key.clone(),
            kind: ContextEntryKind::Research,
            body: "old command".into(),
            author_thread_id: Some(fixture.worker.id),
            user_authored: false,
            expected_revision: Some(corrected.revision),
            source_refs: Vec::new(),
        },
        Some(fixture.worker.id),
    );
    assert!(overwrite.unwrap_err().to_string().contains("cannot overwrite user-authored"));
}

#[test]
fn completed_worker_result_is_saved_as_attributed_project_knowledge() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let fixture = Fixture::new();
    let coordinator = runtime.block_on(fixture.create_project_coordinator(None));
    let assignment = fixture.assignment(None, Some(fixture.worker.id), AssignmentStatus::Working);
    fixture.put_assignment(&assignment);
    fixture
        .orchestrator
        .collaboration_assignment_complete(
            CollaborationAssignmentsCompleteParams {
                operation_id: Uuid::now_v7(),
                assignment_id: assignment.id,
                result: AssignmentResult {
                    outcome: AssignmentOutcome::Success,
                    summary: "Found the canonical test command".into(),
                    changes: Vec::new(),
                    checks: vec!["cargo test -p kybern-daemon --lib".into()],
                    artifacts: Vec::new(),
                    unresolved: Vec::new(),
                    completed_at: Utc::now(),
                },
            },
            Some(fixture.worker.id),
        )
        .unwrap();
    let entry =
        fixture.store.collaboration_context_by_key(coordinator.group.id, &format!("assignment.result.{}", assignment.id)).unwrap().unwrap();
    assert_eq!(entry.author_thread_id, Some(fixture.worker.id));
    assert!(!entry.user_authored);
    assert!(entry.source_refs.contains(&format!("assignment:{}", assignment.id)));
}

#[tokio::test]
async fn recursive_delegation_infers_owned_parent_and_enforces_worktree_policy() {
    let fixture = Fixture::new();
    let parent = fixture.assignment(None, Some(fixture.worker.id), AssignmentStatus::Working);
    fixture.put_assignment(&parent);
    let child = fixture
        .orchestrator
        .collaboration_assignment_create(
            methods::CollaborationAssignmentsCreateParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                parent_assignment_id: None,
                owner_thread_id: Some(fixture.coordinator.id),
                child: None,
                title: "Review recursively".into(),
                instructions: "Inspect the parent result".into(),
                kind: AssignmentKind::Research,
            },
            Some(fixture.worker.id),
            None,
        )
        .await
        .unwrap();
    assert_eq!(child.parent_assignment_id, Some(parent.id));
    assert_eq!(child.depth, 1);

    let mut editor = fixture.worker.clone();
    editor.id = Uuid::now_v7();
    editor.title = "Main-checkout editor".into();
    fixture.store.thread_upsert(&editor).unwrap();
    fixture
        .store
        .collaboration_member_put(&GroupMember {
            group_id: fixture.group.id,
            thread_id: editor.id,
            role: GroupMemberRole::Worker,
            active: true,
            joined_at: Utc::now(),
        })
        .unwrap();
    let edit_error = fixture
        .orchestrator
        .collaboration_assignment_create(
            methods::CollaborationAssignmentsCreateParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                parent_assignment_id: None,
                owner_thread_id: Some(editor.id),
                child: None,
                title: "Edit without isolation".into(),
                instructions: "Change files".into(),
                kind: AssignmentKind::Edit,
            },
            None,
            None,
        )
        .await
        .unwrap_err();
    assert!(edit_error.to_string().contains("isolated worktree"));
}

#[tokio::test]
async fn non_git_project_can_spawn_read_only_worker() {
    let fixture = Fixture::new();
    let assignment = fixture
        .orchestrator
        .collaboration_assignment_create(
            methods::CollaborationAssignmentsCreateParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                parent_assignment_id: None,
                owner_thread_id: None,
                child: Some(CollaborationChildSpec {
                    provider: ProviderInstance::default_for(ProviderKind::Codex),
                    model: None,
                    effort: None,
                    permission_mode: Some(PermissionMode::Supervised),
                    base_revision: None,
                }),
                title: "Read non-Git project".into(),
                instructions: "Research without editing".into(),
                kind: AssignmentKind::Research,
            },
            None,
            None,
        )
        .await
        .unwrap();
    fixture.orchestrator.drain_collaboration_assignments().await.unwrap();
    let started = fixture.store.collaboration_assignment_get(assignment.id).unwrap().unwrap();
    let owner = fixture.store.thread_get(started.owner_thread_id.unwrap()).unwrap().unwrap();
    assert!(owner.worktree.is_none());
    assert_eq!(owner.cwd, fixture.coordinator.cwd);
}

#[tokio::test]
async fn child_model_must_not_be_encoded_as_a_provider_instance() {
    let fixture = Fixture::new();
    let error = fixture
        .orchestrator
        .collaboration_assignment_create(
            methods::CollaborationAssignmentsCreateParams {
                operation_id: Uuid::now_v7(),
                group_id: fixture.group.id,
                parent_assignment_id: None,
                owner_thread_id: None,
                child: Some(CollaborationChildSpec {
                    provider: ProviderInstance { kind: ProviderKind::Codex, instance: "gpt-5.6-luna".into() },
                    model: None,
                    effort: None,
                    permission_mode: Some(PermissionMode::Supervised),
                    base_revision: None,
                }),
                title: "Inspect the README".into(),
                instructions: "Find the test command".into(),
                kind: AssignmentKind::Research,
            },
            None,
            None,
        )
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(message.contains("Unknown codex provider instance 'gpt-5.6-luna'"));
    assert!(message.contains("Put the model selector in child.model"));
}

#[tokio::test]
async fn client_message_id_replays_same_turn_and_rejects_changed_content() {
    let fixture = Fixture::new();
    let message_id = Uuid::now_v7();
    let params = methods::ThreadsSendParams {
        thread_id: fixture.coordinator.id,
        message: UserMessage::text("stable first coordinator message"),
        message_id: Some(message_id),
    };
    let first = fixture.orchestrator.send_client_message(params.clone()).await.unwrap();
    let retry = fixture.orchestrator.send_client_message(params.clone()).await.unwrap();
    assert_eq!(retry.turn_id, first.turn_id);
    assert_eq!(retry.message_id, message_id);
    let changed = methods::ThreadsSendParams { message: UserMessage::text("changed"), ..params };
    assert!(fixture.orchestrator.send_client_message(changed).await.unwrap_err().to_string().contains("message_id"));
    let starts = fixture
        .store
        .events_for_thread(fixture.coordinator.id)
        .unwrap()
        .into_iter()
        .filter(|event| matches!(event.payload, EventPayload::TurnStarted { message_id: id, .. } if id == message_id))
        .count();
    assert_eq!(starts, 1);
}

#[tokio::test]
async fn coordinator_setup_requires_reviewed_research_before_editing_and_survives_restart() {
    let fixture = Fixture::new();
    let coordinator = fixture.create_project_coordinator(Some("Implement the requested feature")).await;
    assert_eq!(fixture.orchestrator.collaboration_group_detail(coordinator.group.id).unwrap().coordinator_setup_complete, Some(false));
    let editing = methods::CollaborationAssignmentsCreateParams {
        operation_id: Uuid::now_v7(),
        group_id: coordinator.group.id,
        parent_assignment_id: None,
        owner_thread_id: Some(coordinator.thread.id),
        child: None,
        title: "Implement".into(),
        instructions: "Implement feature".into(),
        kind: AssignmentKind::Edit,
    };
    let error = fixture.orchestrator.collaboration_assignment_create(editing, None, None).await.unwrap_err();
    assert!(error.to_string().contains("Set up the coordinator first"));
    let mut setup = methods::CollaborationContextPutParams {
        operation_id: Uuid::now_v7(),
        group_id: coordinator.group.id,
        entry_id: None,
        key: "project.setup".into(),
        kind: ContextEntryKind::Research,
        body: "Architecture: empty project. Commands: no test runner yet. Constraints: preserve the user's brief.".into(),
        expected_revision: None,
        author_thread_id: None,
        user_authored: false,
        source_refs: vec![],
    };
    assert!(
        fixture
            .orchestrator
            .collaboration_context_put(setup.clone(), Some(coordinator.thread.id))
            .unwrap_err()
            .to_string()
            .contains("successful research")
    );
    assert!(fixture.orchestrator.collaboration_context_put(setup.clone(), None).is_err(), "a client cannot manufacture setup completion");
    let mut researcher = fixture.worker.clone();
    researcher.id = Uuid::now_v7();
    fixture.store.thread_upsert(&researcher).unwrap();
    fixture
        .store
        .collaboration_member_put(&GroupMember {
            group_id: coordinator.group.id,
            thread_id: researcher.id,
            role: GroupMemberRole::Worker,
            active: true,
            joined_at: Utc::now(),
        })
        .unwrap();
    let mut research = fixture.assignment(None, Some(researcher.id), AssignmentStatus::Completed);
    research.group_id = coordinator.group.id;
    research.result = Some(AssignmentResult {
        outcome: AssignmentOutcome::Failed,
        summary: "Could not inspect".into(),
        changes: vec![],
        checks: vec![],
        artifacts: vec![],
        unresolved: vec![],
        completed_at: Utc::now(),
    });
    fixture.put_assignment(&research);
    setup.source_refs = vec![research.id.to_string()];
    assert!(fixture.orchestrator.collaboration_context_put(setup.clone(), Some(coordinator.thread.id)).is_err());
    research.result.as_mut().unwrap().outcome = AssignmentOutcome::Success;
    research.result.as_mut().unwrap().summary = "Inspected repository and recorded missing tooling".into();
    fixture.put_assignment(&research);
    let overview = fixture.orchestrator.collaboration_context_put(setup.clone(), Some(coordinator.thread.id)).unwrap();
    let retry = fixture.orchestrator.collaboration_context_put(setup, Some(coordinator.thread.id)).unwrap();
    assert_eq!(overview.id, retry.id);
    let corrected = fixture
        .orchestrator
        .collaboration_context_put(
            methods::CollaborationContextPutParams {
                operation_id: Uuid::now_v7(),
                group_id: coordinator.group.id,
                entry_id: Some(overview.id),
                key: "project.setup".into(),
                kind: ContextEntryKind::Research,
                body: "Corrected test command: cargo test".into(),
                expected_revision: Some(overview.revision),
                author_thread_id: None,
                user_authored: true,
                source_refs: vec![],
            },
            None,
        )
        .unwrap();
    assert!(corrected.user_authored);
    assert_eq!(corrected.source_refs, overview.source_refs);
    assert_eq!(fixture.store.collaboration_context_history(overview.id).unwrap().len(), 2);
    fixture.orchestrator.recover_after_restart().await.unwrap();
    assert_eq!(fixture.orchestrator.collaboration_group_detail(coordinator.group.id).unwrap().coordinator_setup_complete, Some(true));
    assert_eq!(
        fixture.store.collaboration_context_by_key(coordinator.group.id, "project.brief").unwrap().unwrap().body,
        "Implement the requested feature"
    );
    let mut policy = coordinator.group.policy.clone();
    policy.require_worktree_for_editing = false;
    fixture
        .orchestrator
        .collaboration_group_update(methods::CollaborationGroupsUpdateParams {
            operation_id: Uuid::now_v7(),
            group_id: coordinator.group.id,
            expected_revision: coordinator.group.revision,
            objective: None,
            success_criteria: None,
            coordinator_thread_id: None,
            coordinator_mode: None,
            policy: Some(policy),
        })
        .unwrap();
    let accepted = fixture
        .orchestrator
        .collaboration_assignment_create(
            methods::CollaborationAssignmentsCreateParams {
                operation_id: Uuid::now_v7(),
                group_id: coordinator.group.id,
                parent_assignment_id: None,
                owner_thread_id: Some(coordinator.thread.id),
                child: None,
                title: "Implement".into(),
                instructions: "Implement feature".into(),
                kind: AssignmentKind::Edit,
            },
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(accepted.kind, AssignmentKind::Edit);
}

#[tokio::test]
async fn coordinator_deletion_retains_history_and_allows_fresh_creation_without_stale_retries() {
    let fixture = Fixture::new();
    let create = methods::CollaborationCoordinatorGetOrCreateParams {
        operation_id: Uuid::now_v7(),
        project_id: fixture.coordinator.project_id,
        provider: ProviderInstance::default_for(ProviderKind::Codex),
        model: None,
        effort: None,
        permission_mode: None,
        coordinator_mode: None,
        initial_goal: Some("Original brief".into()),
    };
    let original = fixture.orchestrator.project_coordinator_get_or_create(create.clone()).await.unwrap();
    assert!(fixture.orchestrator.archive_thread(original.thread.id).await.is_err());
    let delete = methods::CollaborationCoordinatorDeleteParams {
        operation_id: Uuid::now_v7(),
        project_id: original.thread.project_id,
        thread_id: original.thread.id,
    };
    let archived = fixture.orchestrator.project_coordinator_delete(delete.clone()).await.unwrap();
    assert_eq!(archived.status, ThreadStatus::Archived);
    assert_eq!(archived.coordinator_project_id, None);
    assert!(fixture.orchestrator.project_coordinator_get(original.thread.project_id).unwrap().is_none());
    assert!(fixture.store.collaboration_members(original.group.id).unwrap().iter().all(|member| !member.active));
    assert_eq!(fixture.store.collaboration_context_by_key(original.group.id, "project.brief").unwrap().unwrap().body, "Original brief");
    assert!(
        fixture
            .store
            .events_for_thread(original.thread.id)
            .unwrap()
            .iter()
            .any(|event| matches!(event.payload, EventPayload::ProjectCoordinatorDeleted { .. }))
    );
    fixture.orchestrator.recover_after_restart().await.unwrap();
    let fresh = fixture.create_project_coordinator(Some("Fresh brief")).await;
    assert_ne!(fresh.thread.id, original.thread.id);
    assert_ne!(fresh.group.id, original.group.id);
    assert_eq!(fixture.orchestrator.collaboration_group_detail(fresh.group.id).unwrap().coordinator_setup_complete, Some(false));
    let retry = fixture.orchestrator.project_coordinator_delete(delete.clone()).await.unwrap();
    assert_eq!(retry.id, original.thread.id);
    assert_eq!(fixture.orchestrator.project_coordinator_get(fresh.thread.project_id).unwrap().unwrap().thread.id, fresh.thread.id);
    let mut stale = delete;
    stale.operation_id = Uuid::now_v7();
    assert!(fixture.orchestrator.project_coordinator_delete(stale).await.unwrap_err().to_string().contains("coordinator changed"));
    assert!(fixture.orchestrator.project_coordinator_get_or_create(create).await.unwrap_err().to_string().contains("deleted"));
    let old_knowledge = fixture
        .orchestrator
        .collaboration_context_list(methods::CollaborationContextListParams {
            group_id: original.group.id,
            cursor: None,
            limit: 100,
            keys: vec![],
            kinds: vec![],
        })
        .unwrap();
    assert!(old_knowledge.entries.iter().any(|entry| entry.body == "Original brief"));
    assert!(!old_knowledge.entries.iter().any(|entry| entry.body == "Fresh brief"));
}

#[tokio::test]
async fn coordinator_deletion_rejects_active_and_queued_work() {
    let fixture = Fixture::new();
    let coordinator = fixture.create_project_coordinator(None).await;
    let delete = methods::CollaborationCoordinatorDeleteParams {
        operation_id: Uuid::now_v7(),
        project_id: coordinator.thread.project_id,
        thread_id: coordinator.thread.id,
    };
    let mut busy = coordinator.thread.clone();
    busy.status = ThreadStatus::Running;
    fixture.store.thread_upsert(&busy).unwrap();
    assert!(fixture.orchestrator.project_coordinator_delete(delete.clone()).await.is_err());
    busy.status = ThreadStatus::Idle;
    fixture.store.thread_upsert(&busy).unwrap();
    let assignment =
        CollaborationAssignment { group_id: coordinator.group.id, ..fixture.assignment(None, None, AssignmentStatus::Pending) };
    fixture.put_assignment(&assignment);
    assert!(
        fixture.orchestrator.project_coordinator_delete(delete.clone()).await.unwrap_err().to_string().contains("unfinished assignments")
    );
    fixture.put_assignment(&CollaborationAssignment { status: AssignmentStatus::Cancelled, ..assignment });
    let queued = methods::QueuedMessage { id: Uuid::now_v7(), thread_id: busy.id, message: UserMessage::text("Do more work") };
    fixture.orchestrator.enqueue(queued.clone()).unwrap();
    assert!(fixture.orchestrator.project_coordinator_delete(delete).await.unwrap_err().to_string().contains("queued messages"));
    assert!(fixture.orchestrator.project_coordinator_get(coordinator.thread.project_id).unwrap().is_some());
}
