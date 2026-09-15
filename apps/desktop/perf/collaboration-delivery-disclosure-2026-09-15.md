# Collaboration delivery and disclosure — 2026-09-15

Follow-up to PR #17, isolated at `ade-collaboration-disclosure` from `1811620`.
Cargo uses this worktree's own target directory. The original checkout, installed
application, running daemon and normal user database were not changed.

## Delivery finding

Kybern queues collaboration wakeups in its daemon. A busy recipient receives them
as follow-up turns once idle and after active background tasks finish. Progress
messages are persisted without automatic wakeups. Ordinary user steering remains
separate from collaboration delivery.

Previously, `kybern_collaboration_wait` acknowledged returned incoming messages,
but `kybern_collaboration_read` exposed those same messages without acknowledging
them. An agent could incorporate a helper result in its current turn and then
spend a later turn responding to that already-read result.

Both agent tools now acknowledge only messages actually returned in their bounded
response and addressed to their caller. Inspection through the client RPC remains
read-only. Invalid reads, other recipients, unseen pages, and uncertain deliveries
are not consumed. Delivery records and queue-removal events commit together;
cancellation and prior delivery win over stale snapshots. Result history remains.

| Harness | Tool transport | Collaboration delivery |
| --- | --- | --- |
| Codex | Native app-tool request through daemon | Shared queue and read/wait acknowledgement |
| Claude Code | Session-scoped MCP gateway | Same |
| OpenCode | Session-scoped MCP gateway | Same |
| Pi | Registered extension tools | Same |
| OMP | Registered native tools | Same |
| Cursor | Session-scoped MCP gateway | Same |

The regression exercises each provider with an ordinary group and project
coordinator identity, using dedicated mode where supported and ordinary advisory
mode for Codex/Cursor. It uses a mocked owning session, not paid model requests.
Existing driver unit tests exercise adapter configuration and lifecycle. This is
not an end-to-end claim about every installed vendor CLI version.

Unread, independently sent messages still queue. This fix does not infer semantic
equivalence between different messages or discard results because an agent sounds
finished. It specifically prevents a returned inbox message from waking its
recipient a second time. Both updated daemon and client code are needed for the
full behavior; no installed session was restarted during verification.

## Interface

Desktop, phone Threads, and iPad sidebar hide spawned branches by default. Each
parent has an explicit disclosure. Nested branches, missing parents and cycles
stay reachable; the selected child's ancestry initially opens. Explicit collapse
wins. Mobile search and filters show all matching conversations directly.

Queued agent updates have a compact count disclosure. Their expanded rows show
purpose and sender name, with the body on demand. Ordinary prompts retain their
existing edit, remove and attached-context behavior. Transcript updates use a
collapsed sender/purpose row and formatted content. Original routing metadata is
available in desktop details and through mobile Copy original message. Legacy
text-envelope recognition is presentation only and grants no routing authority.

Mobile replaces the horizontally clipped helper strip with a summary and a
bounded vertical list. Attention counts remain in the summary. Labels use the
existing semantic type, flexible widths, and minimum 48-point controls. Existing
Android opaque surfaces and iOS styling remain.

This follows Apple's guidance to [disclose details when relevant](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls)
and retain [legibility as text scales](https://developer.apple.com/design/human-interface-guidelines/typography).
Desktop reuses the existing interruptible disclosure/chevron motion and unmounts
closed content after its exit. Mobile disclosure is a frequent navigation action,
so it adds no custom height animation or stagger. Existing Tap feedback and
Reduce Motion behavior remain. No animation dependency or global token change.

## Verification

- Daemon, store and driver library suites passed; focused delivery regression
  covers all six harnesses and both coordinator modes, failed reads, recipient
  isolation and bounded pages. Store regression covers cancellation/idempotence.
- Desktop: 169 tests, typecheck, lint and production build passed.
- Mobile: 110 tests, typecheck and iOS/Android production JS exports passed.
- Expo Doctor: 20/21; the existing 19 Expo SDK patch-version mismatches remain.
- Native WKWebView under production CSP: collaboration lifecycle/navigation
  fixture, added sidebar and queued-message checks, formatted message expansion
  and content unmount, and zero horizontal overflow at 430 CSS pixels passed.
- Composer-stack native regression: 60 cases passed, including narrow/short
  panes, larger text, RTL, focus/edit retention and accessibility material/motion
  variants covered by that fixture.
- Light desktop and narrow dark screenshots were inspected. These are desktop
  WebKit checks, not React Native device screenshots.

Physical iOS/Android UI, VoiceOver, enlarged mobile system text, release-build
motion feel and paid live provider runs remain unverified. No CPU, energy or
token-cost savings percentage is claimed. Repository references to
`docs/architecture.md` and `docs/design.md` are absent on this branch; existing
kit components, mobile README and performance guidance supplied the UI context.
