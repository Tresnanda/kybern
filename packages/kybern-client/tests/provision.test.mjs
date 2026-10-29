import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseName, defaultEnvFiles, defaultPath, displayPath, formatSize, joinPath, notYetDetail, pathAccepted, provisionAnswer,
  provisionCardInput, provisionFraction, provisionRecordText, provisionSource, provisionStatusText, provisionTargets, targetDetail,
} from "../src/provision.ts";

test("paths read the way the target spells them", () => {
  assert.equal(displayPath("/home/me/projects/kybern", "/home/me", "linux"), "~/projects/kybern");
  assert.equal(displayPath("/home/me", "/home/me/", "linux"), "~");
  assert.equal(displayPath("/home/meow/x", "/home/me", "linux"), "/home/meow/x", "a prefix that is not the folder");
  assert.equal(displayPath("D:\\code\\kybern", "C:\\Users\\Bagus", "windows"), "D:\\code\\kybern");
  assert.equal(joinPath("D:\\code\\", "kybern", "windows"), "D:\\code\\kybern");
  assert.equal(joinPath("C:\\Users\\Bagus", "kybern"), "C:\\Users\\Bagus\\kybern", "a drive path is Windows even without the OS");
  assert.equal(joinPath("/home/me/projects/", "kybern", "linux"), "/home/me/projects/kybern");
  assert.equal(baseName("D:\\code\\kybern"), "kybern");
  assert.equal(baseName("/a/b/"), "b");
});

test("the sheet starts on a usable folder and every detected env file", () => {
  const plan = { suggested_path: "/h/projects/kybern", path_check: { state: "free", path: "/h/projects/kybern", message: "" } };
  assert.equal(defaultPath(plan), "/h/projects/kybern");
  assert.equal(defaultPath({ suggested_path: "/h/p/kybern-2", path_check: { state: "not_empty", path: "/h/x", message: "" } }), "/h/p/kybern-2");
  assert.equal(defaultPath({ suggested_path: null, path_check: { state: "unknown", path: "", message: "" } }), "");
  assert.ok(pathAccepted({ state: "same_repo" }) && pathAccepted({ state: "unknown" }) && !pathAccepted({ state: "not_empty" }) && !pathAccepted({ state: "forbidden" }));
  assert.deepEqual(defaultEnvFiles([{ path: ".env", size: 1, selected: true }, { path: "x/.env", size: 1, selected: false }]), [".env"]);
  assert.deepEqual(provisionAnswer("/p", [".env"]), { decision: "submit", response: { path: "/p", env_files: [".env"] } });
  assert.equal(formatSize(812), "812 B");
  assert.equal(formatSize(4200), "4.2 KB");
  assert.equal(formatSize(52_400_000), "52.4 MB");
});

test("any machine can send and any other can take it", () => {
  const members = [
    { machineId: "mac", machineName: "MacBook", online: true },
    { machineId: "win", machineName: "Windows PC", online: true },
    { machineId: "vps", machineName: "VPS", online: false },
    { machineId: "kdi", machineName: "os-kdi", online: true },
    { machineId: "old", machineName: "Old", online: true, member: false },
  ];
  const targets = provisionTargets(members, new Set(["win", "kdi"]), "win");
  assert.deepEqual(targets.map((t) => [t.machineId, t.has]), [["mac", false], ["vps", false], ["kdi", true]]);
  assert.equal(targetDetail(targets[2], "kybern"), "Already has kybern");
  assert.equal(targetDetail(targets[1], "kybern"), "Offline · sends when it returns");
  assert.equal(provisionSource([{ machineId: "win", online: true }, { machineId: "mac", online: true }], "mac"), "mac", "the one asked for");
  assert.equal(provisionSource([{ machineId: "win", online: false }, { machineId: "mac", online: true }], "win"), "mac", "an online one when it is offline");
  assert.equal(provisionSource([{ machineId: "win", online: false }], "win"), null);
  assert.equal(notYetDetail("os-kdi", "~/projects/kybern"), "Not on os-kdi yet · will be added to ~/projects/kybern");
});

test("progress and records read as sentences", () => {
  const base = { target_name: "os-kdi", detail: "Sending the repository to os-kdi", bytes_sent: 2_000_000, bytes_total: 8_000_000 };
  assert.equal(provisionStatusText({ ...base, phase: "sending" }), "Sending the repository to os-kdi · 2.0 MB of 8.0 MB");
  assert.equal(provisionFraction({ ...base, phase: "sending" }), 0.25);
  assert.equal(provisionFraction({ ...base, phase: "cloning" }), null);
  assert.equal(provisionStatusText({ ...base, phase: "done", result: { env_written: [".env", "a/.env"] } }), "Added to os-kdi · 2 env files copied");
  assert.equal(provisionStatusText({ ...base, phase: "failed", error: "D:\\x already holds other files." }), "D:\\x already holds other files.");
  const approval = { tool_name: "kybern_project_provision", input: { operation_id: "o", then: "delegate", plan: { project_name: "kybern", target: { id: "k", name: "os-kdi", os: "linux", online: true }, target_home: "/home/u", env_files: [] } } };
  const input = provisionCardInput(approval);
  assert.ok(input);
  assert.equal(provisionCardInput({ tool_name: "Bash", input: {} }), null);
  assert.equal(provisionRecordText(input, null), "Waiting to add kybern to os-kdi");
  assert.equal(provisionRecordText(input, { decision: "submit", response: { path: "/home/u/projects/kybern" } }), "Adding kybern to os-kdi · ~/projects/kybern");
  assert.equal(provisionRecordText(input, { decision: "deny" }), "Did not add kybern to os-kdi");
});
