# Working on Kybern

For building Kybern yourself or working on it. If you only want to use Kybern,
the [README](README.md) is the place to start. Agents working in this
repository read [AGENTS.md](AGENTS.md).

## Layout

| Path | What it is |
| --- | --- |
| `crates/kybern-protocol` | Wire types. JSON-RPC 2.0 over WebSocket, scoped tokens, the event-sourced thread model. `kybern-schema` dumps JSON Schema for non-Rust clients. |
| `crates/kybern-store` | SQLite persistence (WAL, event log, projections). |
| `crates/kybern-drivers` | One native driver per agent: Claude Code, Codex, OpenCode, pi, Oh My Pi, Cursor. |
| `crates/kybern` | The shipped package: builds the `kybernd` and `kybern` binaries from the two crates below. |
| `crates/kybern-daemon` | `kybernd`. Owns provider processes, threads, approvals, terminals and project files; serves clients on a loopback port with bearer tokens. |
| `crates/kybern-cli` | `kybern`. Command-line client and the integration harness for every driver. |
| `crates/kybern-client` | Shared WebSocket client used by the CLI and the daemon. |
| `apps/gpuix` | Kybern GPUIX, the desktop app: React on GPUI through Bun, for macOS, Windows and Linux. See [its README](apps/gpuix/README.md). |
| `apps/mobile` | Expo SDK 57 companion for Android and iOS: pairing, streamed conversations, approvals, files, diffs, terminals, tasks, and settings. |
| `packages/kybern-client` | TypeScript transport, protocol types, transcript projection, and composer helpers shared by GPUIX and mobile. |

The previous GPUI desktop client lives on the `gpui` branch and is no longer
built from `main`.

## Build from source

Needs stable Rust 1.88 or newer (`rust-toolchain.toml` picks it up), Node 22,
pnpm 11 (`corepack enable`) and, for Kybern GPUIX, Bun.

```sh
cargo build -p kybern               # target/debug/{kybernd,kybern}
cd apps/gpuix
pnpm install --frozen-lockfile
native/update.sh                    # builds the patched GPUIX addon pinned in native/FORK
pnpm dev                            # runs against ~/.kybern; set KYBERN_DATA_DIR for a scratch daemon
```

Packaging GPUIX for each platform is described in
[apps/gpuix/packaging/README.md](apps/gpuix/packaging/README.md). The
standalone daemon and CLI builds (`cargo build --release -p kybern`) remain
available for headless and remote use.

To connect to another machine, use the desktop environment menu. Each machine
keeps its own projects and running work.

The desktop app reuses an authenticated, protocol-compatible daemon selected
by `KYBERN_DATA_DIR`. If none is available it starts its bundled daemon on an
unused port once, saves it in `desktop.port` for future restarts and updates,
publishes the live endpoint in `daemon.port`, and leaves the daemon running
for CLI and mobile clients when the window closes. For app-managed local
endpoints, reopening the app replaces a daemon when the bundled binary is newer
or incompatible. A daemon selected with `KYBERN_URL` is externally managed and
is never stopped automatically.

The macOS app is signed ad hoc. Ad-hoc signing needs no paid Apple account, but
its designated requirement is the hash of one build. macOS privacy grants such
as Screen Recording can become stale after an update, even while System
Settings still shows the app as allowed. Re-authorizing the updated app may be
necessary. Kybern does not reset TCC or change privacy settings automatically.


## Mobile app

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

## Releasing

See [RELEASING.md](RELEASING.md).
