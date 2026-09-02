# kybern

A native desktop harness for coding agents. Threads, worktrees, approvals,
diffs and terminals for Claude Code, Codex, OpenCode, pi, Oh My Pi and Cursor,
driven through their own protocols, from one Rust daemon and a GPUI client.

kybern is a reimplementation of the ideas in [T3 Code](https://github.com/pingdotgg/t3code)
with a Rust daemon at the center so a desktop app, a phone, and a remote
machine all see the same threads.

## Layout

| Crate | What it is |
| --- | --- |
| `kybern-protocol` | Wire types. JSON-RPC 2.0 over WebSocket, scoped tokens, the event-sourced thread model. `kybern-schema` dumps JSON Schema for non-Rust clients. |
| `kybern-store` | SQLite persistence (WAL, event log, projections). |
| `kybern-drivers` | One native driver per agent. Claude Code today; Codex, OpenCode, pi, omp, Cursor next. |
| `kybern-daemon` | `kybernd`. Owns provider processes, threads, approvals; serves clients on a loopback port with bearer tokens. |
| `kybern-cli` | `kybern`. Command-line client and the integration harness for every driver. |

## Run it

```sh
cargo build
./target/debug/kybernd                       # data in ~/.kybern, port 4173
./target/debug/kybern providers
./target/debug/kybern new -p . "explain this repo in three lines"
./target/debug/kybern threads
./target/debug/kybern send <thread-id> "now write the README"
./target/debug/kybern watch                  # live event stream for all threads
```

Approvals show up inline in `new` and `send`; answer with `y`, `a` (always) or `n`.

## Status

Milestone 1: daemon, protocol, store, Claude Code driver, CLI. Working end to end
including resume across daemon restarts.

Next: remaining drivers, git checkpoints and rewind, terminals, the GPUI desktop
app, then the Expo mobile client.

## License

MIT
