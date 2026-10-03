// The official Cursor SDK runs in this process, never in the Kybern daemon.
// Keep the SDK package on disk: its lazy chunks and platform helpers cannot be
// folded into our Rust binary. Rust embeds this small host, not the SDK.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { format } from "node:util";

export const SDK_VERSION = "1.0.35";
export const SETTING_SOURCES = ["project", "user", "team", "mdm", "plugins"];
const runtimeSecrets = [process.env.CURSOR_API_KEY];

export function runtimePolicy(mode) {
  switch (mode) {
    case "auto":
      return { sandboxOptions: { enabled: true }, autoReview: true };
    case "full-access":
      return { sandboxOptions: { enabled: false }, autoReview: false };
    default:
      throw new Error("Cursor SDK has no interactive approvals. Choose Auto-review (auto) or Full access.");
  }
}

// Params travel in the model selector so the existing Kybern model picker can
// offer native variants without dropping a Cursor-specific parameter.
export function modelSelection(selector) {
  if (!selector || selector === "auto" || selector === "default") return { id: "default" };
  if (selector.startsWith("cursor-model:")) {
    const parsed = JSON.parse(Buffer.from(selector.slice(13), "base64url").toString("utf8"));
    if (!parsed || typeof parsed.id !== "string" || !Array.isArray(parsed.params) ||
        parsed.params.some((p) => typeof p.id !== "string" || typeof p.value !== "string")) {
      throw new Error("Invalid Cursor model variant. Refresh the model list and select it again.");
    }
    return parsed;
  }
  return { id: selector };
}

export function modelCatalog(models) {
  const out = [{ id: "default", display_name: "Default", description: "Cursor’s default model", is_default: true, efforts: [] }];
  for (const model of models) {
    if (model.id === "default") continue;
    out.push({ id: model.id, display_name: model.displayName || model.id, description: model.description, is_default: false, efforts: [] });
    for (const variant of model.variants ?? []) {
      if (!variant.params?.length) continue;
      const selection = { id: model.id, params: variant.params };
      out.push({
        id: `cursor-model:${Buffer.from(JSON.stringify(selection)).toString("base64url")}`,
        display_name: variant.displayName || model.displayName || model.id,
        description: variant.description || model.description,
        is_default: false,
        efforts: [],
      });
    }
  }
  return out;
}

function isAbort(error) {
  const seen = new Set();
  while (error && typeof error === "object" && !seen.has(error)) {
    if (error.name === "AbortError") return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

export function errorText(error, secrets = []) {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  return text.slice(0, 4000);
}

/** One agent per host. emit is ordered and applies stdout backpressure. */
export function createHost(sdk, emit, { apiKey, store, secrets = [] } = {}) {
  let agent;
  let options;
  let active;
  let opening = false;
  let opened = Promise.resolve();
  let closing = false;
  let recoverAbandonedRun = false;
  let sandboxPrimed;
  const localReadOptions = (cwd) => ({ runtime: "local", cwd, ...(store ? { store } : {}) });
  secrets.push(apiKey);
  const safeError = (error) => errorText(error, secrets);

  async function primeSandbox(cwd) {
    // Cursor caches sandbox availability per process. T3 primes the sandbox
    // before the first Full access run so a later restricted run still works.
    sandboxPrimed ??= (async () => {
      const platform = await sdk.createAgentPlatform({ workspaceRef: cwd });
      const release = await platform.prewarmLocalWorkspace({ apiKey, local: { cwd, settingSources: [], sandboxOptions: { enabled: true } } });
      await release();
    })().catch(() => undefined);
    await sandboxPrimed;
  }

  function idle() {
    if (closing) throw new Error("Cursor session is closing.");
    if (active || opening) throw new Error("Cursor is busy. Stop the turn before changing its settings.");
  }

  async function open(request) {
    idle();
    opening = true;
    const openingDone = Promise.withResolvers();
    opened = openingDone.promise;
    try {
      const local = { cwd: request.cwd, settingSources: SETTING_SOURCES, ...runtimePolicy(request.mode), enableAgentRetries: true, ...(store ? { store } : {}) };
      const next = { apiKey, model: modelSelection(request.model), mode: "agent", local, ...(request.mcpServers ? { mcpServers: request.mcpServers } : {}) };
      for (const server of Object.values(request.mcpServers ?? {})) {
        for (const value of Object.values(server.headers ?? {})) {
          secrets.push(value, value.replace(/^Bearer\s+/i, ""));
        }
      }
      if (!local.sandboxOptions.enabled) await primeSandbox(request.cwd);
      const previous = agent;
      const id = request.agentId ?? previous?.agentId;
      agent = id ? await sdk.Agent.resume(id, next) : await sdk.Agent.create(next);
      options = next;
      previous?.close();
      recoverAbandonedRun = !!id;
      if (closing) throw new Error("Cursor session is closing.");
      return { agentId: agent.agentId, model: request.model || "default" };
    } finally {
      opening = false;
      openingDone.resolve();
    }
  }

  async function cancelRun(turn) {
    turn.cancelled = true;
    if (!turn.run) return;
    try { await turn.run.cancel(); } catch (error) { if (!isAbort(error)) throw error; }
  }

  async function send(request) {
    idle();
    if (!agent) throw new Error("Open a Cursor session before sending a message.");
    const starting = Promise.withResolvers();
    const turn = { run: null, cancelled: false, ready: false, pending: [], pendingBytes: 0, updates: Promise.resolve(), done: null, started: starting.promise };
    active = turn;
    const dispatch = (update) => {
      // Serializing callbacks preserves provider order even when the SDK does
      // not await them, and completion waits for the final callback to flush.
      turn.updates = turn.updates.then(() => emit({ type: "update", runId: turn.run.id, update }));
      return turn.updates;
    };
    const onDelta = ({ update }) => {
      if (!turn.ready) {
        turn.pendingBytes += JSON.stringify(update).length;
        if (turn.pendingBytes > 16 * 1024 * 1024) throw new Error("Cursor emitted too much output before starting its run.");
        turn.pending.push(update);
        return;
      }
      return dispatch(update);
    };
    const start = () => agent.send(request.message, { model: options.model, mcpServers: options.mcpServers, onDelta });
    try {
      try { turn.run = await start(); } catch (error) {
        // T3 recovers a stale persisted run only on the first send after resume.
        // Never force every prompt: it could cancel a legitimately active run.
        if (!recoverAbandonedRun || !/already has active run/i.test(safeError(error))) throw error;
        recoverAbandonedRun = false;
        const readOptions = localReadOptions(options.local.cwd);
        const runs = await sdk.Agent.listRuns(agent.agentId, { ...readOptions, limit: 1 });
        const abandoned = runs.items.find((run) => run.status === "running");
        if (!abandoned) throw error;
        await sdk.Agent.cancelRun(abandoned.id, readOptions);
        turn.run = await start();
      }
      recoverAbandonedRun = false;
      await emit({ type: "run_started", runId: turn.run.id });
      // Queue buffered updates before opening the gate for new callbacks.
      for (const update of turn.pending) dispatch(update);
      turn.pending.length = 0;
      turn.ready = true;
      if (turn.cancelled || closing) await cancelRun(turn);
      turn.done = (async () => {
        try {
          const result = await turn.run.wait();
          await turn.updates;
          if (active === turn) active = null;
          await emit({ type: "run_completed", result: {
            id: result.id, status: turn.cancelled ? "cancelled" : result.status,
            result: result.result, usage: result.usage, durationMs: result.durationMs,
            ...(result.error ? { error: { message: safeError(result.error.message) } } : {}),
          } });
        } catch (error) {
          await turn.updates.catch(() => {});
          if (active === turn) active = null;
          if (turn.cancelled && isAbort(error)) {
            await emit({ type: "run_completed", result: { id: turn.run.id, status: "cancelled" } });
          } else {
            await emit({ type: "run_failed", error: safeError(error) });
          }
        }
      })();
      return { runId: turn.run.id };
    } catch (error) {
      if (active === turn) active = null;
      if (turn.run) await cancelRun(turn).catch(() => {});
      throw error;
    } finally {
      starting.resolve();
    }
  }

  async function close() {
    closing = true;
    await opened;
    if (active) {
      const turn = active;
      turn.cancelled = true;
      await turn.started;
      await cancelRun(turn);
      await turn.done;
    }
    agent?.close();
    agent = undefined;
  }

  return {
    close,
    safeError,
    async request(request) {
      switch (request.type) {
        case "open": return open(request);
        case "send": return send(request);
        case "cancel": if (active) await cancelRun(active); return {};
        case "set_model": idle(); if (!agent) throw new Error("Cursor session is not open."); options.model = modelSelection(request.model); return {};
        case "set_mode":
          if (!agent) throw new Error("Cursor session is not open.");
          return open({ cwd: options.local.cwd, model: request.model, mode: request.mode, mcpServers: options.mcpServers });
        case "list": return sdk.Agent.list({ ...localReadOptions(request.cwd), limit: 50, ...(request.cursor ? { cursor: request.cursor } : {}) });
        case "read": {
          const readOptions = localReadOptions(request.cwd);
          const info = await sdk.Agent.get(request.agentId, readOptions);
          const messages = [];
          // Bounded native history; never silently import a truncated thread.
          let bytes = 0;
          for (let offset = 0; ; offset += 100) {
            const page = await sdk.Agent.messages.list(request.agentId, { ...readOptions, offset, limit: 100 });
            bytes += JSON.stringify(page).length;
            if (bytes > 64 * 1024 * 1024) throw new Error("This Cursor transcript exceeds the 64 MB import limit.");
            messages.push(...page);
            if (page.length < 100) break;
          }
          return { info, messages };
        }
        case "close": await close(); return {};
        default: throw new Error(`Unknown Cursor SDK operation: ${request.type}`);
      }
    },
  };
}

async function loadSdk() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error("Cursor SDK requires Node.js 22.13 or newer.");
  const root = process.env.KYBERN_CURSOR_SDK_DIR;
  if (!root) throw new Error("Cursor SDK is not installed. Run `kybern cursor install`.");
  const manifest = JSON.parse(await readFile(join(root, "node_modules/@cursor/sdk/package.json"), "utf8"));
  if (manifest.version !== SDK_VERSION) throw new Error(`Kybern requires @cursor/sdk ${SDK_VERSION}. Run \`kybern cursor install\`.`);
  return createRequire(join(resolve(root), "package.json"))("@cursor/sdk");
}

async function main(mode) {
  // Capture the protocol writer before redirecting SDK console logging. Logs
  // and discovery must never corrupt stdout or include our request payloads.
  const write = (value) => new Promise((done, reject) => process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : done()));
  let writes = Promise.resolve();
  const emit = (value) => (writes = writes.then(() => write(value)));
  const log = (...args) => process.stderr.write(`${errorText(format(...args), runtimeSecrets)}\n`);
  console.log = console.info = console.debug = log;
  const sdk = await loadSdk();
  const credentialStore = new sdk.FileCredentialStore(process.env.KYBERN_CURSOR_AUTH_FILE);
  if (mode === "version") { await emit({ version: SDK_VERSION }); return; }
  if (mode === "login") {
    if (process.env.CURSOR_API_KEY?.trim()) throw new Error("CURSOR_API_KEY overrides browser sign-in. Remove it before signing in.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const result = await sdk.Cursor.auth.login({
      apiKeyName: "Kybern", store: credentialStore, signal: controller.signal,
      onLoginUrl: (url) => log(`Open this page to sign in to Cursor:\n${url}`),
    });
    await emit({ status: "logged-in", email: result.email, apiKeyExpiresAtMs: result.apiKeyExpiresAtMs });
    return;
  }
  if (mode === "logout") { await sdk.Cursor.auth.logout({ store: credentialStore }); await emit({ status: "logged-out" }); return; }
  if (mode === "status") {
    await emit(process.env.CURSOR_API_KEY?.trim() ? { status: "api-key", source: "CURSOR_API_KEY" } : await sdk.Cursor.auth.status({ store: credentialStore }));
    return;
  }
  const saved = await credentialStore.load();
  const apiKey = process.env.CURSOR_API_KEY?.trim() || (saved && (!saved.apiKeyExpiresAtMs || saved.apiKeyExpiresAtMs > Date.now()) ? saved.apiKey : undefined);
  runtimeSecrets.push(apiKey);
  const store = process.env.KYBERN_CURSOR_STATE_DIR ? new sdk.JsonlLocalAgentStore(process.env.KYBERN_CURSOR_STATE_DIR) : undefined;
  if (mode === "probe") {
    if (!apiKey) throw new Error("Sign in with `kybern cursor login` or set CURSOR_API_KEY in Cursor provider settings. Cursor CLI sign-in is separate.");
    const models = await sdk.Cursor.models.list({ apiKey });
    await emit({ version: SDK_VERSION, models: modelCatalog(models) });
    return;
  }
  if (mode !== "stdio") throw new Error(`Unknown Cursor SDK host mode: ${mode}`);
  const host = createHost(sdk, emit, { apiKey, store, secrets: runtimeSecrets });
  let stopping;
  const stop = () => (stopping ??= host.close().finally(async () => { await writes; process.exit(0); }));
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    void (async () => {
      let request;
      try {
        if (line.length > 32 * 1024 * 1024) throw new Error("Cursor SDK request exceeds the 32 MB limit.");
        request = JSON.parse(line);
        if (request.type === "open" && !apiKey) throw new Error("Sign in with `kybern cursor login` or set CURSOR_API_KEY in Cursor provider settings.");
        const result = await host.request(request);
        await emit({ id: request.id, result });
        if (request.type === "close") await stop();
      } catch (error) {
        await emit({ id: request?.id, error: host.safeError(error) });
      }
    })().catch((error) => { log(host.safeError(error)); process.exit(1); });
  });
  input.once("close", () => void stop());
}

// Tests import the host without loading the SDK or touching credentials.
if (process.argv[2] === "--kybern-cursor-sdk") {
  try { await main(process.argv[3]); }
  catch (error) { process.stderr.write(`${errorText(error, runtimeSecrets)}\n`); process.exitCode = 1; }
}
