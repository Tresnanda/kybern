# Package 5 resumed — dock, Explorer, terminal and browser fallback

Worktree: `/Users/mymac/projects/ade-gpuix-dock2`, branch `gpuix/dock2`.

## Recovery and base

The interrupted work was **not** left in a temporary HEAD baseline. All 11
tracked implementation files differed from HEAD. Six matched the saved
`.p5/implementation` copies; five working files were newer and contained the
later inset props, identical-frame suppression, drag mouse-up handling, tree
focus distinction and isolated persistence tests. The saved baseline script
had a `finally` restoration. Kept the newer working files.

Saved the tracked binary diff and all untracked files outside the repository,
reverse-applied only that tracked patch, fast-forwarded `feat/gpuix-mvp` from
89d61ae3 to b311b6a4, and reapplied the patch with `--3way` cleanly. Untracked
files remained in place. No checkout, stash, reset, branch switch, implementation
commit or push. Copied the supplied native binary (SHA-256
`af49625796e6c6f21a02b71c7173c6d7504a4a2e9f73451c2a18fe802d5f2b71`) and installed
the frozen dependencies. The referenced `docs/design.md` and
`docs/architecture.md` are absent in this checkout; used PORTING.md, native
README/PACKAGE-2 and existing dock/desktop components.

## Implementation

- Preserve the inherited validated dock persistence, keyboard file tree,
  terminal search/cell selection, bounded frame crossfade and drag-release fix.
- Adapt native integration: shell width is already event-driven in the new base;
  dock retains derived geometry. Terminal fits from its actual native bounds
  observer, including search-bar and dock-size changes, without window polling.
- Explorer allocates one native syntax document for the entire bounded read,
  releases it on change/unmount (including late allocations), and renders 64-line
  ranges. Horizontal scrolling moves the whole source and gutter; explicit
  virtual-list height prevents blank paint inside the horizontal scroller.
- Floating observes its parent bounds, cancels stale drag/snap geometry on resize,
  projects the corner using shared desktop helpers, and feeds the sampled px/s
  velocity into both spring axes. Keeps content identity and both inset props;
  no App.tsx wiring.
- Browser launch reports completion/failure. Web previews show “Opened in
  browser”, retain float/return controls, ignore stale launch completions, release
  tickets on close/eviction/environment leave, and invalidate pending opens on
  history navigation. Reload replaces the current entry without duplicating it
  or discarding forward history.
- Artifact preview is keyed by thread/path, clears old source during reload,
  suppresses duplicate browser launches, ignores results after unmount and
  reports launch state. Each HTML launch gets a new single-use sandbox ticket;
  its daemon-owned 60-second expiry handles unused tickets (no revoke RPC exists).
- VT: preserve inherited origin/insert/colon RGB/reset handling; correct
  origin-relative VPA/DSR, retain legacy mode-47 alternate contents and clear
  mode-1047 contents, preserve saved pen identity, and encode bracketed paste
  without allowing embedded Escape to forge its delimiters. Tests cover alternate
  resize/history, indexed/RGB color, application cursor and cursor visibility.

No native WKWebView, protocol change, daemon build, dependency addition or
production edit outside the four assigned source directories.

## Validation

- `pnpm typecheck` passes; `bun test ./src`: **33 tests, 128 assertions, zero failures**; `git diff HEAD --check` passes.
- Core native dock in dark/light: entrance, resize, Cmd-J, tab switching/close,
  Explorer and Diff, settled layout and unmount.
- Explorer dark/light: directory arrows, parent/collapse, Home/End, Enter, file
  switching, and **asserted >500px horizontal source movement**. Screenshots show
  the long-line tail, including END_OF_LONG_LINE.
- Runtime dark/light: Review/Artifacts/Preview/Terminal, device toolbar,
  rotation, real scratch-shell pwd/ANSI output, search, exact “Native” cell copy,
  hide/reopen and Cmd-Alt-P float/return.
- Populated Review and Markdown artifact preview/source in dark/light.
- Live view dark/light: projected spring settles at an actual corner and closes.
  The old fixture dragged light mode outside the window after restoring dark
  mode’s corner; it now chooses an in-window opposite trajectory.
- HTTP artifact fixture: HTML body, sandbox CSP, successful first request and
  404 on second use. Browser fallback fixture: rejected scheme, local/server
  tickets, folder permission state and close/revoke.
- Isolated preview lifecycle test: reload/history, 16-entry bound, late open
  after close, late browser launch after close, float close and environment reset.

Native checks exercise real GPUI windows. Browser launching itself is not an
interactive browser automation test; sandbox ticket serving is verified over
HTTP. No hosted publication, agent send or GitHub write was performed.

## Issue #108 disposition

| Line | Status after this package |
| --- | --- |
| 12.1 Dock open/close and resize | Done; dark/light native checks pass. |
| 12.8 Terminal | Partial overall xterm parity; requested VT, search and cell-selection cases pass. Mouse reporting, sixel, IME host, full grapheme width/reflow remain outside this subset. |
| 12.9 Artifacts | Partial overall; lifecycle, native source/Markdown and HTML browser fallback complete. No embedded HTML host. |
| 12.10 Explorer | Done for bounded read, whole-document syntax, horizontal scrolling and tree keys. Existing 256 KiB read limit remains explicit. |
| 12.13 Web preview | Partial overall; browser fallback lifecycle complete, no embedded native page/remote loopback relay. |
| 12.14 Visual preview | Missing; no native HTML host added. |
| 12.15 Mini player | Partial overall; browser-control card and lifecycle complete, no page pixels. |
| 14.1 Computer live view | Partial exact visual parity; bounded crossfade and lifecycle complete, desktop scrim/shimmer styling differs. |
| 24.10 Cmd-Alt-P | Done for the browser fallback; dark/light float/return verified. |
| 25.18 Corner snap | Done; projected desktop corner selection plus native spring initial velocity. |
| 28.13 File tree | Done for navigation keys, typeahead, expand/collapse and open. |

## Performance and cleanup

Apple M1, macOS 27.0, Bun 1.4.0, patched GPUIX 0.10.0; 1280×820
background window. Two fresh processes, 10-second warmup then 15-second samples.
CPU is process CPU time, memory is physical footprint, GPU is process Metal time.
Daemon, shell, external browser, commit time, input latency and energy are excluded.

| Workload | Before CPU % | Final CPU % | Before MiB | Final MiB | Before GPU ms/15s | Final GPU ms/15s |
| --- | --- | --- | --- | --- | --- | --- |
| Preview idle | 3.53 / 3.47 | 2.27 / 2.33 | 182 / 181 | 154 / 161 | 5.4 / 6.5 | 0 / 0 |
| Terminal idle | 2.40 / 3.00 | 2.27 / 2.80 | 183 / 182 | 173 / 164 | 0 / 0 | 0 / 0 |
| Terminal 200k lines | 6.20 / 5.33 | 4.73 / 5.80 | 189 / 191 | 176 / 167 | 17.0 / 24.8 | 0 / 0 |
| Static live frame | 7.80 / 6.33 | 2.47 / 2.53 | 179 / 181 | 165 / 183 | 25.6 / 27.3 | 0 / 0 |

The static live runs each received **22 frame replies during the 15-second
sample**, with visible=true afterward. Identical-image suppression therefore
removes actual redundant paint rather than stopping frame acquisition. The
terminal sentinel remains reachable after both 200k-line bursts. Minimized
intervals assert no further frame requests.

The before logs are the inherited original-HEAD samples, preserved as
`before-runtime.log` / `before-live.log`. Final logs are
`resumed-after-runtime.log` / `resumed-visible-live.log` in the screenshot folder.
These are not simultaneous controlled comparisons: the base and native binary
were updated, and other development activity ran on this host. Zero Metal time
is background/occlusion-sensitive and must not be called an energy guarantee.
No CPU or footprint regression appears in these requested static/burst workloads.

An initial live sequence without a frame-progress assertion varied from
2.47% CPU/183 MiB/0 GPU to 8.53%/193 MiB/110.2 ms. Preserve that evidence in
`resumed-after-live.log`; the repeat adds the explicit visible-frame assertion.
Its minimized runs were 2.47/2.33% CPU, 185/189 MiB, zero GPU and zero requests.

The optional changing-image workload swaps pixels every fourth poll. Original
non-crossfade samples were CPU 5.47/7.00%, 181/179 MiB, GPU 22.5/15.2 ms.
The final crossfade samples were **4.27/4.27%, 195/178 MiB, 45.2/39.8 ms**, each
with 22 visible frame replies. Before the final image-identity fix, current-base
crossfade samples were 5.07/4.87%, 202/191 MiB, 34.4/35.3 ms. The final code
reuses the outgoing native image node instead of uploading its bytes a second
time; old bytes/nodes are still released after 200 ms.

Crossfade GPU work is higher than the old no-crossfade baseline (about 24 extra
milliseconds over 15 seconds on average), and memory varies between launches.
This is disclosed rather than calling all metrics strictly regression-free.
CPU is lower; the requested static/burst workloads show no material regression.
A strict no-increase requirement for changing-frame GPU use remains an acceptance
tradeoff with the newly requested crossfade. No effect was removed to improve
measurement. Logs: `resumed-visible-changing.log` before the identity fix and
`resumed-final-changing.log` after it.

Cleanup: stopped only the task-owned scratch daemon on port 54693; all verification
windows and terminal processes have exited. Removed `.p5/` scratch data and the
external merge-safety copy after exporting the final patch. No Cargo build,
DerivedData, simulator or native compilation output was generated. Retained the
pre-existing native binary directory (23 MiB) and refreshed node_modules (225 MiB)
for parent integration. Screenshots/logs (~18 MiB) remain in the original folder.
Free space was **71 GiB before and 71 GiB after**. No user daemon/data, port 4219,
other agent process, installed app, signing asset or worktree was removed.

## Reproduction

From the repository root, create `.p5/project` with a `dock-example.ts` file and
an isolated `.p5/gpuix-scratch/data` directory. Start only a scratch daemon:

```sh
/Applications/kybern.app/Contents/MacOS/kybernd --data-dir "$PWD/.p5/gpuix-scratch/data" --port 0
```

From `apps/gpuix`, `bun src/dock/verify-run.ts <command...>` uses that daemon,
creates a scratch thread, gives the child its own config directory, then archives
the thread and removes the per-run configuration. Example commands:

```sh
bun src/dock/verify-run.ts bun src/dock/verify-dock-check.ts
bun src/dock/verify-run.ts bun src/dock/verify-dock-check.ts --light
bun src/dock/verify-run.ts bun src/dock/verify-explorer.ts
bun src/dock/verify-run.ts bun src/dock/verify-dock2-runtime-check.ts
bun src/dock/verify-run.ts bun src/dock/verify-dock2-runtime-check.ts --live
bun src/dock/verify-run.ts bun src/dock/verify-dock2-runtime-check.ts --populated
bun src/dock/verify-run.ts bun src/dock/verify-artifact.ts
bun src/dock/verify-run.ts bun scripts/dock2-preview-check.ts
bun src/dock/verify-run.ts bun src/dock/verify-perf.ts
bun src/dock/verify-run.ts bun src/dock/verify-perf.ts --live --active-only
bun src/dock/verify-run.ts bun src/dock/verify-perf.ts --changing
```

Run native fixtures sequentially. Screenshots/logs are in the original
conversation folder `/Users/mymac/projects/ade/previews/gpuix/p5/`.
