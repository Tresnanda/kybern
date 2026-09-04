# Transcript final-answer boundary: T3 Code and Synara

Research date: 2026-09-05

Source snapshots:

- T3 Code: [`7839140e5e93d3f401d7eb45b86cf1a234eb3609`](https://github.com/pingdotgg/t3code/tree/7839140e5e93d3f401d7eb45b86cf1a234eb3609)
- Synara: [`562c5fea77cff1dacb29d5e6216ed94a05f1b6a1`](https://github.com/Emanuele-web04/synara/tree/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1)

## Executive conclusion

Both projects enforce the same important invariant across the provider adapter, projection, and UI:

> When prior deltas exist, a provider completion completes their already-known logical assistant message; it does not create another transcript row. After a turn settles, exactly one assistant identity owns the final prose, and that identity is excluded from the activity disclosure.

They implement the details differently:

- T3 Code uses separate durable assistant-message segments around blocking pauses, then renders `Worked for …` and the terminal assistant message as sibling timeline rows.
- Synara preserves one logical message while recording ordered text slices around tool rows, then attaches the disclosure data to the terminal row but renders the terminal text outside the disclosure panel.

The screenshot failure—identical final prose visible once inside `Worked` and once as the final answer—is therefore most consistent with an identity-normalization failure before presentation: the streamed/resumed response and its completion snapshot became two logical assistant IDs. A UI algorithm that merely chooses “the last assistant row” cannot repair that safely; it will classify the earlier duplicate as narration and fold it.

## T3 Code

### Backend: durable message segments and idempotent completion

T3 keeps per-turn `AssistantSegmentState` with a base key, a monotonically increasing segment index, and the currently active message ID ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L92-L96)). IDs are deterministic: the first segment is `assistant:<base>`, and resumed segments are `assistant:<base>:segment:<n>` ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L246-L254)). `getOrCreateAssistantMessageId` reuses only the active segment; after it has been closed, another delta opens the next ordinal ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1074-L1148)).

A blocking approval/user-input request is an explicit boundary. Before pausing, T3 flushes buffered text, completes the active segment, and clears `activeMessageId`; later text therefore cannot be appended to, or mistaken for, the earlier narration ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1793-L1837)).

Completion is reconciled onto that active identity:

- `finalizeAssistantMessage` emits any remaining text and the completion against the same `messageId` ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1268-L1312)).
- For an `item.completed`, the active segment ID wins over the raw completion ID; completion text is used only when the projected row is absent or empty, and an empty redundant completion is skipped ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1844-L1911)).
- The read-model projector upserts by message ID. Deltas append to that row; an empty completion preserves its accumulated text and only settles `streaming` ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/orchestration/projector.ts#L535-L585)).

The regression test is unusually close to Kybern's reported scenario. It streams “first half,” pauses for approval, resumes under the same provider item ID, and verifies two durable message identities with exactly four events—delta + completion for each and no duplicate prose ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts#L2447-L2577)).

### Backend: child traffic cannot steal the root lifecycle

T3 treats child-agent routing as an explicit three-way decision: lifecycle becomes agent-scoped activity, enumerated child chatter is dropped, and unknown/parent-owned methods fall through to the parent path ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L1020-L1085)). It also has hard guards against registering `/root` or the root provider thread as a child. The source comment records the exact prior failure: doing so intercepted the root final assistant message and `turn/completed`, leaving the thread stuck working ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L1479-L1554)). Child interception runs before legacy suppression so child lifecycle cannot leak into or mutate parent state ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L1726-L1771)).

These rules are pinned to a real Codex multi-agent wire capture. The test documents three shipped routing bugs, child traffic arriving before registration, and `/root` self-activity that must never capture the parent's final message ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/provider/Layers/CodexCollabWire.test.ts#L1-L13), [source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/server/src/provider/Layers/CodexCollabWire.test.ts#L61-L113)).

### UI: the final row is structurally outside `Worked`

T3 derives one terminal assistant identity per turn/response group ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/web/src/components/chat/MessagesTimeline.logic.ts#L430-L453)). It does not use transient `isWorking` alone to decide settlement: a running session turn is authoritative, otherwise the latest turn remains unsettled until it has both a non-running state and `completedAt` ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/web/src/components/chat/MessagesTimeline.logic.ts#L464-L484), [source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/web/src/components/chat/MessagesTimeline.logic.ts#L790-L805)).

For settled turns, the fold algorithm:

1. records the terminal entry separately;
2. explicitly skips that entry when building hidden IDs;
3. hides only entries at or before its position;
4. leaves trailing work visible; and
5. never folds an agent-spawn CTA, because the fleet may outlive the launching turn.

Those invariants are visible directly in [`deriveTurnFolds`](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/web/src/components/chat/MessagesTimeline.logic.ts#L541-L689). The renderer then dispatches `turn-fold` and assistant messages to different row components ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/web/src/components/chat/MessagesTimeline.tsx#L1129-L1145)); `TurnFoldTimelineRow` and `AssistantTimelineRow` are siblings rather than parent/child content ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/web/src/components/chat/MessagesTimeline.tsx#L1439-L1483)).

Tests assert the complete contract: intermediate assistant text and work fold while the final row remains visible ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/web/src/components/chat/MessagesTimeline.logic.test.ts#L686-L785)); post-final tools remain outside the fold ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/web/src/components/chat/MessagesTimeline.logic.test.ts#L787-L867)); and multiple pre-final assistant messages all fold without consuming the terminal message ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/web/src/components/chat/MessagesTimeline.logic.test.ts#L869-L923)). The trailing-tool behavior came from the focused fix [`4b26132`](https://github.com/pingdotgg/t3code/commit/4b26132d2c740ff344ef3fae7ae62e9765759e29).

T3 also keeps subagent lifecycle rows pinned to the first spawn identity and position, replacing updates in place rather than letting progress ticks drift through the transcript ([source](https://github.com/pingdotgg/t3code/blob/7839140e5e93d3f401d7eb45b86cf1a234eb3609/apps/web/src/session-logic.ts#L1064-L1122)).

## Synara

### Backend: one message identity, ordered text slices

Synara's model is more granular inside a message. A tool, warning, approval, or command-output event marks the current text slice closed; the next assistant delta starts a new sequence-positioned slice ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L314-L343)). Segment state is scoped by both target thread and message ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1884-L1901)), and each new slice carries the provider-runtime sequence that established its position ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2385-L2465)).

Completion still targets one known logical message. `resolveAssistantCompletionMessageId` prefers an exact known item ID, then the sole known message, then the streaming/latest known message; only after those fail does it synthesize a new ID ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1218-L1276)). As in T3, the provider's completion text is fallback-only when the existing projected row is absent or empty ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2473-L2520)), and final text plus completion are dispatched with the same message ID ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1421-L1465)).

The projector upserts by message ID, appends streaming deltas, and preserves accumulated text on an empty completion ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/orchestration/projector.ts#L1005-L1118)). It preserves multi-slice boundaries when their collated text equals the completion snapshot ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/orchestration/projector.ts#L308-L365)). Activities use monotonic sequence before timestamp/ID and update in place by activity ID ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/orchestration/projector.ts#L246-L296)).

Subagent ownership is similarly explicit: when provider thread and parent thread IDs differ, ingestion materializes/resolves a child thread and projects the event there; row boundaries affect only that target thread's message state ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2088-L2134)).

The cross-stack introduction of ordered assistant slices is captured in [`dd29079`](https://github.com/Emanuele-web04/synara/commit/dd29079747eaeee096558a56275ce9a97b6f1879).

### UI: disclosure data belongs to the terminal row, but terminal text does not

Synara merges text slices, plans, and work using sequence before timestamp ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/web/src/workLog.ts#L2273-L2406)). A completed assistant message with several stored slices becomes sequence-positioned `message-segment` rows while a streaming message remains one stable live row ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/web/src/workLog.ts#L2343-L2385)). Routed subagent work is excluded from the root transcript and represented in the subagent strip/child threads ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/web/src/workLog.ts#L263-L280)).

The fold pass finds the terminal assistant, starts scanning at `pass - 1`, collects only preceding narration/work/slices, and stores that collection on the terminal row. It skips streaming and active turns ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/web/src/components/chat/MessagesTimeline.logic.ts#L788-L929)). Starting before the terminal is the critical detail: terminal prose is never eligible to enter `collapsedTurnItems`.

The JSX maintains the same boundary. It renders `collapsedTurnItems` inside `CollapsiblePanel`, closes the panel, draws a separator, and only then renders the terminal `messageText` in `ChatMarkdown` ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/web/src/components/chat/MessagesTimeline.tsx#L2197-L2283)). The regression test expects visible message IDs `u1, a3` and collapsed contents `a1, w1, a2, w2`—never `a3` ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/web/src/components/chat/MessagesTimeline.logic.test.ts#L930-L972)). Another test verifies a multi-slice narration folds exactly once by logical message ID ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/web/src/components/chat/MessagesTimeline.logic.test.ts#L974-L1051)); that behavior was added in [`a456d5b`](https://github.com/Emanuele-web04/synara/commit/a456d5baf794507c77f3ebe80916604a47776090).

Finally, Synara uses the session's active turn with a latest-turn fallback so a provider temporarily clearing `activeTurnId` cannot fold the newest answer while work is still running ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/web/src/components/ChatView.tsx#L3098-L3103)). It waits briefly before the live-to-settled collapse and animates an inert visual clone, avoiding a height snap without changing semantic ownership ([source](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/web/src/components/ChatView.browser.tsx#L8564-L8640)).

## The six invariants Kybern should enforce

### 1. Canonicalize identity before storing transcript events

Maintain a per-`(thread, turn, origin)` logical assistant state:

```text
logical message = { stable_id, ordinal, raw_provider_aliases, open, text, thinking }
```

A delta resolves or opens that state. A provider completion resolves to the open/known logical ID even if its raw item ID differs. Raw provider IDs are aliases, not transcript identity.

### 2. Treat completion as reconciliation, never append

For a known logical message, a completion snapshot must:

- mark the same row complete;
- preserve streamed text when the snapshot is empty;
- replace/reconcile only when the provider supplies authoritative content; and
- be idempotent under replay.

Never emit a second assistant row merely because the completion frame has a different raw ID. This is the direct defense against the screenshot's duplicate-final pattern.

### 3. Make pause/resume a new ordinal, not an accidental continuation

When a blocking approval, user-input pause, or genuine provider message boundary closes a segment, clear the active logical ID. If more root text later arrives under the same raw provider ID, allocate `segment:n+1`. This preserves intermediate narration and lets the final segment be selected without moving text after the fact.

Ordered text slices within a logical message are a separate concern: use them when one provider message spans tool rows. Give every slice a monotonic event sequence, not only a timestamp.

### 4. Isolate origin and lifecycle

Classify every provider event before projection as root, child-agent lifecycle, child-owned chatter, or parent-owned control. A child message/turn completion must never settle the root turn, and root self-activity must never register root as a child. Unknown methods should surface to the parent path or diagnostics, not disappear under a catch-all.

### 5. Persist the terminal boundary at turn settlement

When the root turn truly completes, freeze `terminal_message_id = last completed, non-empty root logical message` in the durable turn projection. The UI should consume this identity rather than infer it from text, timestamp, DOM position, or a transient working flag.

If backward compatibility requires inference, constrain it to the last non-empty root message before the turn-completion sequence and assert it is not present in fold membership.

### 6. Make the fold incapable of owning terminal prose

Build fold membership with an exclusive boundary:

```text
folded = same visual response
      && sequence < terminal_message.start_sequence
      && logical_message_id != terminal_message_id
```

Keep rows after the terminal boundary visible. Keep active subagent launch/status affordances visible. Render `Worked` and the terminal answer as sibling nodes, following T3's stricter structure; motion may animate an inert copy, but it must not change ownership.

## Acceptance matrix

The implementation is not complete until daemon/projection tests and UI tests cover all of these, including replay from persisted events:

| Case | Required result |
| --- | --- |
| Deltas + completion snapshot with the same raw ID | One logical message, one visible copy |
| Deltas + identical completion snapshot with a different raw ID | Completion aliases to the open message; no second row |
| Replayed completion | No content duplication and no new row |
| Intermediate narration → tool/approval → resumed root response reusing raw ID | Stable narration segment plus a new terminal ordinal |
| One logical message interleaved with tools | Ordered text slices; reconstructed text exactly once |
| Root final response followed by late tool status | Final remains outside `Worked`; late status remains visible |
| Child and root reuse/collide on raw message IDs | Origin-scoped identities; child prose never enters root transcript |
| Child traffic precedes registration | Root lifecycle remains correct; child lifecycle is eventually represented |
| `/root` self-activity during a multi-agent run | Root is never registered/intercepted as a child |
| Active-turn ID temporarily clears while work continues | No premature fold or final reclassification |
| Fresh live state versus full reload | Identical row identities, order, fold membership, and terminal answer |

## Recommendation

Use T3's sibling-row presentation and active-segment ordinals as the primary model, augmented with Synara's sequence-bearing text slices when a single logical message crosses tool rows. The most important fix belongs in the daemon/driver normalization layer: once duplicate completion snapshots have already become different logical messages, the UI can only guess which copy is real.
