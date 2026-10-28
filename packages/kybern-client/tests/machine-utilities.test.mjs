import assert from "node:assert/strict";
import test from "node:test";
import { destLabel, formatBytes, portLabel, receivedNotice, relayedPreviewPath, sendStatus, sendTargets, sendTooLarge } from "../src/machineUtilities.ts";

test("bytes read the way a file manager says them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(2048), "2 KiB");
  assert.equal(formatBytes(5 * 1024 * 1024 + 300_000), "5.3 MiB");
  assert.equal(formatBytes(2 * 1024 ** 3), "2.0 GiB");
  assert.equal(sendTooLarge(2 * 1024 ** 3), false);
  assert.equal(sendTooLarge(2 * 1024 ** 3 + 1), true);
});

test("a file can be sent to every other machine that is not paused or unpaired", () => {
  const machines = [
    { machineId: "a", name: "Mac", status: "online", isLocal: true },
    { machineId: "b", name: "satyamas", status: "online", isLocal: false },
    { machineId: "c", name: "vps", status: "offline", isLocal: false },
    { machineId: "d", name: "old laptop", status: "paused", isLocal: false },
    { machineId: "e", name: "phone", status: "unpaired", isLocal: false },
    { machineId: "f", name: "via relay", status: "relaying", isLocal: false },
  ];
  const targets = sendTargets(machines);
  assert.deepEqual(targets.map((t) => [t.machineId, t.online]), [["b", true], ["c", false], ["f", true]]);
  assert.equal(targets[1].detail, "Offline · sends when it returns");
});

test("a send reads as waiting, sending with progress, sent, or failed", () => {
  const item = (state, extra = {}) => ({ state, last_error: null, result: null, ...extra });
  assert.deepEqual(sendStatus(item("queued"), "satyamas"), { phase: "waiting", text: "Waiting for satyamas" });
  assert.equal(sendStatus(item("queued", { last_error: "satyamas is offline" }), "satyamas").text, "Waiting for satyamas · satyamas is offline");
  const sending = sendStatus(item("sending"), "satyamas", { item_id: "x", sent: 1048576, total: 4194304 });
  assert.equal(sending.fraction, 0.25);
  assert.equal(sending.text, "Sending to satyamas · 1.0 MiB of 4.0 MiB");
  assert.equal(sendStatus(item("sending"), "satyamas").fraction, undefined);
  assert.equal(sendStatus(item("delivered", { result: { dest_path: "/home/u/Downloads/Kybern/Mac/a.txt" } }), "satyamas").text, "Sent to satyamas · /home/u/Downloads/Kybern/Mac/a.txt");
  assert.equal(sendStatus(item("failed", { last_error: "satyamas does not let this machine send it files." }), "satyamas").phase, "failed");
  assert.equal(sendStatus(item("expired"), "satyamas").text, "Could not send to satyamas");
});

test("the destination and the received notice name the machine and the path", () => {
  assert.equal(destLabel(null, "satyamas"), "satyamas · Downloads/Kybern");
  assert.equal(destLabel({ kind: "project", project: "kybern", subdir: "assets" }, "satyamas"), "satyamas · kybern/assets");
  assert.equal(destLabel({ kind: "project", project: "kybern" }, "satyamas"), "satyamas · kybern");
  const one = receivedNotice({ transfer_id: "t", from_machine: "m", from_name: "Mac", name: "a.txt", files: 1, bytes: 2048, dest_path: "/d/a.txt", at: "" });
  assert.deepEqual(one, { title: "a.txt from Mac", description: "2 KiB · /d/a.txt", path: "/d/a.txt" });
  assert.equal(receivedNotice({ transfer_id: "t", from_machine: "m", from_name: "Mac", name: "app", files: 3, bytes: 10, dest_path: "/d/app", at: "" }).title, "app (3 files) from Mac");
});

test("a forward and a relayed preview path read plainly and refuse odd segments", () => {
  assert.equal(portLabel({ machine_name: "satyamas", remote_port: 5173, local_port: 40123, connections: 0 }), "satyamas:5173 → localhost:40123");
  assert.equal(portLabel({ machine_name: "satyamas", remote_port: 5173, local_port: 40123, connections: 2 }), "satyamas:5173 → localhost:40123 · 2 open");
  assert.equal(relayedPreviewPath("0192-abc", "tkt_1-2"), "/relay/0192-abc/http/preview-proxy/tkt_1-2/");
  assert.equal(relayedPreviewPath("../x", "t"), null);
  assert.equal(relayedPreviewPath("m", "a/b"), null);
});

test("a send's toast follows its phase", async () => {
  const { sendToastShape, sendFinished } = await import("../src/machineUtilities.ts");
  const sending = sendStatus({ state: "sending", last_error: null, result: null }, "vps", { item_id: "i", sent: 1, total: 4 });
  assert.deepEqual(sendToastShape(sending), { kind: "info", progress: 0.25, duration: Number.POSITIVE_INFINITY });
  assert.equal(sendFinished(sending), false);
  const sent = sendStatus({ state: "delivered", last_error: null, result: null }, "vps");
  assert.equal(sendToastShape(sent).kind, "success");
  assert.equal(sendFinished(sent), true);
  assert.equal(sendToastShape(sendStatus({ state: "queued", last_error: null, result: null }, "vps")).kind, "info");
  assert.equal(sendToastShape(sendStatus({ state: "failed", last_error: "No space", result: null }, "vps")).kind, "error");
});

test("terminals open on reachable machines other than the thread's own", async () => {
  const { terminalMachines, terminalTooltip } = await import("../src/machineUtilities.ts");
  const machines = [
    { machineId: "a", name: "Mac", status: "online" },
    { machineId: "b", name: "vps", status: "relaying" },
    { machineId: "c", name: "pc", status: "offline" },
    { machineId: "d", name: "old", status: "paused" },
  ];
  assert.deepEqual(terminalMachines(machines, "a"), [{ machineId: "b", name: "vps" }]);
  assert.deepEqual(terminalMachines(machines, "b").map((m) => m.machineId), ["a"]);
  assert.equal(terminalTooltip("vps"), "Terminal on vps");
  assert.equal(terminalTooltip("vps", "api"), "api · on vps");
});

test("the clipboard goes to and from machines that answer", async () => {
  const { clipboardSources, clipboardTooLarge, clipboardSentNotice } = await import("../src/machineUtilities.ts");
  const machines = [
    { machineId: "a", name: "Mac", status: "online", isLocal: true },
    { machineId: "b", name: "vps", status: "relaying", isLocal: false },
    { machineId: "c", name: "pc", status: "offline", isLocal: false },
  ];
  assert.deepEqual(clipboardSources(machines).map((m) => m.machineId), ["b"]);
  assert.equal(clipboardTooLarge("a".repeat(1024 * 1024)), false);
  assert.equal(clipboardTooLarge("a".repeat(1024 * 1024 + 1)), true);
  // Multi-byte text is counted in bytes, not characters.
  assert.equal(clipboardTooLarge("é".repeat(600 * 1024)), true);
  assert.equal(clipboardSentNotice("vps", { stored: "system", bytes: 2048 }).description, "2 KiB");
  assert.match(clipboardSentNotice("vps", { stored: "buffer", bytes: 5 }).description, /10 minutes/);
});
