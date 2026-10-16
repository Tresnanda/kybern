# Shell and terminal follow-up, 2026-10-16

Worktree: `/Users/mymac/projects/ade-gpuix-shell5`, based on `463d03ca`.
This is focused behavior evidence, not a claim of complete Tauri parity.

## Source mapping and changes

| Tauri reference | GPUIX change |
| --- | --- |
| `apps/desktop/src-tauri/src/lib.rs`: endpoint ownership, binary lookup, login-shell PATH, version/mtime restart, startup announcement, durable desktop port | New `src/shell/daemon.ts`: bounded startup, authenticated probe/shutdown, detached child, log output, stripped inherited `CARGO_TARGET_DIR`, announcement before recovery, dead-child checks, protocol checks, startup coalescing. Separate window processes additionally coordinate through an exclusive local startup lock and a short-lived port/PID announcement. |
| `apps/desktop/src/state/rpc.ts`: connection and live-workspace lifetime | `shell/environment.ts`, `shell/Connection.tsx`, `App.tsx`, `nav/live.ts`, `shell/agentToasts.ts`: await local resolution, restore selected thread after asynchronous reconnect, start live services when a client arrives, replace old-client subscriptions. |
| `apps/desktop/src-tauri/src/environments.rs` and `remote.rs` | `environments/actions.ts`: switching back to local can start a missing daemon; packaged environment windows execute the compiled app without a nonexistent `src/main.tsx` argument; spawn errors reach a toast. `registry.ts` rejects explicit URLs without a token instead of falling through to local discovery. Existing SSH implementation and credential/identity checks retained. |
| `apps/desktop/src-tauri/src/cli.rs`, release/workspace version | `scripts/package-app.ts`, `packaging/entry.ts`, `settings/About.tsx`: stage this checkout's CLI and daemon in the app, pass their runtime paths, carry the workspace version into resources, About/update comparison, and bundle version. CLI fields discover an executable and conventional install destination. |
| `apps/desktop/src/views/Terminal.tsx` and `lib/terminalRenderer.ts` (xterm input transport) | `terminal/keys.ts`, `terminal/vt.ts`, `terminal/Terminal.tsx`: modified function/navigation keys, control/Meta chords, X10/normal/button/any-event mouse tracking, SGR/UTF-8/urxvt encoding, focus reporting, wheel accumulation, Shift selection bypass. Legacy mouse input uses single-byte encoding; ordinary terminal input remains UTF-8. Mouse mode paints only the bounded live screen. |
| Tauri terminal replay and viewport fitting | `VT.resize` removes below-cursor rows before shifting the top into scrollback. This fixes the first replayed line disappearing when the initial pane fit shrinks a 24-row screen. |
| `apps/desktop/src/views/Draft.tsx`: `commands` | `Composer.tsx`: draft `/resume`, `/sessions`, `/settings`, `/usage`, with the source's hints, icons and destinations; existing `/attach` retained. |

The checkout has no `docs/architecture.md` or `docs/design.md`; the requested
porting/native/performance guides and actual matching desktop sources were read.
No dependency versions or native addon patches changed.

## Verification

- `bun test apps/gpuix/src`: 63 tests, 496 assertions, all passed.
- `bun .../typescript/bin/tsc --noEmit -p apps/gpuix`: passed.
- `git diff --check`: passed.
- `scripts/shell5-daemon-check.ts`: real installed `kybernd` 0.9.1, isolated
  `/Users/mymac/projects/ade-gpuix-scratch/round5/shell/daemon`, port **4255**.
  Concurrent calls produced one startup endpoint; another resolver reused it;
  clean shutdown and restart retained the port and changed `started_at`.
  The daemon was shut down and its scratch data removed. Evidence:
  `/Users/mymac/projects/ade/previews/gpuix/round5/shell/daemon-check.json`.
- `scripts/shell5-ui-check.ts --matrix`: four sequential native GPUIX windows,
  dark/light × normal/reduced motion, under the round-5 UI lock. Uses the
  integration checkout's existing patched addon through an explicit
  `NAPI_RS_NATIVE_LIBRARY_PATH`; never writes that binary. Mock RPC transport
  captures actual terminal input. Asserted both replay lines remain visible,
  SGR mouse press/release/wheel bytes, Shift bypass, and all four draft command
  destinations. All four passed after the resize fix.
- Reviewed native screenshots: both terminal lines remain, the terminal cursor
  and tab strip render, and all five draft command rows remain readable.
  Eight screenshots live under the original conversation's
  `previews/gpuix/round5/shell/` (`terminal-*`, `draft-commands-*`).

The native fixture uses production GPUIX components and native event dispatch.
It is not native Tauri or a WebKit screenshot comparison, a physical keyboard
test, a real SSH network test, or an app-bundle shipping check. No 1:1 visual or
motion claim follows from these assertions.

## Remaining gaps

- Nested submenus are still missing. For example, the desktop account `Color`
  submenu and Notes move destinations are represented by separate GPUIX forms.
  No unverified menu primitive was added in this pass.
- Tauri's `TimePicker` has no call sites in this checkout (only its definition);
  no active time-picker surface was found to integrate or verify.
- GPUIX signed self-update artifacts/feed integration are absent. The release
  check remains read-only, using the correct workspace version. No signed
  shipping, notarization, package build, or updater installation was verified.
- Packaged multiwindow launch and sidecar staging were fixed in source, but an
  actual built app with two environment windows was not exercised. Existing
  SSH process tests pass; real host setup/reconnection still needs a target.
- Terminal mouse protocol encoders have unit coverage for drag/hover and legacy
  formats. Native tests cover SGR click/release/wheel and Shift selection only.
  The VT renderer is still a subset of xterm; this does not close all terminal
  escape, shaping, selection, or scrollback interaction differences.

## Resource and cleanup scope

Free space was **118 GiB before**, **115 GiB after** on the workspace volume;
other tracks were working concurrently, so this is not task-attributed growth.
This track performed no native build, install, export, or dependency copy.
The existing dependency directory was temporarily linked for validation; that
link was removed before handoff. Native fixture windows and task scratch daemon
were stopped, and the owned UI lock was released. Retained screenshots and JSON
evidence are approximately **1 MiB**. No Rust target or generated native binary
is retained. No CPU, GPU, memory or battery improvement is claimed.
