import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createHost,
  createAccountHost,
  kybernTools,
  toolResult,
  nativeCatalog,
  modelCatalog,
  modelSelection,
  runtimePolicy,
  errorText,
  modelError,
  handleUnhandledRejection,
  configureAgentTransport,
  STEER_TIMEOUT_MS,
} from "./host.mjs";

function fixture({ duringStart, failStart, warmGate, fetch, platform, checkpoint, runRecord, agentRecord, runSteer, steerTimeoutMs, checkpointSettleMs, checkpointPersistChain } = {}) {
  const terminal = Promise.withResolvers();
  const started = Promise.withResolvers();
  const events = [];
  const calls = [];
  let callback;
  let sends = 0;
  const run = {
    id: "r1",
    wait: () => terminal.promise,
    cancel: async () => {
      calls.push(["cancel"]);
      terminal.resolve({ id: "r1", status: "cancelled" });
    },
    ...(runSteer !== undefined ? { steer: runSteer } : {}),
  };
  const agent = {
    summarize: async () => { calls.push(["summarize"]); return run; },
    agentId: "a1",
    close: () => calls.push(["close"]),
    ...(checkpointPersistChain !== undefined ? { checkpointPersistChain } : {}),
    send: async (message, options) => {
      callback = options.onDelta;
      calls.push(["send", message, options]);
      sends++;
      if (failStart && sends === 1) throw new Error("Agent already has active run");
      callback({ update: { type: "text-delta", text: "before start" } });
      started.resolve();
      if (duringStart) await duringStart;
      return run;
    },
  };
  const storeObj = (runRecord !== undefined || agentRecord !== undefined)
    ? {
        ...(runRecord !== undefined ? { getRun: async (agentId, runId) => (typeof runRecord === "function" ? runRecord(agentId, runId) : runRecord) } : {}),
        ...(agentRecord !== undefined ? { getAgent: async (agentId) => (typeof agentRecord === "function" ? agentRecord(agentId) : agentRecord) } : {}),
      }
    : undefined;
  const sdk = { Agent: {
    create: async (options) => { calls.push(["create", options]); return agent; },
    resume: async (id, options) => { calls.push(["resume", id, options]); return agent; },
    // Oldest first and paged, like the SDK: the stale run is not the first item.
    listRuns: async (_id, { limit, cursor }) => cursor === "next"
      ? { items: [{ id: "done", status: "finished" }, { id: "old", status: "running" }] }
      : { items: [{ id: "first", status: "finished" }].slice(0, limit), nextCursor: "next" },
    cancelRun: async (id) => calls.push(["recover", id]),
  }, createAgentPlatform: async () => ({
    resolveLocalModelSelection: async (selection) => selection,
    createAgent: async (options) => sdk.Agent.create(options),
    resumeAgent: async (id,options) => sdk.Agent.resume(id,options),
    prewarmLocalWorkspace: async (options) => { calls.push(["prime", options]); await warmGate; return () => {}; },
    ...(checkpoint !== undefined ? { checkpointStore: { loadLatest: async () => (typeof checkpoint === "function" ? checkpoint() : checkpoint) } } : {}),
    ...(storeObj ? { store: storeObj } : {}),
  }) };
  const waiters = [];
  const notify = (event) => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(event)) {
        const [{ resolve }] = waiters.splice(i, 1);
        resolve(event);
      }
    }
  };
  const waitForEvent = (pred) => {
    const existing = events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  };
  const host = createHost(sdk, async (event) => { await Promise.resolve(); events.push(event); notify(event); }, {
    apiKey: "secret",
    fetch,
    ...(platform ? { platform } : {}),
    ...(steerTimeoutMs !== undefined ? { steerTimeoutMs } : {}),
    ...(checkpointSettleMs !== undefined ? { checkpointSettleMs } : {}),
  });
  return { host, agent, events, calls, terminal, started, waitForEvent, delta: (update) => callback({ update }) };
}
const open = (host, extra = {}) => host.request({ type: "open", cwd: "/repo", mode: "auto", model: "model", ...extra });
const tick = () => new Promise((done) => setImmediate(done));

test("sandbox approval policy is explicit; model variants retain parameters", () => {
  assert.deepEqual(runtimePolicy("auto", "linux"), { sandboxOptions: { enabled: true }, autoReview: true });
  assert.deepEqual(runtimePolicy("auto", "darwin"), { sandboxOptions: { enabled: true }, autoReview: true });
  assert.deepEqual(runtimePolicy("auto", "win32"), { sandboxOptions: { enabled: false }, autoReview: true });
  assert.deepEqual(runtimePolicy("full-access", "linux"), { sandboxOptions: { enabled: false }, autoReview: false });
  assert.throws(() => runtimePolicy("supervised"), /no interactive approvals/);
  assert.throws(() => runtimePolicy("accept-edits"));
  const models = modelCatalog([{ id: "m", variants: [{ displayName: "Thinking", params: [{ id: "thinking", value: "on" }] }] }]);
  assert.deepEqual(modelSelection(models[1].id), { id: "m" });
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


// Stands in for the daemon's per-conversation MCP endpoint.
function daemonTools(requests = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, authorization: init.headers.Authorization, ...body });
    if (init.headers.Authorization !== "Bearer capability") return new Response("Native tool session is unavailable", { status: 401 });
    const result = body.method === "tools/list"
      ? { tools: [{ name: "kybern_ping", description: "Ping", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } }] }
      : body.params.arguments.fail ? { isError: true, content: [{ type: "text", text: "nope" }] }
      : { content: [{ type: "text", text: `pong ${body.params.arguments.text}` }, { type: "image", data: "aW1n", mimeType: "image/png" }, { type: "resource", resource: { uri: "x" } }] };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
}
const nativeTools = { url: "http://127.0.0.1:9/native-tools/mcp", authorization: "Bearer capability" };

test("Kybern tools run as host custom tools against the scoped daemon endpoint", async () => {
  const requests = [];
  const tools = await kybernTools(nativeTools, { fetch: daemonTools(requests) });
  assert.deepEqual(Object.keys(tools), ["kybern_ping"]);
  assert.deepEqual(tools.kybern_ping.annotations, { readOnlyHint: true });
  assert.equal(tools.kybern_ping.inputSchema.properties.text.type, "string");
  assert.deepEqual(await tools.kybern_ping.execute({ text: "hi" }, {}), { content: [
    { type: "text", text: "pong hi" }, { type: "image", data: "aW1n", mimeType: "image/png" }, { type: "text", text: '{"type":"resource","resource":{"uri":"x"}}' }] });
  assert.deepEqual(await tools.kybern_ping.execute({ fail: true }, {}), { content: [{ type: "text", text: "nope" }], isError: true });
  assert.deepEqual(requests.map((r) => [r.method, r.authorization, r.params.name]), [
    ["tools/list", "Bearer capability", undefined], ["tools/call", "Bearer capability", "kybern_ping"], ["tools/call", "Bearer capability", "kybern_ping"]]);
  assert.notEqual(requests[1].id, requests[2].id);
  // A revoked capability is a readable tool error, never a crashed run.
  const revoked = await kybernTools(nativeTools, { fetch: async (url, init) => JSON.parse(init.body).method === "tools/list"
    ? Response.json({ jsonrpc: "2.0", result: { tools: [{ name: "kybern_ping" }] } }) : new Response("gone", { status: 401 }) });
  const failed = await revoked.kybern_ping.execute({}, {});
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /unavailable \(HTTP 401\)/);
  assert.deepEqual(toolResult({ content: [], structuredContent: { a: 1 } }), { content: [], structuredContent: { a: 1 } });
});

test("tools stay off the executor key and off every send", async () => {
  const f = fixture({ fetch: daemonTools() });
  await open(f.host, { nativeTools });
  const created = f.calls.find((c) => c[0] === "create")[1];
  assert.equal(created.mcpServers, undefined);
  assert.deepEqual(Object.keys(created.local.customTools), ["kybern_ping"]);
  const primed = f.calls.find((c) => c[0] === "prime")[1];
  assert.equal(primed.mcpServers, undefined);
  assert.equal(primed.local.customTools, undefined);
  await f.host.request({ type: "send", message: { text: "hello" } });
  // A send-level MCP override would rebuild every MCP server for the run.
  assert.deepEqual(Object.keys(f.calls.find((c) => c[0] === "send")[2]).sort(), ["model", "onDelta"]);
  f.terminal.resolve({ id: "r1", status: "finished" });
  await tick();
  await f.host.request({ type: "set_mode", mode: "full-access", model: "other" });
  assert.deepEqual(Object.keys(f.calls.filter((c) => c[0] === "resume").at(-1)[2].local.customTools), ["kybern_ping"]);
  await f.host.close();
});

test("run errors redact the SDK key and scoped MCP capability", async () => {
  const f = fixture({ fetch: daemonTools() });
  await open(f.host, { nativeTools });
  await f.host.request({ type: "send", message: { text: "hello" } });
  f.terminal.resolve({ id: "r1", status: "error", error: { message: "secret capability Bearer capability" } });
  await tick();
  assert.equal(f.events.at(-1).result.error.message, "[redacted] [redacted] [redacted]");
  await f.host.close();
});


test("variants fold into one row with structured traits", () => {
  const models = modelCatalog([{ id: "gpt", displayName: "GPT", variants: [
    { params: [{ id: "reasoning_effort", value: "low" }] },
    { params: [{ id: "reasoning_effort", value: "high" }] },
    { params: [{ id: "context", value: "1000000" }, { id: "reasoning_effort", value: "high" }] },
    { params: [{ id: "zdr", value: "true" }] },
  ] }]);
  assert.equal(models.length, 2);
  const [, row] = models;
  assert.equal(row.display_name, "GPT");
  assert.equal(row.resolved_id, "gpt");
  assert.deepEqual(row.efforts, ["low", "high"]);
  assert.deepEqual(row.parameters.map((p) => [p.id, p.label, p.default, p.values.map((v) => v.label)]), [
    ["context", "Context", "default", ["1M", "Default"]],
    ["zdr", "ZDR", "false", ["On", "Off"]],
  ]);
  assert.equal(row.variants.length, 3);
  assert.equal(row.id, row.variants[0].id);
  assert.deepEqual(row.variants[1].params, { context: "1000000", zdr: "false" });
  assert.deepEqual(row.variants[2].params, { context: "default", zdr: "true" });
  assert.deepEqual(modelSelection(row.id, "high"), { id: "gpt", params: [{ id: "reasoning_effort", value: "high" }] });
  assert.deepEqual(modelSelection(row.variants[1].id), { id: "gpt", params: [{ id: "context", value: "1000000" }] });
  assert.throws(() => modelSelection(row.id, "max"), /does not offer/);
  assert.deepEqual(modelSelection(`cursor-model:${Buffer.from(JSON.stringify({id: "gpt", params: [{id: "reason_effort", value: "low"}]})).toString("base64url")}`),
    {id: "gpt", params: [{id: "reason_effort", value: "low"}]});
});

test("context and fast combinations are one row, never fast: false", () => {
  const combos = [];
  for (const context of ["300000", "1000000"]) for (const fast of ["false", "true"]) {
    combos.push({ isDefault: context === "300000" && fast === "false",
      params: [{ id: "context", value: context }, { id: "fast", value: fast }, { id: "effort", value: "low" }] });
    combos.push({ params: [{ id: "context", value: context }, { id: "fast", value: fast }, { id: "effort", value: "high" }] });
  }
  const models = modelCatalog([{ id: "opus", displayName: "Claude Opus 5.5", parameters: [
    { id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
  ], variants: combos }]);
  assert.equal(models.length, 2);
  const [, row] = models;
  assert.equal(row.display_name, "Claude Opus 5.5");
  assert.deepEqual(row.efforts, ["low", "high"]);
  assert.deepEqual(row.parameters.map((p) => [p.id, p.label, p.default]), [["context", "Context", "300000"], ["fast", "Fast", "false"]]);
  assert.deepEqual(row.parameters[0].values.map((v) => v.label), ["300K", "1M"]);
  assert.equal(row.variants.length, 4);
  assert.ok(!JSON.stringify(models).includes("fast: false"));
  const fast = row.variants.find((v) => v.params.context === "1000000" && v.params.fast === "true");
  assert.deepEqual(modelSelection(fast.id, "high").params, [
    { id: "context", value: "1000000" }, { id: "fast", value: "true" }, { id: "effort", value: "high" }]);
});


test("lowercase context sizes and xhigh read as labels", () => {
  const [, row] = modelCatalog([{ id: "g", displayName: "G", variants: [
    { params: [{ id: "context", value: "300k" }, { id: "reasoning", value: "low" }] },
    { params: [{ id: "context", value: "1m" }, { id: "reasoning", value: "xhigh" }] },
  ] }]);
  assert.deepEqual(row.parameters.map((p) => [p.id, p.values.map((v) => v.label)]), [["context", ["300K", "1M"]]]);
  assert.deepEqual(row.variants.map((v) => v.efforts), [["low"], ["xhigh"]]);
});

test("GPT-style `reasoning` is an effort, not a trait, and missing combinations stay missing", () => {
  const combos = [["300k", "false"], ["300k", "true"], ["1m", "false"]];
  const variants = [];
  for (const [context, fast] of combos) for (const reasoning of ["low", "high"]) {
    variants.push({ isDefault: context === "300k" && fast === "false" && reasoning === "low",
      params: [{ id: "reasoning", value: reasoning }, { id: "context", value: context }, { id: "fast", value: fast }] });
  }
  const [, row] = modelCatalog([{ id: "gpt-5.5", displayName: "GPT-5.5", variants }]);
  assert.deepEqual(row.parameters.map((p) => p.id), ["context", "fast"]);
  assert.equal(row.variants.length, 3);
  assert.deepEqual(row.efforts, ["low", "high"]);
  assert.ok(!row.variants.some((v) => v.params.context === "1m" && v.params.fast === "true"));
  assert.deepEqual(modelSelection(row.id, "high").params.at(-1), { id: "reasoning", value: "high" });
  const old = `cursor-model:${Buffer.from(JSON.stringify({ id: "gpt-5.5", params: [{ id: "reasoning", value: "high" }] })).toString("base64url")}`;
  assert.deepEqual(modelSelection(old, "low").params, [{ id: "reasoning", value: "low" }]);
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


test("native defaults never become chosen effort, context, fast or hidden cyber settings", () => {
  const [, row] = modelCatalog([{ id: "opus", variants: [
    { isDefault: true, params: [{id:"cyber",value:"false"},{id:"context",value:"300k"},{id:"fast",value:"false"},{id:"effort",value:"medium"}] },
    { params: [{id:"cyber",value:"false"},{id:"context",value:"1m"},{id:"fast",value:"false"},{id:"effort",value:"medium"}] },
  ] }]);
  assert.deepEqual(modelSelection(row.id), {id:"opus"});
  const encoded = JSON.parse(Buffer.from(row.id.slice(13),"base64url").toString("utf8"));
  // The shared picker compares full params in saved opaque selectors. Keeping
  // those identities must not turn inferred defaults into SDK request params.
  assert.deepEqual(encoded.params,[{id:"cyber",value:"false"},{id:"context",value:"300k"},{id:"fast",value:"false"}]);
  assert.deepEqual(encoded.defaultParams,encoded.params);
  assert.deepEqual(modelSelection(row.variants[1].id), {id:"opus",params:[{id:"context",value:"1m"}]});
  const legacy = `cursor-model:${Buffer.from(JSON.stringify({id:"opus",params:[{id:"cyber",value:"false"},{id:"context",value:"1m"},{id:"fast",value:"false"}],effortParam:"effort",defaultEffort:"medium"})).toString("base64url")}`;
  assert.deepEqual(modelSelection(legacy), {id:"opus",params:[{id:"context",value:"1m"},{id:"fast",value:"false"}]});
});

test("registry errors name the model and explicit values without downgrading the selection", () => {
  const model={id:"grok-4.7",params:[{id:"context",value:"500k"},{id:"fast",value:"true"},{id:"reasoning_effort",value:"xhigh"}]};
  const error=modelError(new Error('Invalid parameters for registry model'),model);
  assert.match(error.message,/grok-4.7.*context=500k.*fast=true.*reasoning_effort=xhigh/);
  assert.match(error.message,/Change.*setting/);
  const auth=new Error("Unauthorized");
  assert.equal(modelError(auth,model),auth);
});


test("account host shares SDK/platform/catalog but scopes concurrent agents, events, askpass and close", async () => {
  const {spawnSync} = await import("node:child_process");
  const events=[];
  const seen=[];
  let creates=0, platforms=0, catalogs=0, releases=0;
  const sdk={Cursor:{models:{list:async()=>{catalogs++;return [{id:"m",displayName:"M"}];}}},
    createAgentPlatform:async()=>{
      platforms++;
      return {
        resolveLocalModelSelection:async selection=>selection,
        prewarmLocalWorkspace:async()=>()=>{releases++;},
        createAgent:async()=>{
          const id="agent"+(++creates);
          return {agentId:id,close(){},send:async(_message,{onDelta})=>{
            await new Promise(done=>setImmediate(done));
            // Child-process environment must see the calling session's
            // capability even with two interleaved sends in one Node process.
            const token=spawnSync(process.execPath,["-e","process.stdout.write(process.env.KYBERN_ASKPASS_TOKEN||'')"],{encoding:"utf8"}).stdout;
            seen.push([id,token]);
            await onDelta({update:{type:"text-delta",text:id}});
            return {id,wait:async()=>({id,status:"finished",result:id}),cancel:async()=>{}};
          }};
        },
      };
    }};
  const ambient=process.env;
  const host=createAccountHost(sdk,async event=>events.push(event),{apiKey:"key"});
  try {
    await Promise.all(["a","b"].map(session=>host.request({type:"open",session,cwd:"/repo",model:"m",mode:"auto",env:{KYBERN_ASKPASS_TOKEN:`scope-${session}-capability`}})));
    await Promise.all(["a","b"].map(session=>host.request({type:"send",session,message:{text:"test"}})));
    await tick();
    assert.deepEqual(seen.sort(),[["agent1","scope-a-capability"],["agent2","scope-b-capability"]]);
    assert.ok(events.filter(event=>event.type==="update").every(event=>event.update.text===(event.session==="a"?"agent1":"agent2")));
    assert.equal(catalogs,1);
    await host.request({type:"catalog",catalog:modelCatalog([{id:"m",displayName:"M"},{id:"new",displayName:"New"}])});
    assert.ok(JSON.parse(process.env.CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON).some(model=>model.id==="new"));
    assert.equal(catalogs,1);
    assert.equal(platforms,1);
    assert.equal(process.env.KYBERN_ASKPASS_TOKEN,undefined);
    await host.request({type:"close",session:"a"});
    await host.request({type:"send",session:"b",message:{text:"still here"}});
    await tick();
    assert.match(host.safeError(new Error("key scope-a-capability scope-b-capability")),/^\[redacted\]/);
  } finally {await host.close();}
  assert.equal(process.env,ambient);
  // Both agents share the workspace executor; host close releases it at once.
  assert.equal(releases,1);
});

test("workspace executors are shared, warmed before the catalog, and linger after the last close", async () => {
  const calls=[];
  const catalog=Promise.withResolvers();
  const sdk={Cursor:{models:{list:async()=>{calls.push("catalog");return catalog.promise;}}},
    createAgentPlatform:async({workspaceRef})=>({
      resolveLocalModelSelection:async selection=>selection,
      prewarmLocalWorkspace:async({local})=>{calls.push(local.settingSources.length ? `prewarm ${workspaceRef} ${local.autoReview}` : "sandbox prime");return async()=>{calls.push(`release ${workspaceRef} ${local.autoReview}`);};},
      createAgent:async()=>({agentId:"agent",close(){}}),
      resumeAgent:async()=>({agentId:"agent",close(){}}),
    })};
  const host=createAccountHost(sdk,async()=>{},{apiKey:"key",lingerMs:30});
  const opening=host.request({type:"open",session:"a",cwd:"/repo",model:"m",mode:"auto"});
  await tick();
  // The scan does not wait for a missing model catalog.
  assert.deepEqual(calls,["prewarm /repo true","catalog"]);
  catalog.resolve([{id:"m",displayName:"M"}]);
  await opening;
  await host.request({type:"open",session:"b",cwd:"/repo",model:"m",mode:"auto"});
  await host.request({type:"open",session:"c",cwd:"/repo",model:"m",mode:"full-access"});
  await host.request({type:"open",session:"d",cwd:"/other",model:"m",mode:"auto"});
  assert.deepEqual(calls.filter(call=>call.startsWith("prewarm")),["prewarm /repo true","prewarm /repo false","prewarm /other true"]);
  for (const session of ["a","b"]) await host.request({type:"close",session});
  // A conversation opened in the linger window reuses the warm executor.
  await host.request({type:"open",session:"e",cwd:"/repo",model:"m",mode:"auto"});
  await host.request({type:"close",session:"e"});
  assert.ok(!calls.includes("release /repo true"));
  await new Promise(done=>setTimeout(done,60));
  assert.ok(calls.includes("release /repo true"));
  assert.ok(!calls.includes("release /other true"));
  // After the linger the workspace is scanned again.
  await host.request({type:"open",session:"f",cwd:"/repo",model:"m",mode:"auto"});
  await host.close();
  assert.ok(calls.includes("release /other true"));
  assert.equal(calls.filter(call=>call.startsWith("prewarm")).length,4);
  assert.equal(calls.filter(call=>call==="sandbox prime").length,1);
});

test("cached catalog preserves native max mode; old incomplete metadata triggers discovery", () => {
  const raw=[{id:"m",displayName:"M",aliases:["m-latest"],variants:[
    {isDefault:true,params:[{id:"context",value:"300k"},{id:"effort",value:"low"}]},
    {isMaxMode:true,params:[{id:"context",value:"1m"},{id:"effort",value:"high"}]},
  ]}];
  const catalog=nativeCatalog(modelCatalog(raw));
  assert.deepEqual(catalog[1].aliases,["m-latest"]);
  assert.equal(catalog[1].variants.find(variant=>variant.params.some(param=>param.value==="1m")).isMaxMode,true);
  assert.equal(catalog[1].variants.find(variant=>variant.params.some(param=>param.value==="300k")).isMaxMode,false);
  const old="cursor-model:"+Buffer.from(JSON.stringify({id:"m",params:[]})).toString("base64url");
  assert.equal(nativeCatalog([{id:old}]),undefined);
});


test("interrupt during workspace prewarm never admits the pending prompt", async () => {
  const gate=Promise.withResolvers();
  const f=fixture({warmGate:gate.promise});
  await open(f.host);
  const sending=f.host.request({type:"send",message:{text:"must not reach the SDK"}});
  await f.host.request({type:"cancel"});
  gate.resolve();
  assert.deepEqual(await sending,{cancelled:true});
  assert.ok(!f.calls.some(call=>call[0]==="send"));
  await f.host.close();
});


test("close during pending prewarm returns immediately and never sends the queued prompt", async () => {
  const gate=Promise.withResolvers();
  const f=fixture({warmGate:gate.promise});
  await open(f.host);
  const sending=f.host.request({type:"send",message:{text:"cancel before admission"}});
  const closed=f.host.close();
  const sentinel=Symbol("still warming");
  assert.notEqual(await Promise.race([closed,tick().then(()=>sentinel)]),sentinel);
  gate.resolve();
  assert.deepEqual(await sending,{cancelled:true});
  await tick();
  assert.ok(!f.calls.some(call=>call[0]==="send"));
  assert.ok(f.calls.some(call=>call[0]==="close"));
});


test("compress uses the SDK summarize run", async () => {
  const f = fixture();
  await open(f.host);
  await f.host.request({type:"send", message:{text:"/compress"}});
  assert.ok(f.calls.some(c=>c[0]==="summarize"));
  assert.ok(!f.calls.some(c=>c[0]==="send"));
  f.terminal.resolve({id:"r1",status:"finished"});
  await tick();
  assert.deepEqual(f.events.map(e=>e.type), ["run_started","run_completed"]);
  await f.host.close();
});

test("unhandled rejection filter ignores only the three known harmless SDK rejections", () => {
  const runGuard = (reason) => {
    const logs = [];
    const exits = [];
    handleUnhandledRejection(reason, { log: (m) => logs.push(m), exit: (code) => exits.push(code) });
    return { logs, exits };
  };
  // 1. Minified WriteIterableClosedError.
  class o extends Error {
    name = "WriteIterableClosedError";
  }
  assert.deepEqual(runGuard(new o("WritableIterable is closed")).exits, []);

  // 2. ConnectError wrapping ERR_STREAM_WRITE_AFTER_END.
  const writeAfterEnd = Object.assign(
    new Error("[aborted] write after end", { cause: Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" }) }),
    { name: "ConnectError", code: 10 },
  );
  assert.deepEqual(runGuard(writeAfterEnd).exits, []);

  // 3. Stall-detector AbortError from onStall.
  const stall = new DOMException("This operation was aborted", "AbortError");
  stall.stack = "AbortError: This operation was aborted\n    at Is.onStall (689.js:1:111536)";
  assert.deepEqual(runGuard(stall).exits, []);

  // Everything else must still crash the host so pool.rs restarts it.
  assert.deepEqual(runGuard(new Error("WritableIterable is closed")).exits, [1]);
  const otherConnect = Object.assign(
    new Error("[aborted] socket hang up", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }),
    { name: "ConnectError", code: 10 },
  );
  assert.deepEqual(runGuard(otherConnect).exits, [1]);
  const otherAbort = new DOMException("onStall was aborted", "AbortError");
  otherAbort.stack = "AbortError: onStall was aborted\n    at somewhereElse (app.js:1:1)";
  assert.deepEqual(runGuard(otherAbort).exits, [1]);
  assert.deepEqual(runGuard("unexpected string rejection").exits, [1]);
});

test("Windows Auto keeps Auto-review on without sandbox and emits a one-time warning notice", async () => {
  const f = fixture({ platform: "win32" });
  await open(f.host, { mode: "auto" });
  const created = f.calls.find((c) => c[0] === "create")[1];
  assert.equal(created.local.autoReview, true);
  assert.equal(created.local.sandboxOptions.enabled, false);
  // No sandbox prime call on win32.
  assert.ok(!f.calls.some((c) => c[0] === "prime" && c[1].local.settingSources.length === 0));
  const notices = () => f.events.filter((e) => e.type === "notice");
  assert.equal(notices().length, 1);
  assert.equal(notices()[0].level, "warning");
  assert.match(notices()[0].text, /Windows/);

  await f.host.request({ type: "set_mode", mode: "full-access", model: "model" });
  await f.host.request({ type: "set_mode", mode: "auto", model: "model" });
  assert.equal(notices().length, 1, "notice is emitted at most once per session");
  await f.host.close();
});

test("run_completed includes contextUsage from checkpointStore.loadLatest and checkpointed from store.getRun", async () => {
  const f = fixture({
    checkpoint: { tokenDetails: { usedTokens: 12_345, maxTokens: 200_000 } },
    runRecord: { startCheckpointRef: { blobId: "b0" }, latestCheckpointRef: { blobId: "b1" } },
  });
  await open(f.host);
  await f.host.request({ type: "send", message: { text: "hi" } });
  f.terminal.resolve({ id: "r1", status: "finished", result: "done" });
  await tick();
  const completed = f.events.find((e) => e.type === "run_completed");
  assert.deepEqual(completed.result.contextUsage, { usedTokens: 12_345, maxTokens: 200_000 });
  assert.equal(completed.result.checkpointed, true);
  await f.host.close();

  // Zero maxTokens (unset protobuf) omits contextUsage; cancelled run without a new checkpoint sets checkpointed=false.
  const f2 = fixture({
    checkpoint: { tokenDetails: { usedTokens: 0, maxTokens: 0 } },
    runRecord: { startCheckpointRef: { blobId: "b0" }, latestCheckpointRef: { blobId: "b0" } },
    checkpointSettleMs: 0,
  });
  await open(f2.host);
  await f2.host.request({ type: "send", message: { text: "hi" } });
  await f2.host.request({ type: "cancel" });
  await tick();
  const cancelled = f2.events.find((e) => e.type === "run_completed");
  assert.equal(cancelled.result.status, "cancelled");
  assert.equal(cancelled.result.contextUsage, undefined);
  assert.equal(cancelled.result.checkpointed, false);
  await f2.host.close();

  // Cancelled run that already saved a new checkpoint sets checkpointed=true.
  const f3 = fixture({
    runRecord: { startCheckpointRef: { blobId: "b0" }, latestCheckpointRef: { blobId: "b1" } },
  });
  await open(f3.host);
  await f3.host.request({ type: "send", message: { text: "hi" } });
  await f3.host.request({ type: "cancel" });
  await tick();
  const cancelledAfterCheckpoint = f3.events.find((e) => e.type === "run_completed");
  assert.equal(cancelledAfterCheckpoint.result.checkpointed, true);
  await f3.host.close();
});

test("cancel awaits in-flight checkpoint persistence, re-reads after settle, and reports unknown on read errors", async () => {
  // 1. SDK cancel resolves wait() while agent.checkpointPersistChain is still persisting.
  // With checkpointSettleMs: 0, only awaiting checkpointPersistChain can observe latest = "b1".
  let latest = "b0";
  const persist = Promise.withResolvers();
  const f1 = fixture({
    runRecord: () => ({ startCheckpointRef: { blobId: "b0" }, latestCheckpointRef: { blobId: latest } }),
    checkpointPersistChain: persist.promise,
    checkpointSettleMs: 0,
  });
  await open(f1.host);
  await f1.host.request({ type: "send", message: { text: "hi" } });
  const done1 = f1.waitForEvent((e) => e.type === "run_completed");
  await f1.host.request({ type: "cancel" });
  await tick();
  assert.equal(f1.events.find((e) => e.type === "run_completed"), undefined, "run_completed must wait for checkpointPersistChain");
  // Finish checkpoint persistence after wait() resolved.
  latest = "b1";
  persist.resolve();
  const c1 = await done1;
  assert.equal(c1.result.checkpointed, true);
  await f1.host.close();

  // 2. Without checkpointPersistChain, a short settle re-read catches a late store write.
  let reads = 0;
  const f2 = fixture({
    runRecord: () => {
      reads++;
      return { startCheckpointRef: { blobId: "b0" }, latestCheckpointRef: { blobId: reads >= 2 ? "b1" : "b0" } };
    },
    checkpointSettleMs: 10,
  });
  await open(f2.host);
  await f2.host.request({ type: "send", message: { text: "hi" } });
  const done2 = f2.waitForEvent((e) => e.type === "run_completed");
  await f2.host.request({ type: "cancel" });
  const c2 = await done2;
  assert.equal(c2.result.checkpointed, true);
  assert.equal(reads, 2);
  await f2.host.close();

  // 3. Agent latestCheckpointRef advancing between before-send and cancel also counts as checkpointed.
  let agentBlob = "a0";
  const f3 = fixture({
    runRecord: { startCheckpointRef: { blobId: "b0" }, latestCheckpointRef: { blobId: "b0" } },
    agentRecord: () => ({ latestCheckpointRef: { blobId: agentBlob } }),
    checkpointSettleMs: 0,
  });
  await open(f3.host);
  await f3.host.request({ type: "send", message: { text: "hi" } });
  agentBlob = "a1";
  const done3 = f3.waitForEvent((e) => e.type === "run_completed");
  await f3.host.request({ type: "cancel" });
  const c3 = await done3;
  assert.equal(c3.result.checkpointed, true);
  await f3.host.close();

  // 4. Store read errors report "unknown" so the prompt is never sent twice while the guide is offered again.
  const f4 = fixture({
    runRecord: async () => { throw new Error("disk busy"); },
    checkpointSettleMs: 0,
  });
  await open(f4.host);
  await f4.host.request({ type: "send", message: { text: "hi" } });
  const done4 = f4.waitForEvent((e) => e.type === "run_completed");
  await f4.host.request({ type: "cancel" });
  const c4 = await done4;
  assert.equal(c4.result.checkpointed, "unknown");
  await f4.host.close();

  // 5. A read error on the pre-send getAgent snapshot also reports "unknown" when getRun saw no new checkpoint.
  const f5 = fixture({
    runRecord: { startCheckpointRef: { blobId: "b0" }, latestCheckpointRef: { blobId: "b0" } },
    agentRecord: async () => { throw new Error("agent read failed"); },
    checkpointSettleMs: 0,
  });
  await open(f5.host);
  await f5.host.request({ type: "send", message: { text: "hi" } });
  const done5 = f5.waitForEvent((e) => e.type === "run_completed");
  await f5.host.request({ type: "cancel" });
  const c5 = await done5;
  assert.equal(c5.result.checkpointed, "unknown");
  await f5.host.close();
});

test("steer forwards run.steer(text), reverts during prewarm/idle, and settles timed-out steers before run_completed", async () => {
  assert.ok(STEER_TIMEOUT_MS > 0 && STEER_TIMEOUT_MS < 60_000, "steer timeout stays well under pool.rs 60 s deadline");
  const steered = [];
  let outcome = "complete_delivered";
  const f = fixture({ runSteer: async (text) => { steered.push(text); return outcome; } });
  await open(f.host);
  // No active turn: reverts cleanly instead of throwing an error.
  assert.deepEqual(await f.host.request({ type: "steer", text: "too early" }), { outcome: "revert_to_followup" });
  await f.host.request({ type: "send", message: { text: "start" } });
  assert.deepEqual(await f.host.request({ type: "steer", text: "change direction" }), { outcome: "complete_delivered" });
  assert.deepEqual(steered, ["change direction"]);
  outcome = "revert_to_followup";
  assert.deepEqual(await f.host.request({ type: "steer", text: "too late" }), { outcome: "revert_to_followup" });
  await assert.rejects(f.host.request({ type: "steer", text: "   " }), /Write a message/);
  const done = f.waitForEvent((e) => e.type === "run_completed");
  f.terminal.resolve({ id: "r1", status: "finished" });
  await done;
  await f.host.close();

  // A steer sent during workspace prewarm (while turn.run is still null) reverts to follow-up cleanly.
  const gate = Promise.withResolvers();
  const warming = fixture({ warmGate: gate.promise });
  await open(warming.host);
  const sending = warming.host.request({ type: "send", message: { text: "start" } });
  await tick();
  assert.deepEqual(await warming.host.request({ type: "steer", text: "during prewarm" }), { outcome: "revert_to_followup" });
  await warming.host.request({ type: "cancel" });
  gate.resolve();
  await sending;
  await warming.host.close();

  // A slow steer returns {outcome: "pending", steerId}; when the SDK later resolves with
  // complete_delivered, the host emits steer_settled before run_completed.
  const deliveredLate = Promise.withResolvers();
  const slowDelivered = fixture({ runSteer: () => deliveredLate.promise, steerTimeoutMs: 10 });
  await open(slowDelivered.host);
  await slowDelivered.host.request({ type: "send", message: { text: "long tool" } });
  const pendingDelivered = await slowDelivered.host.request({ type: "steer", steerId: "steer-deliv-1", text: "redirect" });
  assert.deepEqual(pendingDelivered, { outcome: "pending", steerId: "steer-deliv-1" });
  const settledDelivered = slowDelivered.waitForEvent((e) => e.type === "steer_settled");
  const completedDelivered = slowDelivered.waitForEvent((e) => e.type === "run_completed");
  // Even if run.wait() settles before the pending steer resolves, run_completed waits for steer_settled.
  slowDelivered.terminal.resolve({ id: "r1", status: "finished" });
  await tick();
  assert.equal(slowDelivered.events.find((e) => e.type === "run_completed"), undefined, "run_completed must wait for pending steers");
  deliveredLate.resolve("complete_delivered");
  assert.deepEqual(await settledDelivered, { type: "steer_settled", steerId: "steer-deliv-1", outcome: "complete_delivered" });
  await completedDelivered;
  const delivOrder = slowDelivered.events.map((e) => e.type);
  assert.ok(delivOrder.indexOf("steer_settled") < delivOrder.indexOf("run_completed"), `expected steer_settled before run_completed: ${delivOrder}`);
  await slowDelivered.host.close();

  // A slow steer that later resolves as revert_to_followup emits steer_settled before run_completed.
  const revertedExplicit = Promise.withResolvers();
  const slowRevertExplicit = fixture({ runSteer: () => revertedExplicit.promise, steerTimeoutMs: 10 });
  await open(slowRevertExplicit.host);
  await slowRevertExplicit.host.request({ type: "send", message: { text: "long tool" } });
  const pendingRevertExplicit = await slowRevertExplicit.host.request({ type: "steer", steerId: "steer-rev-1", text: "redirect" });
  assert.deepEqual(pendingRevertExplicit, { outcome: "pending", steerId: "steer-rev-1" });
  const settledRevExplicit = slowRevertExplicit.waitForEvent((e) => e.type === "steer_settled");
  const completedRevExplicit = slowRevertExplicit.waitForEvent((e) => e.type === "run_completed");
  slowRevertExplicit.terminal.resolve({ id: "r1", status: "finished" });
  await tick();
  assert.equal(slowRevertExplicit.events.find((e) => e.type === "run_completed"), undefined, "run_completed must wait for pending steer revert");
  revertedExplicit.resolve("revert_to_followup");
  assert.deepEqual(await settledRevExplicit, { type: "steer_settled", steerId: "steer-rev-1", outcome: "revert_to_followup" });
  await completedRevExplicit;
  const revExplicitOrder = slowRevertExplicit.events.map((e) => e.type);
  assert.ok(revExplicitOrder.indexOf("steer_settled") < revExplicitOrder.indexOf("run_completed"));
  await slowRevertExplicit.host.close();

  // A slow steer that later rejects emits steer_settled with revert_to_followup before run_completed
  // and never triggers unhandledRejection.
  const revertedLate = Promise.withResolvers();
  const slowReverted = fixture({ runSteer: () => revertedLate.promise, steerTimeoutMs: 10 });
  await open(slowReverted.host);
  await slowReverted.host.request({ type: "send", message: { text: "long tool" } });
  const pendingReverted = await slowReverted.host.request({ type: "steer", text: "redirect" });
  assert.equal(pendingReverted.outcome, "pending");
  assert.equal(typeof pendingReverted.steerId, "string");
  assert.ok(pendingReverted.steerId.length > 0);
  const settledReverted = slowReverted.waitForEvent((e) => e.type === "steer_settled");
  const completedReverted = slowReverted.waitForEvent((e) => e.type === "run_completed");
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    slowReverted.terminal.resolve({ id: "r1", status: "finished" });
    await tick();
    revertedLate.reject(new Error("late stream close"));
    assert.deepEqual(await settledReverted, { type: "steer_settled", steerId: pendingReverted.steerId, outcome: "revert_to_followup" });
    await completedReverted;
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  const revOrder = slowReverted.events.map((e) => e.type);
  assert.ok(revOrder.indexOf("steer_settled") < revOrder.indexOf("run_completed"), `expected steer_settled before run_completed: ${revOrder}`);
  await slowReverted.host.close();

  // A run without steer() falls back to revert_to_followup.
  const plain = fixture();
  await open(plain.host);
  await plain.host.request({ type: "send", message: { text: "start" } });
  assert.deepEqual(await plain.host.request({ type: "steer", text: "nudge" }), { outcome: "revert_to_followup" });
  const plainDone = plain.waitForEvent((e) => e.type === "run_completed");
  plain.terminal.resolve({ id: "r1", status: "finished" });
  await plainDone;
  await plain.host.close();
});

test("configureAgentTransport honours useHttp1ForAgent from cli-config.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "kybern-cursor-http1-"));
  try {
    const http1 = JSON.stringify({ network: { useHttp1ForAgent: true } });
    const runCase = async ({ env, file, text }) => {
      const caseDir = await mkdtemp(join(root, "case-"));
      if (file) {
        const target = join(caseDir, file);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, text, "utf8");
      }
      const resolvedEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, join(caseDir, v)]));
      const configured = [];
      const warnings = [];
      const applied = await configureAgentTransport(
        { Cursor: { configure: (opts) => configured.push(opts) } },
        { env: resolvedEnv, home: join(caseDir, "home"), warn: (m) => warnings.push(m) },
      );
      return { applied, configured, warnings };
    };

    // CURSOR_CONFIG_DIR takes precedence over XDG_CONFIG_HOME.
    const fromCursorDir = await runCase({
      env: { CURSOR_CONFIG_DIR: "cfg", XDG_CONFIG_HOME: "xdg" },
      file: "cfg/cli-config.json",
      text: http1,
    });
    assert.equal(fromCursorDir.applied, true);
    assert.deepEqual(fromCursorDir.configured, [{ local: { useHttp1ForAgent: true } }]);

    // XDG_CONFIG_HOME/cursor/cli-config.json.
    const fromXdg = await runCase({ env: { XDG_CONFIG_HOME: "xdg" }, file: "xdg/cursor/cli-config.json", text: http1 });
    assert.equal(fromXdg.applied, true);

    // ~/.cursor/cli-config.json.
    const fromHome = await runCase({ env: {}, file: "home/.cursor/cli-config.json", text: http1 });
    assert.equal(fromHome.applied, true);

    // Explicit false does not configure.
    const disabled = await runCase({
      env: {},
      file: "home/.cursor/cli-config.json",
      text: JSON.stringify({ network: { useHttp1ForAgent: false } }),
    });
    assert.equal(disabled.applied, false);
    assert.deepEqual(disabled.configured, []);
    assert.equal(disabled.warnings.length, 0);

    // Malformed JSON warns and does not throw or configure.
    const damaged = await runCase({ env: {}, file: "home/.cursor/cli-config.json", text: "{" });
    assert.equal(damaged.applied, false);
    assert.equal(damaged.warnings.length, 1);

    // Missing file silently skips.
    const missing = await runCase({ env: {} });
    assert.equal(missing.applied, false);
    assert.equal(missing.warnings.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
