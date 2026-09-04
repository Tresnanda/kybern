# Transcript fixtures

`codex-mixed-agent-turn.json` is a content-redacted, identifier-replaced capture
shape derived from a real Kybern Codex multi-agent event log on 2026-09-04. It
preserves the original event categories and ordering: root narration, root
tools, a linked delegated agent, child-owned tool activity, a native child
thread, child-only prose, the root final response, and task lifecycle updates
after turn settlement.

Both the Rust reload projector and the TypeScript live-event reducer consume
this file. Any ordering or classification change therefore has to agree across
both code paths.

`claude-background-continuation.json` is a minimized, content-redacted replay
of the Claude Code turn shown in the 2026-09-04 bug report. A provisional
`result` closed the root turn while a background Explore agent was active;
Claude then resumed from an internal task notification. The affected daemon
persisted those continuation chunks without `turn_id` and assigned a different
message id to every delta and the completion snapshot. The fixture locks down
legacy recovery while the daemon regression test prevents new logs from taking
that shape.
