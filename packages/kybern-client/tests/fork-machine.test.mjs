import assert from "node:assert/strict";
import test from "node:test";
import { chatLink } from "../src/chatLinks.ts";
import { forkNotice, forkNoticeAction, forkParams, forkQueuedText, forkSheetDefaults, forkTargets, originLabel, parseThreadLink, sameForkProject, shortMachineName, threadLinkHref, looksGeneratedName, friendlyMachineName } from "../src/forkMachine.ts";

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
  assert.equal(originLabel({ origin: { machine_name: "Treshnandas-Macbook.local", kind: { kind: "fork" } } }), "From Treshnandas-Macbook");
  assert.equal(originLabel({ origin: { machine_id: "m1", machine_name: "Treshnandas-Macbook.local", kind: { kind: "fork" } } }, (id) => (id === "m1" ? "Mac" : undefined)), "From Mac");
  assert.equal(shortMachineName("srv1544252.tail1234.ts.net"), "srv1544252");
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

const id = (root) => ({ root_commit: root });
const group = (...roots) => ({ kind: "group", repos: roots.map(id) });

test("a group thread is offered only to machines whose group has exactly the same repositories", () => {
  const instances = [
    { machineId: "b", machineName: "satyamas", projectId: "g-b", online: true, project: group("w", "a") },
    { machineId: "c", machineName: "cachy", projectId: "g-c", online: true, project: group("a") },
    { machineId: "d", machineName: "vps", projectId: "g-d", online: false, project: group("a", "w", "i") },
    { machineId: "e", machineName: "nas", projectId: "s-e", online: true, project: { repos: [id("a")] } },
    { machineId: "f", machineName: "pi", projectId: "g-f", online: true, project: { kind: "group", repos: [] } },
    { machineId: "g", machineName: "lap", projectId: "g-g", online: true },
  ];
  const source = group("a", "w");
  assert.deepEqual(forkTargets(instances, { machineId: "a", project: source }).map((item) => item.machineId), ["b"], "same repositories in another order; a subset, a superset, a single repository and an unread group are not");
  // A group matches by identity key, as the merge does: a remote alone is a repository too.
  const byRemote = (...remotes) => ({ kind: "group", repos: remotes.map((remote) => ({ remote })) });
  assert.deepEqual(forkTargets([{ machineId: "b", machineName: "b", projectId: "p", online: true, project: byRemote("github.com/x/web", "github.com/x/api") }], { machineId: "a", project: byRemote("github.com/x/api", "github.com/x/web") }).length, 1);
  // A group that has not read its identities yet matches nothing, even itself.
  assert.deepEqual(forkTargets([{ machineId: "b", machineName: "b", projectId: "p", online: true, project: group() }], { machineId: "a", project: group() }), []);
  assert.equal(sameForkProject(source, group("w", "a")), true);
  assert.equal(sameForkProject(source, undefined), false);
});

test("a single repository's thread is never offered to a group, and legacy callers without projects still list every machine", () => {
  const instances = [
    { machineId: "b", machineName: "satyamas", projectId: "s-b", online: true, project: { repos: [] } },
    { machineId: "c", machineName: "cachy", projectId: "g-c", online: true, project: group("a", "w") },
    { machineId: "d", machineName: "vps", projectId: "p-d", online: true },
  ];
  assert.deepEqual(forkTargets(instances, { machineId: "a", project: { repos: [] } }).map((item) => item.machineId), ["b", "d"]);
  assert.deepEqual(forkTargets(instances, { machineId: "a" }).map((item) => item.machineId), ["c", "b", "d"]);
});

test("the sheet starts on the first target with no push to origin, and an unedited note is not sent", () => {
  const targets = forkTargets([{ machineId: "b", machineName: "satyamas", projectId: "p2", online: true }], { machineId: "a" });
  const state = forkSheetDefaults(targets, "# Hand-off\n");
  assert.deepEqual(state, { machine: "b", note: "# Hand-off\n", pushOrigin: false });
  assert.deepEqual(forkParams(THREAD, targets[0], state, "# Hand-off\n"), { thread_id: THREAD, machine: "b", project: "p2", push_origin: false });
  assert.deepEqual(forkParams(THREAD, targets[0], { note: "Edited", pushOrigin: true }, "# Hand-off\n", "supervised"), {
    thread_id: THREAD, machine: "b", project: "p2", push_origin: true, handoff_note: "Edited", permission_mode: "supervised",
  });
  assert.deepEqual(forkParams(THREAD, targets[0], state, "# Hand-off\n", null, "codex", { model: "gpt-6", effort: "high" }), {
    thread_id: THREAD, machine: "b", project: "p2", push_origin: false, provider: "codex", model: "gpt-6", effort: "high",
  });
  assert.equal(forkSheetDefaults([], "n").machine, "");
});

test("a fork to a machine that is offline says it waits", () => {
  assert.equal(forkQueuedText("satyamas", true), "Forking to satyamas…");
  assert.equal(forkQueuedText("satyamas", false), "Forking to satyamas when it is back online.");
});

test("provider-made host names are spotted, names people chose are not", () => {
  for (const name of ["srv1544252", "VM-3-60-ubuntu", "ip-10-0-0-1", "3f9a1c07", "123456", "ubuntu-s-1vcpu-nyc1-01", "vm-3-60-ubuntu.local"]) assert.equal(looksGeneratedName(name), true, name);
  for (const name of ["satyamas", "os-kdi", "Treshnandas-Macbook.local", "instabox", "treshnandavps", "deadbeef", "", null]) assert.equal(looksGeneratedName(name), false, String(name));
});

test("a generated host name gives way to Tailscale's name, a chosen name does not", () => {
  assert.equal(friendlyMachineName("srv1544252", "treshnandavps.tail1234.ts.net"), "treshnandavps");
  assert.equal(friendlyMachineName("VM-3-60-ubuntu", "tencent-box"), "tencent-box");
  // No Tailscale name, the same name, or one that is just as generated: keep the host name.
  assert.equal(friendlyMachineName("srv1544252", null), "srv1544252");
  assert.equal(friendlyMachineName("srv1544252", "srv1544252.tail1234.ts.net"), "srv1544252");
  assert.equal(friendlyMachineName("srv1544252", "vm-9-9-9"), "srv1544252");
  // The name the person set wins.
  assert.equal(friendlyMachineName("satyamas", "desktop-abc"), "satyamas");
  assert.equal(friendlyMachineName("Treshnandas-Macbook.local", "other"), "Treshnandas-Macbook");
});
