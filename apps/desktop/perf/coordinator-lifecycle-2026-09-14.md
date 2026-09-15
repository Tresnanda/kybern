# Coordinator setup and deletion verification

Implemented from `origin/main` at `437e09c` on
`feat/coordinator-setup-delete`.

## Behavior

The first Send preserves the user brief and starts repository research. Editing
and integration assignments in the coordinator group are rejected until the
coordinator records `project.setup` knowledge referencing a successful research
assignment performed by a worker. The overview and human corrections persist;
setup does not install dependencies or provision a machine. Subsequent work
reuses the overview. The coordinator's prompt tells it to resume the original
request after saving the overview and to explain blockers instead of claiming
readiness. Existing Codex/Cursor native-tool restrictions remain advisory.

Delete coordinator is exposed in desktop and mobile menus and the Project panel.
It requires inactive agents and no queued messages. The daemon atomically
archives the coordinator, completes its group, revokes memberships, removes its
registration/reservation, and records an idempotent receipt and events. Prior
worker conversations, files, results, and knowledge remain accessible. A new
coordinator gets fresh IDs and knowledge. Old creation/deletion retries cannot
resurrect a deleted identity or delete its replacement.

## Checks

- Rust workspace library tests: 313 passed, 3 ignored.
- Coordinator/collaboration lifecycle tests: 22 passed, covering research gating,
  failed research, user correction and provenance, restart, active/queued work,
  deletion, retained history, fresh creation, and stale retries.
- Public API/CLI transport tests: 4 passed against disposable daemons, including
  concurrent deletion requests, restart, recreation, and CLI receipt replay.
- Protocol tests: 12 passed; reviewed the additive method, scope, and event
  snapshot changes.
- Workspace all-target clippy and formatting passed.
- Desktop: 167 tests, typecheck, lint, and production build passed.
- Mobile: 108 tests, typecheck, and iOS/Android exports passed. Expo Doctor passed
  20/21 checks; its existing SDK 57 patch-version check lists 19 mismatches.
  No dependency changes were made.

## Native appearance and responsiveness

The native `chat-collaboration` fixture uses production React components in the
system WKWebView under the production CSP. Its 31 checks pass, including inert
draft creation, the setup-to-ready state change, deletion copy, cancellation,
a visible server error, stable operation identity on retry, removal from the
sidebar, and returning to an inert creation draft. Document horizontal overflow
was zero. Light desktop and 430 × 800 dark confirmation captures were visually
inspected. The existing dialog becomes a readable bottom sheet at narrow widths.
The setup status gets its own composer row so it remains readable with an open
dock. Local screenshots are in `artifacts/coordinator-lifecycle/` and are excluded
from commits.

The unchanged 1,000-thread / 20-project `work-shell` workload also passed. Its
scoped synthetic commit p95 was 2 ms, frame interval p95 was 18 ms, and the
activity commit p95 was 1 ms. These are fixture measurements on the local Mac's
system WebKit, not CPU, energy, input-latency, React Native, or full-agent
execution measurements. No performance improvement is claimed by this change.

## Limits

This verifies persistence, orchestration rules, transport, and rendered flows.
The overview's factual quality and continuation behavior still depend on the
selected agent; no paid live-provider setup run was performed. Mobile exports
and tests do not replace a physical-device UI check. The running user daemon
and installed app were not replaced. Changes require a daemon and clients built
from this branch; no release, deployment, or PR publication was performed.
