# Harness prompt-cache audit — 2026-09-18

Audited the six native drivers from main `2cd0578`, their session resume paths,
tool catalogs, coordinator instructions, and cache-token projection. Kybern
delegates inference and prompt caching to the harness/provider; it does not
implement a replacement model cache or set provider cache TTLs.

## Findings and fixes

| Harness | Finding | Change / boundary |
| --- | --- | --- |
| Claude Code | Coordinator attaches rebuilt `--append-system-prompt` content after idle resume: objective, knowledge revisions, assignments, and conversation extracts changed the prefix. Ordinary chats do not receive this coordinator prompt. | Coordinator role is stable. Current state is fetched through collaboration and transcript tools, including after a harness switch. Native `--resume` and session identity stay intact. |
| Codex | The same rebuilt snapshot was passed as `developerInstructions` on `thread/resume` and fork. | Same stable-role fix. Dynamic tool definitions retain their deterministic order and schemas; transport IDs/credentials are not added to their definitions. |
| Pi | `before_agent_start` returned the coordinator system addition once, then returned nothing on subsequent turns. The hook's system override is per turn. | Return the same system addition each turn. Only the persisted bootstrap message is once; its existing marker survives resume and branch restoration. |
| OMP | Shares the bundled Pi extension and its first-turn-only behavior. | Same extension fix. Native session/profile binding remains unchanged. |
| OpenCode | Coordinator `system` was consumed after the first ordinary prompt and omitted on resume. OpenCode uses the latest user message's `system` in its model request. | Retain the role and supply it on each ordinary prompt, including resumed sessions. Native slash commands and compaction retain their separate native endpoints and prompt semantics. |
| Cursor | Uses ACP native sessions and native model selection; no Kybern coordinator system override. Required coordinator tool restrictions are rejected because ACP cannot enforce them. | No cache-breaking wrapper found. ACP does not expose cache-hit token counts here, so zero/default usage is not evidence of a cache miss. |

The stable role retains instructions to refresh the objective, assignments,
user-authored context, and setup status. It directs a coordinator that switched
harnesses to read its saved conversation. Mutable context is no longer embedded
in the system prefix or reconstructed from up to 1,000 events at every attach.
No saved transcript or provider session is deleted.

Native tool catalogs are built from an ordered definition vector. The gateway's
per-session authorization capability stays in transport configuration. Cache read
and write counts reported by Claude, Codex, OpenCode, Pi, and OMP remain forwarded
through the existing usage types. Kybern does not turn caching off based on model
name. Switching models, changing native tools/settings, provider TTL expiry,
compaction, and provider-side routing can still reduce cache reuse.

## Evidence and limits

- All 117 driver unit tests passed, including the repeated OpenCode request
  payload assertion and native start/resume/fork tests.
- All 16 bundled extension tests passed. They check byte-identical coordinator
  system content on successive turns and restored branches, one durable marker,
  no injected guidance for ordinary chats, and unchanged permissions.
- Daemon regression verifies that changing live knowledge does not change the
  coordinator prefix, resume keeps it identical, and the changed knowledge
  remains available to ordinary chats through the context tool.
- This is a request-construction audit with deterministic harness fixtures.
  Actual paid model cache-hit rates, billing savings, every third-party plugin,
  and every upstream model were **not measured**. No universal cache-hit
  percentage is claimed.

## Primary references

Current documentation was fetched with Context7 and checked against upstream
sources where the request path matters:

- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): exact prompt prefix, tools/system/messages ordering.
- [Claude Code cache engineering](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything): mutable system instructions and tool-order changes invalidate later prefixes.
- [OpenCode request assembly](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm/request.ts): latest user `system` contributes to the system prompt.
- [OpenCode prompt handling](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts): each new user message records its own `system` field.
- [Pi extension lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md): `before_agent_start` overrides the prompt for that turn.
