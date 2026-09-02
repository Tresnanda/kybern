# kybern mobile

Expo client for the kybern daemon: threads, live transcripts, and approvals
from a phone. Speaks the same JSON-RPC-over-WebSocket protocol as the desktop
app and CLI.

## Run it

Requirements: Node 20+, pnpm 11 (`corepack enable`), Expo Go on the phone.

```sh
# 1. On the machine with your projects, start the daemon reachable from the LAN
#    or Tailscale (it binds to loopback by default).
cargo run -p kybern-daemon -- --bind 0.0.0.0
cat ~/.kybern/daemon.token        # the bearer token

# 2. Start the app
cd apps/mobile
pnpm install
pnpm start                        # scan the QR code with Expo Go
```

The phone and the daemon host must be on the same network (LAN or Tailscale).
On the connect screen enter the daemon address (`ws://<host>:4173/ws`; a bare
`host` or `host:port` is completed for you) and paste the token. Both are
stored in the OS keychain via expo-secure-store.

Pairing links also work: opening `kybern://pair?url=ws%3A%2F%2Fhost%3A4173%2Fws&token=...`
(QR code, AirDrop, or pasted into the address field) connects directly.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm start` | Metro + Expo Go |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm doctor` | `expo-doctor` project checks |
| `pnpm gen:schema` | Regenerates `src/protocol/schema/kybern-protocol.schema.json` from the Rust crate (needs `cargo`). Diff it against `src/protocol/types.ts` after protocol changes. |

## Layout

```
app/                    Expo Router screens
  _layout.tsx           providers, stack, kybern://pair deep link
  connect.tsx           daemon URL + token
  threads.tsx           projects → threads with status dots
  thread/new.tsx        pick agent + permission mode, first message
  thread/[id].tsx       transcript, approvals, composer
src/protocol/           wire types (hand-derived from kybern-protocol) + WebSocket JSON-RPC client
src/connection/         secure endpoint storage, pairing link parsing, connection context
src/state/transcript.ts folds ThreadEvents into TranscriptEntry rows
src/ui/                 theme tokens, markdown, tool rows, approval card, composer
```

## Protocol notes

- Auth is a `Authorization: Bearer <token>` header on the WebSocket upgrade
  (React Native supports headers); `?token=` is the daemon's fallback.
- `events.subscribe` is issued with `after_seq` = the last seq seen, so a
  reconnect or an `events.lagged` notice replays the gap instead of losing it.
- Unknown event kinds and fields are ignored, per the protocol's versioning rule.
