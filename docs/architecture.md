# Architecture

kybern is a daemon with clients. The daemon owns everything that touches a
machine: agent processes, threads, approvals, git, terminals, uploads. Clients
render state and send intents. A desktop app on the same machine is just a
client on localhost, which is what lets a phone or a second machine attach
to the same threads later.

```
┌────────────┐  ws://…/ws (JSON-RPC 2.0)  ┌──────────────────────────────────┐
│ desktop    │◄──────────────────────────►│ kybernd                          │
│ (Tauri)    │                            │  ws.rs      auth + subscriptions │
└────────────┘                            │  rpc.rs     method dispatch      │
┌────────────┐                            │  orchestrator.rs  threads/turns  │
│ kybern CLI │◄──────────────────────────►│  terminal.rs      PTYs           │
└────────────┘                            │  github.rs        gh + git       │
┌────────────┐  Tailscale / LAN + pairing │  http.rs   /pair /assets /health │
│ Expo app   │◄──────────────────────────►│                                  │
└────────────┘                            │  kybern-store (SQLite, events)   │
                                          │  kybern-git   (snapshots, diffs) │
                                          │  kybern-drivers                  │
                                          │    claude  codex  opencode       │
                                          │    pi/omp  cursor(ACP)           │
                                          └──────────────────────────────────┘
```

## Crates

| Crate | Role |
| --- | --- |
| `kybern-protocol` | Wire types. `serde` + `schemars`; `kybern-schema` dumps JSON Schema for TypeScript clients. `methods.rs` is the registry: every method carries the scope it needs. |
| `kybern-store` | SQLite via `rusqlite` in WAL mode. `events` is the append-only per-thread log; `threads`, `projects`, `approvals`, `checkpoints`, `turn_usage`, `tokens`, `assets` are projections and bookkeeping. `projection.rs` folds events into the transcript clients render. |
| `kybern-git` | Shells out to `git`. Snapshots use a temporary index so the user's index is never touched and untracked files are included. |
| `kybern-drivers` | `AgentDriver` (probe, spawn, one-shot) and `AgentSession` (send, interrupt, approvals, mode, model). One native module per agent. |
| `kybern-daemon` | `kybernd`. axum for HTTP and WebSocket, tokio for everything else. |
| `kybern-client` | Async JSON-RPC client shared by the CLI and the desktop shell; the web app speaks the same protocol from TypeScript (`apps/desktop/src/protocol`). |
| `kybern-cli` | `kybern`. Also the integration harness for the daemon. |
| `apps/desktop` | Tauri + React desktop client (crate `kybern-desktop` for the shell). Desktop packages include `kybernd` as a Tauri sidecar but it remains an independent process. |
| `apps/mobile` | Expo client. |

## Threads and turns

A thread binds a project (or a worktree of it), a provider instance, a
permission mode, and a provider-side session id. A turn starts when a user
message is sent and ends with a `TurnCompleted` or `TurnFailed` event.

The orchestrator keeps one live `AgentSession` per thread. Sessions are
spawned lazily on the first send and resumed from the provider's persisted
session on later daemon starts. Driver events are translated into thread
events, persisted with a monotonic `seq`, and broadcast to every connection.
Clients subscribe with `after_seq` to replay what they missed.

## Runtime activity

Subagents, background commands, and monitors launched by the main agent are
durable runtime tasks. Drivers report provider-native lifecycle updates; the
orchestrator persists complete task snapshots and clients project the newest
snapshot per id. An after-turn checkpoint waits for work launched by that turn,
and rewind is blocked while background work can still mutate the tree.

The desktop exposes this state as a sidebar cue, a compact composer summary,
and an Activity dock. Targeted controls only appear when the provider advertises
the exact capability. See [Runtime activity and harness parity](harness-parity.md)
for provider coverage and the checklist for new drivers.

OpenCode activity follows its child-session SSE stream, while Oh My Pi uses its
dedicated RPC subagent subscription and managed-Bash updates. Plain pi and
Cursor ACP retain a conservative tool-scoped fallback until their driven
protocols expose provider-stable child lifecycle events.

## Approvals

Drivers surface provider permission prompts as `PermissionRequest` driver
events. The orchestrator turns them into `ApprovalRequest` rows and events,
marks the thread `awaiting-approval`, and holds the provider's request id
until a client answers with `approvals.respond`. A daemon restart denies
whatever was pending and fails the turn, so nothing runs unattended.

## Checkpoints and rewind

Every turn is bracketed by two working-tree snapshots stored as dangling
commits under `refs/kybern/<thread>/<turn>/{before,after}`. Diffs are between
snapshots, so untracked files show up and nothing depends on the user's
index. `threads.revert` restores the tree to `before` and schedules a
provider fork for the next session:

| Provider | Conversation rewind |
| --- | --- |
| Claude Code | `--resume --fork-session --resume-session-at <last assistant uuid of the kept turn>` |
| Codex | `thread/fork` with `beforeTurnId` |
| OpenCode | `POST /session/:id/fork` at the client-chosen message id |
| pi / omp | `fork` / `branch` at the user entry id |
| Cursor | not available; workspace only |

## Permission modes

| kybern | Claude Code | Codex | OpenCode | omp | Cursor |
| --- | --- | --- | --- | --- | --- |
| Supervised | `default` + stdio prompts | `untrusted` / `workspace-write` | ruleset: ask for bash, edit, web | `always-ask` | ACP permission requests |
| Accept edits | `acceptEdits` | `on-request`, file changes auto-accepted | ask for bash and web only | `write` | same |
| Auto | `auto` | `never` / `workspace-write` | allow all but external dirs and loops | `yolo` | auto-allow |
| Full access | `bypassPermissions` | `never` / `danger-full-access` | allow all | `yolo` | auto-allow |

pi has no permission system and runs as Full access only.

## Access

Tokens are SHA-256 hashed in SQLite with a scope list. The desktop bootstrap
token in `daemon.token` carries every scope. Pairing mints a six-digit code
that `POST /pair` exchanges once for a client-scoped token. Remote clients
reach the daemon over LAN or Tailscale with the same WebSocket.

## Data directory

```
~/.kybern/
  state.sqlite       events, threads, projects, approvals, usage, tokens, assets
  settings.json      defaults and per-provider overrides
  keybindings.json   desktop key bindings
  themes/            JSON themes for the desktop app
  daemon.token       bootstrap bearer token (0600)
  daemon.port        port of the running daemon
  worktrees/         per-thread git worktrees
  assets/            uploaded attachments
```
