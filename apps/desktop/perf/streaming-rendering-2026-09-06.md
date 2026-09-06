# Streaming rendering follow-up — 2026-09-06

This follows the glass/transcript improvements in `591c265` and the peer source review in `2a4a1eb`. The synthetic fixture uses the real Markdown, smooth-stream hook, and message scroller with 120 historical messages and a growing 220-line TypeScript fence. No private conversation data is included.

## Changes

- Stable Markdown component types preserve code-block state. Memoized highlighted HTML also preserves its DOM when surrounding text changes.
- One lazy module worker performs Shiki tokenization outside the renderer thread. A cancellable queue limits pending work to 64 requests and 4 MiB of source; settled results use a 24-entry/4 MiB LRU. Unknown languages, oversized sources, and worker failures fall back to plain text.
- Growing fences highlight at 160–1,000 ms intervals according to source length. Existing prefix work can finish so continuous streams do not starve highlighting; final text is rendered immediately while final highlighting completes.
- Reveal commits are spaced by at least 32 ms except first/final catch-up. The underlying reveal timing remains frame-driven.
- Navigation previews cache bounded text prefixes and invalidate the affected message on mutation. Scroll-driven rail geometry updates coalesce once per frame.

## Native measurement

Run `node scripts/check-rendering.mjs` from `apps/desktop` on macOS. It builds a separate production fixture, loads it in WKWebView at `tauri://localhost` under the actual production CSP, reports JSON, and removes its temporary build. CI runs this after the native material checks. This is a synthetic native rendering comparison, not a whole-app CPU or battery measurement.

| Measurement | Before (2a4a1eb) | After |
| --- | ---: | ---: |
| Historical preview reads after warm-up | 540 | 0 |
| Code wrapper retained across 30 prose updates | 0/30 | 30/30 |
| Unchanged highlighted DOM and wrap setting retained | No | Yes |
| Prose update commit p95 | 8 ms | 5 ms |
| Streaming frame interval p95 | 187 ms | 19 ms |
| Streaming intervals over 25 ms | 10/74 | 1/134 |
| Code DOM mutations during growing stream | 77 | 5 |

The slower baseline produces fewer animation frames, so raw baseline/after render counts are not a useful comparison. In the isolated cadence comparison with the worker already enabled, adding the 32 ms commit interval reduced observed renders from 248 to approximately 128 over the same streaming period.

The final native run also passed exact final code, updated preview after a historical edit, first/last-message navigation, follow mode, and retained reading position during new output. All 84 unit tests, TypeScript, lint, production build, and native material checks are release checks.

## Limits

The transcript still mounts all top-level turns and expanded work. Very large histories can still benefit from virtualization; growing Markdown parsing and rail geometry still have work proportional to their inputs. Measurements depend on host load and do not promise 60 fps on every M1 configuration. The running production app was not replaced or restarted for these checks.
