# Collaboration dock verification

The `collaboration` native WebKit fixture renders the production
`CollaborationPane` under the desktop CSP with a typed in-memory RPC transport.
It exercises the group lifecycle without starting a Kybern app or daemon.

## Workload

The fixture creates a group from an ungrouped thread, verifies that the provider
and model pickers reflect the runtime catalog, and then exercises participant
cards, assignment results, peer-message attribution, paged assignments,
messages, and context, an authoritative context correction, paged revision
history, and pause, resume, and stop controls. It also switches through the
light theme before returning to the requested capture theme.

Run from `apps/desktop`:

```sh
node scripts/check-rendering.mjs collaboration
KYBERN_PERF_WIDTH=420 KYBERN_PERF_HEIGHT=760 KYBERN_COLLAB_THEME=light \
  node scripts/check-rendering.mjs collaboration
```

## Result

Recorded on 2026-09-13 using the system WKWebView on macOS at 1100 points in
dark mode and 420 x 760 points in light mode. Both runs reported:

- group creation, pause, resume, and stop assertions passed;
- unavailable providers stayed out of the picker and the available model was
  selectable;
- Codex dedicated mode was disabled with recovery copy, while revisioned
  provider allowlist and worker-limit edits persisted;
- enabling dedicated mode on a supported idle coordinator released its native
  session before group creation;
- a same-mode policy save also released an idle coordinator and retained the
  backend maximum of 32 active workers;
- public progress messages omitted agent impersonation and wakeup-only fields,
  and every new child request carried an explicit base revision;
- group discovery crossed a cursor boundary and preferred the newest active
  membership over a newer stopped membership;
- older assignment, message, context, and context-history pages were reached;
- assignment result, peer origin and destination, corrected context, and three
  context revisions were present;
- horizontal overflow was 0 points.

The existing `work-shell` fixture also passed after the collaboration event
subscription and dock changes. Its 1,000-thread, 20-project workload measured a
2 ms scoped commit-time p95 and an 18–19 ms frame-interval p95; the baseline
publication measured a 4–6 ms commit-time p95. These are synthetic React commit
and frame interval probes in native WebKit, not input latency, CPU, GPU, energy,
or full-daemon measurements.

## Limits

The transport is deterministic and does not measure socket reconnect latency or
daemon persistence. Group discovery cursor-pages project groups without
retaining the scanned pages; a project with many groups can still require many
group-detail round trips because the protocol has no direct group-by-thread
lookup. Assignment, message, and context panes retain a bounded 200-item window while
their cursor controls can continue to older records; once the window advances,
the UI offers a return-to-latest action. Context history is independently
cursor-paged newest first.

## UI redesign follow-up — 2026-09-14

The production dock now starts with Work, Messages, and Context tabs. Objective,
policy, participant management, and creation forms open in kit dialogs. Completed
groups start with compact results; long result and message bodies remain fully
available through disclosures. Context presents the current revision once and
retains earlier revisions. Background thread metadata no longer re-triggers full
group discovery.

The updated native fixture passed at 1100×720 dark, 430×800 light, and 360×800
dark, with zero document or collaboration-pane horizontal overflow. It retains
the lifecycle, attribution, provider, base-revision, and paging assertions above
and additionally verifies:

- no editable fields mounted in the default Work view;
- labeled dialogs and keyboard tab navigation;
- Escape returns focus to the exact initiating Objective or Context button;
- failed saves and concurrent server updates preserve a local objective draft;
- the concurrent update is rejected using the revision captured before editing;
- three-line message and two-line result previews, with exact full-content tails
  and all structured result fields reachable after expansion;
- twenty thread metadata updates cause zero group-discovery calls.

Focus destinations are asserted. The production focus-ring class is checked,
but synthetic JavaScript keyboard events do not establish trusted operating
system `:focus-visible` modality, so computed ring painting is reported
separately rather than claimed as a native keyboard test.

Read-only replay can be supplied with `KYBERN_COLLAB_REPLAY` and selected with
`KYBERN_COLLAB_VIEW=work|messages|context-history`. It uses persisted records from
the earlier live Claude/Codex run, excludes its transport from the production
bundle, and does not start providers. The archived before/after captures and
their precise evidence limits are in the local
`artifacts/collaboration-redesign/verification.md` report. These layout captures
are not performance measurements or captures of the installed application.
