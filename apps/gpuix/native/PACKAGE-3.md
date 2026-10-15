# Native package 3: cached scrolling and decorated inputs

Worktree: `/Users/mymac/projects/ade-gpuix-native`, branch `gpuix/native`.
Fast-forwarded `feat/gpuix-mvp` from `c97c570e` to `7928d797` before implementation.
All deliverable changes are uncommitted and confined to `apps/gpuix/native/**`
and `apps/gpuix/src/native/**`. No branch switching, push, stash or rebase.
No dependency changes.

## Results and API

1. **Cached scrolling fixed.** A pending scroll now explicitly notifies all owning
   island entities before root invalidation. Root construction no longer clears
   pending offsets before cached descendants build: unused requests are cleared
   after the draw. The existing after-child-splice application order is retained.
   A 48-row list nested under `cache="fill"` and a second cached island moves its
   logical top from row 0 to row 35 and stays there through an unrelated update.
   Dark and light checks pass. TaskWindow's effect-local pre-mount `setRange` can
   be removed; keep normal visible-range overscan and focused-row mounting.

2. **Styled runs and atomic editing implemented.** Foreground/background, weight,
   italic and underline render inside the real native editor. Background paint
   runs before the selection wash. Atomic spans govern selection, caret travel,
   deletion and explicit edits. Untouched ranges rebase, intersected ranges drop,
   and native undo/redo snapshots restore ranges and IDs together with text.
   No parallel JS edit buffer or hidden placeholder text is introduced.

```ts
// Already-existing API, now correct under cached ancestors:
scrollToItem(elementId: number, index: number, offsetInItem?: number): void
getListScrollTop(elementId: number): number[] | null

// New renderer methods, typed and checked by decoratedInputCapabilities(renderer):
setInputDecorations(elementId: number, decorations: InputDecoration[], expectedValue: string): void
hitTestInputDecoration(elementId: number, x: number, y: number): string | null

interface InputDecoration {
  start: number; end: number // UTF-16; surrogate splits reject
  id?: string
  atomic?: boolean
  style?: {
    color?: string; backgroundColor?: string
    fontWeight?: number; fontStyle?: 'normal' | 'italic'; underline?: boolean
    borderRadius?: 0; paddingX?: 0
  }
}
```

`expectedValue` is deliberately required to prevent a stale React effect from
applying ranges to newer native typing. The full contract, validation, range
transforms and hit-test semantics are in README. Decoration changes add no undo
step and do not break native typing coalescing. Native explicit edits still form
one undo step. Secure/composing/unmounted inputs reject decoration updates.

**Limits:** backgrounds are rectangular. Nonzero radius/padding throws; there is
no claim of Tauri pill parity. No replacement labels, hidden Markdown delimiters,
inline React views or per-run font-family override. Atomic editing does not make
text unbreakable for wrapping. The Markdown adapter is deliberately source-mode
and limited to simple single-line marks/links. A real OS IME candidate/commit/cancel
session remains unverified: the implementation preserves native marked-range
replacement/undo and bypasses atom snapping while composing, but synthetic key
tests are not an IME certification.

## Exact app integration

`native/app-integration-3.patch` is an **unapplied** unified diff against 7928d797.
It passed `git apply --check` and TypeScript checking through an in-memory compiler
host. No app source was written to validate it. Runtime app-integration verification
remains for the parent after applying it.

```sh
git apply --check apps/gpuix/native/app-integration-3.patch
git apply apps/gpuix/native/app-integration-3.patch
```

- `src/Composer.tsx` (the editor consuming `src/composer/Completion.tsx`) uses
  `DecoratedTextarea` and `referenceDecorations` for known completion tokens and
  attachment tokens, including @Computer. Plain arbitrary @text does not become
  a reference. Existing completion refs, send serialization, editor ref and native
  edit/selection logic stay in place. Tokens gain rectangular background, weight
  and atomic editing. No fake rounded pills or extra spacer characters.
- `src/notes/NoteEditor.tsx` uses `DecoratedTextarea` for compact and active block
  editors with `markdownInputDecorations`. Bold/italic/code/link marks render while
  editing; task links become atomic spans mid-sentence. Source delimiters and URLs
  remain visible. Existing block storage, toolbar behavior and saves remain.
- `src/tasks/TaskDetail.tsx` uses the same adapter for the description textarea;
  task links are atomic without changing `composeTaskBody`/criteria serialization.
- `src/tasks/TaskWindow.tsx` removes the single eager `setRange` call immediately
  before `scrollToItem`. Its `onVisibleRange` path and focused row remain mounted.

The adapters are actual delivered sources in `src/native/`, not placeholders.
`DecoratedTextarea` uses an existing post-paint bounds observer for native mount
readiness, forwards ordinary props/refs and retries on edits/key-up without polling.
Its mount/atomic behavior is tested in the new lab. Link activation is intentionally
not coupled to ordinary caret clicks; consumers can query the hit API for their
chosen activation gesture.

## Validation

Final signed native binary passed:

- All six core scripts: islands, deferred overlays, native keys/close/drag-region,
  secure input, code wrapping and native motion.
- Dark/light original capability checks: UTF-16 selection, transactions,
  undo/redo, stale edits, fonts, cached selection and virtual rows.
- New dark/light decoration checks: actual styled output; mounted React adapter;
  identified-span hit tests; malformed UTF-16, unsupported geometry and stale
  updates reject; caret skips atoms in both directions; whole-atom deletion;
  undo/redo restores atom identity; Unicode prefix insertion rebases ranges;
  partial explicit edit replaces the whole atom; nested cached 48-row scroll.
- All package 2 layout/syntax checks: resize/clipping/cache/replacement/virtual
  observation, spring velocity, whole/ranged pixel comparisons, syntax lifecycle,
  Unicode copy/remount/revisions/bounds/release, and 70,003-line bounded rendering.
- `native/fixture.ts bun scripts/combined-pointer-check.ts`: Settings pointer and
  Space, sidebar thread, titlebar dock toggle, entrance, Notes and collapse.
- Standalone spring tests: 2 passed.
- `pnpm typecheck`, `pnpm exec tsc -p native/tsconfig.json`: passed.
- `bun test ./src`: **36 passed, 387 assertions**, no failures.
- Unapplied integration patch clean apply and in-memory typecheck: passed.
- Notification subprocess probe: passed after updating its stale assertion.
  The merged packaged-host notification adapter returns `false` for unsupported
  sends, while the old test expected rejection. Only that expectation/reason check
  changed. No permission request or notification was posted. The probe still
  establishes unbundled failure versus bundled center availability, not delivery.

Each successful rebuild ran the prior capability scripts and scratch pointer check.
The first build attempt failed compilation and produced no replacement binary.
The first successful build's suite stopped on the new lab's text-color typing;
after fixing it, the remaining suite and scratch pointer check were completed
before the next rebuild. The final rebuild ran the entire suite successfully.
The final expanded decoration fixture was rerun after its last additions.

Reviewed dark/light screenshots:
`/Users/mymac/projects/ade/previews/gpuix/p1c/decorations-dark.png` and
`decorations-light.png`. They show colored references with real background
rectangles, bold, italic, code background and link underline in the input.
Physical AppKit dragging, external AX and real IME remain outside these synthetic
checks, as in earlier packages.

## Full-app performance

Apple M1, macOS 27.0, Bun 1.4.0, GPUIX 0.10.0. Each independent full-app launch uses
a new scratch daemon and an empty settled thread/composer, 1280×820 background
window, **10 s warmup + 15 s sample**. One fixture window at a time. App integration
patch is not applied in either condition. Same workload as package 2.

| Sample | Process CPU | Physical footprint | Process Metal time / 15 s |
| --- | ---: | ---: | ---: |
| Before 1 | 2.80% | 178 MiB | 0.9 ms |
| Before 2 | 2.87% | 181 MiB | 2.1 ms |
| After 1 | 2.13% | 155 MiB | 3.5 ms |
| After 2 | 3.00% | 157 MiB | 2.2 ms |

Mean CPU **2.835% → 2.565%**, footprint **179.5 → 156 MiB**; no meaningful CPU or
footprint regression observed. Mean Metal time **1.50 → 2.85 ms / 15 s** is an
absolute increase of 1.35 ms, below what these noisy, low-activity samples can
attribute confidently. Do not report it as zero or claim a proven speedup.
Concurrent system work, occlusion and process-launch variation limit precision.
These are not sustained typing/streaming, frame interval, commit, latency or energy
measurements. No continuous timer was introduced by this patch.

Reproduction:
`NATIVE_PERF_WARMUP=10 bun src/shell/verify.fixture.ts bun scripts/native-perf.ts label`

## Follow-up estimate: rounded/padded Tauri-style chips (no implementation)

This estimate is based on the pinned GPUI source in `native/upstream/zed/`, plus
current GPUI text-system docs fetched through Context7. The pinned source is the
integration authority; current docs can differ from that fork. Relevant public
reference: [GPUI text lines and background paint](https://docs.rs/gpui/latest/src/gpui/text_system/line.rs.html).

**Radius without layout padding is small.** GPUI's `TextRun` in
`zed/crates/gpui/src/text_system.rs` becomes `DecorationRun` in
`text_system/line.rs`; `paint_line_background` currently emits rectangular `fill`
quads. Carry a radius (and a span boundary/identity so adjacent same-color atoms
are not merged), then emit rounded quads for each visual fragment. Glyph shaping,
advances, byte offsets and wrapping need not change. Decide whether wrapping rounds
every fragment or only external ends; preserve content-mask clipping, background
before selection, IME underline and caret. Estimate **1–2 engineer-days including
fixtures**, low-to-medium risk. An input-local background painter using existing
wrapped geometry could avoid modifying GPUI's shared `TextRun` API altogether.

**Real `paddingX` is layout work.** A chip needs extra advance before/after its text,
so paint-only expansion is insufficient. The likely seams are:

- GPUI `text_system.rs`: run metadata and shape/cache inputs; introduce spacing
  in the layout result rather than adding real spaces or fake code points.
- `text_system/line_layout.rs`: `LineLayout`/`ShapedGlyph` positions and total width,
  byte-index-to-position and inverse hit tests (`x_for_index`,
  `closest_index_for_x`, `WrappedLineLayout::position_for_index`,
  `closest_index_for_position`). Cache keys must include geometry-bearing spans.
- `text_system/line_wrapper.rs`: wrapping must account for the extra advances;
  define whether a chip is one unbreakable inline box and what happens when it
  is wider than the viewport. Wrapped line starts/ends need consistent padding.
- `text_system/line.rs`: glyph/background/underline origins must consume the same
  padded geometry, including alignment, clipping and wrapped fragments.
- GPUIX `packages/native/src/custom_elements/input.rs`: caret, selection quads,
  mouse hit tests, scroll-to-caret, content-width measurement and IME candidate
  range bounds must all use that same mapping; atom halves map to before/after.

Padding **can** be represented as layout spacing while retaining original UTF-8
indices and unchanged text/undo. It needs an explicit boundary map: merely shifting
subsequent glyph x coordinates makes the caret at an atom's start ambiguous (before
padding versus before the first glyph) and can break inverse hit tests. Glyph
clusters/ligatures crossing span boundaries, bidi order, emoji/combining marks,
selection across wraps, RTL padding, zoom/scale, and IME geometry are the main risks.
A dedicated inline-box layout adapter in the input is another option, but must
still provide every index/geometry query consistently. Neither approach requires
changing the stored text or undo format.

Estimate **4–7 engineer-days implementation plus 3–5 days verification** for a
robust version (roughly 1½–2½ weeks); medium-high risk, especially wrapping,
complex scripts and IME. This is an engineering estimate, not a measured schedule.
The native build currently reconstructs patches in `packages/native/src`; a shared
GPUI implementation also needs a reproducible anchored patch stage for the Zed
submodule files, rather than leaving edits only in disposable upstream output.

**Cheaper visual equivalent:** paint a rounded quad with a small horizontal outset
behind each span, using existing glyph/wrap bounds. This can stay input-local,
leave caret/hit testing/IME math untouched, and take **1–2 days with visual checks**.
It does not reserve width: backgrounds may extend into existing whitespace, collide
with adjacent glyphs/chips or clip at the input edge. Restricting the outset to the
available neighboring gap is safer. Expose it as visual background outset, not
honest layout `paddingX`; it cannot establish Tauri spacing parity. Radius-only
backgrounds with zero outset are the lowest-risk first step.

## Binary and cleanup

Binary:
`/Users/mymac/projects/ade-gpuix-native/apps/gpuix/native/build/gpuix-native.darwin-arm64.node`

SHA-256:
`e777867ebacb1d0059c6b84faca1a058ae3f0dbb4704080ce871c69ce80a0aaa`

The binary is LINKEDIT-aligned, ad-hoc signed and load-checked. Free volume space
was **71 GiB before, 70 GiB after**, always above 30 GiB; other tasks were active.
Retained by explicit request: existing native build/target **1.9 GiB**, upstream
**185 MiB**, reused node_modules **303 MiB**. No second build directory or daemon
build was created. Scratch fixtures remove their daemons/data themselves; no
process from this task remains. Other tasks' scratch daemons were left alone.
Disposable notification bundles, integration compiler input, redundant new lab
screenshots and spring test executable were removed after preserving evidence.
Normal user data, installed app and port 4219 were not used. **No commit.**
