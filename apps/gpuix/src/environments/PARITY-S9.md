# settings9: environments (part B)

Scope: Add environment (address / pairing invitation), Manage environments (edit, forget),
Pair a device (`access.*`), the environments menu, connecting to any saved environment and
per-environment local storage. Reference: `apps/desktop/src/views/EnvironmentSwitcher.tsx`,
`environmentStyles.ts`, `state/environments.ts`, `state/environmentWorkspace.ts`.

## What changed (R1-8)

- Dialog geometry is now the desktop's, measured in the desktop frontend (WebKit, 512 px dialog):
  header 16/16/4 with a 15/18.75 title and 14/22.75 description; the panel starts flush under the
  header (the desktop's `in-[...]:pt-0` wins over `pt-3`, which GPUIX had as a 12 px gap); fields
  are label 13/19.5 w500 + 32 px input (radius 10, border `foreground/30` on focus, red when
  invalid); hints are 13/21.125; footers are 12 px above and below; buttons are 32 px, radius 10,
  14/21 w500, disabled at 64%. `kit.tsx` holds these as local primitives (TODO kit9).
- The Over SSH / Address tab bar is the desktop's 39.5 px track with 31.5 px tabs (13 px, idle
  text at 95%), not a 40 px bar with 14 px labels.
- Address form: pasting a complete invitation fills the address with its URL and the pairing code
  (the desktop's `setAddressOrInvitation`), the address is validated (error line under the
  field), unreachable/loopback errors use the desktop's wording, Enter submits, fields dim while
  connecting and the button shows a loader.
- SSH form: the `ssh-copy-id` hint on permission errors, loader in the button, Enter submits.
- Manage: rows are 68 px (name 14/22.75 + hint 13/21.125 inside 12 px padding), the local row says
  "Managed by Kybern" unless it was configured with a URL, forgetting shows a loader on the row
  and disables the others.
- Pair a device: the code is drawn as six fixed cells 7.5 px apart (GPUIX text has no letter
  spacing, the desktop uses `tracking-[0.25em]`), the paired-device list refreshes every 5 s
  while the dialog is open, Copy invitation has the copy glyph, secondary buttons use the muted
  ink the app theme gives `--secondary-foreground`, and the body scrolls inside the dialog.
- Environments menu: two-line rows (name; status dot and "Connected" / "On this Mac" /
  "SSH connection" / "Remote environment"), the current row filled with a check, 46 px pitch,
  "Open in a new window" on every row, action rows at 28.5 px.
- Settings footer shows the active environment's name with the desktop's dot.

## Per-environment storage (item 5)

Files are per environment: `<data dir>/gpuix-ui.json` (local) or `gpuix-ui-<sha1(profile id)>.json`
(saved environments; `shell/persist.ts`) and `<client config>/workspace-<sha1(env key)>.json`
(sidebar collapse, order, filter, unread; `nav/live.ts`). Keys mirror the desktop's `localStorage`
names. New: `kybern.workspace.selected` (the page the environment was last on, desktop `selected`),
restored on launch and on switching; an open thread already came back through the split view.
Forgetting an environment deletes both files (desktop `forgetEnvironmentStore`).

## Checks (scratch daemons only)

- `src/environments/verify9.ts [dark|light]`: add by invitation, validation, switch, edit, new
  window request, Tailscale switch, pair + Revoke, forget (daemon state asserted over the CLI).
- `src/environments/storage9.ts [dark|light]`: drafts, threads, pages, restart, forget cleanup.
- `src/environments/outage9.ts`: stop daemon B, see the failure, restart it, reconnect.
- Visual pairs: `visual/screens/env9.{gpuix.ts,tauri.mjs}` (`bun scripts/visual-pair.ts env9-menu ...`).

## Known gaps

- `text-wrap: pretty` (the desktop wraps hints and descriptions earlier to avoid short last lines)
  and letter spacing (pairing-code placeholder) have no GPUIX equivalent; wrapping can differ by a word.
- Focus ring and blur validation could not be observed: automation windows are not key windows,
  so `onFocus`/`onBlur` never fire (the Settings search focus pair is blank too). Validation also
  runs on submit, which is what the checks exercise.
- The desktop's stepped ring spinner is drawn with the app's matrix loader (TODO kit9).
- "Open in a new window" spawns a separate process pinned to the environment; one window per
  environment (focus the existing one instead of spawning a second) needs remote9's window registry.
