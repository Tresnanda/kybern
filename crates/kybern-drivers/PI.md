# Pi integration

Kybern drives the user's Pi installation through its native JSONL RPC protocol.
Pi 0.80.5 or later is required for the settlement events used by the driver.
Pi continues to own credentials, models, project resources, extensions, skills,
saved sessions, and project trust. Kybern does not pass a trust override: Pi
uses saved trust decisions and its global `defaultProjectTrust` policy. In RPC
mode, the default `ask` policy safely ignores undecided project-local resources;
trust the project in Pi first if those resources should load in Kybern. Oh My Pi
retains its separate protocol and permission tiers.

## Controls

- Models are discovered with `get_state` and `get_available_models` in the
  selected project and provider environment. Discovery uses `--no-session`,
  has a 15-second deadline, and cancels blocking extension dialogs. A failed
  discovery is reported; an interactive thread can still use Pi's own default.
- The model picker exposes only the selected model's thinking levels, including
  explicit `thinkingLevelMap` exclusions. Changing effort uses
  `set_thinking_level`; clearing effort restores the session's initial level
  clamped to the selected model.
- Desktop and mobile offer **Steer now** during a Pi turn. The driver uses
  `prompt` with `streamingBehavior: "steer"` so Pi handles extension commands and
  the transition between running and idle. **Queue follow-up** remains Kybern's
  durable queue and sends after the current turn finishes.
- Native resume, fork-based rewind, manual compaction, images, extension
  dialogs, and final text/usage remain supported. Tool updates carry bounded
  incremental previews derived from Pi's cumulative snapshots. Completed tool
  output is authoritative, including when a tool rewrites its preview.

## Permissions

Every Pi process loads a bundled Kybern extension from a private temporary
directory. Before sending a user prompt, the driver verifies a versioned
command in Pi's native command catalog. A failed handshake stops the process;
the driver never silently falls back to unrestricted execution.

| Mode | Behavior |
| --- | --- |
| Supervised | Read-only built-in and Kybern app tools run; edits, shell commands, and custom tools require approval. |
| Auto-accept edits | Reads and built-in edits/writes run; shell commands and custom tools require approval. |
| Full access | The Kybern tool hook does not request approval. |

Pi has no Kybern AI approval reviewer, so **Auto** is not offered. Changing modes
uses an internal native extension command and clears previous exact-call grants.
**Always allow** applies only to the same tool name and exact arguments for that
Pi session. A denial, expired request, unavailable approval UI, or hook failure
blocks the call. Native extension dialogs still use the normal question UI.

These are tool-hook permissions, not an operating-system sandbox. Installed Pi
extensions execute as the user, as they do when running Pi directly.

## Kybern app tools

The bundled extension registers seven read-only tools:

| Tool | Scope |
| --- | --- |
| `kybern_thread_context` | Current thread/project metadata and saved thread notes. |
| `kybern_workspace_diff` | Current thread's checkpoint diff, optionally one of its turns or a relative file path. |
| `kybern_read_file` | A bounded file inside the thread's workspace. |
| `kybern_list_files` | One directory level inside the thread's workspace. |
| `kybern_runtime_tasks` | Current thread's recorded runtime tasks. |
| `kybern_list_terminals` | Terminals attached to the current thread. |
| `kybern_read_terminal` | Bounded scrollback from one of those terminals. |

The bridge uses reserved native extension-input requests, intercepted by the
driver rather than shown as questions. The daemon supplies the owning thread
from the live session. Tools cannot choose another thread, project, working
directory, checkpoint, or terminal. File reads reuse workspace containment and
symlink checks. No daemon token, general RPC dispatcher, or new network listener
is exposed to Pi. Requests and results are bounded, timed out, and rejected if
their owning turn or session has ended. Notes are available when Pi calls the
context tool; they are not automatically appended to every prompt.

## Lifecycle guarantees and checks

Startup returns the event stream before waiting for native initialization, so
extension startup dialogs can reach desktop/mobile. User prompts wait for the
initialization and permission handshake. Each logical turn has a generation;
late completion, app-tool, and stats responses cannot update a replacement turn.

`agent_end` is an attempt boundary for Pi. Only settlement plus a native idle
check completes a turn. Successful retries and overflow-compaction continuations
clear transient errors. Stop cancels queued input, retry backoff, dialogs, and
the current run; the daemon's existing bounded forced-stop path closes an agent
that cannot settle, preserving its saved conversation for resume.

Focused checks (no model credentials needed):

```sh
cargo test -p kybern-drivers --lib pi::
cargo test -p kybern-daemon --lib app_tool
node crates/kybern-drivers/src/pi/extension.test.mjs crates/kybern-drivers/src/pi/extension.ts
```

The fake RPC tests exercise retry recovery/exhaustion, deferred prompts,
startup input, compaction, steering, cancellation, authoritative tool output,
model capabilities, and stale responses. Daemon tests cover thread/path/terminal
isolation, request bounds, and asynchronous driver round trips. Run the regular
desktop/mobile checks and native WebKit prompt/question fixtures when changing
client controls. Live tests must use a disposable workspace and Pi agent home.

## Live extension RPC validation

Run the opt-in native RPC fixture from the workspace root. It uses `npx` to run
the requested Pi version, creates and removes a disposable Pi agent home and
workspace, and does not send a model request:

```sh
node crates/kybern-drivers/src/pi/extension.rpc-test.mjs 0.80.5
node crates/kybern-drivers/src/pi/extension.rpc-test.mjs 0.85.1
```

The fixture verifies the versioned `get_commands` handshake, a thread-context
app-tool request/result through native `input`, a permission request through
native `select`, and a permission-mode change while that approval is pending.
The companion `extension.rpc-test.ts` is loaded only by this command. Production
staging embeds `extension.ts`, so the two test commands are never advertised in
a Kybern thread.

For the daemon-to-Pi path on macOS/Linux, build `kybern` and run the opt-in smoke
test with an installed Pi executable:

```sh
cargo build -p kybern
python3 crates/kybern-drivers/tests/pi_release_smoke.py target/debug/kybernd /absolute/path/to/pi
```

The test runs a loopback-only fake model service with placeholder credentials,
a disposable Pi agent home, workspace, and daemon data directory. It checks
actual native tool execution, approval denial and allow-once, mode/effort
changes, app-tool results, steering, stopping, native project trust, and persisted
session resume. Pass the `kybernd` inside the desktop bundle to test the shipped
sidecar. It does not call an external model service.
