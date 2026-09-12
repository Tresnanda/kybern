// Bundled Kybern extension for Pi RPC sessions.
//
// Keep this file dependency-free: the driver stages it in a private temporary
// directory, so package-relative imports would not resolve reliably.

const PROTOCOL_VERSION = 1;
const COMMAND_SENTINEL = "kybern-extension";
const MODE_COMMAND = "kybern-permission-mode";
const PERMISSION_PREFIX = "kybern_permission_request:";
const APP_TOOL_PREFIX = "kybern_app_tool_request:";
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
const APP_TOOL_TIMEOUT_MS = 30 * 1000;
const MAX_EXACT_CALL_GRANTS = 256;
const MAX_APP_ARGUMENT_BYTES = 64 * 1024;
const MAX_PERMISSION_INPUT_BYTES = 192 * 1024;

const ALLOW_ONCE = "Allow once";
const ALLOW_ALWAYS = "Always allow this exact call";
const DENY = "Deny";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
const APP_TOOL_NAMES = new Set([
  "kybern_thread_context",
  "kybern_workspace_diff",
  "kybern_read_file",
  "kybern_list_files",
  "kybern_runtime_tasks",
  "kybern_list_terminals",
  "kybern_read_terminal",
]);

function normalizeMode(value) {
  switch (String(value || "").trim().toLowerCase().replaceAll("-", "_")) {
    case "supervised":
      return "supervised";
    case "accept_edits":
      return "accept_edits";
    case "full_access":
      return "full_access";
    default:
      // Unknown or missing configuration must never widen permissions.
      return "supervised";
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function exactCallKey(toolName, input) {
  return JSON.stringify([toolName, canonicalize(input)]);
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function isAllowedWithoutPrompt(mode, toolName) {
  if (mode === "full_access") return true;
  if (APP_TOOL_NAMES.has(toolName) || READ_ONLY_TOOLS.has(toolName)) return true;
  return mode === "accept_edits" && EDIT_TOOLS.has(toolName);
}

function humanSummary(toolName, input) {
  const detail =
    typeof input?.command === "string"
      ? input.command
      : typeof input?.path === "string"
        ? input.path
        : JSON.stringify(input);
  const clipped = String(detail || "").slice(0, 240);
  return clipped ? `${toolName}: ${clipped}` : toolName;
}

const emptyObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const optionalPath = {
  type: "object",
  properties: { path: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const appTools = [
  {
    name: "kybern_thread_context",
    label: "Kybern thread context",
    description: "Read the current Kybern thread, project, and thread notes.",
    parameters: emptyObject,
  },
  {
    name: "kybern_workspace_diff",
    label: "Kybern workspace diff",
    description: "Read the bounded diff for the current Kybern thread or one of its turns.",
    parameters: {
      type: "object",
      properties: {
        turn_id: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
        include_patch: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "kybern_read_file",
    label: "Kybern read file",
    description: "Read a bounded file inside the current Kybern workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        max_bytes: { type: "integer", minimum: 1, maximum: 131072 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "kybern_list_files",
    label: "Kybern list files",
    description: "List one directory level inside the current Kybern workspace.",
    parameters: optionalPath,
  },
  {
    name: "kybern_runtime_tasks",
    label: "Kybern runtime tasks",
    description: "List runtime tasks owned by the current Kybern thread.",
    parameters: emptyObject,
  },
  {
    name: "kybern_list_terminals",
    label: "Kybern list terminals",
    description: "List terminals owned by the current Kybern thread.",
    parameters: emptyObject,
  },
  {
    name: "kybern_read_terminal",
    label: "Kybern read terminal",
    description: "Read bounded scrollback from a terminal owned by the current Kybern thread.",
    parameters: {
      type: "object",
      properties: {
        terminal_id: { type: "string", minLength: 1 },
        max_bytes: { type: "integer", minimum: 1, maximum: 65536 },
      },
      required: ["terminal_id"],
      additionalProperties: false,
    },
  },
];

async function executeAppTool(name, toolCallId, args, signal, ctx) {
  if (signal?.aborted) throw new Error("Kybern app tool was cancelled.");
  if (ctx.mode !== "rpc" || !ctx.hasUI) {
    throw new Error("Kybern app tools require a Kybern RPC session.");
  }

  const id = requestId();
  const encodedArguments = JSON.stringify(args);
  if (Buffer.byteLength(encodedArguments, "utf8") > MAX_APP_ARGUMENT_BYTES) {
    throw new Error("Kybern app tool arguments are too large.");
  }
  const title =
    APP_TOOL_PREFIX +
    encode({
      version: PROTOCOL_VERSION,
      id,
      name,
      arguments: args,
      toolCallId,
    });

  const encodedResult = await ctx.ui.input(title, "Kybern app tool bridge", {
    signal,
    timeout: APP_TOOL_TIMEOUT_MS,
  });
  if (encodedResult === undefined) {
    throw new Error(signal?.aborted ? "Kybern app tool was cancelled." : "Kybern app tool timed out.");
  }

  try {
    const result = decode(encodedResult);
    if (!result || result.version !== PROTOCOL_VERSION || typeof result.success !== "boolean") {
      throw new Error("Kybern returned an invalid app tool response.");
    }
    if (!result.success) {
      throw new Error(typeof result.error === "string" && result.error ? result.error : "Kybern app tool failed.");
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.data ?? null, null, 2) }],
      details: { requestId: id, source: "kybern" },
    };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Kybern returned an invalid app tool response.");
  }
}

export default function kybernExtension(pi) {
  let mode = normalizeMode(process.env.KYBERN_PI_PERMISSION_MODE);
  let modeRevision = 0;
  const exactCallGrants = new Set();

  pi.registerCommand(COMMAND_SENTINEL, {
    description: `Kybern extension protocol ${PROTOCOL_VERSION}`,
    handler: async () => {},
  });

  pi.registerCommand(MODE_COMMAND, {
    description: "Set Kybern's internal Pi permission mode.",
    handler: async (args) => {
      const normalized = String(args || "").trim().toLowerCase().replaceAll("-", "_");
      if (!["supervised", "accept_edits", "full_access"].includes(normalized)) {
        throw new Error("Expected supervised, accept_edits, or full_access");
      }
      mode = normalized;
      modeRevision += 1;
      exactCallGrants.clear();
    },
  });

  for (const tool of appTools) {
    pi.registerTool({
      ...tool,
      executionMode: "parallel",
      async execute(toolCallId, args, signal, _onUpdate, ctx) {
        return executeAppTool(tool.name, toolCallId, args, signal, ctx);
      },
    });
  }

  pi.on("tool_call", async (event, ctx) => {
    try {
      const toolName = String(event.toolName || "");
      const input = event.input && typeof event.input === "object" ? event.input : {};
      if (isAllowedWithoutPrompt(mode, toolName)) return;

      const serializedInput = JSON.stringify(input);
      if (
        !toolName ||
        toolName.length > 128 ||
        typeof event.toolCallId !== "string" ||
        !event.toolCallId ||
        event.toolCallId.length > 128 ||
        Buffer.byteLength(serializedInput, "utf8") > MAX_PERMISSION_INPUT_BYTES
      ) {
        return { block: true, reason: "Kybern could not safely encode this permission request." };
      }

      const callKey = exactCallKey(toolName, input);
      if (exactCallGrants.has(callKey)) return;
      if (ctx.mode !== "rpc" || !ctx.hasUI) {
        return { block: true, reason: "Kybern approval is unavailable." };
      }

      const id = requestId();
      const approvalRevision = modeRevision;
      const title =
        PERMISSION_PREFIX +
        encode({
          version: PROTOCOL_VERSION,
          requestId: id,
          toolCallId: event.toolCallId,
          toolName,
          input,
        });
      const choice = await ctx.ui.select(title, [ALLOW_ONCE, ALLOW_ALWAYS, DENY], {
        signal: ctx.signal,
        timeout: PERMISSION_TIMEOUT_MS,
      });

      if (approvalRevision !== modeRevision) {
        return { block: true, reason: "Kybern permission mode changed while approval was pending." };
      }

      if (choice === ALLOW_ALWAYS) {
        if (exactCallGrants.size >= MAX_EXACT_CALL_GRANTS) {
          const oldest = exactCallGrants.values().next().value;
          if (oldest !== undefined) exactCallGrants.delete(oldest);
        }
        exactCallGrants.add(callKey);
        return;
      }
      if (choice === ALLOW_ONCE) return;
      return { block: true, reason: `Kybern denied ${humanSummary(toolName, input)}.` };
    } catch {
      return { block: true, reason: "Kybern could not complete the permission check." };
    }
  });

  pi.on("session_shutdown", () => {
    exactCallGrants.clear();
  });
}
