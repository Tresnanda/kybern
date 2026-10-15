# Native diff parity (package 6)

Work is uncommitted in `ade-gpuix-native`, branch `gpuix/native`. Resumed work
fast-forwarded to `feat/gpuix-mvp` aee5df84 without discarding local changes.

## API and implementation

`src/native/diff.ts` exposes `DiffStyle` through `theme.diff` and
`desktopDiffTheme(theme, fileHeaders = true, size = 13)`.
Controls cover separate row/gutter washes, number/text colors, gutter font,
padding and digit sizing, context/deletion markers, header/notice suppression,
syntax opt-out, table layout, horizontal scroll and scrollbar, and expansion size.
Existing native defaults remain available. Desktop uses plain unified text:
omit `wordDiff`, disable syntax highlighting. Neither split view nor intraline
highlighting is offered by the desktop reference.

`src/native/DiffView.tsx` exports `NativeDiffHeader` and `DesktopDiff`.
Headers use desktop file icons, filename/directory, stats, status and collapse.
They remain outside horizontal scrolling. The wrapper expands in 600-line
batches and uses bounded native scrolling for large files. Context gutter clicks
report LEFT for the old number and RIGHT for the new number.
Rust patches are `patches/diff_hooks.py`, `diff_style.rs`, `diff_layout.rs`;
`apply_hooks.py` and `update.sh` include the new capability.

## Integration

`app-integration-6.patch` is intentionally unapplied. It updates PR Changes,
dock Diff, and transcript inline diff rendering. Refreshed against aee5df84;
`git apply --check` and `bun native/check-integration-6.ts` both pass.
No application files outside `src/native` were edited directly.

## Visual evidence and checks

Evidence directory: `/Users/mymac/projects/ade/previews/gpuix/p1f/`.
- `diff-{dark,light}-gpuix.png` and `diff-{dark,light}-tauri.png`: native versus
  actual desktop FileDiffCard rendered by Playwright WebKit, 728 × 800 at 2×.
- `diff-scroll-{dark,light}.png`: END_OF_LONG_LINE is visible at the right end;
  header stats and collapse remain in place.
- `check.log`: dark/light anchors, collapse/reopen, 600-line expansion and
  30,000-line bounded paint (137 initial / 140 final fragments, last line reachable).

Both appearance pairs were regenerated and inspected after resuming. They match
plain unified text, row/gutter washes, line-number columns, markers, hunk labels,
file icons and header structure. Remaining differences: fractional table-border
rounding and small accumulated vertical offsets, header text rasterization and
weight, native rounded-corner clipping, and slightly different scrollbar thumb
geometry. This is not pixel-identical WebKit rendering. The scrollbar is a native
presentation; screenshots verify horizontal wheel reachability, not every physical
trackpad gesture. Large source parsing remains whole-document; bounded paint does
not mean bounded source memory or constant initial parsing cost.

The final rebuild before interruption completed the full update.sh capability
suite, syntax/selection/lifecycle checks, both spring tests, and scratch-daemon
combined-pointer-check (preserved `diff-build-4.log`). No native sources changed
after that build, so no redundant rebuild was run. On resume: diff-check,
application tsc, native tsc, integration virtual typecheck and `bun test ./src`
all pass (43 tests, 402 assertions).

## Performance

Recovered complete before/after logs from the interrupted run, copied alongside
the images. Each of two independent launches has a 10 s warm-up and 15 s sample.
Fixture: idle, background 30,000-line diff; Apple M1/macOS 27, Bun 1.4.0,
GPUIX 0.10.0. CPU is process CPU-time delta; memory is physical footprint.

| Sample | CPU | Footprint | Metal time / 15 s |
| --- | ---: | ---: | ---: |
| Before 1 | 1.93% | 147 MiB | 0 ms |
| Before 2 | 1.80% | 147 MiB | 0 ms |
| After 1 | 0.80% | 137 MiB | 0 ms |
| After 2 | 1.00% | 139 MiB | 0 ms |

No idle regression is observed (means 1.865% → 0.90%, 147 → 138 MiB).
Occlusion and concurrent agents limit comparison. Zero measured Metal time is
not evidence of zero GPU work in a visible interactive window. These samples do
not measure active scrolling, frame intervals, input latency, energy, or streaming.
Before logs are inherited evidence; the original pre-change binary was not rebuilt
or reconstructed during resume.

## Build and disk

Binary: `/Users/mymac/projects/ade-gpuix-native/apps/gpuix/native/build/gpuix-native.darwin-arm64.node`.
61 GiB free at resume; retained incremental build is 1.9 GiB, upstream 185 MiB.
Retained at the parent's explicit request for integration and further native work.
No new dependencies, target directories or native build were created during resume.
Fixture processes close themselves; the inherited diff WebKit Vite server is
stopped at handoff. User app/data and port 4219 are untouched.
