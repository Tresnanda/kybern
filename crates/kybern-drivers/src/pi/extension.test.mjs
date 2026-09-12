// Dependency-free tests for the bundled extension and its fake Pi API.
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const extensionPath = process.argv.at(-1);
const { default: loadExtension } = await import(pathToFileURL(extensionPath));

function fakePi(initialMode = "supervised") {
  process.env.KYBERN_PI_PERMISSION_MODE = initialMode;
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  loadExtension(pi);
  return { commands, tools, handlers };
}

function context(select) {
  return {
    mode: "rpc",
    hasUI: true,
    signal: new AbortController().signal,
    ui: {
      select,
      input: async () => undefined,
    },
  };
}

test("registers the handshake, mode control, and thread-scoped tools", () => {
  const harness = fakePi();
  assert.equal(harness.commands.get("kybern-extension").description, "Kybern extension protocol 1");
  assert.ok(harness.commands.has("kybern-permission-mode"));
  assert.deepEqual([...harness.tools.keys()], [
    "kybern_thread_context",
    "kybern_workspace_diff",
    "kybern_read_file",
    "kybern_list_files",
    "kybern_runtime_tasks",
    "kybern_list_terminals",
    "kybern_read_terminal",
  ]);
});

test("supervised gates shell and remembers only an exact always grant", async () => {
  const harness = fakePi("supervised");
  let prompts = 0;
  const ctx = context(async () => {
    prompts += 1;
    return "Always allow this exact call";
  });
  const toolCall = harness.handlers.get("tool_call");

  assert.equal(await toolCall({ toolName: "read", toolCallId: "r1", input: { path: "a" } }, ctx), undefined);
  assert.equal(await toolCall({ toolName: "bash", toolCallId: "b1", input: { command: "pwd" } }, ctx), undefined);
  assert.equal(await toolCall({ toolName: "bash", toolCallId: "b2", input: { command: "pwd" } }, ctx), undefined);
  assert.equal(prompts, 1);
  assert.equal(await toolCall({ toolName: "bash", toolCallId: "b3", input: { command: "ls" } }, ctx), undefined);
  assert.equal(prompts, 2);
});

test("mode changes clear exact grants and accept edits without prompting", async () => {
  const harness = fakePi("supervised");
  let prompts = 0;
  const ctx = context(async () => {
    prompts += 1;
    return "Always allow this exact call";
  });
  const toolCall = harness.handlers.get("tool_call");
  await toolCall({ toolName: "bash", toolCallId: "b1", input: { command: "pwd" } }, ctx);
  await harness.commands.get("kybern-permission-mode").handler("accept_edits", ctx);
  assert.equal(await toolCall({ toolName: "write", toolCallId: "w1", input: { path: "a", content: "x" } }, ctx), undefined);
  await toolCall({ toolName: "bash", toolCallId: "b2", input: { command: "pwd" } }, ctx);
  assert.equal(prompts, 2);
});

test("an approval from an older mode cannot restore a cleared grant", async () => {
  const harness = fakePi("supervised");
  let resolveApproval;
  const pendingChoice = new Promise((resolve) => {
    resolveApproval = resolve;
  });
  const toolCall = harness.handlers.get("tool_call");
  const pending = toolCall(
    { toolName: "bash", toolCallId: "b1", input: { command: "pwd" } },
    context(async () => pendingChoice),
  );
  await harness.commands.get("kybern-permission-mode").handler("full_access");
  await harness.commands.get("kybern-permission-mode").handler("supervised");
  resolveApproval("Always allow this exact call");
  assert.deepEqual(await pending, {
    block: true,
    reason: "Kybern permission mode changed while approval was pending.",
  });

  let prompted = false;
  await toolCall(
    { toolName: "bash", toolCallId: "b2", input: { command: "pwd" } },
    context(async () => {
      prompted = true;
      return "Deny";
    }),
  );
  assert.equal(prompted, true);
});

test("exact-call grant cache stays bounded", async () => {
  const harness = fakePi("supervised");
  let prompts = 0;
  const ctx = context(async () => {
    prompts += 1;
    return "Always allow this exact call";
  });
  const toolCall = harness.handlers.get("tool_call");
  for (let index = 0; index < 257; index += 1) {
    await toolCall({ toolName: "bash", toolCallId: `b${index}`, input: { command: `echo ${index}` } }, ctx);
  }
  await toolCall({ toolName: "bash", toolCallId: "again", input: { command: "echo 0" } }, ctx);
  assert.equal(prompts, 258);
});

test("denial and cancellation block the tool", async () => {
  const harness = fakePi("supervised");
  const toolCall = harness.handlers.get("tool_call");
  const denied = await toolCall(
    { toolName: "bash", toolCallId: "b1", input: { command: "rm file" } },
    context(async () => "Deny"),
  );
  assert.equal(denied.block, true);
  const cancelled = await toolCall(
    { toolName: "custom", toolCallId: "c1", input: {} },
    context(async () => undefined),
  );
  assert.equal(cancelled.block, true);
});

test("approval bridge failures block the tool", async () => {
  const harness = fakePi("supervised");
  const result = await harness.handlers.get("tool_call")(
    { toolName: "bash", toolCallId: "b1", input: { command: "pwd" } },
    context(async () => {
      throw new Error("bridge closed");
    }),
  );
  assert.deepEqual(result, { block: true, reason: "Kybern could not complete the permission check." });
});

test("app tools use the native UI bridge and decode success", async () => {
  const harness = fakePi("supervised");
  let title;
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      input: async (nextTitle) => {
        title = nextTitle;
        return Buffer.from(JSON.stringify({ version: 1, success: true, data: { text: "ok" } })).toString("base64url");
      },
    },
  };
  const result = await harness.tools.get("kybern_read_file").execute(
    "tool-1",
    { path: "README.md" },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.match(title, /^kybern_app_tool_request:/);
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { text: "ok" });
});

test("app tool failures and missing RPC UI fail closed", async () => {
  const harness = fakePi("full_access");
  const tool = harness.tools.get("kybern_thread_context");
  await assert.rejects(
    tool.execute("tool-1", {}, undefined, undefined, { mode: "print", hasUI: false, ui: {} }),
    /require a Kybern RPC session/,
  );
  await assert.rejects(
    tool.execute("tool-2", {}, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
      ui: {
        input: async () =>
          Buffer.from(JSON.stringify({ version: 1, success: false, error: "stale turn" })).toString("base64url"),
      },
    }),
    /stale turn/,
  );
});

const validationModule = process.env.KYBERN_PI_VALIDATION_MODULE;
if (validationModule) {
  test("plain schemas pass Pi's real tool argument validator", async () => {
    const { validateToolArguments } = await import(pathToFileURL(validationModule));
    const harness = fakePi("supervised");
    const samples = {
      kybern_thread_context: {},
      kybern_workspace_diff: { turn_id: "turn-1", path: "src", include_patch: true },
      kybern_read_file: { path: "README.md", max_bytes: 4096 },
      kybern_list_files: { path: "src" },
      kybern_runtime_tasks: {},
      kybern_list_terminals: {},
      kybern_read_terminal: { terminal_id: "terminal-1", max_bytes: 4096 },
    };
    for (const [name, args] of Object.entries(samples)) {
      const tool = harness.tools.get(name);
      assert.deepEqual(validateToolArguments(tool, { name, arguments: args }), args);
    }
    assert.throws(
      () =>
        validateToolArguments(harness.tools.get("kybern_read_file"), {
          name: "kybern_read_file",
          arguments: { path: "README.md", unexpected: true },
        }),
      /Validation failed/,
    );
  });
}
