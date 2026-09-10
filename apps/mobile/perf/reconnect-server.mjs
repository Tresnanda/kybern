// Native/UI fixture: deterministic grouped work, slow snapshots and reconnect replay.
// node perf/reconnect-server.mjs; POST /disconnect; GET /stats. No real agents/data.
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/package.json"));
const { WebSocketServer } = createRequire(expoRequire.resolve("@expo/cli/package.json"))("ws");
const port = Number(process.env.KYBERN_FIXTURE_PORT ?? 4228);
const at = new Date().toISOString();
const environment = "20000000-0000-4000-8000-000000000001";
const project = { id: "20000000-0000-4000-8000-000000000002", name: "Connection fixture", path: "/fixture", is_git: true, created_at: at, updated_at: at };
const thread = { id: "20000000-0000-4000-8000-000000000003", project_id: project.id, title: "Grouped work and reconnect", provider: { kind: "codex", instance: "default" }, permission_mode: "supervised", status: "running", cwd: project.path, pinned: false, created_at: at, updated_at: at, last_seq: 0 };
const base = { turn_id: "fixture-turn", at, origin: { kind: "root" } };
const transcript = [];
const push = entry => transcript.push({ ...base, seq: ++thread.last_seq, ...entry });
push({ role: "user", id: "user", message: { parts: [{ type: "text", text: "Review the connection and keep the updates readable." }] } });
push({ role: "assistant", id: "narration", text: "I’m checking the connection and loading behavior.", complete: true });
for (let i = 1; i <= 8; i++) push({ role: "tool_call", call: { id: `tool-${i}`, name: "read_file", input: { path: `src/check-${i}.ts` } }, output: `Check ${i}: complete.`, complete: true, is_error: false });
push({ role: "tool_call", call: { id: "active", name: "run_command", input: { command: "Verify reconnect replay" } }, output: null, complete: false, is_error: false });
push({ role: "assistant", id: "live", text: "## Connection check\n\nThe completed steps are grouped above. This message stays visible while the connection recovers.\n\n| Check | Result |\n| --- | --- |\n| History | Preserved |\n| Details | Expandable |", complete: false });
const inline = process.env.KYBERN_FIXTURE_INLINE === "1";
const models = process.env.KYBERN_FIXTURE_MODELS === "1";
const history = process.env.KYBERN_FIXTURE_HISTORY === "1";
const skills = [
  { name: "better-ui", path: "/skills/better-ui/SKILL.md", scope: "user", enabled: true },
  { name: "mobile-ios-design", path: "/skills/mobile-ios-design/SKILL.md", scope: "user", enabled: true },
  { name: "figma", display_name: "Figma Design", path: "/plugins/figma", scope: "plugin", enabled: true },
];
if (inline) {
  thread.status = "idle";
  transcript.length = 0;
  push({ role: "user", id: "inline-user", message: { parts: [
    { type: "text", text: "Please review the mobile layout with " },
    { type: "skill", name: "better-ui", path: skills[0].path },
    { type: "text", text: " and " },
    { type: "skill", name: "mobile-ios-design", path: skills[1].path },
    { type: "text", text: ". Use " },
    { type: "mention", name: "figma", display_name: "Figma Design", path: skills[2].path },
    { type: "text", text: " to check " },
    { type: "file_mention", path: "src/My App.tsx" },
    { type: "text", text: ". Keep the mentions in the sentence.\nThis is the next paragraph." },
  ] } });
  push({ role: "assistant", id: "live", text: "The highlighted references stay in the sentence and wrap with your text.", complete: true });
  push({ role: "turn_summary", stop_reason: "completed", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 1000, terminal_message_id: "live" });
}
if (models) {
  thread.status = "idle";
  thread.provider.kind = "claude-code";
  thread.model = "opus";
  thread.effort = "medium";
}
if (history) {
  thread.status = "idle";
  thread.title = "File links and earlier history";
  transcript.length = 0;
  for (let i = 1; i <= 100; i++) {
    const turn_id = `history-${i}`;
    push({ role: "user", id: `u-${i}`, turn_id, message: { parts: [{ type: "text", text: `Question ${i}` }] } });
    push({ role: "assistant", id: `a-${i}`, turn_id, text: `## Reply ${i}\n\n` + "Keep this paragraph in place while earlier messages arrive. ".repeat(3) + "\n\n[Open prompt](2026-09-10-hermes-prompt.md) · [Missing file](missing.md)", complete: true });
    push({ role: "turn_summary", turn_id, stop_reason: "completed", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 1000, terminal_message_id: `a-${i}` });
  }
}
const providers = models
  ? Object.entries({ "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", pi: "Pi", omp: "Oh My Pi", opencode: "OpenCode" }).map(([kind, display_name]) => ({
    kind, display_name, available: true, supported_permission_modes: ["supervised"], supports_fork: false,
    supports_model_switch: true, supports_effort_switch: false, supported_efforts: ["low", "medium", "high"], instances: ["default"],
    models: kind === "claude-code" ? [{ id: "opus", display_name: "Claude Opus", default_effort: "medium" }] : [],
  }))
  : [{ kind: "codex", display_name: "Codex", available: true, supported_permission_modes: ["supervised"], supports_fork: false, supports_model_switch: false, instances: ["default"], models: [] }];
const submitted = [];
const historyRequests = [];
let failHistory = false;
const events = [];
const counts = {};
let socketCount = 0;
const snapshot = () => ({ thread, transcript, pending_approvals: [], pending_questions: [], runtime_tasks: [], provider_commands: [], provider_usage: {} });
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "POST" && req.url === "/disconnect") {
    for (const socket of wss.clients) socket.terminate();
    const delta = "\n\nReconnected: the cached conversation caught up without reloading.";
    transcript.at(-1).text += delta;
    events.push({ ...base, thread_id: thread.id, seq: ++thread.last_seq, kind: "assistant_text_delta", message_id: "live", delta });
    res.end("{}");
  } else if (req.method === "POST" && req.url === "/fail-history") { failHistory = true; res.end("{}");
  } else if (req.url === "/pair") res.end(JSON.stringify({ token: "local-fixture-only", environment_id: environment }));
  else if (req.url === "/stats") res.end(JSON.stringify({ counts, socketCount, head: thread.last_seq, submitted, historyRequests }));
  else { res.statusCode = 404; res.end("{}"); }
});
const wss = new WebSocketServer({ server });
wss.on("connection", socket => {
  socketCount++;
  socket.on("message", raw => {
    const { id, method, params } = JSON.parse(raw.toString());
    counts[method] = (counts[method] ?? 0) + 1;
    const send = value => { if (socket.readyState === 1) socket.send(JSON.stringify(value)); };
    let result;
    switch (method) {
      case "daemon.info": result = { version: "0.3.2", protocol_version: 1, environment_id: environment, hostname: "Connection fixture", os: "fixture", arch: "arm64", data_dir: "/fixture", scopes: ["orchestration.read", "orchestration.operate"], started_at: at }; break;
      case "events.subscribe": {
        const subscription_id = `sub-${socketCount}-${id}`;
        send({ jsonrpc: "2.0", id, result: { subscription_id, head_seq: thread.last_seq, replay_ready: true } });
        for (const event of events.filter(e => params.after_seq != null && e.seq > params.after_seq)) send({ jsonrpc: "2.0", method: "event", params: { subscription_id, event } });
        send({ jsonrpc: "2.0", method: "events.ready", params: { subscription_id, head_seq: thread.last_seq } });
        return;
      }
      case "threads.get": {
        let page = snapshot();
        if (history) {
          const eligible = transcript.filter(row => params.before_seq == null || row.seq < params.before_seq);
          const rows = eligible.slice(-(params.transcript_limit ?? eligible.length));
          page = { ...page, transcript: rows, next_before_seq: rows.length < eligible.length ? rows[0].seq : null };
          historyRequests.push({ ...params, entries: rows.length, at: Date.now() });
          if (params.before_seq && failHistory) {
            failHistory = false;
            setTimeout(() => send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Connection interrupted. Try again." } }), 600);
            return;
          }
        }
        const response = JSON.stringify({ jsonrpc: "2.0", id, result: page });
        setTimeout(() => { if (socket.readyState === 1) socket.send(response); }, history ? 600 : 1800);
        return;
      }
      case "threads.files.read":
        submitted.push({ method, params });
        if (params.path === "missing.md") { send({ jsonrpc: "2.0", id, error: { code: -32602, message: "File not found. Check the path or ask the agent to recreate it." } }); return; }
        result = { content: params.path.endsWith(".ts") ? "export const connected = true;\n".repeat(30) : "# Hermes prompt\n\nOpened from the connected conversation workspace.\n\n[Related source](docs/My%20File.ts:12)\n\n| Check | Result |\n| --- | --- |\n| File links | Open here |\n| History | Loads while scrolling |", binary: false, truncated: false, size: 240 };
        break;
      case "projects.list": result = { projects: [project] }; break;
      case "threads.list": result = { threads: [thread], activity: [] }; break;
      case "providers.list": result = { providers }; break;
      case "threads.update":
        submitted.push({ method, params });
        if (params.model === "rejected-model" || (models && ("effort" in params || "permission_mode" in params))) {
          send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Choose another model. The fixture rejected this change." } });
          return;
        }
        if (params.model !== undefined) thread.model = params.model;
        result = thread;
        break;
      case "approvals.list": result = { approvals: [] }; break;
      case "queue.list": result = { messages: [] }; break;
      case "settings.get": result = { default_provider: "codex", default_permission_mode: "supervised", worktrees_default: false, providers: {}, background: {}, access: {} }; break;
      case "threads.diff": result = { from: "HEAD", to: "WORKTREE", files: [], patch: "" }; break;
      case "git.status": result = { branch: "main", clean: true, ahead: 0, behind: 0, files: [] }; break;
      case "skills.list": result = { skills }; break;
      case "files.search": result = { files: ["src/My App.tsx"] }; break;
      case "queue.add":
      case "threads.send":
      case "threads.steer":
        submitted.push({ method, params });
        result = { message_id: `sent-${submitted.length}`, turn_id: base.turn_id, queued: true };
        break;
      default: send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Read-only connection fixture" } }); return;
    }
    send({ jsonrpc: "2.0", id, result });
  });
});
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ port, environment, thread: thread.id })));
