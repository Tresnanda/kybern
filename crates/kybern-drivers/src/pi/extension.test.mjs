// Dependency-free tests for the bundled extension and its fake Pi API.
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const extensionPath = process.argv.at(-1);
const { default: loadExtension } = await import(pathToFileURL(extensionPath));

function fakePi(initialMode = "supervised", configuredTools, policy = {}) {
  process.env.KYBERN_PI_PERMISSION_MODE = initialMode;
  if (configuredTools) process.env.KYBERN_PI_APP_TOOLS = JSON.stringify(configuredTools);
  else delete process.env.KYBERN_PI_APP_TOOLS;
  if (policy.systemPrompt) process.env.KYBERN_PI_SYSTEM_PROMPT = policy.systemPrompt;
  else delete process.env.KYBERN_PI_SYSTEM_PROMPT;
  if (policy.coordinatorOnly) process.env.KYBERN_PI_COORDINATOR_ONLY = "1";
  else delete process.env.KYBERN_PI_COORDINATOR_ONLY;
  if (policy.deniedTools) process.env.KYBERN_PI_DENIED_TOOLS = JSON.stringify(policy.deniedTools);
  else delete process.env.KYBERN_PI_DENIED_TOOLS;
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

test("computer_use is accepted from the configured native bridge", () => {
  const harness = fakePi("supervised", [
    {
      name: "computer_use",
      description: "Drive the desktop.",
      parameters: { type: "object", properties: { action: { type: "string" } }, additionalProperties: false },
    },
  ]);
  assert.ok(harness.tools.has("computer_use"));
});

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

test("native collaboration tools are exposed only for a configured bridge", () => {
  const definitions = [
    {
      name: "kybern_threads_search",
      description: "Find persisted threads.",
      parameters: { type: "object", properties: { query: { type: ["string", "null"] } }, additionalProperties: false },
    },
    {
      name: "kybern_thread_read",
      description: "Read a persisted thread.",
      parameters: {
        type: "object",
        properties: { thread_id: { type: "string", format: "uuid" } },
        required: ["thread_id"],
        additionalProperties: false,
      },
    },
    {
      name: "kybern_thread_send",
      description: "Send a durable message.",
      parameters: {
        type: "object",
        properties: { thread_id: { type: "string" }, message: { type: "string", minLength: 1 } },
        required: ["thread_id", "message"],
        additionalProperties: false,
      },
    },
    {
      name: "kybern_collaboration_spawn",
      description: "Delegate bounded work.",
      parameters: {
        type: "object",
        properties: { assignment: { type: "string", minLength: 1 }, provider: { enum: ["pi", "omp"] } },
        required: ["assignment"],
        additionalProperties: false,
      },
    },
  ];
  const harness = fakePi("supervised", definitions);
  assert.deepEqual([...harness.tools.keys()], definitions.map((tool) => tool.name));
  for (const definition of definitions) {
    const registered = harness.tools.get(definition.name);
    assert.equal(registered.description, definition.description);
    assert.deepEqual(registered.parameters, definition.parameters);
  }
});

test("configured bridge rejects names that the daemon bridge cannot serve", () => {
  const harness = fakePi("supervised", [
    { name: "third_party_tool", description: "Unsafe", parameters: { type: "object" } },
    { name: "kybern_thread_read", description: "Read", parameters: { type: "object" } },
  ]);
  assert.deepEqual([...harness.tools.keys()], ["kybern_thread_read"]);
});

test("ordinary tool registration does not install coordinator guidance", async () => {
  const withoutBridge = fakePi();
  const hook = withoutBridge.handlers.get("before_agent_start");
  assert.equal(typeof hook, "function");
  assert.equal(await hook({ systemPrompt: "native" }), undefined);
});

test("coordinator system prefix stays stable while its history marker is added once", async () => {
  const withBridge = fakePi("supervised", [], { systemPrompt: "Use kybern_thread_send for durable routing." });
  const hook = withBridge.handlers.get("before_agent_start");
  assert.deepEqual(await hook({ systemPrompt: "native" }), {
    message: {
      customType: "kybern-coordinator-bootstrap-v1",
      content: "Use kybern_thread_send for durable routing.",
      display: false,
    },
    systemPrompt: "native\n\nUse kybern_thread_send for durable routing.",
  });
  assert.deepEqual(await hook({ systemPrompt: "native" }), {
    systemPrompt: "native\n\nUse kybern_thread_send for durable routing.",
  });
});

test("saved coordinator sessions backfill only when the durable marker is absent", async () => {
  const oldCoordinator = fakePi("supervised", [], { systemPrompt: "Coordinator role." });
  await oldCoordinator.handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
  assert.equal((await oldCoordinator.handlers.get("before_agent_start")({ systemPrompt: "native" })).message.customType, "kybern-coordinator-bootstrap-v1");

  const bootstrappedCoordinator = fakePi("supervised", [], { systemPrompt: "Coordinator role." });
  await bootstrappedCoordinator.handlers.get("session_start")({}, {
    sessionManager: {
      getBranch: () => [{ type: "custom_message", customType: "kybern-coordinator-bootstrap-v1", content: "Coordinator role." }],
    },
  });
  assert.deepEqual(await bootstrappedCoordinator.handlers.get("before_agent_start")({ systemPrompt: "native" }), {
    systemPrompt: "native\n\nCoordinator role.",
  });
  await bootstrappedCoordinator.handlers.get("session_tree")({}, {
    sessionManager: {
      getBranch: () => [{ type: "custom_message", customType: "kybern-coordinator-bootstrap-v1", content: "stale role" }],
    },
  });
  assert.equal((await bootstrappedCoordinator.handlers.get("before_agent_start")({ systemPrompt: "native" })).message.content, "Coordinator role.");
});

test("routing guidance does not change supervised tool permissions", async () => {
  const harness = fakePi("supervised", [], { systemPrompt: "Kybern routing guidance." });
  let prompts = 0;
  const result = await harness.handlers.get("tool_call")(
    { toolName: "bash", toolCallId: "bash-1", input: { command: "pwd" } },
    context(async () => {
      prompts += 1;
      return "Deny";
    }),
  );
  assert.equal(prompts, 1);
  assert.equal(result.block, true);
});

test("coordinator policy blocks third-party extension tools", async () => {
  const harness = fakePi(
    "full_access",
    [{ name: "kybern_collaboration_read", description: "Read", parameters: { type: "object" } }],
    { coordinatorOnly: true },
  );
  const blocked = await harness.handlers.get("tool_call")(
    { toolName: "third_party_extension", toolCallId: "extension-1", input: {} },
    context(async () => "Deny"),
  );
  assert.deepEqual(blocked, { block: true, reason: "Kybern coordinator policy permits only collaboration tools." });
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
