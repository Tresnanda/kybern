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

`coordinator-rotation-*.json` are synthetic Coordinator context refreshes: a
pending row that never settled, a settled one with a written handoff, a missing
handoff, a handoff the user edited afterwards, and a harness switch. Each starts
with one finished turn; all but the pending one end with a second turn, so the
row's place between the two is checked as well.
`coordinator-rotation.expected.json` holds the row signatures both consumers
must produce: `rotation_fixtures_project_to_the_shared_signatures` in
`crates/kybern-store/src/projection.rs` and the rotation test in
`apps/desktop/transcript.test.mjs` (which also runs the mobile reducer).
