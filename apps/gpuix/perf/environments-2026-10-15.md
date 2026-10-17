# Environments, floating panel and workspace dialogs

Branch: `gpuix/environments`. Apple M1, macOS 27.0, Bun 1.4.0,
GPUIX 0.10.0 with the existing cached-island native module. All writes used
scratch daemons (4219 and this task's second daemon on 4227), isolated client
metadata and file credentials. The user's default daemon and Keychain were
not modified. No packages, Rust builds or native-module builds were added.

## Implementation

- `shell/environment.ts`: active environment and revision, ordered singleton
  teardown/reset hooks, connection lifecycle and per-environment key. `App.tsx`
  remounts the workspace by environment and revision; switching stays in the
  same native process. `state.ts` resets the socket/lists/open thread and guards
  stale replies; reconnect re-reads registry/credentials/port files.
- `environments/registry.ts`, `credentials.ts`, `actions.ts`: desktop-compatible
  registry and macOS generic-password service, address/invitation validation,
  identity verification, credentials saved before the post-pairing handshake,
  editing/forgetting and separate-process new windows. Explicit isolated file
  credentials are available only alongside an isolated client config directory.
- `sidebar/EnvironmentSwitcher.tsx`, `environments/Dialogs.tsx`: saved-machine
  menu, add/edit/manage forms, pairing invitation, QR, Tailscale exposure,
  expiry state and device revocation. Waiting sheets do not poll.
- `vendor/qrcodegen.ts`: Nayuki's MIT TypeScript source at commit
  `3c6d0b3cefb4e049dc337e82237c9644399716a8`; only module exports and trailing
  whitespace changed. `environments/qr.ts` uses `encodeText(..., Ecc.MEDIUM)`
  and a single SVG path with a four-module quiet zone. No Core Image in the app.
- `environment/Panel.tsx`, `ThreadNote.tsx`, `store.ts`: 288px floating card,
  section visibility, git/workspace/editor rows and revision-checked compact
  Markdown note drafts. Enter is 180ms, exit 120ms, keyboard immediate;
  Reduce Motion removes movement. The card and environment menu live outside
  cached islands because deferred layers inside islands lost native hit bounds.
- `dialogs/ProjectPicker.tsx`, `WorktreeCleanup.tsx`, `Account.tsx`: daemon folder
  browsing/add, source/blocker-aware cleanup, and browser/paste/device-code
  account sign-in with daemon notifications, retry and explicit refresh.
- Shared-file changes are additive integration or lifecycle registrations:
  Composer/composer store; nav store/live/history/TitleBar; dock stores and
  Explorer; settings store/appearance/breadcrumb/secondary; connection,
  persistence, sidebar width, toasts; transcript caches; usage and PR caches.
  Composer drafts and model/account/permission choices persist per environment.
  Old async results are ignored by client/revision ownership checks.

New singleton stores added by sibling ports must register
`onEnvironmentChange(reset)`; state that must be saved before switching uses
`onEnvironmentLeaving(save)`. Stop subscriptions at priority -100. The shared
preference cache flushes/changes at -80, app state clears at -60 and navigation
at -50; ordinary resets then load the destination's preferences. React-local
forms/effects remount with the workspace.

## Verification

- `pnpm typecheck` and `git diff --check` passed.
- Dark and light native interaction checks: panel visibility/section toggles,
  environment menu/add/manage/pairing, remote picker and account picker.
- A→B→A in one process: B has no A project/thread/note; A's note draft,
  unsent composer text and Explorer tab restore. Five further round trips:
  233, 235, 247, 244, 233 MB; a prior simple run was 229, 229, 228, 232, 231 MB.
  These bounded runs do not show a monotonic trend; they are not a long-run
  leak proof. Different runs varied with concurrent native windows.
- API check redeemed an invitation, verified identity, edited the profile,
  revoked its device token, confirmed reconnection fails, and forgot the profile.
- Worktree check created an empty idle scratch thread without starting an agent,
  inspected its managed worktree and removed it through the light-mode UI.
  Remote folder browsing and Add this folder succeeded.
- Reduce Motion panel and section checks passed.
- QR check parses the installed CLI's half-block matrix. Nayuki and the Rust
  encoder produce different masks/segmentation (both 45×45 for the fixture).
  Exact pixel equality is not asserted. Quick Look rasterizes our SVG, and
  `scripts/decode-qr.swift` uses Vision in a test-only process to assert that
  it decodes to the exact invitation. This passed; no decoder enters the app.

Verification entry points (run in `apps/gpuix` with the patched
`NAPI_RS_NATIVE_LIBRARY_PATH`):

- `src/environment/verify.ts [dark|light]`: card and section toggles.
- `src/environments/verify.ts [dark|light]`: two-daemon switching and forms.
  `FORMS_ONLY=1` omits the five extra cycles; `MEASURE=1` additionally samples.
- `src/environments/verify-api.ts`: isolated pairing/edit/revoke/forget and
  an idle cleanup fixture. Requires the isolated client and credential paths.
- `src/dialogs/verify.ts [dark|light]`: worktree, account and folder dialogs;
  `REMOVE_FIXTURE=1` removes the generated cleanup fixture.
- `src/environments/verify-qr.ts`: CLI comparison plus test-only Vision decode.
- `src/environments/verify-memory.ts`: two fresh QR lifecycle runs without
  screenshots. `src/environment/verify-performance.ts`: clean panel samples.

The fixture scripts intentionally name this task's scratch folders and existing
A fixture. Recreate the second daemon and isolated profile before rerunning;
they cannot silently connect to the user's default daemon.

## Measurements

The final TypeScript encoder's fresh → pairing QR → close → home physical
footprint, without screenshots:

| Run | Fresh | QR open | Closed | Home |
| --- | ---: | ---: | ---: | ---: |
| 1 | 191 MB | 204 MB | 204 MB | 204 MB |
| 2 | 200 MB | 215 MB | 215 MB | 216 MB |

The abandoned Core Image implementation measured 325 MiB idle after pairing,
2.60% CPU and 0.1ms GPU over 15s; active 16 toggles measured 317 MiB, 5.33% CPU,
13.5ms GPU. That was a screenshot-heavy run. A screenshot-heavy final TS run
also reached 321 MiB idle and 299 MiB active, so those are **not controlled
memory comparisons**. Screenshot instrumentation contributes substantially;
use the clean lifecycle numbers above for the final QR implementation.

Clean panel-only samples without screenshots: 186 MiB, 2.67% CPU, 1.6ms GPU
idle; a repeat was 175 MiB, 4.00% CPU, 20.5ms GPU. Shared scratch-daemon traffic
and concurrent native windows varied during these runs. The unpaced active
stress script produced 752 toggles in 15s (232 MiB, 90.33% CPU, 259.6ms GPU);
a second run produced 572 toggles (206 MiB, 102.67% CPU, 874.4ms GPU). Those
are deliberate saturation workloads, not normal use. The final screenshot
interaction sample exercised 12 toggles in 15s at 4.47% CPU / 12.9ms GPU.
Idle approximately meets the 3% target in the first sample; the 4% repeat is
recorded rather than treating the threshold as universally established.

All windows were launched in the background. GPU measurements are accumulated
Metal client time from `ioreg`, not GPU utilization or energy. CPU is process
CPU time divided by 15s; footprint comes from `footprint -p`, not RSS. Background
occlusion and concurrent tasks limit generalization. No Tauri comparison or
battery claim is made here.

## Parity accounting: issue #108

- Done: §13 “Floating card toggled from the header; sections hideable”.
- Partial: §13 “Rows: Changes, Running in, Branch, Commit and push, Repository,
  Pull request, Editor, thread Notes”. All rows work through existing APIs;
  PR opens the browser until the Review dock exists, notes are plain Markdown
  with explicit save instead of the rich editor. As in the current desktop,
  `git.commit` commits but does not actually push (daemon contract gap).
- Done: §4 “Environment switcher row”, “Add environment by address or pairing
  invitation”, “Manage environments: edit and forget”, “Reconnect after failure;
  the workspace remounts when switching”.
- Partial: §4 “Environments menu: switch, ‘Open in a new window’”: switching
  tested; new windows use a separate Bun process, not native multi-window API,
  and were not opened in this single-window verification.
- Partial: §4 “Pair a device: QR, Tailscale switch, invitations, device list with
  Revoke (`access.*`)”: implemented; invitation/revoke/QR tested. Tailscale
  reachability was not toggled or exercised across a real remote network.
- Partial: §4 “Connect to any environment”: address/invitation connections work;
  SSH profiles give a desktop handoff. “Add environment over SSH
  (`remote_bootstrap`, `remote_ssh_hosts`)” remains open; these are Tauri APIs.
- Done: §21 “Project picker for remote environments (`projects.browse`)” and
  “Worktree cleanup dialog (`threads.worktree.*`)”.
- Partial: §21 “Add account sheet (`providers.accounts.login.*`)”: browser,
  paste/device-code paths and completion/cancel/retry are implemented. Only
  the initial native sheet was exercised, with no real account login. Interactive
  terminal sign-in directs to desktop; the full color/duplicate-edit flow is absent.
- Open: §21 “Close guard (‘Threads still working’)”: GPUIX 0.10.0 exposes no
  supported should-close window interception.
- Advanced: §27 “Multiple windows, one per environment; keychain credentials”
  (Keychain implementation matches desktop service/account but was not exercised
  against the real Keychain); “Pairing QR” is complete on macOS.
- Advanced: §29 “Per-environment local storage (drafts, project order, filters,
  notifications, layout)”. These existing stores now reload/reset on switching;
  sibling Notes/Tasks stores must register when merged.

Review images are outside git under
`/Users/mymac/projects/ade/previews/gpuix/environments/`: `panel-dark.png`,
`panel-light.png`, `restored-panel-{dark,light}.png`, `switcher-{dark,light}.png`,
`add-{dark,light}.png`, `manage-{dark,light}.png`, `pair-{dark,light}.png`,
`worktree-{dark,light}.png`, `account-{dark,light}.png`, and
`project-picker-{dark,light}.png`.

## Cleanup

Stopped this task's second scratch daemon only; the shared 4219 daemon remains
running. Removed the 88 MiB Swift module cache and disposable second-daemon,
credential and client-registry fixtures after checks. No new Rust target or
node_modules installation was created. The preinstalled 184 MiB node_modules
is retained. Free space was 69 GiB before and after the test-only Swift work;
concurrent tasks prevent attributing volume-level differences to this task.
Review images and small numeric evidence remain in the conversation previews.
