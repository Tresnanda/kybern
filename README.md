# kybern

A desktop harness for coding agents. Threads, worktrees, approvals, diffs,
terminals and a file explorer for Claude Code, Codex, OpenCode, pi, Oh My Pi
and Cursor, driven through their own protocols, from one Rust daemon and a
Tauri + React desktop client.

kybern is a reimplementation of the ideas in [T3 Code](https://github.com/pingdotgg/t3code)
with a Rust daemon on each host. Desktop and mobile clients connect to a
selected machine, which keeps its own projects, threads, and running agents.
The desktop client's look follows
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

Choose what this machine will do:

| Machine | Install |
| --- | --- |
| Your Mac, Windows PC, or Linux desktop | Desktop app. It bundles the local daemon. |
| VPS or another machine that runs agents | `kybernd` only; optionally `kybern` for administration over SSH. No desktop, Node, or pnpm required. |
| Phone | The mobile companion is still a source-only scaffold; see [apps/mobile](apps/mobile/README.md). |

Install and authenticate your coding-agent CLIs on the machine that will run
work. A VPS keeps its own projects, threads and provider credentials; connecting
to it does not copy your laptop's projects or credentials.

### Desktop app

**Build from source today.** There is no published release available at the
time of writing. Install stable Rust, Node 22+, pnpm 11, and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), then:

```sh
git clone https://github.com/Tresnanda/kybern.git
cd kybern/apps/desktop
pnpm install --frozen-lockfile
pnpm tauri build
```

Install the generated package under `target/release/bundle/` at the repository
root. On macOS, open the DMG and drag **kybern.app** into Applications. The build
bundles `kybernd`; you do not need to install the daemon or CLI separately.

Tagged releases are configured to publish macOS DMGs to
[GitHub Releases](https://github.com/Tresnanda/kybern/releases), named
`kybern-<version>-<arch>-apple-darwin.dmg` (`aarch64` for Apple silicon,
`x86_64` for Intel). Windows and Linux desktop packages currently require a
source build.

The macOS bundle is signed ad hoc and is not notarized. Follow macOS's
**Privacy & Security → Open Anyway** flow if it blocks the app you built or
intentionally downloaded. For an ad-hoc bundle reported as damaged, you can
remove its quarantine attribute after verifying where it came from:

```sh
xattr -dr com.apple.quarantine /Applications/kybern.app
```

### Daemon only: VPS or remote machine

From a checkout, install the daemon with stable Rust and your platform's native
build tools. This builds only the Rust host; it does not build the desktop app.

```sh
git clone https://github.com/Tresnanda/kybern.git
cd kybern
cargo install --locked --path crates/kybern-daemon
```

Cargo normally installs `kybernd` in `~/.cargo/bin`; make sure it is on `PATH`.
For headless administration and fresh invitations without restarting the daemon,
also install the optional CLI:

```sh
cargo install --locked --path crates/kybern-cli
```

Once binary releases are published, the release page will also provide
standalone daemon and CLI archives and shell/PowerShell installers. Release
builds target macOS (Apple silicon/Intel), Linux (x86_64/arm64 musl), and Windows
(x86_64). Until then, use the source commands above.

#### Connect over Tailscale

With Tailscale installed and connected on the VPS and your desktop or phone,
configure [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
on the VPS to forward HTTPS to Kybern:

```sh
tailscale serve --bg http://127.0.0.1:4173
kybernd --port 4173 --pair
```

`kybernd --pair` starts the daemon and prints:

- A six-digit pairing code, valid once for ten minutes.
- Detected addresses, including a matching Tailscale HTTPS proxy when configured.
- A complete invitation for each address, containing the code and environment identity.

In the desktop app, choose **Switch environment → Add environment**, enter a
name, and paste the complete invitation into **Address or pairing invitation**.
You can also enter its address and code separately. Keep the daemon running.
Create a separate code for each client.

If the daemon is already running, generate a new invitation over SSH with:

```sh
kybern pair
```

Do not start a second daemon against the same data directory. If you installed
only `kybernd`, its `--pair` option is for startup; use the optional CLI to pair
more devices while work stays running.

Discovery checks active network interfaces and the installed Tailscale CLI.
It prefers a matching HTTPS Serve proxy, and lists direct Tailscale, private,
and public interface addresses only when the daemon listens on them. It never
opens a firewall, enables Serve, or guesses that a public NAT address accepts
inbound connections. With the default loopback listener and no proxy, it prints
local-only addresses and tells you to configure a proxy or SSH tunnel.

#### Connect through an SSH tunnel or another HTTPS proxy

For an SSH tunnel, start the daemon on the VPS:

```sh
kybernd --port 4173 --pair
```

On your desktop, keep this tunnel running:

```sh
ssh -N -L 14173:127.0.0.1:4173 user@your-vps
```

Use **http://127.0.0.1:14173** and the code printed on the VPS. The tunnel's
local port belongs to your desktop, so use that address instead of the VPS's
printed loopback address. A phone needs its own reachable route; it cannot use
a tunnel running only on your desktop.

For an existing HTTPS reverse proxy, supply its public address explicitly:

```sh
kybernd --port 4173 --advertise-url https://kybern.example.com --pair
```

This advertises the URL; it does not configure the proxy or TLS. See the
[remote environments guide](docs/remote-environments.md) for proxy routes,
direct interface binding, running the daemon after logout/reboot, device
revocation, and custom data directories.

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

To connect to another machine, use the desktop environment menu. Each machine
keeps its own projects and running work. The [remote environments guide](docs/remote-environments.md)
covers pairing, Tailscale/HTTPS, SSH tunnels, credentials and reconnect behavior.

For development, run the web app with hot reload inside the Tauri window:

```sh
cd apps/desktop && pnpm tauri dev
```

The desktop app reuses an authenticated, protocol-compatible daemon selected
by `KYBERN_DATA_DIR`. If none is available it starts the bundled daemon on an
unused port, writes that port to `daemon.port`, and leaves the daemon running
for CLI and mobile clients when the window closes.

For app-managed local endpoints, reopening the desktop automatically replaces a
daemon when the staged binary is newer or incompatible. A daemon selected with
`KYBERN_URL` is externally managed and is never stopped automatically. Note that
`pnpm build` builds only the React frontend; use the Tauri wrapper to build and
stage daemon or driver changes as well: `pnpm tauri dev` or `pnpm tauri build`.

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
