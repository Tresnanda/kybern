# Package 6: Settings, Pull requests and Usage (2026-10-15)

Worktree: `/Users/mymac/projects/ade-gpuix-settings`, branch `gpuix/settings`.
Fast-forwarded to `1c6a986e` before work. Changes are **uncommitted** for the parent.
Only `src/settings/**`, `src/pulls/**` and `src/usage/**` contain source changes.

## Changes

- Accounts: rename/color editing with the desktop's name/color validation;
  default account, per-project override/inheritance, sign-out and removal
  confirmations. Existing CLI accounts retain their protected identity.
- Agents: existing harness updates, OMP global/project profiles and Coordinator
  defaults retained. Cursor SDK install, browser sign-in/reopen/cancel, sign-out
  and Check again now call `cursor.setup/status`. Polling runs only while an
  install/sign-in is pending and stops on unmount; no idle timer added.
- Integrations: connector Sign in calls `integrations.login` for the selected
  matching project/provider conversation and opens its native Terminal dock.
  With no matching conversation, the page explains how to proceed.
- Computer: install/permission setup, removal of individual always-allowed apps,
  app-note editing/deletion with the daemon's 1500-character limit, inline errors.
- General: close confirmation uses the existing `kybern.askBeforeClose` seam.
  Global notes accurately describe the implemented separate-machine storage.
- About: read-only release check and Releases handoff; explicit bundled-command
  and install-path fields call the existing CLI status/install/uninstall seams.
  Tests install only a temporary fixture symlink, never a real executable.
- Appearance honors `KYBERN_CLIENT_CONFIG_DIR` for fixture isolation. Existing
  production preference paths remain compatible; System copy reflects live mode.
- `openSettingsTab(tab)` exports a live external navigation entry point, using
  batched local screen state. Escape in account dialogs leaves Settings open.
- PR merge split-menu pointer fix: shared Usage/PR `Button` rendered inside a
  Menu trigger no longer owns a no-op click handler or second tab stop. The Menu
  owns input; decorative child has `pointerEvents: none`. Before the fix, the
  pointer action test could not open Close/Checkout. After it, all six actions
  reach the mock RPC with the reviewed head and checkout's linked thread id.
- Existing native sliding pills, keyboard-immediate changes and Reduced Motion
  paths remain intact; no new animation or continuously polling render loop.

## Validation

The copied current native binary resolves the older Settings switch and PR-row
selection failures. Original Settings smoke passed switch round-trip,
`settings.changed`, and numeric clamping; its first run's later shortcut lookup
failed because that scratch daemon had no composer/project. `verify.scratch.ts`
provides an isolated conversation without launching any agent turn.

The original dark PR/Usage native check passes: grouping/period, search, 2400-line
native diff, inline drafts, remount retention, timeline pagination, send/merge
surfaces, sidebar peek, GitHub missing/auth states. The light check initially
asserted a zero bar count while the virtual chart was offscreen after reloading;
`usage/verify.native.ts` waits for loaded stats and scrolls the chart into view
before counting its seven bars. This check passes light.

`settings/verify.native.ts` uses a mock server for account/settings/setup writes;
only `settings.get` reads the explicit scratch daemon for defaults. It exercises
account name/color, default/project assignment, sign-out/removal, app-note save,
computer setup dispatch, Cursor install/sign-in/cancel, and temporary CLI symlink
install/uninstall. `pulls/verify.actions.ts` uses an in-memory fixture exclusively:
comment, approve, request changes, merge, close, checkout, reviewed head, failed
submission draft retention/retry, and empty list. No real GitHub/provider/account,
Keychain, OS permission or integration state is modified.

Final checks:

| Check | Result |
|---|---|
| `pnpm typecheck` | Pass |
| `bun test ./src` | 21 pass, 0 fail, 88 assertions |
| Original `settings-check.ts`, dark | Pass (switch + notification + numeric field + all sections/search/Escape/shortcut/Back) |
| Original Settings navigation-only, light | Pass |
| New native Settings controls, dark/light | Pass (including dialog Escape containment; mock-only mutations) |
| Original PR/Usage native check, dark | Pass |
| Scroll-aware PR/Usage native check, light | Pass |
| All six PR actions, dark/light | Pass (mock RPC only) |
| `git diff --check` | Pass |

Screenshots/logs: `/Users/mymac/projects/ade/previews/gpuix/p6/`.
The original scripts' failed attempts remain described above rather than being
counted as passes. No GUI test was used to authorize real account or OS writes.

## Issue #108 status

| Line | Status | Evidence / remaining work |
|---|---|---|
| 18.1–18.10 | Done | Native dark/light page flow; all six actions on mock RPC; pagination/drafts/errors/empty state. Real GitHub writes deliberately not exercised. |
| 19.1–19.2 | Done | Native dark/light Usage grouping/period/chart and breakdown; desktop pure formatting/usage logic retained. |
| 21.6 | Partial | Existing browser/paste/device-code account dialog remains; terminal account login still hands off to desktop (outside ownership). |
| 22.1–22.2 | Done | Native screen/navigation and external openSettingsTab entry point. |
| 22.3 | Partial | General RPC controls and close preference work; shared-global note routing is not available. |
| 22.4 | Partial | Live themes; material switch persists but needs relaunch. |
| 22.5 | Partial | Agent notifications setting retained; native OS notification service belongs to shell. |
| 22.6 | Done | Harness updates, OMP default/project profiles, delegation/Coordinator controls, Cursor SDK/sign-in actions implemented; real installs not exercised. |
| 22.7 | Partial | Management/default/project actions implemented and mock-tested; desktop's complete grouped account usage/avatar presentation still differs. |
| 22.8 | Partial | Catalog changes and selected-conversation terminal login wired; real connector OAuth completion not exercised. |
| 22.9 | Partial | Setup, per-app revoke and note editing implemented; actual OS permission prompts/install not exercised, manual Check again required. |
| 22.10 | Done | Existing background controls/activity retained. |
| 22.11 | Partial | Update manifest check and explicit CLI management work; signed GPUIX self-update artifact absent. |
| 25.2 | Done for package 6 | Native settings/PR/Usage sliding pills retained; keyboard and Reduced Motion are immediate. Other dock surfaces belong to other packages. |
| 26.4, 27.5 | Partial | Persisted translucency, launch-time native material only. |
| 27.13 | Partial | Read-only update manifest + Releases handoff; no signed GPUIX updater. |
| 27.15 | Partial | CLI symlink management wired and temporary-path native-tested; packaging must supply bundled CLI path for automatic discovery. |

## Parent/native requests (no edits outside ownership)

- P2: import `openSettingsTab` from `settings/SettingsScreen.tsx` and call
  `openSettingsTab('about')` / `openSettingsTab('accounts')` for rail/title-bar
  entries. Add account already uses `showDialog({ kind: 'account' })`.
- Shared global notes need the notes owner's runtime/client routing to this
  Mac's daemon, with one app-wide `kybern.notes.globalHome` preference. A
  Settings-only switch would falsely promise sharing; no fake toggle added.
- Runtime translucency needs a native window-background/material setter that
  both removes and restores blur, then a hook in `shell/appearance.ts`. The
  current `applyDesktopMaterial` can retint existing blur, not toggle it.
- Packaging: supply `KYBERN_BUNDLED_CLI` as the explicit bundled CLI executable
  path. `platform.ts` CLI functions mutate symlinks (they are not dry-run plans),
  so no real CLI path was used in verification.
- About needs a GPUIX application version/release channel and signed artifact
  before the shared desktop update feed can support automatic installation.

- Test maintenance outside ownership: `scripts/settings-check.ts --live-theme`
  should resolve its expected appearance file under `KYBERN_CLIENT_CONFIG_DIR`
  when set, falling back to `~/Library/Application Support/kybern-gpuix`, and
  hash `process.env.KYBERN_URL || dir`. Its old hard-coded home path does not
  reflect explicit fixture isolation. The new native checks do not use that
  hard-coded readback.


## Performance and acceptance limit

Apple M1, macOS 27.0, Bun 1.4.0, patched GPUIX 0.10.0, 1280×820 background
window. Every row has two fresh-process runs, each with **10 s warmup + 15 s
sampling**. Settings alternates General/Appearance every 500 ms. PR switches
among three 2400-line native diffs every 700 ms. CPU is process CPU time;
footprint is `footprint`, not RSS; GPU is accumulated process Metal time.

| Workload/version | CPU % (runs 1 / 2) | Footprint MiB (1 / 2) | GPU ms per 15 s (1 / 2) |
|---|---:|---:|---:|
| Settings initial baseline | 19.00 / 19.80 | 169 / 170 | 224.5 / 202.8 |
| Settings baseline replay, same populated scratch data | 11.73 / 18.40 | 179 / 188 | 45.7 / 192.8 |
| Settings final, batched navigation | 18.80 / 19.40 | 171 / 187 | 225.8 / 195.8 |
| PR before trigger fix | 13.13 / 13.00 | 215 / 217 | 52.1 / 45.2 |
| PR after trigger fix | 12.53 / 11.87 | 218 / 222 | 45.5 / 45.3 |

The initial Settings baseline used an empty scratch workspace; navigation tests
then created scratch conversations. The replay temporarily restored only six
owned source files from HEAD against the same populated data, restoring all
edits in `finally`. Intermediate external-store navigation samples are also
retained in the logs; the shipped implementation uses batched local state.

**A strict no-regression performance sign-off is not established.** Settings CPU
and GPU vary substantially between nominally identical background runs while
other agents/windows are active; its matched-baseline memory range overlaps the
final range. PR mean CPU is lower (13.07% → 12.20%) and GPU lower (48.65 → 45.40
ms), but mean footprint is 4 MiB higher (216 → 220 MiB). These measurements do
not justify asserting zero memory regression or a general speedup. Re-run the
owned `verify.perf.ts` scripts when other native fixtures are idle before closing
the performance gate. Frame intervals, React commit time, input latency, energy,
and a simultaneous Tauri comparison were not measured.

## Cleanup and handoff

Stopped only this task's scratch daemon PID 30041 on port 4276. Removed scratch
daemon/config/project data, the six-file replay backup after restoring edits,
and the task-copied 23 MiB native binary after verifying it had no open handles.
For another native run, copy the current binary from the parent worktree again.
No Rust build or simulator installation was performed. The pre-existing/reused
204 MiB `node_modules` remains for parent checks. Approximately 24 MiB of requested
screenshots and logs remains in the conversation's `previews/gpuix/p6` folder.
Free space was 72 GiB before and 73 GiB after; other workers were active, so this
is not a claim that task cleanup reclaimed 1 GiB. Port 4219, the installed Kybern
app, normal `~/.kybern`, real provider accounts and Keychain were preserved.

All source changes remain uncommitted. No App.tsx, TitleBar.tsx, state.ts or native
source was edited. The changed source files and verification scripts are confined
to the three owned directories; this document is the detailed integration report.
