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
logical sessions; releasing the final session terminates the account process
group. Dropping a cancelled startup releases only its own session. A timed-out
or crashed host is retired before it can admit another prompt.
A first send after resume may recover an abandoned persisted run once, using
`Agent.listRuns` and `Agent.cancelRun`; new sessions never force-cancel runs.
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
their own MCP headers, cancellation state and SDK agent. Workspace platforms and
prewarm leases are reference counted and discarded with the last user; catalog
data stays loaded for the account process's lifetime.

The daemon passes its cached model catalog to new sessions. Opaque selectors
retain native parameter and max-mode metadata so the host can reconstruct the
SDK catalog and seed `CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON` without another network
list. Old caches lacking this metadata deliberately discover once per host,
then share the result across workspaces. A provider refresh updates the live
account catalog without restarting its agents. No max-mode label is added to the picker.
`prewarmLocalWorkspace` starts during open with the exact eventual workspace,
settings, sandbox and MCP options; its lease survives until session close.

Commands, model changes, history, and authentication use the official SDK APIs.
`/compress` is a native message command. MCP uses the daemon’s per-thread HTTP
endpoint and scoped bearer capability. Secrets never appear in response errors.

## Startup measurements (2026-10-31)

Apple M1 MacBookPro17,1, macOS arm64, Node 24.22.1, SDK 1.2.0, existing browser
login; `Reply with OK` on GPT-5.4 Nano, scratch JSONL stores and workspaces.
Native project/user/team/MDM/plugin settings remained enabled. These are small
live samples, with uncontrolled network latency and other agents compiling on
the same Mac, not latency guarantees.

| Boundary | Before account host | Account host |
| --- | ---: | ---: |
| Process start to agent open | 5,389 ms | 372 ms |
| Cold start to first SDK delta | 24,679 ms | 28,506 ms |
| Warm send to first SDK delta | 3,284 ms | 7,945 ms |
| Second agent open in the same host | — | 74 ms |
| Second agent open through first SDK delta | — | 6,006 ms |

A separate scratch-daemon run included the real Kybern guide and per-thread MCP
capability. It reached session readiness in 400 ms cold, 1 ms for the same
session, and 44 ms for another agent in the same host. End-to-end first provider
events were **38,818 / 9,521 / 29,738 ms** respectively. SDK prewarm alone took
25,877 ms cold and 9,541 ms for the second agent's distinct MCP configuration.
One SDK load served both agents. All three replies completed as `OK`.

The under-2-second warm / under-5-second cold first-output targets are **not
met**. Host/model-discovery overhead is reduced, but workspace/runtime setup and
backend first-event latency still dominate. No settings, tools, context size,
permissions or output were removed to improve these numbers. Ten tiny prompts
were sent across all ADE-105 benchmarks; ADE-106 variant checks sent none.

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

Timing logs are permanent: `RUST_LOG=provider.stderr=debug,kybern::turn_startup=info`
shows `cursor_timing` phases for Node start, SDK load, catalog/model check, agent
creation, workspace prewarm and first SDK event. The existing daemon startup
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
