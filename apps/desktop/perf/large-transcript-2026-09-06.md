# Large transcript and Markdown scaling — 2026-09-06

This completes the work tracked in [issue #1](https://github.com/Tresnanda/kybern/issues/1) for v0.2.0. The comparison uses the production React components in native WKWebView on an Apple M1 with 16 GB RAM. The baseline is v0.1.9 (`7643958`); all input is generated fixture data.

## Changes

- Transcript turns, large expanded work groups, and focused agent activity use measured virtual rows in their existing scroll container. Small work lists stay in normal flow. Selection and keyboard focus pin their rows; small user choices such as tool expansion and code wrapping survive virtual unmounts.
- Rail entries come from transcript data, including offscreen messages. Active-message lookup uses the virtual row index and at most the visible turn’s two message rectangles. Long rails also virtualize their ticks and support Home, End, arrows, and Page Up/Down. Fixed tick geometry avoids persistent scroll reconciliation, and the long rail starts its content at the top rather than centering overflowing content.
- Large Markdown runs in a module worker. Appends reparse the final top-level construct and reuse completed blocks. Potential reference/footnote definitions and edits take the complete-document path so earlier links remain correct. Rendering retains stable block objects, and only the live tail receives word animations.
- A bounded queue coalesces superseded consumers and lets an active prefix finish. The worker retains at most 16 parser sessions; settled Markdown uses a 24-document cache. Both use an approximate 8 MiB budget, and pending source is limited to 64 jobs/8 MiB. Small first responses render synchronously; uncached large first responses remain readable as text while formatting loads. Subsequent updates retain the prior tree until the worker returns. Unsupported workers or oversized queued input fall back to readable source.
- The worker uses the same GFM, HTML-as-text, and URL policy as the original renderer. Vite resolves the character-entity decoder’s DOM-free entry in both development and production: its browser entry calls `document.createElement`, which fails in a worker. The native tests verify actual formatted output, not merely the readable fallback.
- Sidebar context menus and their submenus now share the existing translucent popup material: 64% surface tint and one 16 px blur layer. They were missing from the popup selectors, leaving a transparent surface without blur. Opaque and accessibility fallbacks remain covered.

## Measurement

The scaling fixture has 400 historical turns with eight Markdown sections each, followed by a turn containing 800 file-read tools. It samples 90 scroll positions, expands the work group, then streams a roughly 46,000-character answer containing 180 GFM tables for 2.3 seconds. A text input receives an event every 80 ms during that stream.

| Measurement | v0.1.9 baseline | v0.2.0 local runs |
| --- | ---: | ---: |
| Initial React mount commit | 902 ms | 47 ms |
| Mounted history messages | 802 | 8 |
| History DOM nodes | 37,265 | 453 |
| Message rectangle reads during scrolling | 72,180 | 88 |
| Scroll frame interval p95 | 66 ms | 23–24 ms |
| Scroll intervals over 25 ms | 90 / 90 | 3–4 / 90 |
| Open-work commit | 146 ms | 18–19 ms |
| Mounted expanded tool rows | 800 | 25 |
| Expanded DOM nodes | 50,883 | 746 |
| Streaming frame interval p95 | 105 ms | 18–19 ms |
| Streaming intervals over 25 ms | 24 / 36 | 0 / 139 |
| Input event to next frame p95 | 165 ms | 15–16 ms |
| Final React update commit | 69 ms | 2 ms |

The final check requires the exact final marker **and all 180 rendered tables**. The input probe checks dispatched events, subsequent frames, and the number of timer ticks delivered; it is not an OS-level key-to-screen latency measurement. Mount and final commit timings measure synchronous React work, with worker formatting checked separately. These synthetic results do not establish whole-app battery use or a universal frame-rate guarantee.

The existing 220-line streaming code-fence fixture also passes: 30/30 unchanged code wrappers and highlighted DOM retained, wrap state preserved, exact final code, no repeated historical preview reads, and bounded highlight/reveal work.

## Regression coverage and reproduction

From `apps/desktop` on macOS:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
node --experimental-strip-types scripts/check-window-material.mjs
node scripts/check-rendering.mjs
node scripts/check-rendering.mjs materials
node scripts/check-rendering.mjs scaling
node scripts/check-rendering.mjs interaction
```

The rendering runner builds each fixture separately and uses the real production CSP at `tauri://localhost`. The fixtures are excluded from the shipped application; temporary builds are removed automatically. For a baseline rerun, copy `perf/scaling.html`, `perf/scaling.tsx`, `perf/vite.config.ts`, and the two `check-rendering` scripts into an isolated v0.1.9 checkout. Its structural and responsiveness assertions are expected to fail while still reporting the baseline metrics.

All 92 unit tests pass locally. Differential Markdown tests compare the incremental renderer with a full ReactMarkdown render at every character boundary and across mixed appends/edits, including lists, fences, tables, references, footnotes, raw HTML, URLs, CRLF, tabs, and Unicode. Queue tests cover cancellation, worker failure, and memory limits. Navigation tests cover all historical entries, prepends, edits, and stable live prefixes.

Native interaction checks cover visible first/middle/last rail targets; selection and focus retention/release; code wrapping; reading position while output arrives; prepended history; expansion across tool and turn unmounts; resize; thread isolation; following new output; and reaching the final entry in an 800-tool agent activity view. Menu tests cover dark/light main menus and submenus, opaque mode, keyboard focus, action dispatch, and closing. The window-material check also covers reduced transparency and increased contrast. These native suites run in macOS CI.

Individual very large Markdown constructs still require work proportional to that construct inside the worker. Reference definitions can require a full parse, and cold formatting is asynchronous. Virtualization reduces mounted UI work; it does not discard transcript data. The running production app was not replaced or restarted during validation.
