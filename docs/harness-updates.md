# Harness updates

Settings → Agents has an automatic-update switch and an Update now action for installed agents. The switch is opt-in and stored per daemon environment. Once enabled, the daemon checks each eligible harness daily; busy harnesses are reconsidered every 30 seconds. The app window does not need to stay open while its daemon is running. Update now also waits for idle.

The updater uses the machine hosting the agent, with its existing installation and provider environment. It does not install missing CLIs. Results, versions, and last-check times persist across reconnects. A failed check waits until the next daily attempt unless manually retried; an interrupted update is shown as a failure after restart.

## Installation behavior

| Harness | Update path |
| --- | --- |
| Claude Code | Advertised native `update`, or the existing Homebrew cask, retaining `claude-code` versus `claude-code@latest`. |
| Codex | Advertised native `update`, which delegates to its installation manager, or the existing Homebrew cask. Older CLIs lacking this command require a manual update. |
| OpenCode | Advertised native `upgrade`, or its existing Homebrew formula. |
| pi | `update --self` only when the installed CLI advertises it. Older versions with extension-only update commands require a manual CLI update. |
| OMP | Advertised native `update`, or its existing Homebrew formula. No plugin-update or channel-changing flags are added. |
| Cursor | Advertised native `update`. |

Configured binary overrides and recognized Nix/mise/asdf/rtx installations are skipped. Native updater restrictions are preserved, including `DISABLE_UPDATES` and, for automatic attempts, `DISABLE_AUTOUPDATER`. Package-manager permissions, network failures, and unsupported installers produce a visible result. Kybern does not elevate privileges or migrate to a different installer. Existing provider-controlled auto-updaters are independent of Kybern's schedule.

## Work protection

Updates serialize across providers. A provider gate prevents new sends and one-shot title/summary jobs from racing installation. The daemon checks active turns, pending approvals, and tracked background tasks before retiring idle sessions. The next turn resumes the stored conversation using the updated CLI. Sends during installation return a retryable explanatory error; queued messages remain queued. Work launched outside this daemon is not tracked by this gate.

Updater processes have closed stdin, bounded output capture, and a five-minute timeout. Timeout/cancellation terminates the process tree. Successful exit is followed by a version probe and model-catalog invalidation. Kybern does not promise rollback or compatibility with future provider protocol changes.

## CLI

- `kybern harness-updates`: show results.
- `kybern harness-updates --run codex`: request an idle-time update.
- `harness_updates.list` requires orchestration read scope; `harness_updates.run` requires orchestration operate scope, matching the existing settings controls.

## Sources checked September 5, 2026

- [Claude Code installation and updates](https://code.claude.com/docs/en/setup)
- [Codex CLI updater](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs) and [installation diagnostics](https://github.com/openai/codex/blob/main/codex-rs/cli/src/doctor/updates.rs)
- [OpenCode upgrade command](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/upgrade.ts)
- [pi package and self-update documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [OMP installation](https://github.com/can1357/oh-my-pi/blob/main/README.md), plus the installed `omp update --help`
- [Cursor CLI updates](https://cursor.com/docs/cli/installation)

Verification uses fake updater executables and scratch daemons: native argument handling, failure reporting, process-tree timeout, daily retry limits, active-turn/approval/background-task exclusion, sends during installation, custom-binary exclusion, and persisted results. No real harness upgrade is performed by these tests.

The deterministic updater checks and native Agents settings review passed. On September 5, 2026, automatic updates were then enabled in the normal local environment: Codex updated from 0.146.1 to 0.153.4, OpenCode to 1.18.29, OMP to 18.1.10, and Cursor to 2026.09.02-c22c1a3. Claude Code 2.1.261 was already current. Pi was absent and skipped. The real Codex turn test passed after its upgrade.
