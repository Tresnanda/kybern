# remote9: windows, SSH environments, preview relay over SSH

Scope (issue #108): §27.8 multiple windows + Keychain, §27.9 / §4.3 SSH bootstrap and tunnel, §4.7 connect to
any environment, §27.10 preview loopback relay against a real remote environment. Reference:
`apps/desktop/src-tauri/src/{environments,remote,preview_relay}.rs`, `views/EnvironmentSwitcher.tsx`,
`state/environments.ts`, `lib/environments.ts`.

## One window per environment

A window is a process. The renderer keeps its single window, scroll/list handles and key routing in
thread-locals, and every app store is module state. That is what one Tauri webview's JS realm is, so a process per
window keeps the desktop's isolation without rewriting every store. `windows/registry.ts`:

- every window claims `<client config>/gpuix-windows/<pid>.json` (environment, Unix socket) and rewrites the
  claim when it switches environments;
- "Open in a new window" focuses the window that already shows that environment, asking it over its socket
  (it de-miniaturizes and makes itself key; under `GPUIX_BACKGROUND` it only orders itself front). Otherwise it
  spawns `main.tsx` pinned by `KYBERN_GPUIX_ENVIRONMENT` and claims the child's pid at once, so a second click
  waits for that window instead of opening another. Claims of exited processes are dropped when read. There are
  no timers: the socket only wakes on a request;
- every window is titled "<environment> — Kybern" and retitled on switches (desktop `selectEnvironment`).

The desktop opens another window on every click. Focusing the existing one follows the #108 item ("one per
environment").

Credentials: `environments/credentials.ts` uses the desktop's Keychain service. Checks set
`KYBERN_GPUIX_KEYCHAIN_SERVICE=kybern-gpuix-test-…`, which is accepted only with a scratch client config, so they
exercise the real Keychain without touching the desktop's items.

## SSH

`environments/ssh.ts` follows `remote.rs`. Error copy is word for word (`explain`); the tunnel keeper respawns
`ssh -N -L` on the same local port with 1–30 s backoff; `waitReady` reports starting/ready/failed like
`wait_ready`; a tunnel that cannot open fails the start step; and updates say "Updated kybernd X to Y".
`runSsh` waits for stdout to end before reading the probe, because `exit` can come first, and caps that wait so
a ControlPersist master cannot hold a step. The forward runs with `ControlMaster=no ControlPath=none`, while
probes use the user's multiplexing.

## Checks (scratch only)

`environments/remote9.lib.ts` sets up a throwaway user-space `sshd` on 127.0.0.1:2299 (scratch keys, a
`ForceCommand` that sets a scratch `HOME` whose `.kybern` is daemon B's scratch dir) and a `KYBERN_SSH`
wrapper, `ssh -F <scratch config>` with ControlMaster aliases. `~/.ssh` is never read or written.

- `environments/remote9.ts [dark|light]`: address + code, invitation, Keychain items, forget; SSH host list,
  bootstrap through the dialog, pairing, tunnel kill → same port, SSH down → banner → recovery, permission and
  unreachable errors, starting a stopped remote daemon.
- `windows/remote9-windows.ts [dark|light]`: open, focus existing, self, close → reopen; titles; B's connection
  count; Keychain.
- `environments/remote9-preview.ts [dark|light] [--transport-only]`: a server started on the SSH machine,
  through `openRelay` → tunnel → B `/preview-proxy`, then in the dock preview (UI lock), a tunnel drop and Reload.
- `windows/registry.test.ts`: focus/open/stale-claim logic with real sibling processes.
- Visual pairs: `visual/screens/remote9.*` (`r9-ssh-progress`, `r9-ssh-permission`, `r9-ssh-unreachable`), with a
  no-network `ssh` for GPUIX and mocked `remote_bootstrap` events for the desktop.

## Known gaps

- Every window process has its own Dock icon, and ⌘Q quits only the window it is in; the desktop has one app.
  Closing that gap needs a native multi-window host: one GPUI app owning N windows, each fed by its own JS realm
  (worker).
- On the test target, macOS `nohup` refuses to run in a non-root sshd session ("can't detach from console"). The
  scratch HOME has a SIGHUP-ignoring shim. The desktop's start script is identical; a real macOS or Linux sshd
  is unaffected.
- Installing or updating kybernd from the GitHub installer is covered by unit tests only, because it needs the
  published HTTPS installer.
- Machine suggestions are chips under the field; the desktop uses a `<datalist>`.
