# Environment menu, image actions and agent lifecycle — 2026-09-18

## UI review

The existing kit remains the source of density, materials, icons and motion.
This pass uses better-layout, better-ui and apple-design, with Apple's
[Menus](https://developer.apple.com/design/human-interface-guidelines/menus),
[Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)
and [Offering help](https://developer.apple.com/design/human-interface-guidelines/offering-help)
guidance. Icon actions retain accessible names and brief tooltips.

### Shared alignment and hierarchy

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| LOW | `src/views/EnvironmentSwitcher.tsx:153`, `src/styles/kit.css:3049` | Negative icon margins crowded labels; action and choice gaps differed | 12px icon/text gaps and aligned leading edges | Clear grouping and consistent scanning |
| LOW | `src/views/EnvironmentSwitcher.tsx:159`, `src/styles/kit.css:3063` | Status could approach the primary label's size with custom type settings | Relative 82% status size with an 11px floor; dot and label vertically centered | Machine name leads; connection state remains readable |
| LOW | `src/styles/kit.css:3068` | Small checkmark looked thinner than neighboring icons | 14px check with 2.75 stroke on its 24px grid | Match optical icon weight at rendered size |

### Consistent controls

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM | `src/components/kybern/ResponseImage.tsx:217` | Copy/Download had labels and sat below the separately positioned close action | Three aligned icon controls; Copy and Download retain tooltips, names and pending/confirmation behavior | Predictable toolbar placement and consistent hit areas |

Native `chat-fixes` passes in system WKWebView at `tauri://localhost` under the
production CSP at 900px and 1100px window widths. Checks cover light/dark,
selected/disabled rows, action keyboard focus, long labels at 200% zoom with RTL,
status/dot alignment, icon/text gaps and stroke, loaded/retry image states,
icon-only labels, toolbar geometry, dialog close and focus restoration.
Screenshots in `perf-artifacts/menu-polish-20260918` show the real components.

Not verified: every intermediate window width, screen-reader speech, and a
10%-speed browser animation-panel review. Existing menu and IconSwap motion
were reused without changing their timing. Native clipboard/file saving was
verified in the previous pass; this pass preserves those implementations.

Approve for the inspected UI scope.

## Issue #35 and collaboration delivery

Codex successful child `turn/completed` notifications now emit terminal Completed
instead of active Waiting. Real child `turn/started` notifications explicitly
resume reusable task IDs; completion timestamps clear, stop capability returns,
and persisted Rust/shared TypeScript/desktop projections accept that restart.
Ordinary delayed progress cannot revive terminal tasks. Genuine approval waits,
processes and monitors retain their existing semantics. Existing stale active
rows are settled by the daemon's existing restart recovery when the new daemon
starts; no production data was rewritten during this work.

The shared daemon collaboration path now filters to the caller before its
100-message limit, with deterministic chronological order. Reading structured
assignment results consumes the matching canonical queued notification even
when it falls outside that page. Completion atomically supersedes older pending
Result snapshots on the same assignment/route; it preserves actionable messages,
other recipients and deliveries already owned by a provider. Exact repeated
terminal Result bodies remain durable without waking another turn, while a
new follow-up result still wakes. Completion refuses to skip unread assignment
instructions. Read-only thread/UI history reads remain read-only.

New assignment prompts prioritize current user instructions, plans and project
setup. Agent-authored archived result bodies stay available through selective
context reads instead of automatically filling the startup prompt. A regression
with 40 old reports preserves the important current context in under 1 KiB;
this is fixture evidence, not a measured percentage of real session tokens.

Combined validation:

- Rust library tests: daemon 170 passed / 2 ignored, drivers 117, store 30.
- Changed Rust crates Clippy with warnings denied; workspace format check passed.
- Desktop 246 tests, typecheck, lint, production web build passed.
- Native production-CSP `chat-fixes` and `work-shell` passed after integration.
  The 1,000-thread shell retained unread indicators and working/monitoring/idle
  transitions; this is UI regression coverage, not live-provider validation.
- Sidecar-aware Tauri debug build passed, including the changed daemon/drivers.
- Worker mobile typecheck and 110 tests passed. Parent Android/iOS export passed.
- Expo Doctor: 20/21 checks passed; existing exact-pinned SDK 57 packages lag
  current patch recommendations (19 packages). No dependency versions changed.

No live provider sessions were exercised for this regression; lifecycle and
cross-harness inbox coverage use deterministic fixtures. An already in-flight
provider notification cannot be revoked safely. The installed application and
production daemon stayed running unchanged, so the delivery behavior takes
effect when this build is installed and its daemon starts. No release or push.

