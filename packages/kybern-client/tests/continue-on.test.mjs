import assert from "node:assert/strict";
import test from "node:test";
import { historyLabel, moveBanner, moveParams, moveQueuedText, threadTakesMessages, waitingMove } from "../src/continueOn.ts";
import { forkNotice, forkNoticeAction, forkNoticeText } from "../src/forkMachine.ts";
import { applyEvent, emptyThreadState, seedFromGet } from "../src/transcript.ts";

const THREAD = "0192f7a0-1111-7222-8333-444455556666";
const SOURCE = "0192f7a0-2222-7222-8333-444455556666";
const OP = "0192f7a0-3333-7222-8333-444455556666";

test("a thread that is moving takes no messages and says so; one that moved links to its continuation", () => {
  assert.equal(moveBanner({ moved: null }), null);
  assert.equal(moveBanner({}), null);
  assert.equal(threadTakesMessages({}), true);

  const departing = moveBanner({ moved: { state: "departing", peer: "m-2", peer_name: "satyamas", operation_id: OP } });
  assert.equal(departing.text, "Moving to satyamas…");
  assert.equal(departing.open, undefined, "nothing to open before the target confirms");
  assert.equal(threadTakesMessages({ moved: { state: "departing", peer: "m-2", operation_id: OP } }), false);

  const unsure = moveBanner({ moved: { state: "departing", peer: "m-2", peer_name: "satyamas", operation_id: OP, uncertain: true } });
  assert.match(unsure.text, /Couldn't confirm the move to satyamas/);
  assert.equal(unsure.uncertain, true);

  const departed = moveBanner({ moved: { state: "departed", peer: "m-2", peer_name: "satyamas", peer_thread_id: THREAD, operation_id: OP } });
  assert.equal(departed.text, "This thread continues on satyamas.");
  assert.deepEqual(departed.open, { label: "Open", href: `kybern://thread/m-2/${THREAD}` });
  assert.equal(threadTakesMessages({ moved: { state: "departed", peer: "m-2", operation_id: OP } }), false);
  assert.equal(moveBanner({ moved: { state: "departed", peer: "m-2", operation_id: OP } }).machineName, "another machine");
});

test("move notices open the continuation and the failure ones do not", () => {
  const done = forkNotice({ kind: "move", machine_id: "m-2", machine_name: "satyamas", thread_id: THREAD, branch: "kybern/move-ab12" });
  assert.deepEqual(forkNoticeAction(done), { label: "Open", href: `kybern://thread/m-2/${THREAD}` });
  assert.equal(forkNoticeText(done, "Continued on satyamas · open"), "Continued on satyamas");
  for (const kind of ["move_queued", "move_failed", "move_released"]) {
    const notice = forkNotice({ kind, machine_id: "m-2", machine_name: "satyamas", thread_id: THREAD });
    assert.equal(notice.kind, kind);
    assert.equal(forkNoticeAction(notice), null);
  }
});

test("the sheet sends the edited note only, and a waiting move is found by its thread", () => {
  const target = { machineId: "m-2", projectId: "p-1" };
  assert.deepEqual(moveParams(SOURCE, target, { note: "  generated  " }, "generated"), { thread_id: SOURCE, machine: "m-2", project: "p-1" });
  assert.equal(moveParams(SOURCE, target, { note: "mine" }, "generated", "auto").handoff_note, "mine");
  assert.equal(moveParams(SOURCE, target, { note: "mine" }, "generated", "auto").permission_mode, "auto");
  assert.equal(moveQueuedText("satyamas", true), "Moving to satyamas when this turn ends…");
  assert.equal(moveQueuedText("satyamas", false), "Moving to satyamas when it is back online.");

  const item = (state, source) => ({ id: "i", kind: "move", state, payload: { source_thread_id: source } });
  assert.equal(waitingMove([item("delivered", SOURCE), item("queued", THREAD)], SOURCE), null);
  assert.equal(waitingMove([item("queued", SOURCE)], SOURCE).state, "queued");
  assert.equal(waitingMove([{ id: "j", kind: "fork", state: "queued", payload: { source_thread_id: SOURCE } }], SOURCE), null);
});

test("imported history is one collapsed block and counts messages, not tool lines", () => {
  const items = [
    { role: "user", text: "Fix the login" },
    { role: "tool", text: "Bash: cargo test", tool: "Bash" },
    { role: "assistant", text: "Done" },
  ];
  assert.equal(historyLabel("Mac", items), "Earlier on Mac · 2 messages");
  assert.equal(historyLabel("Mac", items.slice(0, 1), 5), "Earlier on Mac · 1 message (+5 older)");

  const event = { kind: "history_imported", seq: 2, thread_id: THREAD, at: "2026-10-29T00:00:00Z", from_machine: "m-1", from_machine_name: "Mac", from_thread: SOURCE, from_title: "Fix login", items, omitted: 3 };
  const state = applyEvent({ ...emptyThreadState(), loaded: true }, event);
  assert.equal(state.blocks.length, 1);
  assert.deepEqual(
    { kind: state.blocks[0].kind, id: state.blocks[0].id, name: state.blocks[0].fromMachineName, omitted: state.blocks[0].omitted, count: state.blocks[0].items.length },
    { kind: "history", id: "history:2", name: "Mac", omitted: 3, count: 3 },
  );
  assert.equal(applyEvent(state, event).blocks.length, 1, "a replayed event does not add a second block");

  const seeded = seedFromGet({
    thread: { id: THREAD, last_seq: 2 },
    transcript: [{ role: "history", turn_id: "0".repeat(8) + "-0000-0000-0000-000000000000", seq: 2, from_machine: "m-1", from_machine_name: "Mac", from_thread: SOURCE, from_title: "Fix login", items, at: "2026-10-29T00:00:00Z" }],
    pending_approvals: [],
  });
  assert.deepEqual({ kind: seeded.blocks[0].kind, id: seeded.blocks[0].id, omitted: seeded.blocks[0].omitted }, { kind: "history", id: "history:2", omitted: 0 });
});
