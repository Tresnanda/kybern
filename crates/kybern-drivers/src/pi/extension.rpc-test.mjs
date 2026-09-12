import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2] ?? "0.80.5";
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Pi version: ${version}`);

const fixture = fileURLToPath(new URL("./extension.rpc-test.ts", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `kybern-pi-extension-${version}-`));
const project = join(scratch, "project");
await mkdir(project);

let stderr = "";
const child = spawn(
  "npx",
  [
    "--yes",
    "--package",
    `@earendil-works/pi-coding-agent@${version}`,
    "pi",
    "--mode",
    "rpc",
    "--approve",
    "--session-id",
    "44444444-4444-4444-8444-444444444444",
    "--extension",
    fixture,
  ],
  {
    cwd: project,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(scratch, "agent"),
      KYBERN_PI_PERMISSION_MODE: "supervised",
    },
  },
);

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-16 * 1024);
});

const queued = [];
const waiting = [];
let stdoutBuffer = "";

function deliver(frame) {
  const index = waiting.findIndex(({ predicate }) => predicate(frame));
  if (index === -1) queued.push(frame);
  else waiting.splice(index, 1)[0].resolve(frame);
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  while (true) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline === -1) break;
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (line) deliver(JSON.parse(line));
  }
});

function waitFor(predicate, label, timeoutMs = 180_000) {
  const queuedIndex = queued.findIndex(predicate);
  if (queuedIndex !== -1) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve: (frame) => {
        clearTimeout(timer);
        resolve(frame);
      },
      reject,
    };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(waiter);
      if (index !== -1) waiting.splice(index, 1);
      reject(new Error(`Timed out waiting for ${label}\n${stderr}`));
    }, timeoutMs);
    waiting.push(waiter);
  });
}

function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function decode(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function notification(frame, kind) {
  if (frame.type !== "extension_ui_request" || frame.method !== "notify") return false;
  if (!frame.message?.startsWith("kybern_rpc_test_result:")) return false;
  return decode(frame.message.slice("kybern_rpc_test_result:".length)).kind === kind;
}

async function closeChild() {
  if (child.exitCode !== null) return;
  child.stdin.end();
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);
  await exited;
  clearTimeout(timer);
}

try {
  send({ id: "commands", type: "get_commands" });
  const commands = await waitFor((frame) => frame.type === "response" && frame.id === "commands", "command catalog");
  assert.equal(commands.success, true);
  assert.ok(commands.data.commands.some((command) => command.name === "kybern-extension"));

  send({ id: "app", type: "prompt", message: "/kybern-test-app-tool" });
  const appRequest = await waitFor(
    (frame) => frame.type === "extension_ui_request" && frame.method === "input" && frame.title?.startsWith("kybern_app_tool_request:"),
    "app tool input request",
  );
  const appEnvelope = decode(appRequest.title.slice("kybern_app_tool_request:".length));
  assert.equal(appEnvelope.name, "kybern_thread_context");
  assert.equal(appEnvelope.toolCallId, "rpc-test-app");
  send({
    type: "extension_ui_response",
    id: appRequest.id,
    value: Buffer.from(JSON.stringify({ version: 1, success: true, data: { thread: { id: "thread-1" } } })).toString("base64url"),
  });
  const appNotice = await waitFor((frame) => notification(frame, "app"), "app tool result");
  const appResult = decode(appNotice.message.slice("kybern_rpc_test_result:".length));
  assert.equal(appResult.ok, true);
  assert.deepEqual(JSON.parse(appResult.result.content[0].text), { thread: { id: "thread-1" } });
  assert.equal((await waitFor((frame) => frame.type === "response" && frame.id === "app", "app command response")).success, true);

  send({ id: "permission", type: "prompt", message: "/kybern-test-permission" });
  const permissionRequest = await waitFor(
    (frame) => frame.type === "extension_ui_request" && frame.method === "select" && frame.title?.startsWith("kybern_permission_request:"),
    "permission selection",
  );
  assert.deepEqual(permissionRequest.options, ["Allow once", "Always allow this exact call", "Deny"]);

  // Change mode while the old approval is unresolved. Its later answer must
  // not restore a grant after the mode command clears the cache.
  send({ id: "mode", type: "prompt", message: "/kybern-permission-mode full_access" });
  assert.equal((await waitFor((frame) => frame.type === "response" && frame.id === "mode", "mode command response")).success, true);
  send({ type: "extension_ui_response", id: permissionRequest.id, value: "Always allow this exact call" });
  const permissionNotice = await waitFor((frame) => notification(frame, "permission"), "stale permission result");
  const permissionResult = decode(permissionNotice.message.slice("kybern_rpc_test_result:".length));
  assert.deepEqual(permissionResult.result, {
    block: true,
    reason: "Kybern permission mode changed while approval was pending.",
  });
  assert.equal(
    (await waitFor((frame) => frame.type === "response" && frame.id === "permission", "permission command response")).success,
    true,
  );

  // Full access now bypasses the selection and completes synchronously.
  send({ id: "full-access", type: "prompt", message: "/kybern-test-permission" });
  const fullAccessNotice = await waitFor(
    (frame) => notification(frame, "permission") || (frame.type === "extension_ui_request" && frame.method === "select"),
    "full-access permission result",
  );
  assert.equal(fullAccessNotice.method, "notify", "Full access unexpectedly requested approval");
  const fullAccessResult = decode(fullAccessNotice.message.slice("kybern_rpc_test_result:".length));
  assert.equal(fullAccessResult.result, null);
  assert.equal(
    (await waitFor((frame) => frame.type === "response" && frame.id === "full-access", "full-access command response")).success,
    true,
  );

  console.log(`Pi ${version} Kybern extension RPC roundtrip passed`);
} finally {
  await closeChild();
  await rm(scratch, { recursive: true, force: true });
}
