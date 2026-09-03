# kybern

A desktop harness for coding agents. Threads, worktrees, approvals, diffs,
terminals and a file explorer for Claude Code, Codex, OpenCode, pi, Oh My Pi
and Cursor, driven through their own protocols, from one Rust daemon and a
Tauri + React desktop client.

kybern is a reimplementation of the ideas in [T3 Code](https://github.com/pingdotgg/t3code)
with a Rust daemon at the center so a desktop app, a phone, and a remote
machine all see the same threads. The desktop client's look follows
[Synara](https://github.com/Emanuele-web04/synara) (MIT): its stylesheet,
primitives and icon system are vendored under `apps/desktop/src/components/synara`
and `apps/desktop/src/lib/synara`.

## Layout

| Path | What it is |
| --- | --- |
| `crates/kybern-protocol` | Wire types. JSON-RPC 2.0 over WebSocket, scoped tokens, the event-sourced thread model. `kybern-schema` dumps JSON Schema for non-Rust clients. |
| `crates/kybern-store` | SQLite persistence (WAL, event log, projections). |
| `crates/kybern-drivers` | One native driver per agent: Claude Code, Codex, OpenCode, pi, Oh My Pi, Cursor. |
| `crates/kybern-daemon` | `kybernd`. Owns provider processes, threads, approvals, terminals and project files; serves clients on a loopback port with bearer tokens. |
| `crates/kybern-cli` | `kybern`. Command-line client and the integration harness for every driver. |
| `crates/kybern-client` | Shared WebSocket client used by the CLI and the desktop shell. |
| `apps/desktop` | The desktop app: Tauri 2 shell (`src-tauri`, crate `kybern-desktop`) around a React 19 + Tailwind 4 web app. Bundles and spawns `kybernd` if none is running. |
| `apps/mobile` | Expo client (connect, threads, transcript, approvals, composer). |

The previous GPUI desktop client lives on the `gpui` branch and is no longer
built from `main`.

## Install

Prebuilt binaries for every tagged release live on
[GitHub Releases](https://github.com/Tresnanda/kybern/releases). The daemon
(`kybernd`) and CLI (`kybern`) are built by [cargo-dist](https://axodotdev.github.io/cargo-dist/)
for macOS (Apple silicon + Intel), Linux (x86_64 + arm64, static musl) and
Windows (x86_64). The desktop app ships as a macOS DMG.

### Daemon and CLI

macOS / Linux:

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/Tresnanda/kybern/releases/latest/download/kybern-daemon-installer.sh | sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/Tresnanda/kybern/releases/latest/download/kybern-cli-installer.sh | sh
```

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://github.com/Tresnanda/kybern/releases/latest/download/kybern-daemon-installer.ps1 | iex"
powershell -ExecutionPolicy Bypass -c "irm https://github.com/Tresnanda/kybern/releases/latest/download/kybern-cli-installer.ps1 | iex"
```

Both installers put the binary in `~/.cargo/bin` (or `%USERPROFILE%\.cargo\bin`).
Plain archives (`.tar.xz` / `.zip`) with SHA-256 sums are on the same release page.

### Install on macOS

Download `kybern-<version>-<arch>-apple-darwin.dmg` from the release
(`aarch64` for Apple silicon, `x86_64` for Intel), open it and drag
**kybern.app** to Applications. The app bundles its own `kybernd`, so nothing
else is needed.

The app is signed ad hoc, not with an Apple Developer ID, and it is **not
notarized**. The first launch is therefore blocked by Gatekeeper. To open it:

1. In Finder, **right-click (or Control-click) kybern.app and choose "Open"**.
2. Click **Open** in the dialog. macOS remembers the choice; later launches
   work with a normal double-click.

If macOS reports the app as "damaged" (Sequoia and later do this for some
unsigned downloads), clear the quarantine flag once and open normally:

```sh
xattr -dr com.apple.quarantine /Applications/kybern.app
```

### Windows and Linux desktop app

Not packaged yet. Build the desktop app from source (below); Tauri produces
the platform installer with `kybernd` bundled as a sidecar.

## Build from source

Needs stable Rust 1.88 or newer (`rust-toolchain.toml` picks it up), Node 22
and pnpm 11 (`corepack enable`).

```sh
cargo build --release -p kybern-daemon -p kybern-cli   # target/release/{kybernd,kybern}

cd apps/desktop
pnpm install --frozen-lockfile
pnpm tauri build                                        # builds and bundles kybernd automatically
```

The `pnpm tauri` wrapper builds the daemon for the same profile and target,
stages the target-triple sidecar expected by Tauri, and then runs the Tauri
CLI. The standalone daemon and CLI builds remain available for headless and
remote use.

For development, run the web app with hot reload inside the Tauri window:

```sh
cd apps/desktop && pnpm tauri dev
```

The desktop app reuses an authenticated, protocol-compatible daemon selected
by `KYBERN_DATA_DIR`. If none is available it starts the bundled daemon on an
unused port, writes that port to `daemon.port`, and leaves the daemon running
for CLI and mobile clients when the window closes.

During development, run `kybern --data-dir /tmp/kyb stop-daemon` before
relaunching after daemon or driver changes; otherwise the new desktop build
will intentionally reuse the old process for the same data directory.

### macOS app bundle

`scripts/bundle-macos.sh` runs the self-contained `pnpm tauri build`, verifies
the bundled daemon, signs the app ad hoc, and writes
`dist/kybern-<version>-<arch>-apple-darwin.dmg`:

```sh
scripts/bundle-macos.sh              # SKIP_BUILD=1 reuses the last complete app
```

It needs Xcode command line tools (`codesign`, `hdiutil`), Node 22 and pnpm.

### Releasing

Tagging `vX.Y.Z` runs `.github/workflows/release.yml` (generated by
`dist generate` from `dist-workspace.toml`): it builds the daemon and CLI for
every target, publishes archives + installers to a GitHub Release, and then
runs `.github/workflows/macos-app.yml`, which builds the DMG with the bundle
script on macOS runners and uploads it to the same release. Run
`dist plan` locally to check the config after editing it, and `dist generate`
to refresh `release.yml`.

## Run it

```sh
cargo build
./target/debug/kybernd                       # data in ~/.kybern, port 4173
./target/debug/kybern providers
./target/debug/kybern new -p . "explain this repo in three lines"
./target/debug/kybern threads
./target/debug/kybern send <thread-id> "now write the README"
./target/debug/kybern watch                  # live event stream for all threads
./target/debug/kybern ls <project-id> src    # browse project files
./target/debug/kybern terminal run <thread-id> "git status"
```

Approvals show up inline in `new` and `send`; answer with `y`, `a` (always) or `n`.

## Status

What works today, all verified end to end on macOS:

- **Daemon**: WebSocket JSON-RPC with scoped tokens, SQLite event log with
  replay, per-turn git checkpoints, turn and thread diffs, workspace revert
  and conversation rewind, server-owned terminals, project file listing and
  reading, pairing codes for other devices, attachment uploads, settings and
  keybindings files.
- **Agents**: Claude Code, Codex, OpenCode, Oh My Pi, and Cursor drive
  through their native protocols with streaming, tool calls, approvals,
  resume, and model switching. pi is wired but untested here.
- **Desktop**: projects and threads in a translucent sidebar, a streaming
  transcript with a message rail, "Worked for" disclosures and inline diffs,
  a frosted composer with @ file mentions, / commands, queued follow-ups,
  approval cards answered by digit, permission mode and model/effort pickers,
  hand-off between agents, a right dock with diff, terminal tabs (shells and
  agent CLIs side by side) and a file explorer, an Environment card, a pull
  request list, a command palette, settings, light and dark themes, and
  resizable panes.
- **CLI**: everything the daemon does, usable from scripts.
- **Mobile**: Expo client scaffold in `apps/mobile`. Not yet run on a device.

See `docs/architecture.md` for how the pieces fit and `docs/design.md` for
the desktop design rules.

## License

MIT. Synara's vendored UI code is MIT as well; see its license header notes
in `apps/desktop/src/components/synara`.
