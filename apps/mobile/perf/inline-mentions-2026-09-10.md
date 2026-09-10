# Inline mentions and desktop delivery shortcuts — 2026-09-10

Skills, plugins, and file mentions now share the surrounding text paragraph in
mobile user bubbles. The composer inserts editable `$skill` / `@mention` text at
the caret, retaining the native part identity for sending. Selected file paths
with spaces and tokens followed by punctuation remain structured. Images and
attachments retain their existing tiles and send behavior.

Highlights use `accent` / `accentSoft` in light and dark themes. The iOS input
uses native attributed text. Android retains the controlled native text input
and paints a noninteractive highlight layer synchronized with its scroll offset;
Android does not combine a controlled value with attributed children. Caret
selection is supplied only for programmatic insertion, allowing normal native edits. Screen readers receive the native field, not the paint layer.
Message text remeasures when the system font scale changes.

Desktop Enter queues during a running turn, regardless of the button's selected
mode. Command+Enter on macOS / Control+Enter elsewhere steers where the provider
supports steering. Shift+Enter stays a newline and IME confirmation does not send.
Suggestion acceptance and the button/menu remain available; delivery hints show
the shortcuts.

## Verification

- Desktop native WebKit prompts fixture under production CSP: keyboard delivery,
  selected-button override, IME/newline guard, failure retention, and light/dark.
- Mobile unit tests: inline grouping, exact whitespace/paragraphs, mid-text picker
  insertion with suffix preservation, skill/plugin/file identity, paths with
  spaces, punctuation, unknown-token fallback, and existing send-motion checks.
- iPhone 17 Pro simulator / iOS 27 / Expo Go 57.0.9: skill/plugin insertion,
  continued typing, highlight wrapping, queue submission with exact structured
  parts, input clearing, light/dark, and inline bubble wrapping at accessibility
  extra-large text. App chrome at extreme text sizes is not covered by this fix.
- Android 15/API 35 arm64 emulator / Expo Go: skill/plugin/file selection,
  native editing with highlighted text, and multiline scrolling. A 395-character
  prompt entered in timed 24-character bursts matched the submitted text exactly,
  retained the skill's native identity, and cleared after sending. The final
  long-input check used a fresh development bundle; production exports also pass.
  One-shot `adb input text` stress injection was not a valid text-preservation
  check on this emulator: InputDispatcher explicitly discarded trailing events
  as stale. This does not establish physical-device rapid-typing performance.
- Desktop 115 tests, mobile 73 tests, both type checks, desktop lint/build,
  Expo Doctor 21/21, and Android/iOS production exports.

Run the synthetic mobile fixture from `apps/mobile` with
`KYBERN_FIXTURE_INLINE=1 node perf/reconnect-server.mjs`, then connect Expo Go to
its loopback endpoint. `GET /stats` exposes synthetic submitted messages for
checking the exact wire parts. It never starts a coding agent. Screenshots are
untracked in `artifacts/inline-mentions-20260910/` at the repository root.

These are simulator/emulator functional checks, not physical-device latency,
energy, VoiceOver/TalkBack, or a packaged release qualification. No release,
installed desktop replacement, or mobile update was published.
