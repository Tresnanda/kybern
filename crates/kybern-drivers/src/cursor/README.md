# Cursor local SDK driver

New Cursor sessions use official `@cursor/sdk` **1.0.35**, exact-pinned with an
npm lockfile. Rust embeds `sdk/host.mjs` and owns one Node process per session.
The SDK itself stays on disk so its lazy chunks, sandbox helper, ripgrep, and
native tree-sitter modules remain available. The host’s `argv[1]` is located
beside the SDK package: Cursor resolves platform helpers by walking from this
path. Resolving the JavaScript package alone is insufficient.

The implementation follows [T3’s Cursor adapter at 8ed276c](https://github.com/pingdotgg/t3code/blob/8ed276c246b624631e7d39241ebfd22d8314cb68/apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.ts)
and its [SDK lifecycle service](https://github.com/pingdotgg/t3code/blob/8ed276c246b624631e7d39241ebfd22d8314cb68/apps/server/src/orchestration-v2/Adapters/CursorAgentSdk.ts).
That nightly pins SDK 1.0.31. Kybern uses 1.0.35, checked against the installed
public types and [Cursor’s official SDK documentation](https://cursor.com/docs/sdk/typescript).
The official SDK Bridge was evaluated, but this small isolated host retains the
SDK’s native browser authentication and model catalog APIs directly.

## Permission contract

- `auto`: `local.sandboxOptions.enabled = true`, `local.autoReview = true`.
- `full-access`: both are false.
- `supervised` and `accept-edits` return actionable errors before an SDK agent
  is created. The SDK has no interactive approval response channel.
- Project, user, team, MDM, and plugin settings are enabled as in T3.
- The first Full access open primes sandbox support, matching T3’s workaround
  for the SDK’s process-level sandbox availability cache. Failure to prime does
  not downgrade an Auto-review run; the SDK must accept the requested sandbox.
- Per-app Kybern computer-use consent remains independently enforced by the
  daemon. Coordinator native-tool restrictions are not claimed or simulated.

## Lifecycle and compatibility

`cursor-sdk:<agentId>` is a local SDK agent. Non-prefixed saved IDs keep the
legacy ACP adapter. Cloud `bc-` IDs are rejected. Opening or reading native
history never executes a prompt. Unsupported persisted history formats fail
explicitly rather than creating an empty imported conversation.

Every SDK run maps to one Kybern turn. Updates emitted before `send()` resolves
are buffered and emitted after the run start. Completion waits for queued
deltas. Authoritative final text replaces the final message in place. Nested
agent text keeps a child origin; native task IDs do not become false resumable
handles. The daemon suppresses its generic tool/task fallback for SDK events.

Cancellation during admission is remembered and applied as soon as a run exists.
Close waits for admission, cancels the run, and closes the SDK agent. Rust owns
and terminates the helper process group on close, timeout, or cancelled startup.
A first send after resume may recover an abandoned persisted run once, using
`Agent.listRuns` and `Agent.cancelRun`; new sessions never force-cancel runs.
SDK shell failures cannot crash the Rust daemon.

Commands, model changes, history, and authentication use the official SDK APIs.
`/compress` is a native message command. MCP uses the daemon’s per-thread HTTP
endpoint and scoped bearer capability. Secrets never appear in response errors.

## Setup and distribution

`kybern cursor install` stages `npm ci --ignore-scripts --no-audit --no-fund`
from the embedded manifest/lockfile, then atomically renames it into the versioned
cache. No installs occur during discovery. `login`, `status`, and `logout` work
without a running daemon and use `FileCredentialStore` and `Cursor.auth`.

The daemon offers the same setup to clients as `cursor.status` and
`cursor.setup` (`kybern-daemon/src/cursor_setup.rs`, `access:write`). Install
runs in the background. Sign-in starts the host with
`KYBERN_CURSOR_LOGIN_EVENTS=1`: the SDK opens no browser on the daemon machine
and the host prints `{"status":"login-url"}` instead, which the client opens.
The SDK polls Cursor until the browser finishes, so this works for remote
daemons. Both refresh the provider catalog when they finish.

Node 22.13+ and npm are runtime prerequisites. The default SDK cache is
`~/.kybern/cache/cursor-sdk/1.0.35`. Debug builds can reuse `sdk/node_modules`.
`KYBERN_CURSOR_SDK_DIR`, `KYBERN_CURSOR_NODE`, `KYBERN_CURSOR_AUTH_FILE`, and
`KYBERN_CURSOR_STATE_DIR` support isolated setup/testing; `CURSOR_API_KEY` takes
precedence over the saved SDK login. The provider binary setting is reserved
for old ACP sessions.

## Validation

```sh
node --test crates/kybern-drivers/src/cursor/sdk/host.test.mjs
CARGO_INCREMENTAL=0 cargo test -p kybern-drivers --lib
CARGO_INCREMENTAL=0 cargo test -p kybern-drivers --test live_drivers cursor_completes_a_turn -- --nocapture
```

The live test uses a temporary workspace and separate SDK state directory. It
checks an Auto-review turn, saved history and listing, closes the process,
resumes the same agent in a new process, and verifies conversation continuity.
It skips when SDK discovery/authentication is unavailable, or fails instead if
`KYBERN_LIVE_TESTS` is set. Host unit tests need no SDK installation or credential;
CI runs them on macOS and Linux. Native Windows sandbox support is determined by
Cursor; Kybern never silently disables a requested sandbox.

Validated on macOS arm64, 2026-10-03: driver unit/lifecycle tests; orchestrator
regressions; real sandboxed SDK create, history/list, process restart and resume;
real authenticated MCP tool round-trip; desktop typecheck, lint, tests, build and
native WebKit chat fixture; mobile typecheck, 111 tests and iOS/Android exports.
Expo Doctor passed 20/21 checks, reporting pre-existing Expo patch-version
mismatches. Linux/Windows live SDK execution, native child-agent runs and mobile
visual inspection were not exercised in this change.
