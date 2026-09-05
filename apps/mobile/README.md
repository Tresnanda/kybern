# kybern mobile

Expo client for the kybern daemon: threads, live transcripts, and approvals
from a phone. Speaks the same JSON-RPC-over-WebSocket protocol as the desktop
app and CLI.

## Run it

Requirements: Node 20+, pnpm 11 (`corepack enable`), Expo Go on the phone.

```sh
# 1. On the machine with your projects, start the daemon reachable from the LAN
#    or Tailscale (it binds to loopback by default).
cargo run -p kybern-daemon -- --bind <private-interface-ip> --port 4173
kybern pair                       # one-use code, expires in ten minutes

# 2. Start the app
cd apps/mobile
pnpm install
pnpm start                        # scan the QR code with Expo Go
```

The phone and the daemon host must be on the same network (LAN or Tailscale).
On the connect screen enter the daemon address (`ws://<host>:4173/ws`; a bare
`host` or `host:port` is completed for you) and its pairing code. The resulting
device credential and verified environment identity are stored together in
SecureStore. Use HTTPS or an encrypted private network. See the
[remote setup guide](../../docs/remote-environments.md) for Tailscale Serve.

Pairing invitations use
`kybern://pair?url=ws%3A%2F%2Fhost%3A4173%2Fws&code=123456&environment=<id>`.
Paste one into the address field, or open it in a development/native build
registered for the `kybern` scheme. The connect screen displays its endpoint
before pairing. Invitations contain no long-lived token.

The app remains the existing companion scaffold with one saved endpoint. Its
shared connection and pairing foundation is ready for a future mobile
environment picker and companion UI; push notifications are not implemented.

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
  connect.tsx           daemon URL + pairing code
  threads.tsx           projects → threads with status dots
  thread/new.tsx        pick agent + permission mode, first message
  thread/[id].tsx       transcript, approvals, composer
src/protocol/           facades for packages/kybern-client + generated JSON schema
src/connection/         secure endpoint storage, pairing link parsing, connection context
src/state/transcript.ts folds ThreadEvents into TranscriptEntry rows
src/ui/                 theme tokens, markdown, tool rows, approval card, composer
```

## Protocol notes

- The shared transport exchanges an Authorization bearer credential at
  `POST /session` for a 30-second single-use WebSocket ticket. It validates
  protocol and environment identity before opening the workspace.
- Returning from background checks connection liveness. Interrupted mutations
  are rejected and never automatically retried.
- `events.subscribe` is issued with `after_seq` = the last seq seen, so a
  reconnect or an `events.lagged` notice replays the gap instead of losing it.
- Unknown event kinds and fields are ignored, per the protocol's versioning rule.
