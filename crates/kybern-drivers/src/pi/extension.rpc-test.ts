// Manual real-Pi RPC fixture. Load this file instead of extension.ts, invoke
// /kybern-test-app-tool or /kybern-test-permission, and answer the emitted
// extension_ui_request. It wraps the real Pi ExtensionAPI while capturing the
// Kybern definitions needed to invoke them without an LLM request.

import loadKybern from "./extension.ts";

const RESULT_PREFIX = "kybern_rpc_test_result:";

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export default function kybernRpcTest(pi) {
  const tools = new Map();
  let toolCallHandler;
  const wrapped = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool) => {
          tools.set(tool.name, tool);
          return target.registerTool(tool);
        };
      }
      if (property === "on") {
        return (event, handler) => {
          if (event === "tool_call") toolCallHandler = handler;
          return target.on(event, handler);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  loadKybern(wrapped);

  pi.registerCommand("kybern-test-app-tool", {
    description: "Exercise Kybern's app tool bridge without calling a model.",
    handler: async (_args, ctx) => {
      try {
        const result = await tools
          .get("kybern_thread_context")
          .execute("rpc-test-app", {}, ctx.signal, undefined, ctx);
        ctx.ui.notify(`${RESULT_PREFIX}${encode({ kind: "app", ok: true, result })}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `${RESULT_PREFIX}${encode({ kind: "app", ok: false, error: error instanceof Error ? error.message : String(error) })}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("kybern-test-permission", {
    description: "Exercise Kybern's permission bridge without calling a model.",
    handler: async (_args, ctx) => {
      try {
        const result = await toolCallHandler(
          { type: "tool_call", toolCallId: "rpc-test-permission", toolName: "bash", input: { command: "pwd" } },
          ctx,
        );
        ctx.ui.notify(`${RESULT_PREFIX}${encode({ kind: "permission", ok: true, result: result ?? null })}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `${RESULT_PREFIX}${encode({ kind: "permission", ok: false, error: error instanceof Error ? error.message : String(error) })}`,
          "error",
        );
      }
    },
  });
}
