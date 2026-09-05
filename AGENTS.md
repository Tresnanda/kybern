# kybern

Rust workspace: a daemon (`kybernd`) that drives coding agents, a Tauri + React
desktop client, a CLI, and an Expo mobile client. Read `docs/architecture.md`
for how the pieces fit and `docs/design.md` for the desktop design rules
before touching UI.

## Layout

| Path | What |
| --- | --- |
| `crates/kybern-protocol` | Wire types. Every RPC method lives in `methods.rs` with its scope. `kybern-schema` bin dumps JSON Schema. |
| `crates/kybern-store` | SQLite. Migrations are the array in `schema.rs`; append a new entry, never edit an old one. `projection.rs` folds events into transcripts. |
| `crates/kybern-git` | Snapshots, diffs, worktrees via the `git` CLI. |
| `crates/kybern-drivers` | One module per agent: `claude`, `codex`, `opencode`, `pi` (also omp), `cursor`. All implement `AgentDriver` + `AgentSession` from `lib.rs`. |
| `crates/kybern-daemon` | `main.rs` (axum), `ws.rs` (auth, subscriptions), `rpc.rs` (dispatch), `orchestrator.rs` (threads, turns, approvals, checkpoints), `terminal.rs`, `files.rs`, `github.rs`, `http.rs`, `access.rs`, `settings.rs`. |
| `crates/kybern-client` | Async JSON-RPC client shared by the CLI and the desktop shell. |
| `crates/kybern-cli` | `kybern` binary. Also the integration harness. |
| `apps/desktop` | Desktop app. `src-tauri` is the Tauri 2 shell (crate `kybern-desktop`: resolves or spawns `kybernd`, exposes `endpoint`/`data_dir_path`). `src/` is the React app (see below). |
| `apps/mobile` | Expo client (pnpm 11, exact pins). |

The old GPUI client is on the `gpui` branch. Do not port its views back.

### Desktop app (`apps/desktop/src`)

| Path | What |
| --- | --- |
| `protocol/` | TypeScript wire types + the WebSocket JSON-RPC client. Keep `types.ts` in step with `kybern-protocol`. |
| `state/` | `store.ts` (zustand), `rpc.ts` (boot, subscriptions, actions), `transcript.ts` (folds events into blocks and turn groups), `nav.ts`. Stateful modules reload the page on HMR through `lib/hot.ts`. |
| `views/` | One file per surface: `Sidebar`, `Draft` (home), `Thread`, `Transcript`, `Composer`, `RightPanel` (dock), `Terminal`, `Explorer`, `Environment`, `PullRequests`, `Palette`, `SettingsDialog`, `Handoff`, `chrome` (headers, toggles), `chatLayout` (shared column gutter). |
| `components/kit/` | UI primitives. `components/kit/chat/` holds the composer/transcript helpers and the `composerPickerStyles` class constants. |
| `components/beui/` | BeUI components, vendored (MIT): message scroller with rail, file tree. |
| `components/kybern/` | Our own pieces: `DiffView`, `Markdown` (shiki), `ResizeHandle`, `bits`. |
| `lib/kit/` | Icon system (`icons.tsx`, Central SVGs under `public/central-icons-*`), theme math (`applyTheme.ts`), density/typography/width variables, sidebar row styles. |
| `styles/kit.css` | Base stylesheet (tokens, primitives, chat surfaces). `styles/kybern.css` adds only what the Tauri shell needs. |

## Build and run

```sh
cargo build -p kybern-daemon -p kybern-cli               # seconds
./target/debug/kybernd --data-dir /tmp/kyb --port 4199   # scratch daemon
./target/debug/kybern --data-dir /tmp/kyb providers

cd apps/desktop
pnpm install --frozen-lockfile
KYBERN_DATA_DIR=/tmp/kyb KYBERN_NO_ACTIVATE=1 pnpm tauri dev
```

Use a scratch `--data-dir` for testing so `~/.kybern` stays clean. The app
connects to the daemon named by `KYBERN_DATA_DIR` (port and token files) and
spawns `kybernd` from its own directory or `PATH` when none is reachable.
`KYBERN_NO_ACTIVATE=1` keeps the window from stealing focus.

The desktop package scripts build and stage `kybernd` as a Tauri sidecar; use
`pnpm tauri ...` rather than calling the Tauri CLI directly. Daemons outlive
desktop windows. For an app-managed local endpoint, the desktop restarts a
daemon whose version is incompatible or whose binary is older than the staged
binary. Explicit `KYBERN_URL` endpoints remain externally managed and are never
stopped by the app. `pnpm build` only builds the web frontend; use the Tauri
wrapper when daemon or driver changes must be included: `pnpm tauri dev` or
`pnpm tauri build`.

## Tests and checks

```sh
cargo test --workspace                                    # unit + snapshot + live driver tests
cargo test -p kybern-drivers --test live_drivers          # runs real agent CLIs when installed, skips otherwise
cargo fmt --all --check && cargo clippy --workspace -- -D warnings

cd apps/desktop && pnpm typecheck && pnpm lint && pnpm build
```

Protocol changes break `crates/kybern-protocol/tests/snapshots`. That is the
point: review the diff, then `INSTA_UPDATE=always cargo test -p kybern-protocol`.
CI runs fmt, clippy, the Rust tests and the desktop typecheck/lint/build on
ubuntu and macos.

## Conventions

- Adding an RPC method: struct pair + `method!` in `methods.rs`, add it to
  `registry!`, add it to `bin/schema.rs`, handle it in `daemon/src/rpc.rs`,
  add a CLI subcommand, mirror the types and the `Methods` map entry in
  `apps/desktop/src/protocol/types.ts`. Scope is enforced in `ws.rs` from the
  registry.
- Adding a driver: implement the traits in `drivers/src/lib.rs`, register in
  `registry.rs`, add a live test in `tests/live_drivers.rs`, document the
  permission-mode mapping in `docs/architecture.md`. Speak the agent's own
  protocol; do not add a shared abstraction layer. Follow
  `docs/harness-parity.md` for spawned-agent and background-process lifecycle,
  controls, recovery, and UI parity.
- Events are append-only. New behavior means a new `EventPayload` variant plus
  handling in `store/projection.rs` and `apps/desktop/src/state/transcript.ts`.
  Clients ignore unknown kinds.
- Thread anchors for rewind are recorded on `TurnCompleted` (`TurnAnchors`).
- `serde_json` has `preserve_order` on for deterministic schemas. Keep it.
- Copy: sentence case, verb-first buttons, errors say what to do next.

## Desktop UI rules

- Before styling anything new, find the matching kit component or class
  constant and reuse it; class strings in `views/` are shared on purpose. Do not reintroduce generic shadcn styling.
- Icons come from `lib/kit/icons.tsx` (Central, Tabler, react-icons).
  Phosphor and lucide are not used.
- Base UI menus: `MenuGroupLabel` must sit inside a `MenuGroup`; picker popups
  are `ComposerPickerMenuPopup`; dialogs use `components/kit/dialog`.
- Transcript, composer and the home screen share `CHAT_COLUMN_GUTTER` from
  `views/chatLayout.ts` so their columns line up edge to edge.
- Panes that stay mounted while hidden switch with `opacity-0` +
  `pointer-events-none`, never `visibility: hidden` (xterm mis-measures).
- Dependencies are exact-pinned; `.npmrc` sets `save-exact` and
  `ignore-scripts`. Check socket.dev before adding a package.

## Verifying UI

There is no GUI test harness. Launch the app against a scratch daemon, drive
state from the CLI (`kybern send <thread> --detach ...`, `kybern approvals allow`,
`kybern terminal send ...`) or with `cliclick`/`osascript`, and screenshot only
the app window by id (`screencapture -l <id>`), never the full screen. See
`docs/design.md` for what "right" looks like. Run one Kybern UI at a time: close
the packaged app before launching `pnpm tauri dev`, and target the dev process's
window id rather than opening the installed app by bundle name.

## Data directory

`~/.kybern/`: `state.sqlite`, `settings.json`, `keybindings.json`, `themes/`,
`daemon.token` (0600), `daemon.port`, `worktrees/`, `assets/`.
