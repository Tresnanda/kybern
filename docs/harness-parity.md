# Runtime activity and harness parity

Kybern treats work launched by the main thread agent as runtime activity. This
includes subagents, background shell commands, and long-running monitors. The
daemon owns the lifecycle; clients render durable state and send supported
control intents.

## Product contract

Runtime activity has three levels of visibility:

1. A quiet thread cue in the sidebar shows that work continues after the main
   response settles.
2. A compact strip above the composer summarizes active agents and background
   work.
3. The Activity dock shows active and recent items, hierarchy, elapsed time,
   usage or process metrics, and provider-supported controls.

The transcript records one stable launch row in the originating turn. Streaming
progress belongs in Activity so repeated updates do not flood the conversation.
Approvals remain higher priority than activity cues.

Controls are capability-gated. A driver must never advertise `stop` or
`background` unless it can target that exact provider task. Interrupting the
whole parent turn is not an acceptable implementation of a targeted control.

## Daemon model

Drivers emit `RuntimeTaskStarted`, `RuntimeTaskUpdated`, and
`RuntimeTaskCompleted`. The orchestrator converts each update into a complete
`RuntimeTask` snapshot and appends it to the thread event log. The store folds
the newest snapshot for each provider-stable task id.

Every task carries:

- its Kybern thread and originating turn;
- normalized kind and status, plus the provider's original type;
- provider task, child-thread, tool-call, and parent ids when available;
- background state, current tool, usage, and process metrics when available;
- explicit `stop` and `background` capabilities;
- start, update, and completion timestamps.

Full snapshots make reconnect and replay deterministic. Updates may arrive out
of order, repeat, or describe a task that was discovered after it started; the
orchestrator upserts by provider-stable id. Unknown provider states should map
to the nearest non-terminal state and preserve the original value in
`provider_type` or `detail`.

An after-turn checkpoint is deferred while activity launched by that turn is
still active. When the final task settles, the orchestrator records the
checkpoint. Rewind is rejected while background work is active because the
provider may still mutate the working tree. On daemon recovery, tasks left
active in the event log become `interrupted`; Kybern does not pretend it still
owns an unrecovered process or child session.

## Provider matrix

| Harness | Observation | Targeted stop | Move to background | Notes |
| --- | --- | --- | --- | --- |
| Claude Code | Native task lifecycle and background-task updates | Yes, with `stop_task` | Yes, with `background_tasks` when Claude supplies a tool-use id | Preserves Claude task type, hierarchy, description, usage, and progress. |
| Codex | Child-thread and collaboration items; experimental background-terminal inventory | Yes for a child turn; yes for a discovered background process | No | Background process CPU and RSS are polled from `thread/backgroundTerminals/list`; termination uses `thread/backgroundTerminals/terminate`. The driver degrades cleanly when the experimental API is unavailable. |
| OpenCode | Task-shaped tool calls while the provider tool is active | No | No | A detached result is retained as recent activity with a note that ongoing lifecycle is unavailable. |
| pi / omp | Task-shaped tool calls while the provider tool is active | No | No | Same conservative tool-scoped fallback. |
| Cursor (ACP) | Agent-shaped ACP tool calls while the provider tool is active | No | No | ACP `other` calls use the title as a classification hint; controls remain hidden. |

The generic fallback is intentionally observational. A provider tool completing
must not leave an immortal active task in Kybern when that provider exposes no
subsequent lifecycle channel.

## Reference implementations

This contract was checked against two active desktop-agent implementations on
2026-09-03:

- [Synara at `562c5fe`](https://github.com/Emanuele-web04/synara/tree/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1)
  models Claude tasks as first-class provider runtime events, offers targeted
  stop and background controls, and keeps a compact task card next to the
  conversation. Kybern follows its capability-gated control boundary.
- [T3 Code at `fff33f9`](https://github.com/pingdotgg/t3code/tree/fff33f9e851912363c5b1f3ac65598be35eb5f0d)
  persists task start, progress, and completion events and renders a dedicated
  Agents panel with stable rows and tolerant client-side folding. Kybern follows
  its stable-roster and replay approach while adding background-process control.

Pin references to reviewed commits so later upstream redesigns do not silently
change the rationale behind this contract.

## Adding or updating a harness

Use this checklist whenever a provider gains task, subagent, or background
process support:

1. Capture current provider documentation and real protocol fixtures. Record
   start, progress, completion, failure, cancellation, reconnect, and nested
   task shapes.
2. Choose a provider-stable id. Never key a task by display text or array
   position. Preserve the originating Kybern turn and provider parent ids.
3. Map the provider lifecycle to `RuntimeTaskStatus`. Emit a terminal event for
   every observed terminal path, including provider exit and user interruption.
4. Implement targeted controls on `AgentSession` only when the provider exposes
   them. Advertise the matching capability per task, not per provider.
5. Decide recovery behavior. If the provider can reattach and inventory live
   work, reconcile it; otherwise let daemon recovery mark stale work
   `interrupted`.
6. Verify checkpoint and rewind behavior with a task that outlives its parent
   response. The after checkpoint must wait, and rewind must not race active
   work.
7. Verify approvals raised by child work still route to the parent Kybern
   thread without leaking child prose into the main transcript.
8. Add parser fixtures, lifecycle projection tests, a live-driver case when the
   CLI is available, and RPC/CLI coverage for every advertised control.
9. Check the desktop at narrow and wide dock widths. Long commands and agent
   prompts must truncate visually while remaining available in a tooltip.
10. Update the matrix above with exact observation and control limits.

The protocol and Activity UI should not need provider-specific branches. If a
new provider concept cannot be represented without discarding meaningful
lifecycle information, extend the append-only protocol first and keep older
clients tolerant of the new event kind.
