# Conversation parity continuation — 2026-10-15

Worktree: `/Users/mymac/projects/ade-gpuix-transcript`, branch `gpuix/transcript`.
Inherited 25 changed/new files at `007f4481`. Fast-forwarded `feat/gpuix-mvp`
to `b311b6a4` without stashing, committing or discarding inherited edits.
Copied the current native module and installed the frozen lockfile. All source
changes remain uncommitted, limited to package 3 ownership. No push.

## Inherited and preserved

- Coordinator starter/opening message, idle harness switch, disabled-send hints.
- Notes/tasks/Computer completion and per-draft reference metadata.
- Enter interception fixing the completion/send race.
- Individual activity panel presence, clamped subagent prompt, bounded Markdown memoization.
- Word-boundary/visibility-aware streaming reveal and exact settlement.
- Visual browser/source entry point and explicit Mermaid-source fallback.
- Save-to-note fixtures and per-run scratch/config isolation.
- Earlier-history top-entry intent and keyboard-operable message navigation.

## Finished in this continuation

- Completion reads native UTF-16 selection, works in the middle of a draft,
  preserves the suffix and avoids duplicate separating spaces. Arrow navigation
  now reaches the composer through interception; a bounded 32ms selection read
  follows the native default movement. Ordinary editing and native undo remain
  owned by the input. No continuous caret polling.
- Completion inserts through `editInput(expectedValue)` as one undo step.
  Reference metadata is adopted only after a successful transaction. Menu
  replacement is suppressed for ranges/IME composition; send checks live marked
  composition too. Native real-IME candidate selection still needs manual testing.
- Reference chips for files, threads, notes, tasks and Computer. Clicking a chip
  selects its exact token using native selection, so deletion/replacement stays
  in native undo history. These are **above-editor chips**, not inline rich atoms.
- Text-paste notification and successful attachment feedback; file drop shares
  the normal upload/error path. Clipboard-image extraction and drag-enter
  highlighting remain absent from the exposed composer API.
- `useComposerOverlayHeight()` is a measured external store, zero when absent.
  Producer-owned numeric-ref observers avoid native missing-test-ID failures.
  `useMeasureComposerOverlay(priority)` registers a mounted surface; priority 1
  full-stack measurement overrides the priority 0 card. No timers.
- Searchable message navigation, active-row indication, and keyboard activation;
  full message indices remain stable after filtering.
- Subagent entry uses layout-neutral native `translateX` instead of `left`.
  Outgoing-page retention is **not implemented** (see below).

## Integration patch and outstanding boundaries

`src/composer/app-integration.patch` is a valid, `git apply --check`-verified patch
against this base. It imports `useMeasureComposerOverlay`, calls
`useMeasureComposerOverlay(1)` unconditionally in `HomePage`, and attaches its ref
to the absolute bottom wrapper containing requests, composer/subagent bar and
16px gutter. App.tsx was not edited.

Package 5 can import `useComposerOverlayHeight` from `Composer.tsx` or
`composer/height.ts` and add it to bottom-corner clearance. Before the App patch,
only the card plus its queued/tray children is measured. The full-stack patch
also handles a blocking request replacing the composer.

Retaining old React children inside `SubagentPageMotion` alone would paint the
new conversation twice: Transcript, paced blocks, request panels and composers
read global selected/open state. Safe outgoing retention requires a per-page
frozen state context/snapshot (including paced blocks and action suppression),
or native retained display content, plus shell integration. No speculative
state.ts changes or duplicate live page were introduced. Keyboard navigation
remains instant; pointer entry remains 220ms with Reduce Motion handling.

Native input has selection/atomic editing but no inline token-span model.
Full inline rich-editor parity therefore remains open. Mermaid is readable,
copyable source with an explicit unavailable-preview label. HTML visuals open
through daemon frame tickets in the browser and offer bounded source; embedded
HTML hosting belongs to package 5/native. Those fallbacks are not 1:1 parity.

## Verification

Artifacts and raw logs: `/Users/mymac/projects/ade/previews/gpuix/p3/`.

- `pnpm typecheck`: passes.
- `bun test ./src`: 22 pass, 0 fail, 342 assertions across 8 files.
- Native conversation, dark/light: notes/tasks/Computer wire parts; atomic
  completion undo/redo; middle-of-draft suffix preserved exactly; measured
  overlay grows when chips appear; Coordinator opening message and switch.
- Native transcript parity: multiline/send/queue/steer exactly once,
  Enter/Tab/arrows/Escape, approval digits; 5,000-line bounded code expansion,
  scroll-away/thread-switch/anchor restore, lightbox and clamped prompt.
- Native requests, dark/light: held delivery, permission apply, usage recovery,
  Coordinator cards, subagent send/background/stop/forwarding, formatted result
  details, item Undo/Restore/Open, note/task navigation.
- Native navigation, dark/light: search and first/middle/last keyboard jumps.
- Reveal, reduced motion on/off: valid prefix and exact final Unicode text.
- Save-to-note, dark/light on a fresh installed scratch daemon: create and append
  preserve exact Markdown. Scratch daemon/data removed by the wrapper.
- Screenshots inspected in dark/light: readable chips/composer and Coordinator
  layout. Fixture diagnostics at the top are not production UI.
- `git diff --check` and the App patch dry run pass.

No real provider turn, hardware IME session, clipboard image, or retained
outgoing-page transition was certified. Fixtures are native GPUIX windows, not
WebKit substitutes. The installed app and normal user data stayed untouched.

## Streaming measurements

Apple M1, macOS 27.0 (26A428), Bun 1.4.0, GPUIX 0.10.0/current patched module.
1280×820 background native window; deterministic append every 300ms with bold
Markdown and Unicode. Two independent runs per version, each 10s warm-up + 15s
sample. One GPUIX process; no scratch daemon in these streaming samples.
`perf/sample.ts` reports CPU-time deltas, physical footprint and accumulated
Metal GPU time. No screenshots during sampling.

| Run | Footprint | CPU | GPU work / 15s |
| --- | ---: | ---: | ---: |
| Inherited baseline 1 | 202 MiB | 28.60% | 25.4ms |
| Inherited baseline 2 | 202 MiB | 29.07% | 37.1ms |
| Continuation 1 | 185 MiB | 17.47% | 45.8ms |
| Continuation 2 | 175 MiB | 7.87% | 0.0ms |

Do not interpret these as a speedup: the after samples differ substantially,
and the zero GPU sample is consistent with background throttling. These edits
did not materially optimize the streaming fixture hot path. Other development
work and window coverage were not controlled. No matched idle baseline,
foreground repeat, Tauri comparison, commit timing, input latency or energy
measurement was taken.

## Issue #108 status changes / retained gaps

| Lines | Status after continuation |
| --- | --- |
| 5.9, 5.13 | Done: Coordinator draft and explicit disabled-send reasons; native checks pass. |
| 7.8 | Done for paced/word-aware streaming; exact final text verified. |
| 7.17 | Partial: code copy/wrap, tables and links exist; Mermaid source fallback and separate note/task buttons, not full inline parity. |
| 7.27 | Partial: visual/source entry points implemented; embedded HTML host absent. |
| 7.35 | Done: bounded rail and searchable virtual navigation with first/middle/last checks. |
| 9.8, 24.15 | Partial: native selection and atomic undo/redo pass; above-editor chips only and hardware IME pending. |
| 9.10 | Partial: notes/tasks added and wire parts verified; desktop filter-chip parity remains. |
| 9.11 | Done: Computer available from the enabled skill catalog and sent as a mention. |
| 9.16 | Partial: file uploads/drop and feedback; clipboard-image paste absent. |
| 9.21 | Missing: drag-enter highlighting is not exposed/wired. |
| 10.5 | Done: idle Coordinator harness switch verified; running switch blocked. |
| Subagent push/pop | Partial: entry translation works; outgoing-page retention needs the state/shell boundary described above. |

## Disk and lifecycle

Free workspace-volume space: 72 GiB before, 71 GiB after (other parallel work
was active; this is not attributed solely to this package). Pre-existing
node_modules refreshed from 204 to 225 MiB and the 23 MiB native module remain
for parent integration/reverification. No Rust build or new target directory.
Final preview/log folder is about 14 MiB. No task fixture UI or scratch daemon
remains. Do not delete the worktree: it contains the uncommitted deliverables.
