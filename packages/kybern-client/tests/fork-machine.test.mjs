import assert from "node:assert/strict";
import test from "node:test";
import { chatLink } from "../src/chatLinks.ts";
import { forkNotice, forkNoticeAction, forkParams, forkQueuedText, forkSheetDefaults, forkTargets, originLabel, parseThreadLink, threadLinkHref } from "../src/forkMachine.ts";

const THREAD = "0192f7a0-1111-7222-8333-444455556666";

test("a machine-qualified thread link round-trips and bare ones still resolve", () => {
  assert.equal(threadLinkHref("m-1", THREAD), `kybern://thread/m-1/${THREAD}`);
  assert.deepEqual(parseThreadLink(`kybern://thread/m-1/${THREAD}`), { machineId: "m-1", threadId: THREAD });
  assert.deepEqual(parseThreadLink(`<kybern://thread/${THREAD}/>`), { threadId: THREAD });
  assert.equal(parseThreadLink("kybern://thread/m-1/not-a-uuid"), null);
  assert.equal(parseThreadLink(`kybern://note/${THREAD}`), null);
  assert.equal(parseThreadLink(`kybern://thread/../${THREAD}`), null);
});

test("chat links resolve a thread on another machine", () => {
  assert.deepEqual(chatLink(`kybern://thread/satya/${THREAD}`), { kind: "thread", threadId: THREAD, machineId: "satya" });
  assert.deepEqual(chatLink(`kybern://thread/${THREAD}`), { kind: "thread", threadId: THREAD });
  assert.deepEqual(chatLink(`kybern://task/${THREAD}`), { kind: "kybern", target: "task", id: THREAD });
});

test("fork notices carry the machine and, once delivered, the thread to open", () => {
  const done = forkNotice({ kind: "fork", machine_id: "m-2", machine_name: "satyamas", thread_id: THREAD, branch: "kybern/fork-ab12" });
  assert.deepEqual(done, { kind: "fork", machineId: "m-2", machineName: "satyamas", threadId: THREAD, branch: "kybern/fork-ab12" });
  assert.deepEqual(forkNoticeAction(done), { label: "Open", href: `kybern://thread/m-2/${THREAD}` });
  const queued = forkNotice({ kind: "fork_queued", machine_id: "m-2", machine_name: "satyamas", operation_id: "x" });
  assert.equal(queued.threadId, undefined);
  assert.equal(forkNoticeAction(queued), null);
  const failed = forkNotice({ kind: "fork_failed", machine_id: "m-2", thread_id: THREAD });
  assert.equal(failed.threadId, undefined, "a fork that did not arrive has nothing to open");
  assert.equal(failed.machineName, "another machine");
  assert.equal(forkNotice({ kind: "other", machine_id: "m-2" }), null);
  assert.equal(forkNotice({ kind: "fork" }), null);
  assert.equal(forkNotice(null), null);
  assert.equal(forkNotice(["fork"]), null);
});

test("a thread another machine started says where it came from", () => {
  assert.equal(originLabel({ origin: { machine_name: "satyamas", kind: { kind: "fork" } } }), "From satyamas");
  assert.equal(originLabel({ origin: { machine_name: "vps", kind: { kind: "delegation", task_id: "t" } } }), "From vps");
  assert.equal(originLabel({ origin: { machine_name: "vps", kind: { kind: "composer" } } }), null);
  assert.equal(originLabel({ origin: null }), null);
  assert.equal(originLabel(undefined), null);
});

test("targets are the other machines that have the project; paused ones are left out", () => {
  const instances = [
    { machineId: "a", machineName: "Mac", projectId: "p1", online: true },
    { machineId: "b", machineName: "satyamas", projectId: "p2", online: false },
    { machineId: "c", machineName: "cachy", projectId: "p3", online: true },
    { machineId: "d", machineName: "vps", projectId: "p4", online: true, paused: true },
  ];
  assert.deepEqual(forkTargets(instances, { machineId: "a" }).map((item) => item.machineId), ["c", "b"], "online first, then by name");
  assert.deepEqual(forkTargets(instances.slice(0, 1), { machineId: "a" }), []);
});

test("the sheet starts on the first target with no push to origin, and an unedited note is not sent", () => {
  const targets = forkTargets([{ machineId: "b", machineName: "satyamas", projectId: "p2", online: true }], { machineId: "a" });
  const state = forkSheetDefaults(targets, "# Hand-off\n");
  assert.deepEqual(state, { machine: "b", note: "# Hand-off\n", pushOrigin: false });
  assert.deepEqual(forkParams(THREAD, targets[0], state, "# Hand-off\n"), { thread_id: THREAD, machine: "b", project: "p2", push_origin: false });
  assert.deepEqual(forkParams(THREAD, targets[0], { note: "Edited", pushOrigin: true }, "# Hand-off\n", "supervised"), {
    thread_id: THREAD, machine: "b", project: "p2", push_origin: true, handoff_note: "Edited", permission_mode: "supervised",
  });
  assert.equal(forkSheetDefaults([], "n").machine, "");
});

test("a fork to a machine that is offline says it waits", () => {
  assert.equal(forkQueuedText("satyamas", true), "Forking to satyamas…");
  assert.equal(forkQueuedText("satyamas", false), "Forking to satyamas when it is back online.");
});
