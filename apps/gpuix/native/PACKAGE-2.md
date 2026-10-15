# Native package 2: layout, syntax ranges, spring velocity, notification boundary

Worktree: `/Users/mymac/projects/ade-gpuix-native`, branch `gpuix/native`.
Fast-forwarded `feat/gpuix-mvp` to `bfbf9644` before implementation. No new commit,
branch switch, stash, reset, rebase or push. App source outside `src/native/` was
not edited. The build's pnpm auto-install refreshed `pnpm-lock.yaml`'s two patch
hashes; that generated lockfile is the sole change outside the assigned paths.

## Results

| Capability | Result | Evidence |
| --- | --- | --- |
| OS notifications | Blocked by unbundled host identity | Modern center aborts in native/Bun subprocesses; legacy center is nil. A disposable `.app` can create the modern center. No permission requested or notification posted. |
| Event-driven layout | Implemented | Dark/light resize, clipped bounds, changed and unchanged cached paint, host replacement, virtual unpaint, duplicate rejection, coalescing, unsubscribe. |
| Whole-document virtual code | Implemented | Pixel-identical whole/ranged rendering at every fixture line boundary; Unicode cross-range copy/remount; stale revisions/results rejected; bounded jobs/documents; release; four mounted rows from 70,003 lines. |
| Spring initial velocity | Implemented | Both axes, opposite directions, velocity-only retargets, equal source/target and exact endpoints; analytical derivative unit check. |

The README contains the precise contracts, limits and implementation seams. New
public imports are in `src/native/layout.ts`, `layout-hooks.ts`, `syntax.tsx`,
`motion.ts`, and the deliberately unsupported `notifications.ts` gate.

```ts
onWindowResize(renderer, callback): () => void
observeElementBounds(renderer, number | { id: number } | { testId: string }, callback): () => void
useNativeWindowSize(): WindowResizeEvent
useElementBounds(testId): ElementBoundsEvent | null

createSyntaxDocument(renderer, { text, language?, path? }): Promise<SyntaxDocument>
updateSyntaxDocument(renderer, id, { expectedRevision, text }): Promise<SyntaxDocument>
releaseSyntaxDocument(renderer, id): void
getSyntaxDocumentText(renderer, document): string
// <VirtualCode document={id} revision={revision} startLine={start} endLine={end} />
// transition={{ type: 'spring', duration, bounce, velocityX, velocityY }}
```

The bundled-notification prerequisite is a real native host/helper `.app` with a
stable bundle identifier and a retained notification delegate plus ID-carrying IPC.
The pinned GPUI already guards its own notification center when mainBundle has no
bundle ID (`zed/crates/gpui_macos/src/system_notifications.rs`). The small probe
establishes center creation in a bundle, **not** authorization, displayed banners,
clicks, launch recovery or production signing. Those still require packaged-host
verification. No automatic notification integration should be enabled yet.

## Exact app integration patch

`app-integration.patch` is a concrete, **unapplied** unified diff against the merged
app. It passed `git apply --check` and TypeScript checking with its modified sources
supplied through an in-memory compiler host, without writing app files. The parent
should integrate and run full-app interaction checks; the proposed app behavior has
not been runtime-tested here.

From the repository root:

```sh
git apply --check apps/gpuix/native/app-integration.patch
git apply apps/gpuix/native/app-integration.patch
```

The patch changes:

- `shell/window.ts`: replace the 300 ms window-size poll with `onWindowResize`.
  Keep the existing frame-position/appearance read at 900 ms, also refreshing it
  on resize. The API does not pretend to observe movement or OS appearance.
- `dock/Dock.tsx`: retain the existing derived `dockGeometry` calculation, now fed
  by event-driven shell width. There is no independent dock geometry poll in this
  merged app. `observeElementBounds(renderer, {testId:'right-dock'}, callback)` is
  available for a future native surface that needs the actual animated/clipped box;
  adding that subscription merely to recompute the current target width would cause
  unnecessary per-frame React work.
- `dock/Explorer.tsx`: own one asynchronously parsed document per file, release it
  on source/path change or unmount, and render shared 64-line ranges. Keep the
  existing fixed 20 px row geometry, gutter styling, virtual list and full-content
  copy action. Failed document allocation has retry UI. Native wrapping remains
  opt-out for those fixed-height rows.
- `live/Floating.tsx`: observe the container, maintain a persistent translating
  motion wrapper, sample pointer velocity in px/s, and pass it into the corner
  spring. Remove the corner-key remount so content identity survives a snap.
  Reduced-motion/keyboard paths and direct dragging remain immediate; stale
  pointer velocity and resize geometry are not reused. This shared component is
  already consumed by `preview/Preview.tsx` and the live computer view, so no
  separate preview patch is needed.

Notification integration is intentionally absent from the patch because there is
no working OS bridge to call. Once the helper exists, wire it in
`shell/agentToasts.ts`: preserve the current setting, historical-event, top-level
thread and selected/focused-thread filters; map a notification ID to both environment
and thread; post only when unfocused; and activate the native window before
`openThread` on a verified click. Calling the current unsupported gate there would
only throw, so such a patch would falsely claim completion.

Other existing `useWindowSize({intervalMs:...})` consumers can switch imports/calls
to `useNativeWindowSize()` in `src/native/layout-hooks.ts`; they were not edited.
This includes Notes, Terminal, popup layout, and toast window sizing. Element-bound
consumers should subscribe after mounting a unique test ID or numeric ref and use
`clippedRect` when placing a native child view. The separate visibility poll remains.

## Validation

The final signed native build passed:

- `pnpm typecheck`, native fixture typecheck, and `bun test ./src`: **21 tests,
  88 assertions**, no failures.
- All six original scripts: islands, overlay replay, native input/close/drag-region,
  secure input, code wrapping, and native motion.
- Dark/light input selection/undo/stale edits/fonts/cached selection/virtual lists.
- Dark/light layout and velocity check, including changed ancestor clipping and
  observed native translation.
- Whole/ranged syntax PNG comparisons: TypeScript, Python, Bash, embedded HTML,
  unknown-grammar fallback, plus wrapped TypeScript. Every boundary is compared.
- Dark/light syntax lifecycle: exact Unicode/newline copy across two ranges,
  retained copy after remount, full-source read, edits before the viewport, stale
  revisions and parse completion, 32-document limit, eight-pending-job limit,
  cancelled released work, and zero registered sources/jobs after release.
- Large syntax fixture: 70,003 lines, >512 KiB, four mounted rows, absolute numbers.
- Scratch `combined-pointer-check.ts`: Settings pointer/Space, sidebar selection,
  titlebar dock toggle, completed entrance, Notes tab and collapse.
- Two standalone Rust spring tests: finite values, endpoints, damping and initial
  derivative/direction including same-target motion.
- Separate notification subprocess proof; no permission request/post.
- Unapplied integration diff: clean apply check and in-memory TypeScript check.

`native/update.sh` now runs the original and new rendering checks, scratch pointer
fixture, and spring unit tests after rebuilding. Notification probing is separate
because it intentionally crashes unbundled subprocesses. Cross-display scale-factor
changes, physical AppKit window gestures, external AX permission behavior, and an
actual packaged notification interaction remain unverified. No new claim is made
about those OS-level paths.

## Controlled full-app performance

Apple M1, macOS 27.0, Bun 1.4.0, GPUIX 0.10.0, 1280×820 background window. Each
sample uses a new scratch daemon/thread and the full app with an empty settled
thread/composer, a 10 s warmup, then 15 s sampling. One fixture window at a time.
Before is the merged original binary; after is the final package 2 binary. These
samples do not exercise sustained streaming, active loaders or proposed app patches.
Other agents/system work and window occlusion limit precision.

| Sample | Process CPU | Physical footprint | Process Metal time / 15 s |
| --- | ---: | ---: | ---: |
| Before 1 | 3.33% | 175 MiB | 2.8 ms |
| Before 2 | 3.73% | 155 MiB | 0.8 ms |
| Final after 1 | 3.13% | 174 MiB | 2.3 ms |
| Final after 2 | 3.27% | 172 MiB | 3.6 ms |

Mean CPU is 3.53% → 3.20% (−0.33 percentage points); mean footprint is
165 → 173 MiB (+8 MiB), within the 20 MiB spread between baseline launches. Metal
time is 1.8 → 2.95 ms per 15 s sample. These short, low-activity measurements do not
prove a speedup or exact memory/GPU equivalence. No meaningful CPU regression is
observed; the memory/GPU differences should remain visible rather than being
reported as zero. Commit timing, input latency, frame intervals and energy were
not measured. No new continuous native timer was introduced.

Reproduction:

```sh
NATIVE_PERF_WARMUP=10 bun src/shell/verify.fixture.ts bun scripts/native-perf.ts label
```

## Deliverable and cleanup

Binary: `apps/gpuix/native/build/gpuix-native.darwin-arm64.node` in this worktree,
repaired for Xcode LINKEDIT alignment, ad-hoc signed and load-checked by `update.sh`.
SHA-256: `af49625796e6c6f21a02b71c7173c6d7504a4a2e9f73451c2a18fe802d5f2b71`.
The native incremental target is reused; no second build directory or daemon build
was created. Final screenshots belong in the original conversation's
`/Users/mymac/projects/ade/previews/gpuix/p1b/` directory. Scratch daemons/data and
fixture processes are stopped/removed by their owning harnesses. The installed
Kybern app, port 4219 and normal user data are untouched.

Free space: 73 GiB before and 73 GiB at handoff (74 GiB at the final build check). Retained by request: native
build 1.9 GiB, upstream checkout 186 MiB; reused dependencies 303 MiB. Concurrent
work can change volume free space independently. Temporary notification bundles,
probe binaries, test executables and in-memory-integration scratch input are removed
at handoff. Source changes and the worktree remain, uncommitted, for the parent.
