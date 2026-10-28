# Desktop icon and interaction polish — 2026-09-19

Based on `origin/main` at `4bccf826` (v0.4.10). Applied better-ui,
better-writing, better-layout, better-typography and apple-design. Apple HIG
references: [Menus](https://developer.apple.com/design/human-interface-guidelines/menus),
[Motion](https://developer.apple.com/design/human-interface-guidelines/motion),
[Typography](https://developer.apple.com/design/human-interface-guidelines/typography).
The project's sentence case, density, icon adapter and popup materials remain
in use. The architecture/design documents referenced by AGENTS.md are absent
from this revision; the existing components and performance guide supplied the
local design conventions.

## Alignment and hierarchy

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM | `src/views/Thread.tsx:394`, `src/styles/kit.css:3031` | Fixed 224px menu, 18px icons pulled 2px toward the edge, widely tracked shortcuts | Content-sized menu with a 208px minimum, 16px icon column, 28px rows, aligned shortcuts and nested radii | Shared alignment makes actions easier to scan while preserving compact desktop density |

Native WebKit `materials` passed before and after the change under the production
CSP at `tauri://localhost`. At 1100px and 480px viewport widths, the real menu
primitive measured 208px wide with 28px rows and 16px icons. Dark/light modes,
keyboard focus, disabled/destructive rows, selection and dismissal passed.
Double-size text with RTL stayed within the popup. The existing context-menu,
submenu, opaque-material and command-list checks also passed. A settled popup
has `filter: none` and opacity 1; a 250ms screenshot caught its existing entry
blur, so the final screenshot waits until the transition finishes.

Runtime: macOS 27.0 (26A428), arm64, system WKWebView. Geometry measurements are
single synthetic fixture observations, not CPU, energy or whole-app performance
claims. Screenshots are kept out of commits in the original conversation folder
at `perf-artifacts/ui-polish-20260919`.

## Clear status and recoverable notifications

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM | `src/views/Transcript.tsx:1040` | Dim animated check and lengthy answered-question copy | Stable outlined status icon and “Answers submitted” with stronger text contrast; full label available on hover | Legible completion feedback and direct wording |
| MEDIUM | `src/views/Transcript.tsx:1040`, `src/views/Thread.tsx:394`, `src/views/Activity.tsx:133` | Generic work glyphs obscured terminal/agent differences | Requested Hugeicons ComputerTerminal01 and Robot01 through the existing adapter | Contextual icons identify the work at a glance |
| MEDIUM | `src/views/Thread.tsx:394` | Generic helper-group icon | Distinct spawned harness logos in the group preview; existing actual-harness logos in child rows retained | Attribution follows the spawned harness |
| HIGH (fixed) | `src/views/NotificationBell.tsx:32`, `src/state/notifications.ts:30`, `src/state/store.ts:394` | Failed or blocked statuses could keep the red bell ping permanently | Dismiss all hides current attention entries and persists dismissal cursors per environment; new sequences notify again | People can clear stale alerts without changing thread status or resolving pending approvals |

Notification unit coverage includes completed, failed and blocked entries,
reloading stale snapshots, newer failures and approvals, dismissing a later
failure again, completion re-notification, environment isolation and migration
from the prior storage version. Event-driven checks also cover rename/pin
updates whose payload sequence predates the event, replayed requests and
failures, and dismissing a newly received failure before its status projection
arrives. A newer snapshot received without its event history remains eligible
to notify, since the client cannot prove it was only an offline metadata edit.

## Stable motion and input metrics

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM | `src/views/Composer.tsx:855`, `src/components/kit/chat/composerPickerStyles.ts:246` | Native textarea carried a two-line minimum and 1.625 leading | One-line textarea with 1.4 leading inside a two-line frame; the blank frame area still focuses the input | More compact native caret metrics while preserving a generous editing target |
| MEDIUM | `src/App.tsx:192`, `src/styles/settings.css:2` | Workspace and settings both changed opacity during navigation | Opaque settings surface with a symmetric 8px, 300ms, bounce-0 spring; instant keyboard/reduced-motion paths | Avoids exposing an empty layer between fading full-window surfaces |

Matched native composer observations were editor/frame/line-height
`39/39/19.5 px` before and `17/33.59/16.8 px` after. The extreme caret height
in the user's crop was **not reproduced** in the native fixture. Input metrics
and screenshots improved, but that exact symptom is not verified as resolved.
The streaming-output cursor was left unchanged.

Native `settings` passed 27/27 checks in normal motion and 25/25 in forced
reduced motion, including a settled opaque layer, interrupted reversal, focus
restoration and overflow. Native `chat-collaboration` passed, including retained
editor geometry, blank-area focus and child navigation. Native `work-shell`
passed with 1,000 synthetic threads across 20 projects: Dismiss all cleared
completed, failed and blocked entries, newer failures reappeared, and activity
state transitions remained correct. These are fixture checks; production user
data and the running daemon were not changed.

Native `questions` and `composer-stack` also passed; the latter covers compact
controls, shared panel edges and accessibility material/motion fallbacks. The
composer-stack answer preview passed 60 layout samples, then rendered and
asserted the actual settled “Answers submitted” row and semantic icon; its native
screenshot was visually inspected. Mixed process/agent stacks were reviewed in
source, not directly asserted by a native fixture.

Desktop verification: 259 tests, typecheck, ESLint and production frontend build
passed. The final older-snapshot dismissal guard also passed the 10-test focused
notification suite. The build reported the existing large-chunk and mixed
static/dynamic-import warnings. No Rust/protocol or native packaging change.

Not verified: every intermediate width, actual screen-reader speech,
pseudo-localized translations, and playback in a browser animation panel at
10% speed or frame-by-frame sampling of the settings root transition. No whole-app CPU or energy claim is made.

Approve for the inspected scope; the exact oversized-caret symptom remains Not verified.

Follow-up visual revision: replaced the submitted-answer glyph with Hugeicons
CheckmarkCircle04, retaining the cached icon adapter. Harness marks now use
20px circular frames with a 2px separator matching the composited composer
rail surface; the marks are 16px and overlap by 4px. The terminal activity
icon receives a local 1px downward optical adjustment; shared row geometry
is unchanged. Revised native answer/activity and helper screenshots were
visually inspected. Typecheck and the native helper fixture passed.
Follow-up verification also passed ESLint, the production build, diff-check,
and all 60 native composer-stack layout samples. Existing build warnings remain.

Final requested glyph: CheckmarkSquare04 replaces CheckmarkCircle04 for submitted answers.
