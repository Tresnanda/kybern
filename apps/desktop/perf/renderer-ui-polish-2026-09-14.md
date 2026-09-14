# Profile and diagram UI polish

Follow-up to the [renderer fixes](renderer-followups-2026-09-14.md), in the same isolated worktree, based on `77686ab`.

## Changes

OMP profiles now use explicit **Use environment**, **OMP default**, and **Named profile** choices. The default remains visible; project overrides live in one disclosure with a configured-project count. Named inputs appear only when needed. Short hints describe new-chat and worktree behavior, while grouped labels and aligned controls replace the previous paragraphs. The card changes to one column when space is limited, and project names retain their full accessible text. Escape discards input and returns focus to its selector.

Mermaid blocks now have a **Preview / Source** switch, a restrained sliding selection indicator, and an **Expand diagram** action. The larger view uses the existing dialog, closes with Escape, and restores keyboard focus. It shares the finished SVG image URL; opening it does not create another renderer. The transcript preview has a bounded height, with full-size viewing available through expansion. Copy still returns the exact source. Unavailable previews keep readable source and a short status message.

The changes reuse Kybern's settings, menu, disclosure, dialog, typography and motion primitives. They add no dependencies, animation loops, backdrop layers, or renderer caches. The prior history paint boundaries, worker limits, retention improvements and opaque composer fix remain in place.

## Verification

Desktop: 134 tests, typecheck, lint and production build pass. The final fixture matrix passed in system WKWebView at `tauri://localhost` under the production CSP, on Apple M1 / 16 GiB / macOS 27.0 (26A5416b). The same functional checks also passed in the locally installed headless Playwright WebKit over loopback HTTP with the application's CSP. Native screenshots were reviewed in light/dark, narrow and enlarged-text layouts.

- Profiles at 1100px dark, 480px light, and 360px RTL with 150% UI text: save, explicit unnamed/default behavior, inheritance, preservation of unrelated provider settings, cancellation/focus, project selection, and closed-content unmounting passed. Controls stayed inside the viewport.
- Mermaid at 1100px dark and 480px light/RTL: six diagram families in both themes, exact source/copy, stable settled images, invalid/incomplete fallback, image-URL cleanup and idle renderer release/restart passed. Expanded images reused the same URL, dialogs fit the viewport, and Escape restored focus.
- Shared rendering and interaction checks passed: 30/30 historical code wrappers retained identity, exact final text and wrap state survived streaming, and keyboard focus, selection, navigation, reading position and follow controls remained functional.
- Both disclosure and diagram selection passed a mid-animation reversal at 10% speed using fixture-only CSS durations. Emulated reduced-motion CSS disabled the selection animation.

An earlier native run was interrupted by the Mac locking: WebKit reported a hidden page and paused timers. All native cases were rerun successfully after unlock. Temporary diagnostic changes to the native harness were removed.

The native rendered-history memory guard also passed, with no builds running during sampling:

| Measurement | Prior renderer follow-up | UI polish rerun | Guard |
| --- | ---: | ---: | ---: |
| History-stage peak physical footprint | 416.9 MiB | 406.9 MiB | 768 MiB |
| Full stress-sequence peak physical footprint | 801.1 MiB | 858.0 MiB | 1024 MiB |

The sequence sampled 1,600 nonempty frames across cold/warm/fast history, mixed work, streaming, expanded thinking/tools and long code. Frame-interval p95 was 17–18 ms per stage. Separately, the Markdown rendering fixture measured 1 ms explanation-commit p95 and 18 ms streaming frame-interval p95. No CPU, energy or OS input-latency measurement was taken for this UI pass.

Native allocations vary; these single-run figures do not establish a memory change attributable to the UI polish. The guard covers this isolated stress workload and does not impose a whole-application RAM cap.

To repeat the native cases from `apps/desktop`:

```sh
node scripts/check-rendering.mjs profiles
KYBERN_PERF_WIDTH=480 VITE_PERF_THEME=light node scripts/check-rendering.mjs profiles
KYBERN_PERF_WIDTH=360 VITE_PERF_RTL=1 VITE_PERF_TEXT_SCALE=1.5 node scripts/check-rendering.mjs profiles
node scripts/check-rendering.mjs mermaid
KYBERN_PERF_WIDTH=480 VITE_PERF_THEME=light VITE_PERF_RTL=1 node scripts/check-rendering.mjs mermaid
node scripts/check-rendering.mjs rendering
node scripts/check-rendering.mjs interaction
node scripts/check-rendering-memory.mjs
```

Keep the Mac unlocked and the test window visible during native checks. Screenshots and headless runner/results are stored outside git in the conversation's `.artifacts/renderer-ui-polish/` folder.
