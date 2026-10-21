# macOS app packaging

Build from `apps/gpuix` with `bun scripts/package-app.ts` (or `pnpm package:app`).
It packages for this Mac's arch; `--arch x64` builds the Intel app on Apple Silicon
(Bun cross-compiles its runtime; `KYBERN_BIN_DIR` must hold x86_64 `kybernd` and
`kybern`, e.g. `target/x86_64-apple-darwin/release`). Requires macOS, Bun
(verified 1.4.0), the installed pinned dependencies, Xcode command-line tools,
and the existing patched addon for that arch in `native/build`.
Local test builds of another arch take `--test`: the bundle becomes `Kybern GPUIX (x86_64 test).app`
with id `dev.kybern.gpuix.test`, so LaunchServices and notifications never confuse it with the
installed app (macOS 27 posts a Rosetta-retirement notice naming whatever x86_64 bundle launches).
`bun packaging/rosetta-check.ts <out>` smoke-checks that test bundle under Rosetta; it needs
macOS 27 or earlier, since macOS 28 drops Rosetta for apps. Releases never pass `--test`.
No packages are installed, no native addon is rebuilt, and only ad-hoc signing
is used. No signing identity/key lookup, installation, PATH change or Login Item.

Output: `dist/Kybern GPUIX.app`, already covered by this app's `dist/` ignore rule.
Bundle ID `dev.kybern.gpuix` is distinct from `dev.kybern.desktop`.
The icon is copied from `apps/desktop/src-tauri/icons/icon.icns` at build time.
No entitlements are needed for this local, non-sandboxed, non-hardened ad-hoc app.
This is a local development bundle, not notarized distribution packaging.

## Why compiled Bun

[Bun's executable documentation](https://github.com/oven-sh/bun/blob/main/docs/bundler/executables.mdx)
supports standalone compilation; [its file-type documentation](https://github.com/oven-sh/bun/blob/main/docs/runtime/file-types.mdx)
supports native addons. The dynamic NAPI override loads our existing external
`.node` from Resources. A bundled-runtime/source tree is therefore unnecessary.
The compiled app does not need Bun, node_modules, or source files beside it.

Compilation alone would break dynamic `import.meta.url` font lookups: Bun's
virtual executable filesystem is not the source tree. The build plugin rewrites
source URL bases to Resources and copies both fonts into `Resources/src/assets/fonts`.
The entry point sets the native addon path before dynamically importing the app.
It also sets the compiled app's menu name to Kybern GPUIX without editing shell
sources. The real app launched and passed the pointer workflow with this setup.

The build disables Bun's ambient dotenv, bunfig, tsconfig and package auto-loading
at executable runtime. Only the explicit runtime environment selects the daemon.
Temporary `.bun-build` files from Bun 1.4.0 are removed in the script's finally block.
Do not package over a running copy of this bundle.

## Run and checks

Run with a scratch data directory that already has a daemon:

```sh
KYBERN_DATA_DIR=/path/to/gpuix-scratch/data \
  './dist/Kybern GPUIX.app/Contents/MacOS/Kybern GPUIX'
```

The executable itself is the main macOS bundle process (not a shell launcher).
It has a Dock icon, regular activation policy, and the app name/menu. Finder can
launch the `.app`; tests execute its binary directly to reliably pass scratch
connection variables. The package does not bundle/spawn a daemon itself.

From `apps/gpuix`, these use the existing fixture to start/stop an isolated daemon
on a free port, create only scratch data, and remove it on exit:

```sh
bun src/shell/verify.fixture.ts bun packaging/pointer-check.ts
bun src/shell/verify.fixture.ts bun packaging/verify.ts bundle
bun src/shell/verify.fixture.ts bun packaging/verify.ts source
bun src/shell/verify.fixture.ts bun packaging/notification-check.ts
pnpm exec tsc --noEmit -p packaging/tsconfig.json
```

The bundle harness uses the real compiled executable with the existing stdio
automation protocol. `pointer-check.ts` mirrors the combined pointer check with
only its harness/dock-wait import locations changed.

## Notifications

`src/native/notifications.ts` exposes `status()`, `requestPermission()`,
`post({id,title,body})`, `onClick(callback)` and `reason`. Unbundled calls return
`unsupported` / `false` without invoking the abort-prone macOS notification center.
`onClick` returns an unsubscribe function. `post` never prompts implicitly.
Denied/not-yet-granted posting returns false; native service errors reject.

The small ARC Objective-C dylib uses [UNUserNotificationCenter](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter)
and a strongly retained delegate. Completions and notification IDs cross a
synchronized JSON queue, woken by Bun's threadsafe callback; no polling loop.
The callback is retained for process lifetime. The native default-click handler
activates the app and makes its main window key; the JS subscriber opens the thread.
The delegate is reasserted for commands because GPUI also owns a notification
center delegate. Do not introduce a separate competing notification consumer.

An actual macOS permission prompt appeared for **Kybern GPUIX / dev.kybern.gpuix**.
The prompt was allowed through accessibility. Authorization returned `granted`,
posting returned `true`, and the real Notification Center banner was observed.
Unbundled calls were verified as `unsupported`, `unsupported`, `false` with a reason.

**Real click delivery remains unverified.** Computer-use banner clicks failed with
`noWindowsAvailable`; subsequent attempts also timed out as banners disappeared.
No `[notification click]` was observed. The delegate implementation is present,
but this is not evidence that click delivery works. Run the notification check
above, click the banner body promptly (or its entry in Notification Center), and
verify `[notification click] package-test-...` in the terminal. The test exits
after a callback or 90 seconds. On a fresh machine first choose **Allow** on the
“Kybern GPUIX” notification prompt; this machine already granted it. If denied,
turn on Allow notifications for Kybern GPUIX in System Settings → Notifications.
No permission or settings for the installed Tauri app were changed.

`agent-toasts.patch` is the exact **unapplied** shell integration patch. From the
repository root, `git apply --check apps/gpuix/packaging/agent-toasts.patch` passes.
It preserves current settings, history/deduplication/top-level-thread filters and
existing toasts; posts only while unfocused; bounds the ID mapping to 256 entries;
and only opens the thread if the original environment is still active. Native
activation precedes the navigation visually through the main queue. It includes
finished/failed, approval, and user-input notifications. Shell files were not edited.
This mapping is process-local: click routing after quitting/relaunching or after
switching environments is deliberately not implemented. Verify real click delivery
before calling notification parity complete.

## Measurements and validation (2026-10-15)

Apple M1, macOS 27, Bun 1.4.0, patched GPUIX 0.10.0, background 1280×820 Home,
isolated daemon with one idle thread, no agent running. Each process receives two
10-second warmups followed by 15-second samples. Memory is `footprint`, CPU is
process CPU-time delta, GPU is AGX accumulated time. Other desktop work and window
occlusion limit precision; these are not energy or frame-latency measurements.

Bundle allocated disk size: **87 MiB** (`du -sh`). Initial cold-ish app-ready was
3136 ms; later launches ranged 475–2332 ms. Source launch measured 1013 ms.
App-ready is the automation root appearing, before daemon hydration finishes;
these few mixed-cache launches do not prove a startup speedup.

| Launch | Sample | CPU | Physical footprint | Metal time / 15 s |
| --- | --- | ---: | ---: | ---: |
| Source | 1 | 2.53% | 162 MiB | 0.4 ms |
| Source | 2 | 2.33% | 162 MiB | 0.0 ms |
| Initial bundle | 1 | 2.60% | 99 MiB | 0.0 ms |
| Initial bundle | 2 | 2.33% | 99 MiB | 0.0 ms |
| Final bundle | 1 | 2.53% | 100 MiB | 0.0 ms |
| Final bundle | 2 | 2.40% | 100 MiB | 0.0 ms |

The compiled runtime uses less physical memory in these samples; CPU differences
are negligible. No claim is made about streaming, large transcripts or foreground GPU.

Passed: app and packaging TypeScript checking; ad-hoc deep/strict signature
verification; actual compiled app startup; Settings pointer and Space toggles;
sidebar thread selection; titlebar dock opening, entrance, Notes tab and collapse;
NSWorkspace bundle identity/name/icon/regular activation policy; AX app-menu name;
notification authorization and visible posting; unbundled safety gate.

Free space was 73 GiB before work and 72 GiB after work (other workers active). Only the final
87 MiB `.app` is retained as generated packaging output. Task-created temporary
Bun build executables were removed; all fixture daemons/data are cleaned by their
harness. Existing native builds/dependencies are untouched. No commits were made;
`feat/gpuix-mvp` was fast-forward merged at the start as requested.

## Exact unapplied shell patch

```diff
--- a/apps/gpuix/src/shell/agentToasts.ts
+++ b/apps/gpuix/src/shell/agentToasts.ts
@@ -1,4 +1,4 @@
-import { onEnvironmentChange } from './environment.ts'
+import { environmentKey, onEnvironmentChange } from './environment.ts'
 // Agent event toasts (desktop `state/rpc.ts` `announce`): a turn that finishes or
 // fails, or an agent that needs an approval or an answer, while the reader is not
 // looking at that thread. Finished and failed toasts last 6 s; approval and
@@ -11,6 +11,7 @@
 import { openThread } from '../nav/history.ts'
 import { onLiveEvent } from '../nav/live.ts'
 import { getNav } from '../nav/store.ts'
+import { notifications } from '../native/notifications.ts'
 import { isWindowVisible } from '../native/visibility.ts'
 import { getClient, getState } from '../state.ts'
 import { isWindowFocused } from './window.ts'
@@ -29,6 +30,13 @@
   const startedAt = Date.now()
   const announced = new Map<ThreadId, number>()
   const finished = new Map<ThreadId, string>()
+  const targets = new Map<string, { environment: string; thread: string }>()
+  stops.push(notifications.onClick(id => {
+    const target = targets.get(id)
+    // The native delegate activates the app/window. Never open a thread on a
+    // different daemon after an environment switch.
+    if (target?.environment === environmentKey()) openThread(target.thread)
+  }))
   let enabled = true
 
   const readSettings = (settings: Settings | undefined) => {
@@ -67,6 +75,19 @@
       if (event.turn_id) finished.set(event.thread_id, event.turn_id)
     }
     const title = thread.title || 'Thread'
+    if (!isWindowFocused()) {
+      const id = `agent:${event.thread_id}:${event.seq}`
+      targets.set(id, { environment: environmentKey(), thread: event.thread_id })
+      if (targets.size > 256) targets.delete(targets.keys().next().value!)
+      const body = event.kind === 'turn_failed' ? `Failed: ${event.error}`
+        : event.kind === 'approval_requested' ? `Needs approval: ${event.approval.summary}`
+        : event.kind === 'user_input_requested' ? 'Needs your input' : 'Finished working'
+      void notifications.requestPermission().then(status => {
+        if (status === 'granted' && getClient() === client && enabled && !isWindowFocused()) {
+          return notifications.post({ id, title, body })
+        }
+      }).catch(error => console.error('[notifications]', error))
+    }
     const open = { label: 'Open thread', onClick: () => openThread(event.thread_id) }
     if (event.kind === 'user_input_requested' || event.kind === 'approval_requested') {
       toast(title, {
```
