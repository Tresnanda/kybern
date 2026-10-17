# Remaining right dock panels — 2026-10-15

## Implementation and parity

This follows `dock.md`. The dock shell, Agents, Activity, Diff, Explorer and Project
were already present. This change adds the remaining six dock choices in the
same order as desktop `RightPanel.tsx`, plus the computer view outside the dock.

- `src/dock/Notes.tsx`: scoped pinned/recent notes, 50-row cap, thread note,
  lazy revision-zero creation, persisted first-save draft, project quick capture.
  Existing `notes/store.ts`, `NoteSession` and `NoteEditor` own document updates.
  `NoteEditor.tsx` adds an optional compact Markdown textarea; the full-page
  editor remains the default. A notification arriving before the first save
  response cannot replace the textarea and lose continued typing.
- `src/dock/Tasks.tsx`: scoped status groups, existing status/priority glyphs,
  current-thread task/criteria count, 50-row cap, quick add, Return/⌘Return,
  Escape and blur behavior. Existing task store/model/navigation are reused.
  Notes, Tasks and Artifacts reuse `TaskWindow`; offscreen row content unmounts.
- `src/dock/Review.tsx`: resolves the thread branch PR through `git.status`, then
  mounts existing `pulls/Detail`. `PrTabs.tsx` adds an optional compact file list
  above the native diff, selected by `PrDetail.tsx` below 700px. Summary,
  checks/reviews, review drafts, timeline and action confirmations remain shared.
- `src/dock/Artifacts.tsx`: native Artifact receipts, pagination, local file
  preview, native Markdown/source, browser preview tickets, and shared publishing
  prompts. Publishes only when the user requests it, queued when a turn runs.
  No fixture performs agent sends, publication or GitHub mutations.
  `Explorer.tsx` only exports the existing bounded `FileCode` renderer.
- `src/terminal/{vt,keys,Terminal}`: bounded TypeScript VT screen and scrollback,
  fixed Menlo text grid, ANSI colors, cursor, input/paste/copy, terminal tabs,
  CLI chooser, native resize and exit states. Only the selected terminal mounts;
  hiding the tab unsubscribes without killing its daemon-owned PTY. Reopening
  replays the daemon's bounded output buffer. Output repaint is coalesced at
  33ms and suppressed while the window is hidden.
- `src/live/{ComputerLiveView,poll,Floating}`: one outstanding `computer.frame`
  request, 700ms cadence only while running, visible and not dismissed; late
  responses after hide are dropped. Uses native window occlusion/minimize
  detection. Image bytes go directly into the native image node; no frame file,
  data-URL image cache or transcript persistence. Expand, close, latest action,
  point marker, 12-second completion linger, persisted corner and drag snap.
  Floating cards use an opaque anchored layer so cached content cannot cover
  their controls. Corner changes fade through the shared popup primitive;
  keyboard/reduced-motion changes are instant.
- `src/preview/{store,Preview}`: address classification, server discovery,
  history, reload, folder permission state, ticket cleanup, device dimensions,
  rotate, external-browser launch and floating browser controls. Uses shared
  preview target/viewport helpers. Metadata is bounded to 40 threads ×16 entries.
  `resetPreviews()` is the integration hook for the environment-switch lifecycle;
  this base predates that lifecycle, so the integrator must register it. It
  invalidates pending opens and releases tickets before clearing the cache.
- `App.tsx`: only two imports and two overlay mounts. `dock/store.ts` only adds
  tab names. No daemon/protocol/native/dependency changes.

Exact issue #108 lines advanced:

| Checklist line | Status and remaining gap |
| --- | --- |
| “Review tab (PR for this branch)” | Done; shared PR UI with compact diff layout. |
| “Terminal tab (`terminals.*`)” | Functional; partial xterm parity, limits below. |
| “Artifacts tab” | Partial; source/Markdown native, HTML in external browser. |
| “Notes tab” | Partial rich-editor parity; complete scope/navigation/autosave, plain Markdown editing. |
| “Tasks tab” | Done for the compact task list, current task and quick add. |
| “Preview tab, web (`previews.*`)” | Partial; chrome and browser fallback. Native page hosting requires the API below. |
| “Floating preview mini player (`⌥⌘P`)” | Partial; floating address/browser controls, no embedded page. |
| “Live view of what the agent sees (`computer.frame`)” | Functional; partial pixel parity (footer controls instead of desktop scrim/shimmer/frame crossfade). |
| “`⌥⌘P` float or dock the preview” | Done for the fallback card. |
| “`⌘L` preview address bar” | Implemented while Preview is mounted. |
| “Terminal passes `⌘` shortcuts through” | Done; native ⌘J verified from terminal focus. |
| “Mini player and live view corner snap” | Partial; persisted nearest quadrant with fade, no desktop velocity projection/spring trajectory. |

“Preview tab, visual” remains outside this web-preview work. Existing generic
native font, rich-editor, rectangular clipping and input-selection limits remain.

## Native webview investigation

Two isolated probes in `scripts/webview-{investigate,prototype}.tsx` established:

1. Bun callbacks executing inside this GPUIX window report
   `NSThread.isMainThread = true`; the system `WKWebView` class is available.
2. A child `WKWebView` can be allocated and attached to GPUI's content NSView.
   `NSInvocation` can safely pass the CGRect for `setFrame:` through FFI.
   The prototype loaded only a local fixture and reported a non-null superview.
3. The probe detaches/releases its view and exits after 45 seconds. It is never
   imported by production. Attachment is evidence of feasibility, not evidence
   of reliable browser interaction or a measured WebKit process lifecycle.

The shipped fallback instantiates **no WKWebView**. An FFI implementation cannot
meet the required integration contract with the APIs currently available:

- `getElementBounds` is a sampled JS getter, not a per-frame layout callback.
  Native child views would lag dock drag/resize/slide and would not inherit GPUI
  scrolling, rounded clipping or cached-island clipping.
- NSViews paint over GPUI's Metal contents. GPUI menus, dialogs, the floating
  player and transient overlays have no central native-view suspension hook.
  Guessing visibility from individual React menu state is insufficient.
- A focused WKWebView becomes AppKit's responder. Its typing and app-command
  routing cannot be reliably joined to GPUI's window keyboard handlers via the
  public JS API. A click must never type into both the page and the composer.
- Detaching an NSView is not enough to establish bounded WebKit network/content
  process and website-data lifetime. No production resource claim is made.

Proposed patched-native API (illustrative, not an existing GPUIX component):

```tsx
<native-view kind="webview" sessionId={threadId} url={ticketURL}
  visible={selected && windowVisible} viewport={{ width, height }}
  onNavigation={syncAddressHistory} onLoadError={showError}
  onCommand={routeApplicationShortcut} />
```

The native implementation must own these responsibilities:

- Create/update/dispose on AppKit's UI thread, keyed by a bounded session ID.
  Use a nonpersistent website-data store and an explicit bounded process pool.
  Verify network/content processes after close; retain at most the active page
  and the deliberately floating page, not one WK process group per thread.
- Apply host bounds, visible rect and clipping in the **same GPUI frame**,
  including display scaling, flipped Cocoa coordinates, dock transforms and
  window resize. Suspend/hide while a covering GPUI overlay paints.
- Expose navigation state (URL, title, loading, history availability), navigation
  commands, file/server ticket errors, responsive viewport and zoom controls.
- Transfer focus explicitly, route app Cmd shortcuts once, keep ordinary page
  keys/IME/selection local, clear focus when hidden and restore the previous
  GPUI focus owner on close. A native overlay/hit-test ordering contract is
  required, not a timer that repositions a child NSView.
- Dispose observers, delegates, pending navigation, views and references on
  panel close, thread/environment switch and window close. Visibility changes
  must pause page activity where possible and be observable in tests.

Browser fallback history covers submitted addresses, not navigation done inside
the external browser. Device toolbar values are displayed for use in that
browser's responsive mode; they do not resize an external browser. Local-file
previews use the daemon sandbox ticket, server previews use its proxy ticket.
Authenticated remote endpoint relay/browser bridging remains an integration gap.

## Terminal limits and bounds

The implementation covers common shell output, fragmented CSI/OSC, SGR 16/256/
RGB colors, bold/inverse, cursor addressing, erase, scroll regions, insert/delete
lines and characters, alternate screen, save/restore cursor, device status
replies, bracketed paste and application cursor keys. OSC titles are bounded;
OSC clipboard and hyperlinks have no side effects. Cursor restore is clamped
when the grid was resized. UTF-8 input chunks use a streaming decoder.

History retains at most 5,128 rows (5,000 plus a batch-deletion allowance),
1,000,000 history cells, 4,096 styles, 512×200 screen cells, a 4KiB OSC sequence
and 64 UTF-16 code units per combined cell. Native row contents only mount for
the visible range plus overscan; updates preserve row IDs and untouched rows.

This is not full xterm emulation: no mouse reporting, sixel, full Unicode cluster
width tables, IME text-input host, find, link activation or full-screen-program
compatibility guarantee. Italic/underline flags are parsed but not painted.
Resize keeps source cells and clips to the current width instead of reflowing
old wrapped paragraphs. Copy uses native selection when available, otherwise the
bounded screen/history text; precise cross-row selection was not validated.
Terminal resize uses the existing 300ms native window-size sampler while mounted;
there is no native layout subscription in this base. Copy/paste invoke macOS
clipboard tools. PTY replay after a hidden tab is limited to daemon retention.

## Verification

All writes targeted the shared scratch daemon on port 4219; the user daemon was
not written to. Native commands used the cached patched `.node` supplied by the
main GPUIX checkout. No builds or package installations were performed.

- `pnpm typecheck` and `git diff --check` pass. The final combined dock/parser/poller run passed 11 tests / 44 assertions.
- `bun test src/terminal/vt.test.ts src/live/poll.test.ts`: 8 tests / 32 assertions,
  including 200,000 rows, fragmented escapes, true colors, Unicode, alternate
  screen, resize/cursor replies, keyboard passthrough and hidden late replies.
- `scripts/dock2-check.ts`: dark/light Notes/Tasks, initial thread note creation,
  delayed initial-save response with continued typing, autosave, inline task
  Return/Escape, panel unmount. Existing NoteSession conflict/recovery checks
  and full Notes native regression passed (`src/notes/session.verify.ts`,
  `NOTES_SKIP_PERF=1 bun src/notes/verify.ts`).
- `scripts/dock2-runtime-check.ts`: dark/light empty and populated Review,
  Summary/Changes/review popover, actual scratch Markdown artifact read,
  formatted preview/source, native terminal `pwd` and ANSI output, ⌘J from
  terminal focus, Preview device rotation and ⌥⌘P float/dock.
- `scripts/dock2-preview-check.ts`: rejected scheme, local file ticket fetch,
  running server proxy fetch, outside-folder permission state and ticket revoke.
  No external browser or hosted page is opened in tests.
- Runtime `--live`: ephemeral synthetic 640×400 image, drag/corner snap,
  close controls in both appearances. `--live --perf` asserts that
  minimized and dismissed views issue **zero further requests**, and restore
  resumes polling. This uses an in-memory mocked `computer.frame`, not an
  actual computer action. Native pointer-automation occasionally missed a
  toolbar control's painted bounds; retry conditions/raw last-painted positions
  and keyboard dock opening avoid assuming fixed timing. Full final runs pass.

## Measurements

Apple M1, macOS 27.0, Bun 1.4.0, patched GPUIX 0.10.0, 1280×820 logical window.
Each sequence starts a fresh process; panels are then sampled in order after
unmounting the previous one. Each table has two independent fresh sequences.
No screenshots are taken during measurement. Samples are 15 seconds with
`perf/sample.ts`: process CPU time, physical footprint (`footprint`) and total
Metal GPU time (`ioreg`). Daemon, shell process, and external browser are excluded.
GPU is background-window lower-bound evidence, not frame-rate/energy/latency.

**Concurrency caveat:** no exclusive-machine benchmark was possible. In
particular, populated Review/Artifacts and live-view measurements after 08:35 UTC
on 2026-10-15 overlapped the integration agent's native fixtures/performance work.
These are explicitly concurrent-host observations, not controlled before/after
comparisons or proof of an optimization. Earlier Notes/Tasks and terminal samples
preceded that integration run, but other development processes were still active.

| Workload | Footprint MiB,1/2 | CPU%,1/2 | GPU ms/15s,1/2 |
| --- | ---: | ---: | ---: |
| Notes: 14 project notes + compact thread editor |170 /188 |3.40 /3.47 |3.8 /2.5 |
| Tasks: 60 open fixture tasks, 50-row dock cap |191 /192 |3.47 /2.93 |2.1 /3.3 |
| Review:empty branch |179 /164 |2.93 /3.47 |0.5 /3.1 |
| Artifacts:empty |180 /165 |3.33 /3.27 |5.9 /4.7 |
| Review:populated summary (concurrent) |180 /166 |2.60 /2.73 |4.0 /4.7 |
| Artifacts:one receipt (concurrent) |182 /169 |3.07 /2.80 |8.0 /6.4 |
| Preview:browser fallback chrome |180 /164 |3.27 /2.67 |4.9 /5.0 |
| Terminal:idle shell |182 /195 |3.47 /2.80 |8.4 /9.1 |
| Terminal:`yes | head -n 200000` burst |194 /210 |6.60 /5.87 |15.7 /12.5 |

The terminal producer completed in 502/506ms. Those timings end when the daemon
output notification contains the final sentinel, not when every native pixel
has painted. The test separately verifies that the final sentinel is reachable
in the native grid. CPU is averaged over the whole 15-second sample containing
the burst; it is **not** a sustained saturation figure or per-frame latency.

| Live-view workload (concurrent host) | Footprint MiB, 1 / 2 | CPU %, 1 / 2 | GPU ms / 15s, 1 / 2 |
| --- | ---: | ---: | ---: |
| 640×400 synthetic frame, 700ms polling | 180 / 181 | 7.47 / 8.27 | 29.6 / 27.2 |
| Same window minimized | 171 / 174 | 2.73 / 2.73 | 0 / 0 |
| Restored, then live card dismissed | 165 / 169 | 2.93 / 3.33 | 6.7 / 4.9 |

The active image workload includes the app's running-thread state. Both minimized
and dismissed 15-second intervals asserted an unchanged frame-request counter.
The image fixture is synthetic SVG; real JPEG/PNG captures, large Retina frames,
actual computer-action latency and sustained device energy are not benchmarked.

## Screenshots and cleanup

Screenshots are outside git in the conversation's original folder:
`/Users/mymac/projects/ade/previews/gpuix/dock2/`.

Pairs: `notes-{dark,light}.png`, `tasks-{dark,light}.png`,
`review-populated-{dark,light}.png`, `review-changes-{dark,light}.png`,
`review-popover-{dark,light}.png`, `artifacts-populated-{dark,light}.png`,
`artifacts-markdown-{dark,light}.png`, `artifacts-source-{dark,light}.png`,
`terminal-{dark,light}.png`, `preview-{dark,light}.png`,
`preview-mini-{dark,light}.png`, `live-{dark,light}.png`,
`live-snap-{dark,light}.png`.

Scratch fixture notes/files were removed, tasks soft-deleted, threads archived
and all task-created terminal processes closed by the verification scripts.
Shared daemon 4219 remains running. No generated target/DerivedData/downloads.
Existing 184MiB node_modules retained as instructed; native sources 56KiB.
Screenshots total 12MiB and are retained for review. Free shared-volume disk was
69 GiB before the final check sequence and68 GiB after amid concurrent work.
