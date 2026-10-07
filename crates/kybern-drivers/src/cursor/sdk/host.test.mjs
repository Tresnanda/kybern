import assert from "node:assert/strict";
import { test } from "node:test";
import { createHost, modelCatalog, modelSelection, runtimePolicy, errorText } from "./host.mjs";

function fixture({ duringStart, failStart } = {}) {
  const terminal = Promise.withResolvers();
  const started = Promise.withResolvers();
  const events = [];
  const calls = [];
  let callback;
  let sends = 0;
  const run = { id: "r1", wait: () => terminal.promise, cancel: async () => {
    calls.push(["cancel"]); terminal.resolve({ id: "r1", status: "cancelled" });
  } };
  const agent = { agentId: "a1", close: () => calls.push(["close"]), send: async (message, options) => {
    callback = options.onDelta;
    calls.push(["send", message, options]);
    sends++;
    if (failStart && sends === 1) throw new Error("Agent already has active run");
    callback({ update: { type: "text-delta", text: "before start" } });
    started.resolve();
    if (duringStart) await duringStart;
    return run;
  } };
  const sdk = { Agent: {
    create: async (options) => { calls.push(["create", options]); return agent; },
    resume: async (id, options) => { calls.push(["resume", id, options]); return agent; },
    listRuns: async () => ({ items: [{ id: "old", status: "running" }] }),
    cancelRun: async (id) => calls.push(["recover", id]),
  }, createAgentPlatform: async () => ({ prewarmLocalWorkspace: async () => { calls.push(["prime"]); return () => {}; } }) };
  const host = createHost(sdk, async (event) => { await Promise.resolve(); events.push(event); }, { apiKey: "secret" });
  return { host, events, calls, terminal, started, delta: (update) => callback({ update }) };
}
const open = (host, extra = {}) => host.request({ type: "open", cwd: "/repo", mode: "auto", model: "model", ...extra });
const tick = () => new Promise((done) => setImmediate(done));

test("sandbox approval policy is explicit; model variants retain parameters", () => {
  assert.deepEqual(runtimePolicy("auto"), { sandboxOptions: { enabled: true }, autoReview: true });
  assert.deepEqual(runtimePolicy("full-access"), { sandboxOptions: { enabled: false }, autoReview: false });
  assert.throws(() => runtimePolicy("supervised"), /no interactive approvals/);
  assert.throws(() => runtimePolicy("accept-edits"));
  const models = modelCatalog([{ id: "m", variants: [{ displayName: "Thinking", params: [{ id: "thinking", value: "on" }] }] }]);
  assert.deepEqual(modelSelection(models[2].id), { id: "m", params: [{ id: "thinking", value: "on" }] });
  assert.equal(errorText(new Error("secret failed"), ["secret"]), "[redacted] failed");
});

test("deltas before send resolves stay ordered; final completion follows every delta", async () => {
  const f = fixture();
  await open(f.host);
  await f.host.request({ type: "send", message: { text: "hello", images: [{ data: "abc", mimeType: "image/png" }] } });
  await assert.rejects(open(f.host), /busy/);
  f.delta({ type: "text-delta", text: "tail" });
  f.terminal.resolve({ id: "r1", status: "finished", result: "before starttail" });
  await tick();
  assert.deepEqual(f.events.map((e) => e.type), ["run_started", "update", "update", "run_completed"]);
  assert.equal(f.calls.find((c) => c[0] === "send")[1].images[0].data, "abc");
  await f.host.close();
});

test("close during run admission cancels the returned run and closes the agent", async () => {
  const gate = Promise.withResolvers();
  const f = fixture({ duringStart: gate.promise });
  await open(f.host);
  const sending = f.host.request({ type: "send", message: { text: "hello" } });
  await f.started.promise;
  const closing = f.host.close();
  gate.resolve();
  await Promise.all([sending, closing]);
  assert.ok(f.calls.some((c) => c[0] === "cancel"));
  assert.equal(f.calls.at(-1)[0], "close");
  assert.equal(f.events.at(-1).result.status, "cancelled");
});

test("resume recovers a stale run once; a new agent never force-cancels one", async () => {
  const f = fixture({ failStart: true });
  await open(f.host, { agentId: "a1" });
  await f.host.request({ type: "send", message: { text: "again" } });
  assert.deepEqual(f.calls.find((c) => c[0] === "recover"), ["recover", "old"]);
  await f.host.close();
  const fresh = fixture({ failStart: true });
  await open(fresh.host);
  await assert.rejects(fresh.host.request({ type: "send", message: { text: "first" } }), /active run/);
  assert.ok(!fresh.calls.some((c) => c[0] === "recover"));
  await fresh.host.close();
});

test("permission changes resume the same agent with sandbox primed before full access", async () => {
  const f = fixture();
  await open(f.host);
  await f.host.request({ type: "set_mode", mode: "full-access", model: "other" });
  const resumed = f.calls.find((c) => c[0] === "resume");
  assert.equal(resumed[1], "a1");
  assert.equal(resumed[2].local.sandboxOptions.enabled, false);
  assert.ok(f.calls.findIndex((c) => c[0] === "prime") < f.calls.indexOf(resumed));
  await f.host.request({ type: "set_mode", mode: "auto", model: "other" });
  assert.equal(f.calls.filter((c) => c[0] === "resume").at(-1)[2].local.autoReview, true);
  await f.host.close();
});


test("run errors redact the SDK key and scoped MCP capability", async () => {
  const f = fixture();
  await open(f.host, { mcpServers: { kybern: { type: "http", url: "http://localhost/mcp", headers: { Authorization: "Bearer capability" } } } });
  await f.host.request({ type: "send", message: { text: "hello" } });
  f.terminal.resolve({ id: "r1", status: "error", error: { message: "secret capability Bearer capability" } });
  await tick();
  assert.equal(f.events.at(-1).result.error.message, "[redacted] [redacted] [redacted]");
  await f.host.close();
});


test("effort variants share a model; context and ZDR preserve native parameters", () => {
  const models = modelCatalog([{ id: "gpt", displayName: "GPT", variants: [
    { params: [{ id: "reasoning_effort", value: "low" }] },
    { params: [{ id: "reasoning_effort", value: "high" }] },
    { params: [{ id: "context", value: "1000000" }, { id: "reasoning_effort", value: "high" }] },
    { params: [{ id: "zdr", value: "true" }] },
  ] }]);
  assert.equal(models.length, 4);
  assert.deepEqual(models[1].efforts, ["low", "high"]);
  assert.equal(models[1].display_name, "GPT");
  assert.equal(models[2].display_name, "GPT · 1M context");
  assert.equal(models[3].display_name, "GPT · ZDR");
  assert.deepEqual(modelSelection(models[1].id, "high"), { id: "gpt", params: [{ id: "reasoning_effort", value: "high" }] });
  assert.deepEqual(modelSelection(models[2].id), { id: "gpt", params: [{ id: "context", value: "1000000" }, { id: "reasoning_effort", value: "high" }] });
  assert.throws(() => modelSelection(models[1].id, "max"), /does not offer/);
  assert.deepEqual(modelSelection(`cursor-model:${Buffer.from(JSON.stringify({id: "gpt", params: [{id: "reason_effort", value: "low"}]})).toString("base64url")}`),
    {id: "gpt", params: [{id: "reason_effort", value: "low"}]});
});


test("the effort control reaches native sends and survives permission changes", async () => {
  const f = fixture();
  const [, model] = modelCatalog([{id:"m", variants:[
    {params:[{id:"reason_effort",value:"low"}]},
    {params:[{id:"reason_effort",value:"high"}]},
  ]}]);
  await open(f.host, {model:model.id, effort:"high"});
  assert.deepEqual(f.calls.find((c) => c[0] === "create")[1].model.params, [{id:"reason_effort",value:"high"}]);
  await f.host.request({type:"set_effort",effort:"low"});
  await f.host.request({type:"set_mode",mode:"full-access",model:model.id});
  assert.deepEqual(f.calls.filter((c) => c[0] === "resume").at(-1)[2].model.params, [{id:"reason_effort",value:"low"}]);
  await f.host.request({type:"send",message:{text:"hello"}});
  assert.deepEqual(f.calls.find((c) => c[0] === "send")[2].model.params, [{id:"reason_effort",value:"low"}]);
  await f.host.close();
});
