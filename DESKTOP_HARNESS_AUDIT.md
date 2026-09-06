# Desktop harness audit

Worktree: `ade-desktop-harness-health`; branch: `feat/desktop-harness-health`.
Kybern baseline: `0409a2c04e8c2855b703d5267598fa739c3684c7`.
Source review: 2026-09-06. T3Code: `eee05575ebd514db36f61d7eb05d2258a10c96bd`.
Synara: `562c5fea77cff1dacb29d5e6216ed94a05f1b6a1`.

The baseline references `docs/architecture.md`, `docs/design.md`, and
`docs/harness-parity.md`, but those files are absent from this checkout.
The existing kit, theme, composer, and driver contracts were used instead.
The requested eight design skills informed the implementation. The new ring
is static; the existing kit supplies tooltip motion and reduced-motion behavior.

## Requested changes

| Request | Result |
| --- | --- |
| Faster harness availability | Environment-scoped, 24-hour last-known catalog appears immediately while the authoritative catalog refreshes. Typing is independent of provider discovery; sending still needs a provider. A first-ever probe still takes time. |
| Subscription limits | Codex account read plus account update notifications; Claude reported rate-limit events. Named windows merge independently and survive thread reload. No credentials are scraped and no missing limits are invented. |
| Context indicator | Composer ring with focus/hover details, exact reported token counts, quota windows, and local reset times. Codex uses the last context snapshot, not cumulative spending; Claude uses the latest root message and its reported model window; Cursor uses ACP context usage. Pi/OMP use the last assistant usage and reported model window, with explicit contextUsage when available. OpenCode combines completed root-message usage with the native provider model window. |
| Compaction investigation | Native automatic compaction remains owned by the harness. Start/completion notices improved for Codex and Pi/OMP; Claude no longer displays a fabricated zero post-compaction count. Manual `/compact`, `threads.compact`, and `kybern compact` now use native operations. See below. |
| Slash-command investigation | Live command discovery now covers Claude, Cursor ACP, Pi/OMP, and OpenCode. Codex skills/plugins and native compact are supported. Terminal-only interfaces cannot be exported where the harness has no protocol operation. |
| Full translucency | Opt-in Appearance setting extends macOS material to content routes and floating surfaces, including the terminal canvas. Reduced transparency and increased contrast retain opaque content. Native desktop blur requires native verification. |
| Composer scrolling/spacing | Explicit shared editor metrics, matched scrollbar width, scroll synchronization after resize and native caret scrolling, and disabled automatic text correction/capitalization. Typing stays immediate. |
| Session/process cleanup | Actual stdin pipe closure; exit waits no longer hold the child mutex; owned process groups/trees; startup/handle lifetime guards; Cursor and OpenCode worker cancellation; release/resume barriers. Only session-owned processes are targeted. |

## Compaction: what Kybern actually does

There is no Kybern summarizer that silently replaces or truncates stored history.
The agent manages its context; Kybern persists the conversation and provider notices.
`AgentSession::compact`, the `threads.compact` RPC, the `kybern compact` CLI,
and the thread composer's `/compact` action now expose manual compaction. The
action runs as a persisted turn: concurrent sends and idle release are blocked,
normal interruption/completion/error recovery apply, and the full Kybern
transcript remains intact. Running agents/background tasks prevent compaction.
Codex uses `thread/compact/start`, Pi/OMP use RPC `compact`, and OpenCode uses
`session/{id}/summarize` with the selected model. Claude and Cursor only gain the
action if their installed native protocol explicitly advertises `compact`.
No guessed terminal prompt is used for a harness that does not advertise it.

| Harness | Native automatic-compaction integration in Kybern | Manual native surface verified in comparison sources |
| --- | --- | --- |
| Codex | `contextCompaction` item start/completion becomes a transcript notice. | `thread/compact/start`; T3Code and Synara invoke it explicitly. |
| Claude Code | `system/status: compacting` and `compact_boundary` become notices. Resume-return choices also map “Compact and continue” to the native `compact` response. | A terminal slash command is different from an SDK operation. Synara explicitly marks thread compaction unsupported for its Claude adapter. |
| Pi / OMP | `compaction_start` / `auto_compaction_start` and completion events become notices. | Synara's Pi adapter invokes `session.compact()`. This does not prove identical support in every OMP version. |
| OpenCode | `session.compacted` becomes a notice. | T3Code and Synara expose native session summarization. |
| Cursor | ACP context-usage notifications are supported; no explicit compaction control is wired. | Synara marks thread compaction unsupported for Cursor. |

Command discovery consumes Claude's initialize response, Cursor ACP's available
commands update, Pi/OMP's `get_commands`, and OpenCode's `/command`. Catalogs
survive thread reload and update with the live session. Selecting a native
command inserts its invocation so arguments can be edited before sending.
Collisions with Kybern actions appear as `harness:<name>` in the picker and
retain their real native invocation. Codex does not export a universal terminal
slash-command catalog; its native skill/plugin catalogs remain available.

Evidence:
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [T3Code Codex runtime](https://github.com/pingdotgg/t3code/blob/eee05575ebd514db36f61d7eb05d2258a10c96bd/apps/server/src/provider/Layers/CodexSessionRuntime.ts)
- [T3Code OpenCode adapter](https://github.com/pingdotgg/t3code/blob/eee05575ebd514db36f61d7eb05d2258a10c96bd/apps/server/src/provider/Layers/OpenCodeAdapter.ts)
- [Synara Codex manager](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/codexAppServerManager.ts)
- [Synara Pi adapter](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/provider/Layers/PiAdapter.ts)
- [Synara Claude adapter](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/provider/Layers/ClaudeAdapter.ts)
- [Synara Cursor adapter](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/provider/Layers/CursorAdapter.ts)

Local evidence: `crates/kybern-drivers/src/{lib,codex,claude,pi,opencode,cursor}.rs`,
`crates/kybern-protocol/src/methods.rs`, `crates/kybern-store/src/projection.rs`,
`apps/desktop/src/state/transcript.ts`, and `apps/desktop/src/views/{Draft,Thread,Composer}.tsx`.

## Slash commands: three different features

1. **Kybern actions**: `/attach`, `/settings`, `/usage`, and thread actions such as
   `/changes`, `/terminal`, `/files`, `/activity`, and `/archive` are composer actions.
2. **Skills/plugins**: discovered through `skills.list` and provider-native catalogs
   or configured directories. Selecting a skill produces a structured content part.
3. **Native terminal commands**: not automatically exported by a subprocess's JSON,
   HTTP, or ACP protocol. Kybern does not proxy every terminal UI command.

| Harness | Selected skill delivery |
| --- | --- |
| Codex | Visible `$skill` plus native structured `skill` input; plugins use `mention` input. |
| Claude Code | Native `/skill-name` invocation; the last selected skill is dispatched as the command. |
| OpenCode | Native session command contract. |
| Pi / OMP | `/skill:name` in the native prompt. |
| Cursor | `/name` as ACP text. |

T3Code has an explicit provider slash-command catalog and a capability-specific
`compact` command. Synara likewise separates compaction operations and runtime
capabilities. Neither repository supports the conclusion that all terminal slash
commands can be forwarded unchanged through every harness protocol.

Evidence: Kybern `crates/kybern-daemon/src/skills.rs`, driver skill-dispatch tests,
`apps/desktop/src/views/Composer.tsx`,
[T3Code provider snapshots](https://github.com/pingdotgg/t3code/blob/eee05575ebd514db36f61d7eb05d2258a10c96bd/apps/server/src/provider/providerSnapshot.ts),
and the pinned adapter sources above.

## Cleanup findings and recovery

`kill_on_drop(true)` alone was insufficient: reader tasks retain `Arc<Session>`,
so the child may not be dropped when startup fails. Codex and Pi/OMP start their
reader before fallible protocol setup. Claude also needs ownership independent
of its reader after successful startup. Each public stdio session now owns a
lifetime guard that aborts its tasks and closes its own process tree on drop.
Cursor's startup worker and OpenCode's event worker have cancellation guards.

`AsyncWrite::shutdown` was not an actual pipe drop. Closing stdin now takes and
drops the pipe. `wait()` used to hold the child mutex across process exit;
stdout could close first and leave cleanup blocked behind the waiter. The new
wait loop checks exit under a short lock and permits kill to proceed.

An idle session was removed from the session map before close completed. A new
send could therefore race its writer lock. A per-thread completion barrier now
keeps resume behind close. Once idle release is claimed, detached cleanup tasks
finish it even if the maintenance caller is cancelled. Existing checks for
turns, approvals, and active background work remain in place.

Process cleanup uses only the process group/tree created for that specific
spawn. It never searches process names or kills a writer found from an error
string. A writer-conflict error preserves the source conversation and tells the
user to let the owning session finish, close it, and retry. `/reconnect`,
`threads.release`, and `kybern release` explicitly release an idle process owned
by this daemon, with a resume barrier and history preservation. Active turns,
background tasks, and approvals are refused; unidentified processes are not adopted. It does not silently
fork/reset history or stop another application's legitimate writer.

Limits: arbitrary pre-existing orphans cannot safely be identified solely from
a writer-conflict message. SIGKILL/power loss cannot execute Rust cleanup. The
regressions exercise owned startup failure, cancellation/drop, EOF, blocked
exit waits, descendants, and ordinary daemon lifecycle paths; they do not claim
to reclaim every pre-existing orphan or to validate Windows process-tree behavior
from this macOS environment.

## Verification

- 48 Rust driver unit/regression tests with fake processes; no real live-driver turns.
- 61 daemon tests with isolated stores, including active-session protection and resume barriers.
- 10 protocol tests; schemas reviewed and the additive event snapshot updated.
- 8 store tests and 72 frontend tests, including sparse quota merges and context shrinkage.
- Rust formatting and affected-crate Clippy checks; desktop typecheck, lint, and production web build. The web build retains its existing large-chunk and mixed-import warnings.
- Browser renderer against `/tmp/kybern-desktop-harness-health-qa`, using a fake
  Codex process: long input, capped-editor end scrolling, context ring, keyboard
  tooltip details, exact token counts, and both quota reset times.
- Scratch end-to-end native Codex compaction: accepted request, progress notices,
  concurrent-send rejection, completion, preserved transcript, context shrinks
  from 68,000 to 8,000 tokens.
- Native desktop builds with `RUSTFLAGS="-C strip=none"`. This local workaround
  avoids the macOS 27 LINKEDIT loading problem in stripped proc-macro libraries
  ([Rust issue](https://github.com/rust-lang/rust/issues/157750)); no global
  compiler settings were changed.
- Native macOS WindowServer/vibrancy visual verification awaits permission for
  an isolated QA window alongside the user's app, an exception to AGENTS.md's
  one-Kybern-UI rule. The main app and daemon have remained open.

All builds use the new worktree's own `target` and frontend output. No merge,
installation, release, main-daemon restart, or mobile edits were performed.

## Follow-up: phantom subagent on Codex resume

Early notifications were routed before the start/resume/fork response bound the
root thread ID. Comparing a notification ID against `None` classified the root
as child activity. Notifications now wait for root binding and replay in order
under a notification lock. Root IDs are also rejected by the shared subagent
registration path and collaboration-item updates. A regression covers early
root turns and prose, genuine child activity, and self-referencing collaboration
items. Existing stored phantom rows are not rewritten by this change.


## Native protocol sources used for the completion pass

- [Pi RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-mode.ts): native `compact`, `get_commands`, and idle state after immediately handled extension commands.
- [Pi command discovery](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md): extension, template and skill commands; interactive-only builtins are not included.
- Codex app-server and the pinned T3Code/Synara sources linked above.

Quota percentages/reset times still require native account telemetry. Missing
account quotas are shown as unavailable rather than inferred from token usage.


## Asynchronous Codex questions

The installed Codex app-server schema and captured rollout confirm that
`request_user_input_async` produces a completed `agentMessage` with
`delivery: "async"` and `questions: [{ title, options }]`. It is not a blocking
`item/tool/requestUserInput` server request. Kybern previously kept only `text`,
which explains the plain paragraph and bullet list in the screenshot.

The driver now preserves this metadata as an append-only question event. The
composer shows an explicit answer form, including free-text input, without
changing the thread to awaiting approval. Unanswered requests survive turn
completion, session release and `threads.get` hydration. `threads.answer`
(`kybern answer`) validates complete answers and serializes duplicate
submissions. Active Codex turns receive `turn/steer` with `expectedTurnId`;
idle conversations start a normal resumable turn. Rejected delivery leaves the
form pending and shows the error. Answers are retained in the transcript without
replacing the original prompt. Existing plain-text history cannot recover the
previously discarded metadata automatically; the live database is not rewritten.

Regression coverage includes the native item shape, nullable/missing options,
active-turn steering, explicit answers, duplicate submissions, late/startup
rejection, idle resumption, and frontend reload/history behavior. A lifecycle
test's fixed startup timer was replaced with a readiness/gate handshake after it
raced process startup during a loaded build.


Historical phantom activity is also excluded during transcript and runtime-task
projection when an agent's provider thread ID exactly matches a root session
bound in that conversation. The targeted activity SQL query includes binding
events, so task lists and sidebar summaries agree with transcript hydration.
Bindings are collected before folding, covering notifications that preceded the
root binding. Real child IDs, processes, and unbound/unknown agents are retained.
The event log is preserved; this does not stop or signal any process.
