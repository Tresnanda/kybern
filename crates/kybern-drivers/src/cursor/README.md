# Cursor local SDK driver

New Cursor sessions use official `@cursor/sdk` **1.2.0**, exact-pinned with an
npm lockfile. Rust embeds `sdk/host.mjs` and owns one Node process per Cursor
account/environment, shared by its agents and native-history readers.
The SDK itself stays on disk so its lazy chunks, sandbox helper, ripgrep, and
native tree-sitter modules remain available. The host’s `argv[1]` is located
beside the SDK package: Cursor resolves platform helpers by walking from this
path. Resolving the JavaScript package alone is insufficient.

The implementation follows [T3's model selector](https://github.com/pingdotgg/t3code/blob/main/packages/provider-cursor/src/server/sdkModel.ts)
and [SDK lifecycle runner](https://github.com/pingdotgg/t3code/blob/main/packages/provider-cursor/src/server/CursorAgentSdk.ts).
Kybern uses 1.2.0 with zod 4.6.7, checked against the installed public types and
[Cursor's official SDK documentation](https://cursor.com/docs/sdk/typescript).
The official SDK Bridge was evaluated, but this small isolated host retains the
SDK’s native browser authentication and model catalog APIs directly.

## Model selections

Selectors carry the model ID and explicit trait choices. Native catalog defaults
are displayed by the existing picker but are not filled into requests. An unset
effort stays unset. Hidden `cyber=false` copied by older catalogs is discarded;
explicit context and fast values in saved selectors remain intact. Registry
errors name the model and requested settings and tell the user what to change.
There is no fallback to a smaller context or a different fast mode.

At thread open, the daemon translates pre-SDK IDs such as
`cursor-grok-4.5-high` using the project's cached default-account catalog. It
preserves the exact model and explicit effort, leaves saved transcript events
intact, and leaves unknown or non-default-account IDs unchanged.

Validated on macOS arm64, 2026-10-31, using the existing SDK login and isolated
JSONL state: create/resume accepted Grok 4.7 (context=500k, fast=true,
reasoning_effort=xhigh), Sonnet 5.5 (context=1m), Opus 5.5 (context=1m), and
GPT-5.6 Sol (context=1m). No prompt was sent by these variant checks.
`npm audit signatures` verified all eight installed package signatures.

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
Close waits for admission, cancels that session's run, releases its workspace
warm lease, and closes its SDK agent. The daemon's existing idle policy closes
logical sessions. The account process outlives its final session by
`HOST_LINGER` (10 minutes) with its warm workspaces, then exits; a session
opened meanwhile reuses it. Dropping a cancelled startup releases only its own session. A timed-out
or crashed host is retired before it can admit another prompt.
A first send after resume may recover an abandoned persisted run once, using
`Agent.listRuns` and `Agent.cancelRun`; new sessions never force-cancel runs.
Runs list oldest first, so recovery pages through them for the running one
(a host killed mid-turn otherwise left its agent stuck with an "active run").
SDK shell failures cannot crash the Rust daemon.

The Rust supervisor restarts a crashed account host and resumes every confirmed
native agent with its own model, effort, permission mode and MCP capability.
It fails an interrupted turn and never replays its prompt: admission could have
succeeded before the crash. Calls that arrive during restoration wait for the
confirmed agent to resume. Repeated crashes (more than three in a minute) stop
recovery and surface an actionable error. Unconfirmed creates are never replaced
with an empty conversation.

Events carry a logical session ID and fold through an independent transcript
stream per agent. A saturated output receiver retires only that session with
an explicit error, so sibling control requests cannot hang behind it. Scoped askpass credentials use an async-local environment view
rather than replacing the account host's ambient credentials. Sessions retain
their own tool capability, cancellation state and SDK agent. Workspace platforms
are reference counted; workspace executors are shared (below); catalog data
stays loaded for the account process's lifetime.

The daemon passes its cached model catalog to new sessions. Opaque selectors
retain native parameter and max-mode metadata so the host can reconstruct the
SDK catalog and seed `CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON` without another network
list. Old caches lacking this metadata deliberately discover once per host,
then share the result across workspaces. A provider refresh updates the live
account catalog without restarting its agents. No max-mode label is added to the picker.
A missing catalog is fetched while the workspace scan runs, not before it.

## Workspace executors and Kybern tools

The SDK's local executor (rules, skills, plugins, user and project MCP servers,
sandbox) is the slowest part of a first turn: about 7–25 s of sequential
requests to Cursor from this network. The SDK caches executors by workspace,
account, settings, sandbox/auto-review policy **and agent-level MCP servers**.
The host therefore:

- calls `prewarmLocalWorkspace` first in open, keyed only by workspace and
  policy, and shares that lease between every agent in the workspace; it
  lingers `HOST_LINGER` after its last session;
- serves Kybern's tools as SDK `local.customTools` (`kybernTools` in
  `host.mjs`): it lists the daemon's per-thread MCP endpoint with that thread's
  scoped bearer and forwards each call there. A per-thread bearer in
  `mcpServers` would give every conversation its own cold executor. Tool events
  arrive from the SDK's `custom-user-tools` server and are named
  `mcp__kybern__<tool>` as before. Custom tools are not subject to Cursor's
  auto-review; the daemon's own consent rules still apply to every call;
- never passes `mcpServers` to `send`. A send-level override makes the SDK
  build a fresh MCP lease for the run, reconnecting every project and user
  server; the run's tool listing waited for the slowest one (about 6 s per turn
  with the 20 servers on the test machine). T3 omits it for the same reason.

Commands, model changes, history, and authentication use the official SDK APIs.
`/compress` is a native message command. Secrets, including the tool
capability, never appear in response errors.

## Startup measurements (2026-10-31)

Apple M1 MacBookPro17,1, Node 24.22.1, SDK 1.2.0, existing browser login,
GPT-5.4 Nano, `Reply with OK`, scratch stores and workspaces, all native setting
sources enabled (the user's 20 MCP servers included). Round-trip time to Cursor's
backend was about 270 ms with 0.6–3 s TLS handshakes; other agents were compiling
on the same Mac (load averages 5–42). Old (process per session) and new runs were
interleaved. Small samples, not guarantees.

| Send → first streamed text | Before | After |
| --- | ---: | ---: |
| Next turn, same conversation | 9.6–16.2 s | 2.1–2.3 s |
| New conversation, warm workspace in the host | (cold) | 2.3–2.6 s |
| New conversation within the linger window | (cold) | 2.6 s |
| Fully cold (open + send) | 24.8–31.3 s | 23.2–26.5 s |

Scratch daemon (real guide, real tool endpoint): 17.3 s cold, 2.7 s for the next
turn, 3.3 s for a new conversation in the same workspace, 12.9 s for a new
workspace in a running host. Fully cold time is Cursor's: the executor build
and the first run on a new executor (two key exchanges, a new TLS connection and
about 2.4 s of in-stream setup) cannot be done without a run. Under 2 s warm is
reached for the host-protocol path only in its best samples; under 5 s cold is
not reachable from the client on this network.

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
`~/.kybern/cache/cursor-sdk/1.2.0`. Debug builds can reuse `sdk/node_modules`.
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

Timing logs are permanent: `RUST_LOG=kybern_drivers::cursor::timing=debug,kybern::turn_startup=info`
shows the host's phases: `node_spawn`/`host_reused`, `node_start`, `sdk_load`,
`tools`, `model_catalog` (source daemon/host/fetched), `model_check`,
`agent_creation`, `prewarm`/`prewarm_shared`, and per send `prewarm_wait`,
`run_started`, `first_event` and `first_text`. The existing daemon startup
spans measure session/checkpoint readiness and the first provider event from
turn admission. Session IDs correlate interleaved account-host phases; prompts,
keys and MCP capabilities are not logged.

The live test uses a temporary workspace and separate SDK state directory. It
checks an Auto-review turn, saved history and listing, releases the session,
resumes the same agent after release, and verifies conversation continuity.
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
