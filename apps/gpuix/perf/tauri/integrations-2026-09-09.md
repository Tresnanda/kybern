# Connectors and native Claude artifacts — 2026-09-09

Implemented provider-owned integration management and native Claude artifact
receipts, previews, and publication controls. Desktop opens Integrations in
Settings and Artifacts in the dock. Mobile exposes both through the conversation
menu and integration management through the capability picker. CLI commands cover
all six new RPCs. The existing prompt/Notes/performance changes remain intact.

## Verification

- `cargo test --workspace`: 213 passed, 2 ignored; the added preview-expiry
  regression also passed separately. Native cloud publication and
  real plugin installation are not part of these tests.
- `cargo fmt --all --check`, workspace clippy with warnings denied, and protocol
  snapshot review/update passed. Six additive methods retain separate read,
  orchestration-operation, and terminal-operation scopes.
- Desktop: 111 tests, TypeScript check, lint, production frontend build passed.
  Existing Vite chunk-size/dynamic-import notices remain.
- Mobile: TypeScript check, 40 tests, Expo Doctor 21/21, Android and iOS exports
  passed. No native dependency or configuration change was introduced.
- `node scripts/check-rendering.mjs integrations`: production components in
  native macOS WebKit at `tauri://localhost`, under the production CSP. Both light
  and dark themes pass. The fixture mounts only 40 of 85 plugin entries initially,
  reveals another page on request, hides unavailable actions, forwards mutations,
  recovers from provider errors, and keeps the existing OAuth terminal instead of
  recreating it. Sign-in URLs and redirect submission are exercised with synthetic
  provider output. Republish preserves the native returned URL.
- HTML previews in that fixture come from a real scratch daemon. Scripts run in
  an opaque sandbox origin, cannot read the parent document, and preserve their
  counter across Source/Preview toggles. HTTP tests assert no network access in
  the CSP, no-store responses, ticket expiry/single use, workspace confinement
  including symlink escape, and bounded receipt pagination. Repeated completion
  events do not duplicate gallery rows.
- iPhone 17 Pro, iOS 27 simulator, Expo Go 57.0.9: real scratch daemon pairing,
  provider catalog rendering, local HTML preview, source inspection, and retained
  interactive state exercised. The counter continued from 1 to 2 after toggling
  source. The temporary connection was removed after testing. Android runtime
  interaction was not exercised; Android evidence is tests and bundle export.

Desktop and simulator checks ran on this Apple M1 Mac with macOS 27. These are
functional/rendering checks, not frame-rate, CPU, energy, or battery benchmarks.
No performance claim is inferred from them. Screenshots are local review
artifacts, outside the committed source.

## Provider boundaries

Claude Code 2.1.266 was inspected; native Artifact input and the publication
workflow were checked against the current official [SDK tool definition](https://code.claude.com/docs/en/agent-sdk/typescript)
and [artifact documentation](https://code.claude.com/docs/en/artifacts). Codex
management parameters came from the installed app-server's generated JSON schemas.

Kybern sends publication through a normal Claude turn and its approvals. It never
invents a publication URL from assistant prose or treats a failed receipt as
published. HTML/Markdown are native publish inputs; the prompt asks Claude to
prepare other formats when needed and preserve capabilities and version history.
Local previews are capped at 1 MB and HTML/SVG previews cannot fetch network
resources. Live connectors run on Claude's hosted page.

Share and version controls open the hosted Claude page. Kybern does not implement
a separate account-sharing/version-management API or clone every Claude web UI
control. Account eligibility, native CLI availability, and provider restrictions
still apply. Codex installations requiring its native interstitial remain in
Codex; new Claude installations use its native user scope. No custom MCP
configuration editor was added.

No real-account publication, plugin installation, OAuth grant, release, desktop
replacement, or mobile OTA update was performed. Provider mutation tests use
synthetic executables/catalogs. Existing user daemon data and installed clients
were preserved.

## UI follow-up

Applied the requested better-ui, better-layout, better-writing,
better-typography, animate-expo, and mobile-ios-design guidance to the
integration screens. Mobile provider/category controls now wrap, announce
selection, and avoid spatial press motion for routine filtering. Plugin titles
use the existing label hierarchy; rows retain spacing and Dynamic Type.
Desktop names/descriptions wrap long identifiers, and provider/project selection
is disabled while an integration mutation is pending. Both surfaces explain
Codex @ mentions versus Claude /plugin:skill commands and give a next step in
empty/offline states. Android continues to use custom primitives and the shared
liquid-style navigation surfaces; no native Android controls were added.

Both clients' typechecks, desktop lint, focused composer/capability tests, and
the native WebKit integration fixture (light/dark) passed after this follow-up.
Physical iPad testing is being prepared separately; no motion/performance claim
is made from the source audit or WebKit checks.
