// Isolated native-rendering fixture. Never connects to a real daemon or agent.
// Run from apps/mobile: node perf/fixture-server.mjs
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/package.json"));
const cliRequire = createRequire(expoRequire.resolve("@expo/cli/package.json"));
const { WebSocketServer } = cliRequire("ws");

const port = Number(process.env.KYBERN_FIXTURE_PORT ?? 4217);
const at = "2026-09-09T00:00:00Z";
const environment = "10000000-0000-4000-8000-000000000001";
const project = {
  id: "10000000-0000-4000-8000-000000000002",
  name: "Performance fixture",
  path: "/fixture",
  is_git: true,
  created_at: at,
  updated_at: at,
};
const thread = {
  id: "10000000-0000-4000-8000-000000000003",
  project_id: project.id,
  title: "Long conversation · 400 turns",
  provider: { kind: "codex", instance: "default" },
  permission_mode: "supervised",
  status: "idle",
  cwd: project.path,
  pinned: false,
  created_at: at,
  updated_at: at,
  last_seq: 2000,
};
const transcript = [];
for (let i = 1; i <= 400; i++) {
  const turn_id = `turn-${i}`;
  const base = { turn_id, at, origin: { kind: "root" } };
  const push = (entry) =>
    transcript.push({ ...base, seq: transcript.length + 1, ...entry });
  push({
    role: "user",
    id: `user-${i}`,
    message: {
      parts: [
        {
          type: "text",
          text: `Request ${i}: explain the result and show the implementation.`,
        },
      ],
    },
  });
  for (let tool = 0; tool < 2; tool++)
    push({
      role: "tool_call",
      call: {
        id: `tool-${i}-${tool}`,
        name: "read_file",
        input: { path: `src/feature-${i}.ts` },
      },
      output: "Synthetic tool output for native performance testing.\n".repeat(
        300,
      ),
      complete: true,
      is_error: false,
    });
  push({
    role: "assistant",
    id: `assistant-${i}`,
    text: `## Reply ${i}\n\nThe implementation keeps each settled message stable while the latest response changes. ${"This paragraph provides realistic wrapping and selectable text. ".repeat(8)}\n\n\`\`\`typescript\nfunction example${i}(value: number) {\n  return value * 2;\n}\n\`\`\`\n\n| Check | Result |\n| --- | --- |\n| Formatting | Preserved |\n| Content | Complete |\n\n${i === 400 ? "LATEST REPLY 400 — end of conversation." : `Completed reply ${i}.`}`,
    complete: true,
  });
  push({
    role: "turn_summary",
    stop_reason: "completed",
    usage: { input_tokens: 100, output_tokens: 100, cached_input_tokens: 0 },
    duration_ms: 1500,
    terminal_message_id: `assistant-${i}`,
  });
}
const snapshot = {
  thread,
  transcript,
  pending_approvals: [],
  pending_questions: [],
  runtime_tasks: [],
  provider_commands: [],
  provider_usage: {},
};
let streamTimer;
let liveMessage;
function emit(payload) {
  const event = {
    seq: ++thread.last_seq,
    thread_id: thread.id,
    turn_id: "fixture-live",
    at: new Date().toISOString(),
    ...payload,
  };
  for (const socket of wss.clients)
    if (socket.readyState === 1)
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: { subscription_id: "fixture-subscription", event },
        }),
      );
}
function stopStream() {
  clearInterval(streamTimer);
  streamTimer = undefined;
  if (liveMessage) {
    liveMessage.complete = true;
    emit({
      kind: "assistant_message_completed",
      message_id: liveMessage.id,
      origin: { kind: "root" },
      text: liveMessage.text,
      thinking: null,
    });
    liveMessage = undefined;
  }
  thread.status = "idle";
  emit({ kind: "thread_updated", thread: { ...thread } });
}
function startStream() {
  if (streamTimer) return;
  thread.status = "running";
  emit({ kind: "thread_updated", thread: { ...thread } });
  liveMessage = {
    role: "assistant",
    id: `live-${thread.last_seq}`,
    turn_id: "fixture-live",
    at,
    origin: { kind: "root" },
    seq: thread.last_seq + 1,
    text: "",
    complete: false,
  };
  transcript.push(liveMessage);
  let count = 0;
  streamTimer = setInterval(() => {
    const delta =
      ++count % 20 === 0
        ? "\n\n"
        : "Streaming text with **formatting** and realistic wrapping. ";
    liveMessage.text += delta;
    emit({
      kind: "assistant_text_delta",
      message_id: liveMessage.id,
      origin: { kind: "root" },
      delta,
    });
    if (count === 600) stopStream();
  }, 50);
}
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "POST" && req.url === "/stream/start") {
    startStream();
    res.end("{}");
  } else if (req.method === "POST" && req.url === "/stream/stop") {
    stopStream();
    res.end("{}");
  } else if (req.url === "/pair")
    res.end(
      JSON.stringify({
        token: "local-fixture-only",
        environment_id: environment,
      }),
    );
  else if (req.url === "/snapshot") res.end(JSON.stringify(snapshot));
  else if (req.url === "/health") res.end(JSON.stringify({ ok: true }));
  else {
    res.statusCode = 404;
    res.end("{}");
  }
});
const wss = new WebSocketServer({ server });
wss.on("connection", (socket) =>
  socket.on("message", (raw) => {
    const { id, method } = JSON.parse(raw.toString());
    let result;
    switch (method) {
      case "daemon.info":
        result = {
          version: "0.2.5",
          protocol_version: 1,
          environment_id: environment,
          hostname: "Local fixture",
          os: "fixture",
          arch: "arm64",
          data_dir: "/fixture",
          scopes: ["orchestration.read", "orchestration.operate"],
          started_at: at,
        };
        break;
      case "events.subscribe":
        result = {
          subscription_id: "fixture-subscription",
          head_seq: thread.last_seq,
        };
        break;
      case "events.unsubscribe":
        result = {};
        break;
      case "projects.list":
        result = { projects: [project] };
        break;
      case "threads.list":
        result = { threads: [thread], activity: [] };
        break;
      case "threads.get":
        result = snapshot;
        console.log(
          JSON.stringify({
            event: "snapshot",
            at: Date.now(),
            entries: transcript.length,
          }),
        );
        break;
      case "providers.list":
        result = {
          providers: [
            {
              kind: "codex",
              display_name: "Codex",
              available: true,
              supported_permission_modes: ["supervised"],
              supports_fork: false,
              supports_model_switch: false,
              instances: ["default"],
              models: [],
            },
          ],
        };
        break;
      case "approvals.list":
        result = { approvals: [] };
        break;
      case "queue.list":
        result = { messages: [] };
        break;
      case "settings.get":
        result = {
          default_provider: "codex",
          default_permission_mode: "supervised",
          worktrees_default: false,
          providers: {},
          background: {},
          access: {},
        };
        break;
      case "git.status":
        result = {
          branch: "main",
          clean: true,
          ahead: 0,
          behind: 0,
          files: [],
        };
        break;
      case "threads.diff":
        result = { from: "HEAD", to: "WORKTREE", files: [], patch: "" };
        break;
      default:
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Read-only performance fixture" },
          }),
        );
        return;
    }
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }),
);
server.listen(port, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      port,
      bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      invitation: `kybern://pair?url=http%3A%2F%2F10.0.2.2%3A${port}&code=123456&environment=${environment}`,
      thread: thread.id,
    }),
  ),
);
