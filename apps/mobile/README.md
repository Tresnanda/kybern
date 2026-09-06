# kybern mobile

Expo SDK 57 client for the kybern daemon: threads, live transcripts, and
approvals from a phone. Speaks the same JSON-RPC-over-WebSocket protocol as
the desktop app and CLI, through the shared `packages/kybern-client`.

## Design

Ink on paper. One neutral ramp, saturated color only for status (blue working,
amber waiting, red failed) and the orange Full access accent. All floating
chrome is Liquid Glass on iOS 26 (`expo-glass-effect`, native tab bar, native
large-title headers, SwiftUI menus from `@expo/ui`); older iOS and Android get
the same layout on a blurred, tinted material so both platforms read alike.

| Surface | What |
| --- | --- |
| Threads tab | Large title, native search, projects as glass groups, long-press for pin and archive (peek preview on iOS). |
| Approvals tab | Everything waiting on you across threads, badge on the tab, Allow / Always / Deny on each card. |
| Settings tab | Environment, what the daemon holds open, 7-day usage, disconnect. |
| Thread | Transcript under a transparent header, glass composer riding the keyboard, approvals fused above it, native menu for pin, permissions and archive. |
| New thread | Form sheet: project, agent, permission mode, worktree, first message. |
| Connect | Pairing code or device token; pairing links fill the form. |

Motion runs on the UI thread (Reanimated 4): press feedback scales to 0.96,
the working dot breathes, disclosures spring open, approvals rise in. Haptics
fire once per commit and never alone. Reduced motion is honoured.

## Run it

Requirements: Node 20+, pnpm 11 (`corepack enable`), Xcode 26+ for iOS
(Liquid Glass needs the iOS 26 SDK), Android Studio for Android. The app uses
native modules that are not in Expo Go, so build a development client.

```sh
# 1. On the machine with your projects, start the daemon reachable from the LAN
#    or Tailscale (it binds to loopback by default).
cargo run -p kybern --bin kybernd -- --bind <private-interface-ip> --port 4173
kybern pair                       # one-use code, expires in ten minutes

# 2. Build and run the app
cd apps/mobile
pnpm install --frozen-lockfile
npx expo run:ios                  # or: npx expo run:android
```

The phone and the daemon host must be on the same network (LAN or Tailscale).
On the connect screen enter the daemon address (`ws://<host>:4173/ws`; a bare
`host` or `host:port` is completed for you) and its pairing code. The device
credential and verified environment identity are stored in SecureStore.

Pairing invitations use
`kybern://pair?url=ws%3A%2F%2Fhost%3A4173%2Fws&code=123456&environment=<id>`.
Paste one into the address field, or open it in a build registered for the
`kybern` scheme.

## Layout

| Path | What |
| --- | --- |
| `app/` | Expo Router routes. `(tabs)/` hosts the native tab bar with a stack per tab; `thread/[id]` and `thread/new` sit on the root stack so the composer owns the bottom edge. |
| `src/ui/` | `theme.ts` tokens, `Glass`, `Icon` (SF Symbols + Material Symbols), `Tap` (press feedback), `Button`, `Composer`, `ApprovalCard`, `ToolRow`, `Markdown`, `Card`, `Chips`, `Field`, `NativeMenu`. |
| `src/state/` | `daemon.ts` (projects, threads, approvals, live), `transcript.ts` (event folding). |
| `src/connection/` | Endpoint storage, pairing, the single client. |
| `src/protocol/` | Re-exports of the shared client and types. |

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm start` | Metro |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm doctor` | `expo-doctor` project checks |
| `pnpm gen:schema` | Regenerate the protocol JSON Schema from the Rust crate |
