# Kybern mobile

A fresh Expo client for the Kybern daemon, with an Ink palette, native navigation,
light/dark appearance, SF Symbols, responsive text, touch feedback, and motion that
respects Reduce Motion. The computer runs the agents; the phone controls their work.

## Run

Requires Node, pnpm 11.25.0, and Xcode for iOS or Android Studio for Android.
Dependencies are exact-pinned. The default start command targets a development build.

```sh
cd apps/mobile
pnpm install --frozen-lockfile
pnpm ios
# Later, with the development app installed:
pnpm start --lan
```

For Expo Go, install a version that supports SDK 57, then run `pnpm start:go --lan`
and scan its QR code. The normal `pnpm start` QR opens the Kybern development app.
Expo Go does not list this app automatically; EAS registration does not publish it
there. Config plugins and the Kybern URL scheme require a development build.

For a standalone simulator build without Metro:

```sh
pnpm exec expo run:ios --configuration Release --device
```

Connect using a pairing invitation from the desktop environment menu or an access
token. `kybern://pair?...` invitations fill the connection sheet. Pairing credentials are saved in device secure storage as soon as the invitation
is redeemed, so a failed live connection can be retried from Settings → Computers.
Every live connection verifies the daemon identity before exposing its data.
Manually entered access tokens are verified before saving.
A physical phone needs a reachable computer address (for example, its Tailscale
address); `127.0.0.1` works only when the simulator and daemon share a Mac.
The computer must stay awake and reachable. Do not expose the daemon publicly.

For isolated development from the repository root:

```sh
cargo build -p kybern-daemon -p kybern-cli
./target/debug/kybernd --data-dir /tmp/kybern-mobile-dev --port 4199
# In another terminal:
./target/debug/kybern --data-dir /tmp/kybern-mobile-dev pair --address http://127.0.0.1:4199
```

## Workflows

- Start, search, pin, archive, and resume conversations across saved computers.
- Choose projects, agents/accounts, models, effort, permissions, branches, and worktrees.
- Stream replies, reasoning, tool output, images, code, and Markdown tables.
- Attach files, mention project files, skills, and installed plugins, queue follow-ups, and interrupt turns.
- Answer approvals, provider questions, connector permissions, and structured forms.
- Browse/search project files; inspect workspace diffs; commit or create draft pull requests.
- Use a real terminal with tabs, replay, resize, direct input, and keyboard shortcuts.
- Inspect background tasks, stop/background supported tasks, compact/release sessions,
  hand off conversations, and restore checkpoints.
- View provider commands, context capacity, and reported quota limits.
- Manage projects, usage, computer defaults, agent configuration, resource limits,
  updates, Tailscale exposure, and paired devices.

The **Files** browser uses the daemon’s project-root file API, matching desktop;
**Changes** and **Terminal** operate in the thread’s worktree when present.
Provider capabilities and installed tools determine which actions are available.
Handoff starts a new agent conversation from the source transcript in the project;
it does not transfer a running agent process or an uncommitted worktree.

## Implementation

- `app/`: native routes and screens.
- `src/features/`: composer, transcript, approvals, files, changes, and terminal.
- `src/ui/`: typography, Ink tokens, accessible touch controls, and motion.
- `src/state/runtime.ts`: secure connections, subscriptions, and snapshot hydration.
- `packages/kybern-client`: shared typed RPC client, transcript projection, and
  provider input normalization, also used by desktop.

Hydration begins after subscription acknowledgement and replays buffered events
past the snapshot sequence. Reconnects reload subscribed threads. Every event is
folded, while streamed UI notifications are coalesced to 32 ms.

The terminal embeds xterm 6.0.0 and addon-fit 0.11.0 with no CDN access. Its WebView
receives terminal bytes, never connection tokens. To rebuild the vendored bundle,
install desktop dependencies first, then run:

```sh
node apps/mobile/scripts/build-terminal.mjs
```

`plugins/withSceneLifecycle.js` supplies the UIScene lifecycle needed by the iOS 27
SDK until Expo provides its own scene delegate. Native `ios/` and `android/`
directories are generated and ignored.

## Verify

```sh
cd apps/mobile
pnpm typecheck
pnpm test
pnpm exec expo-doctor
pnpm export
# Shared transcript and provider-input coverage:
cd ../desktop
node --experimental-strip-types --test transcript.test.mjs userInput.test.mjs
```

The native app has been exercised on an iPhone 17 Pro simulator with iOS 27 against
a scratch daemon and a real agent. Android and physical-device performance still
need device testing. This client does not register for push notifications while
suspended; agents continue on the computer, and foregrounding reconnects and
restores state. Desktop notification settings apply to the computer.

## Mobile navigation

The project control above the composer opens a searchable project picker with
an Add project action. Browse an existing folder on the connected computer;
adding it also makes it available on desktop.

In a conversation, the top-right environment pill opens branch, changes, commit,
repository, pull request, and thread actions. Separate floating pills above the
composer open Files, Terminal, and Tasks & agents. The top progressive blur ends
near the project name; the bottom blur begins within the lower quarter of the
composer. Both use David Mokos’s MIT progressive-blur registry component
(`src/components/ui/progressive-blur.tsx`).

Type `@` for project files and installed plugins, `$` for skills, or `/` for
commands and skills. Suggestions appear at the caret inside the composer and
preserve surrounding text. Native harness commands remain editable before
sending; local navigation commands execute on selection. New-thread composers
allow agent, model, reasoning, permission, and workspace setup. Existing threads
keep their agent and workspace while exposing model, reasoning, permissions,
context usage, queue/stop controls, and session-specific commands. Permissions,
model/reasoning, and usage open native picker sheets without expanding the input.

Settings opens a compact overview with dedicated pages for appearance, computers,
thread defaults, agents, usage, background/updates, and access. Computer settings
load when their page is opened; appearance and saved connections work offline.

Task activity retains parent/child relationships, separate agent transcripts,
live process output, status and provider-supported stop/background controls.
Reconnecting restores task state from the daemon; foreground completion does not
hide background activity. Work continues on the computer when the phone sleeps.

Connect a computer supports live camera QR scanning, importing a QR image,
and manual pairing. Camera permission is requested only when enabling it.
The simulator can verify QR image decoding; a physical device is required to
verify live camera capture.

The Kybern logo and app icon reuse the desktop artwork. Harness artwork is
stored in `src/generated/provider-marks.json` from the desktop icon set.
Regenerate it with `node scripts/build-brand-marks.cjs` after installing both
clients’ dependencies.
The default dark surfaces match desktop Ink (`#181818`) with neutral grays;
blue links, green additions, and red removals retain semantic meaning.

Files uses a virtualized native adaptation of BeUI's expandable file tree. Opening
a file pushes a separate screen and preserves the tree's expansion and selection
when returning. Text source has lexical syntax colors; Markdown has Preview/Raw
controls. Previews read at most 128 KB and label truncation. Copy and Add to message
remain available in the file screen.

BeUI's question-card flow is adapted in `src/components/beui`: single and multiple
selection, custom answers, previous/next navigation, and an editable review before
submission. Existing provider response formats and connector approvals are retained.
Agent and effort choices use compact rows inside the model sheet. Thread scrolling
uses measured content bounds, and the Latest control no longer changes the bottom
content padding as it appears. The Files and Terminal shortcuts are icon buttons.

The thread header has one ellipsis button. Its menu uses the shape-morph model
from liquid-gooey (MIT; attribution in `src/components/liquid`): a leading center
spring, a following size spring, and a rounded silhouette that settles into the
panel. The blur and labels are separate; text stays unscaled. Closing morphs back
to the measured button before unmounting, while Reduce Motion uses a short fade.

The thread header uses a shorter progressive fade above the conversation. Terminal
uses the app theme, an edge-to-edge xterm canvas and scrollable groups of shell
keys above the native keyboard. Control applies to the next typed character.
Input edits, including Unicode composition, are translated into ordered PTY writes;
terminal resizing follows the viewport and selected shell.

Live assistant text uses a bounded adaptive reveal buffer with 32 ms display
commits. Completed paragraphs keep their native views, while completion, changes
to existing text, reduced motion, backgrounding and offscreen rows catch up without
a reveal delay. See [the mobile cadence check](perf/streaming-2026-09-09.md) for
reproducible measurements and their limits.

## EAS

The project belongs to the personal account **treshnanda**:
https://expo.dev/accounts/treshnanda/projects/kybern-mobile

Run these commands from `apps/mobile`:

```sh
# Installable Android development app (connects to Metro):
npx eas-cli@latest build --platform android --profile development
# Android APK that runs without Metro:
npx eas-cli@latest build --platform android --profile preview
# iOS simulator development app:
npx eas-cli@latest build --platform ios --profile development-simulator
# Store builds:
npx eas-cli@latest build --platform all --profile production
```

Physical iOS development builds require Apple signing and registered devices.
Store submission credentials are configured when preparing a release. Native changes, including Android
system appearance, require a new development build; Metro reload is insufficient.

Android uses bundled Material Symbols alongside iOS SF Symbols. Root surfaces and
system bar content follow the selected appearance. The terminal empty state keeps
its own responsive inset while an open shell retains the full canvas. Latest sits
at the trailing edge of the Files, Terminal, and Tasks & agents row.

Native sockets send the device credential in an authorization header and explicitly
use the existing trusted Kybern app origin (`tauri://localhost`). Android otherwise
synthesizes the server's HTTP origin, which the daemon's browser-origin allowlist
rejects after successful pairing. Browser clients retain the single-use ticket
flow. This transport fix is JavaScript-only and works with existing Mac daemons.

The Android release manifest explicitly allows direct LAN/Tailscale HTTP and
WebSocket endpoints through `plugins/withAndroidLocalNetworking.js`. Expo Go's
network defaults are not sufficient to verify a standalone APK. Preview and
production builds auto-increment the remotely managed native build number.
