# Harness marks and custom model IDs — 2026-09-10

Mobile harness artwork resolves SVG `currentColor` against the current Ink theme
before native rendering. Codex, Cursor, Pi, and the dark OpenCode mark now follow
the text color. Claude Code and Oh My Pi retain their brand colors and gradients.
The shared component covers the composer, pickers, sessions, and integrations.

Discovered models are suggestions, not an allowlist. Both mobile model pickers
offer **Use “…”** for an exact ID absent from the catalog. Selected custom IDs
stay visible after the picker reopens or the catalog refreshes. Desktop exposes
**Use custom model…** in the model submenu, including when discovery is empty.
IDs retain their case, provider prefixes, punctuation, and version suffixes;
outer whitespace is trimmed and empty/whitespace-containing IDs are rejected.

Custom selection updates the model without an accompanying effort change.
Claude Code supports live model switching but rejects live effort switching.
Thread setup also omits unchanged effort and permission fields on save.
Existing daemon/driver paths already store and forward arbitrary model strings;
the harness remains responsible for model availability and validation.

## Verification

- iPhone 17 Pro simulator, iOS 27, Expo Go 57.0.9: inspected all six harness
  logos in dark and light themes, including switching themes while mounted.
- Android 15/API 35 arm64 emulator, Expo Go: inspected all six marks in both
  themes, including expanded sheets and the Codex composer control.
- Both mobile clients selected `claude-opus-4-8` from a fixture catalog containing
  only `opus`. Captured `threads.update` params contained the exact model ID and
  thread ID, with no effort or permission update. The selected custom row and
  composer label survived refresh.
- Android thread setup selected and saved `claude-opus-4-8[1m]` unchanged while
  retaining the existing medium effort and supervised permission mode.
- Desktop native WebKit prompts fixture under the production CSP passed in
  light/dark, with populated/empty catalogs, invalid-ID guards, rejected-change
  input retention, exact display, reopening, and cancel behavior.
- Desktop 115 tests, mobile 75 tests, both type checks, desktop lint/build,
  Expo Doctor 21/21, and Android/iOS production exports passed.

Run `KYBERN_FIXTURE_INLINE=1 KYBERN_FIXTURE_MODELS=1 node perf/reconnect-server.mjs`
from `apps/mobile` for the synthetic provider catalog and captured requests at
`GET /stats`. The fixture does not start agents or contact model providers.
These checks validate UI behavior and transport values, not access to a
particular model on an actual provider account. Screenshots are untracked in
`artifacts/custom-models-20260910/`. No release or EAS update was published.
