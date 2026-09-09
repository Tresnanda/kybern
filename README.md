# kybern

A desktop and mobile harness for coding agents. Threads, worktrees, approvals, diffs,
terminals and a file explorer for Claude Code, Codex, OpenCode, pi, Oh My Pi
and Cursor, driven through their own protocols, from one Rust daemon and a
Tauri + React desktop client and an Expo mobile companion.

kybern is inspired by [T3 Code](https://github.com/pingdotgg/t3code) and
[Synara](https://github.com/Emanuele-web04/synara), with a Rust daemon on
each host. Desktop and mobile clients connect to a selected machine, which
keeps its own projects, threads, and running agents.

## Layout

| Path | What it is |
| --- | --- |
| `crates/kybern-protocol` | Wire types. JSON-RPC 2.0 over WebSocket, scoped tokens, the event-sourced thread model. `kybern-schema` dumps JSON Schema for non-Rust clients. |
| `crates/kybern-store` | SQLite persistence (WAL, event log, projections). |
| `crates/kybern-drivers` | One native driver per agent: Claude Code, Codex, OpenCode, pi, Oh My Pi, Cursor. |
| `crates/kybern` | The shipped package: builds the `kybernd` and `kybern` binaries from the two crates below. |
| `crates/kybern-daemon` | `kybernd`. Owns provider processes, threads, approvals, terminals and project files; serves clients on a loopback port with bearer tokens. |
| `crates/kybern-cli` | `kybern`. Command-line client and the integration harness for every driver. |
| `crates/kybern-client` | Shared WebSocket client used by the CLI and the desktop shell. |
| `apps/desktop` | The desktop app: Tauri 2 shell (`src-tauri`, crate `kybern-desktop`) around a React 19 + Tailwind 4 web app. Bundles and spawns `kybernd` if none is running. |
| `apps/mobile` | Expo SDK 57 companion for Android and iOS: pairing, streamed conversations, approvals, files, diffs, terminals, tasks, and settings. |
| `packages/kybern-client` | TypeScript transport, protocol types, transcript projection, and composer helpers shared by desktop and mobile. |

The previous GPUI desktop client lives on the `gpui` branch and is no longer
built from `main`.

## Install

Choose what this machine will do:

| Machine | Install |
| --- | --- |
| Your Mac, Windows PC, or Linux desktop | Desktop app. It bundles the local daemon. |
| VPS or another machine that runs agents | `kybernd` only; optionally `kybern` for administration over SSH. No desktop, Node, or pnpm required. |
| Android phone or iPhone | The [mobile companion](apps/mobile/README.md), paired with a running Kybern daemon. Android preview APKs run without Metro or Expo Go. |

Install and authenticate your coding-agent CLIs on the machine that will run
work. A VPS keeps its own projects, threads and provider credentials; connecting
to it does not copy your laptop's projects or credentials.

### Desktop app

Every desktop package bundles `kybernd`; you do not need to install the daemon
or CLI separately on a desktop.

**macOS**, two ways. The quickest is one command, which installs the app into
Applications and opens it with no prompt:

```sh
curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-mac-install.sh | sh
```

Or download the DMG from the
[release page](https://github.com/Tresnanda/kybern/releases/latest) and drag
kybern into Applications. Kybern is not notarized by Apple, so the first launch
of a browser download is blocked with "Apple could not verify kybern is free of
malware". Allow it once:

1. Click **Done** on that dialog (not Move to Trash).
2. Open **System Settings → Privacy & Security** and scroll to the **Security**
   section. Click **Open Anyway** next to "kybern was blocked to protect your
   Mac".

   ![Open Anyway in Privacy & Security](assets/readme/gatekeeper-open-anyway.png)

3. Confirm with **Open Anyway** on the next dialog and enter your password or
   Touch ID.

   ![Confirm opening kybern](assets/readme/gatekeeper-confirm.png)

That is a one-time step. Updates installed by the app itself are never blocked,
and neither is the command above, because only browser downloads are marked for
this check.

**Linux and Windows**: download from the release page.

| Platform | Asset |
| --- | --- |
| macOS, Apple silicon | `kybern-<version>-aarch64-apple-darwin.dmg` |
| macOS, Intel | `kybern-<version>-x86_64-apple-darwin.dmg` |
| Linux x86_64 | `kybern-<version>-x86_64-unknown-linux-gnu.AppImage` or `.deb` |
| Windows x86_64 | `kybern-<version>-x86_64-pc-windows-msvc-setup.exe` |

The app checks the release feed after launch and every few hours, and offers
to install a newer version; **Settings → About** has a manual check. Installing
an update restarts the app and its local daemon, so agents running on that
machine restart with it. Remote environments are unaffected.

To build from source instead, install stable Rust, Node 22+, pnpm 11, and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), then:

```sh
git clone https://github.com/Tresnanda/kybern.git
cd kybern/apps/desktop
pnpm install --frozen-lockfile
pnpm tauri build
```

The package lands under `target/release/bundle/` at the repository root. Source
builds do not self-update.

### Mobile companion

Kybern mobile connects to the same daemon as desktop. It supports streamed
conversations, model and permission controls, file attachments and mentions,
approvals and questions, project files and diffs, terminal sessions, background
tasks, and computer settings. The agents run on your computer; keep it awake and
reachable while working from your phone.

Android preview builds are distributed through the personal
[EAS project](https://expo.dev/accounts/treshnanda/projects/kybern-mobile/builds).
Install the APK on your phone; it includes its JavaScript and assets and runs
without Metro or Expo Go. These are preview builds, not a Google Play release.
iOS development builds require Apple device signing; no App Store release is
configured yet.

To pair, open **Pair a device** on desktop, enable **Reachable over Tailscale**
when needed, and scan the invitation in mobile. Both devices need a route to the
same daemon; use the computer's reachable address, not the phone's `localhost`.
Each pairing code is single-use. Android release builds permit direct HTTP and
WebSocket connections for LAN/Tailscale addresses; use your tailnet or an HTTPS
proxy when connecting remotely.

For development and building from source:

```sh
cd apps/mobile
pnpm install --frozen-lockfile
pnpm start:go --lan   # Expo Go with SDK 57 support
# Or compile and install the native development app:
pnpm android         # pnpm ios on a Mac with Xcode
pnpm start --lan     # Metro for an installed development app
# Standalone Android APK built on EAS:
npx eas-cli@latest build --platform android --profile preview
```

See [the mobile README](apps/mobile/README.md) for build profiles, verification,
native configuration, pairing, and platform limitations.

### Daemon only: VPS or remote machine

The easiest path needs nothing on the machine but SSH access: in the desktop
app choose **Switch environment → Add environment → Over SSH**, enter
`user@host`, and Kybern installs the daemon, starts it, and pairs through a
tunnel it manages.

To set the machine up yourself instead, one command installs the daemon and the `kybern` CLI into `~/.cargo/bin`
without Rust, Node or a desktop. Add `--service` on a Linux machine with systemd
to keep the daemon running as a user service:

```sh
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/Tresnanda/kybern/releases/latest/download/kybern-remote-install.sh | sh -s -- --service
```

Other options: `--version 0.2.0` pins a release, `--port` and `--bind` set the
service's listener (default `127.0.0.1:4173`).

A remote daemon updates itself: **Settings → Agents → Updates** on the desktop
shows its version, checks the release feed, and installs the newest version
once nothing is running, restarting it under its service manager. Turn on
**Update the daemon automatically** there for a daily check. The same is
available headless as `kybern daemon-update --check` and `--run`. The release page also has
`kybern-installer.sh`, its PowerShell twin, and one `kybern-<target>` archive
per platform holding both binaries: macOS (Apple silicon/Intel), Linux
(x86_64/arm64 musl) and Windows (x86_64). Run the installer again to upgrade.

From a checkout, `cargo install --locked --path crates/kybern` builds the same
binaries with stable Rust and your platform's native build tools.

#### Connect over Tailscale

With Tailscale installed and connected on the VPS and your desktop or phone,
the quickest route is to let the daemon listen on its Tailscale address:

```sh
kybern pair --tailscale
```

This opens a listener on the VPS's Tailscale IP next to the loopback one,
remembers the choice in `settings.json` (`access.tailscale`), and prints a QR
code the Kybern mobile app can scan. The desktop app offers the same switch,
**Reachable over Tailscale**, in **Pair a device**. Traffic stays inside the
tailnet's WireGuard tunnel; nothing is exposed on the public interface.

For a browser-friendly HTTPS address instead, configure
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
on the VPS to forward to Kybern:

```sh
tailscale serve --bg http://127.0.0.1:4173
kybernd --port 4173 --pair
```

`kybernd --pair` starts the daemon and prints:

- A six-digit pairing code, valid once for ten minutes.
- A QR code of the invitation when a reachable address was detected.
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
local-only addresses and tells you to run `kybern pair --tailscale` or
configure a proxy or SSH tunnel.

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

This advertises the URL; it does not configure the proxy or TLS.

## Build from source

Needs stable Rust 1.88 or newer (`rust-toolchain.toml` picks it up), Node 22
and pnpm 11 (`corepack enable`).

```sh
cargo build --release -p kybern   # target/release/{kybernd,kybern}

cd apps/desktop
pnpm install --frozen-lockfile
pnpm tauri build                                        # builds and bundles kybernd automatically
```

The `pnpm tauri` wrapper builds the daemon for the same profile and target,
stages the target-triple sidecar expected by Tauri, and then runs the Tauri
CLI. The standalone daemon and CLI builds remain available for headless and
remote use.

To connect to another machine, use the desktop environment menu. Each machine
keeps its own projects and running work.

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

A push to `main` updates the source and runs CI; it does not publish a new
installed-app version. Desktop builds also run on relevant `main` changes to
validate packages and warm caches. Publishing is a separate action.

| Release unit | Version and delivery |
| --- | --- |
| Daemon, CLI, and desktop | Share the Rust workspace/Tauri version. `scripts/release.sh X.Y.Z` updates these versions and pushes `vX.Y.Z`. The release and desktop workflows build in parallel and attach their packages to the same GitHub Release. Desktop packages include the daemon. |
| Android and iOS mobile app | Use `expo.version` in `apps/mobile/app.json`, independent of the desktop release number. EAS builds use the selected commit and profile. Android `versionCode` and iOS `buildNumber` identify individual binaries; EAS manages these remotely. Preview and production builds increment them automatically. |
| Wire protocol | `PROTOCOL_VERSION` is a compatibility contract, not an app release number. Bump it for breaking wire changes and update both clients and the daemon together. Additive features may still require a newer daemon even when the protocol number is unchanged. |

A daemon-only fix is shipped in the next daemon/desktop release. A desktop-only
fix uses that same release unit because desktop bundles its daemon. A mobile-only
fix uses a compatible EAS Update or a mobile build, with no desktop version bump. A change spanning the
clients and daemon may require both release paths; publish the daemon support
before shipping a mobile feature that depends on it.

The desktop release script does not change the mobile app version or start EAS.
Mobile builds and updates are manual. Mobile 0.1.1 enables EAS Update on the
`preview` and `production` channels with fingerprint-based runtime compatibility.
Compatible JavaScript updates download at launch and apply on the next launch;
Settings → App updates also allows an explicit check and restart. Older APKs
need one new install to enable this. Native changes always require a new binary.
See the [mobile update commands](apps/mobile/README.md#eas). Do not introduce mobile
version tags without first narrowing the daemon workflow's broad tag trigger.

`release.yml` is generated by `dist generate` from `dist-workspace.toml`;
`desktop.yml` builds desktop installers and updater metadata for the same tag.
Use `dist plan` to check the distribution config and `dist generate` to refresh
the generated workflow after changing it.

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

### Resume a conversation started elsewhere

Choose **Resume session** beside **New thread** in the sidebar. You can also
use `/resume` or `/sessions` in the composer, the project menu, or the command
palette. Search by title, folder, or native session ID; filter by
harness and project. Choosing a conversation imports its available message and
tool history and continues the same native session on your next message.
Choosing it again opens its existing Kybern thread, including archived threads.

```sh
kybern sessions --provider claude-code
kybern sessions --provider codex --query "session picker"
kybern resume --provider codex <native-session-id>
kybern send <returned-thread-id> "Continue from where we left off"
```

All six harnesses are supported: Claude Code, Codex, OpenCode, pi, OMP, and
Cursor CLI. Discovery uses the selected environment's installed harness and
configured profile. Cursor uses CLI sessions exposed through ACP; editor-only
or cloud conversations are not included. The original working folder must
still exist. Kybern uses it directly and does not create or switch a worktree.

Importing history does not execute old tools, recreate checkpoints, or charge
historical usage to Kybern. History imports are limited to 64 MB. If a harness
refuses continuation because another process owns the session, close that
process and retry. Saved sessions remain native to their original harness.

### Connectors, plugins, and Claude artifacts

Open **Settings → Integrations** on desktop, or **Connectors and plugins** in a
mobile conversation’s menu. Claude Code uses its native plugin catalog, scopes,
installation commands, and MCP sign-in. Codex uses its app-server catalog,
plugin actions, and account connector setup pages. Provider restrictions remain
in effect; plugins that require Codex’s installation interstitial must be
installed there. New Claude plugin installs use the native user scope. Existing
project/local scopes are preserved. Start a fresh agent session after changing
plugins. Connected Codex apps and enabled Claude plugin skills also appear in
the composer’s capability picker.

In a Claude conversation, ask for an artifact, or open **Artifacts** in the
desktop dock or mobile conversation menu. You can preview an HTML, Markdown,
or SVG file, inspect its source, request native publication, open a returned
Claude URL, and republish to that URL. React and other sources must be prepared
as HTML/Markdown for Claude’s native Artifact tool. Publication remains a normal
Claude turn with its normal approval handling; a successful native tool receipt
is required before Kybern marks an artifact as published.

**Share and versions** opens the hosted Claude page. Claude owns hosting,
sharing permissions, version selection, and live account connectors; Kybern
does not clone those account controls or use an undocumented publishing API.
Local HTML/SVG previews have an isolated origin and cannot access the daemon’s
credentials or fetch network resources. Use the hosted page for connector-backed
content and remote dependencies. Sources are limited to 1 MB inside the thread’s
workspace. Native publication also requires a Claude account and CLI version
that supports [Claude Code artifacts](https://code.claude.com/docs/en/artifacts).

```sh
kybern integrations list . --provider claude-code
kybern integrations change . plugin-name@marketplace enable --scope project
kybern integrations login <thread-id> <mcp-server-name>
kybern artifacts list <thread-id>
kybern artifacts read <thread-id> artifacts/dashboard.html
```

These additive RPCs require a daemon containing this feature. Updating only the
phone’s JavaScript does not add the corresponding daemon support.

### Background behaviour

The daemon outlives the app, so it trims what it keeps alive once work
finishes. Agent processes are resumed from the provider's own session on the
next message, so releasing one loses no conversation. Limits live under
`background` in `settings.json` (also in Settings > General > Background);
every value is in minutes and `0` turns that limit off.

| Setting | Default | What it does |
| --- | --- | --- |
| `session_idle_minutes` | 10 | Close an idle thread's agent process after this long. Running, awaiting-approval, and background-task threads are never touched. |
| `max_idle_sessions` | 4 | Most idle agent processes kept warm; the least recently used go first. |
| `terminal_idle_minutes` | 60 | Close shells with no window attached and nothing in the foreground. |
| `daemon_idle_exit_minutes` | 0 (off) | Exit the daemon after nothing has needed it. Only for daemons the desktop app starts on demand; the CLI and remote clients do not restart an exited daemon. |

`kybern activity` shows what the daemon is holding open right now: clients,
agent processes (live and idle), terminals, queued follow-ups, and when it
would exit if idle exit is on.

## Status

Current capabilities (platform verification is documented per client):

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
- **Mobile**: Android and iOS companion with saved computers, QR pairing,
  streamed threads, approvals, files/diffs, terminals, tasks, and settings.
  iOS simulator workflows have been exercised against a real daemon; Android
  bundles, native configuration, and pairing transport are checked separately.
  See [mobile verification notes](apps/mobile/README.md#verify) for limitations.

## License

MIT.
