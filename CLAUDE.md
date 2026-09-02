# kybern

Rust workspace: a daemon (`kybernd`) that drives coding agents, a GPUI desktop
client, a CLI, and an Expo mobile client. Read `docs/architecture.md` for how
the pieces fit and `docs/design.md` for the desktop design rules before
touching UI.

## Layout

| Path | What |
| --- | --- |
| `crates/kybern-protocol` | Wire types. Every RPC method lives in `methods.rs` with its scope. `kybern-schema` bin dumps JSON Schema. |
| `crates/kybern-store` | SQLite. Migrations are the array in `schema.rs`; append a new entry, never edit an old one. `projection.rs` folds events into transcripts. |
| `crates/kybern-git` | Snapshots, diffs, worktrees via the `git` CLI. |
| `crates/kybern-drivers` | One module per agent: `claude`, `codex`, `opencode`, `pi` (also omp), `cursor`. All implement `AgentDriver` + `AgentSession` from `lib.rs`. |
| `crates/kybern-daemon` | `main.rs` (axum), `ws.rs` (auth, subscriptions), `rpc.rs` (dispatch), `orchestrator.rs` (threads, turns, approvals, checkpoints), `terminal.rs`, `github.rs`, `http.rs`, `access.rs`, `settings.rs`. |
| `crates/kybern-client` | Async JSON-RPC client shared by CLI and app. |
| `crates/kybern-cli` | `kybern` binary. Also the integration harness. |
| `crates/kybern-term` | VT state machine + GPUI terminal element. |
| `crates/kybern-app` | GPUI desktop app. `app.rs` is the workspace view; `views/` renders panes from `state.rs`. |
| `apps/mobile` | Expo client (pnpm 11, exact pins). |

## Build and run

```sh
cargo build -p kybern-daemon -p kybern-cli      # seconds
cargo build -p kybern-app                        # ~10 min cold; gpui is heavy
./target/debug/kybernd --data-dir /tmp/kyb --port 4199   # scratch daemon
./target/debug/kybern --data-dir /tmp/kyb providers
KYBERN_URL=ws://127.0.0.1:4199/ws KYBERN_TOKEN=$(cat /tmp/kyb/daemon.token) \
  KYBERN_NO_ACTIVATE=1 ./target/debug/kybern-app
```

Use a scratch `--data-dir` for testing so `~/.kybern` stays clean. The app
spawns `kybernd` from its own directory when no daemon is reachable.
`KYBERN_NO_ACTIVATE=1` keeps the app from stealing focus; `KYBERN_RIGHT_TAB=terminal`
opens on the terminal tab.

## Tests and checks

```sh
cargo test --workspace --exclude kybern-app     # unit + snapshot + live driver tests
cargo test -p kybern-drivers --test live_drivers # runs real agent CLIs when installed, skips otherwise
cargo fmt --all --check && cargo clippy --workspace --exclude kybern-app -- -D warnings
```

Protocol changes break `crates/kybern-protocol/tests/snapshots`. That is the
point: review the diff, then `INSTA_UPDATE=always cargo test -p kybern-protocol`.
CI runs fmt, clippy, and the non-GUI tests on ubuntu and macos.

## Conventions

- Adding an RPC method: struct pair + `method!` in `methods.rs`, add it to
  `registry!`, add it to `bin/schema.rs`, handle it in `daemon/src/rpc.rs`,
  add a CLI subcommand. Scope is enforced in `ws.rs` from the registry.
- Adding a driver: implement the traits in `drivers/src/lib.rs`, register in
  `registry.rs`, add a live test in `tests/live_drivers.rs`, document the
  permission-mode mapping in `docs/architecture.md`. Speak the agent's own
  protocol; do not add a shared abstraction layer.
- Events are append-only. New behavior means a new `EventPayload` variant plus
  handling in `store/projection.rs` and `app/src/state.rs`. Clients ignore
  unknown kinds.
- Thread anchors for rewind are recorded on `TurnCompleted` (`TurnAnchors`).
- `serde_json` has `preserve_order` on for deterministic schemas. Keep it.
- Copy: sentence case, verb-first buttons, errors say what to do next.

## gpui

- `gpui`, `gpui_platform`, `gpui_macros` are git deps **without** a rev on
  purpose: gpui-component depends on the unpinned Zed source, and pinning a
  different rev yields two gpui crates and type mismatches. `Cargo.lock` pins
  the actual rev. Bump by updating gpui-component's rev and `cargo update -p gpui`.
- `gpui_component::init(cx)` must run before any component. The root view must
  render `Root::render_{sheet,dialog,notification}_layer` or dialogs never show.
- Render helpers that take `&mut Workspace` return `AnyElement`; returning
  `impl IntoElement` captures the borrow under edition 2024.
- Element ids from strings: `ElementId::Name(SharedString)`; tuples with
  `String` do not convert.
- `IconName` lacks Send/GitBranch/Terminal; add SVGs under a custom asset
  source if needed.

## Verifying UI

There is no GUI test harness. Launch the app against a scratch daemon, drive
state from the CLI (`kybern send <thread> --detach ...`, `kybern approvals allow`),
and screenshot only the app window by id (`screencapture -l <id>`), never the
full screen. See `docs/design.md` for what "right" looks like.

## Data directory

`~/.kybern/`: `state.sqlite`, `settings.json`, `keybindings.json`, `themes/`,
`daemon.token` (0600), `daemon.port`, `worktrees/`, `assets/`.
