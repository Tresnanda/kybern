// The official Cursor SDK runs in this process, never in the Kybern daemon.
// Keep the SDK package on disk: its lazy chunks and platform helpers cannot be
// folded into our Rust binary. Rust embeds this small host, not the SDK.
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { format } from "node:util";

export const SDK_VERSION = "1.2.0";
export const SETTING_SOURCES = ["project", "user", "team", "mdm", "plugins"];
const runtimeSecrets = [process.env.CURSOR_API_KEY];
const processStarted = performance.now();
function timing(phase, started, extra = {}) {
  process.stderr.write(`cursor_timing ${JSON.stringify({phase, ms: Math.round((performance.now() - started) * 100) / 100, ...extra})}\n`);
}

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
const EFFORT_PARAMS = new Set(["effort", "reason_effort", "reasoning_effort", "reasoningEffort", "reasoning"]);
const selectorFor = (selection) => `cursor-model:${Buffer.from(JSON.stringify(selection)).toString("base64url")}`;

export function modelSelection(selector, effort) {
  if (!selector || selector === "auto" || selector === "default") {
    if (effort) throw new Error("Select a model with an effort control first.");
    return { id: "default" };
  }
  if (selector.startsWith("cursor-model:")) {
    const parsed = JSON.parse(Buffer.from(selector.slice(13), "base64url").toString("utf8"));
    if (!parsed || typeof parsed.id !== "string" || !Array.isArray(parsed.params) ||
        parsed.params.some((p) => typeof p.id !== "string" || typeof p.value !== "string")) {
      throw new Error("Invalid Cursor model variant. Refresh the model list and select it again.");
    }
    const legacyEffort = parsed.params.find((p) => EFFORT_PARAMS.has(p.id));
    const effortParam = parsed.effortParam ?? legacyEffort?.id;
    // Old catalogs copied this hidden, constant SDK default into every Opus
    // selector. It was never a user choice. Keep all explicit context/fast values.
    const params = parsed.params.filter((p) => !(p.id === "cyber" && p.value === "false") &&
      !parsed.defaultParams?.some((value) => value.id === p.id && value.value === p.value) &&
      (!effort || !EFFORT_PARAMS.has(p.id))).map((p) => ({ ...p }));
    if (effort) {
      if (!EFFORT_PARAMS.has(effortParam) || (parsed.effortValues && !parsed.effortValues.includes(effort))) {
        throw new Error("This Cursor model does not offer that effort. Refresh models and select an available effort.");
      }
      params.push({ id: effortParam, value: effort });
    }
    return { id: parsed.id, ...(params.length ? { params } : {}) };
  }
  if (effort) throw new Error("This Cursor model has no effort control.");
  return { id: selector };
}

const ON_VALUES = { true: "false", on: "off" };
const sentence = (text) => { const words = text.replaceAll("_", " ").trim(); return /^zdr$/i.test(words) ? "ZDR" : words.charAt(0).toUpperCase() + words.slice(1); };
function valueLabel(parameter, value, named) {
  // Cursor sends sizes as `300k`/`1m` or as plain numbers; show `300K`/`1M`.
  if (/context/i.test(parameter)) return value.replace(/000000$/, "M").replace(/000$/, "K").replace(/[km]$/, (unit) => unit.toUpperCase());
  if (value === "true" || value === "on") return "On";
  if (value === "false" || value === "off") return "Off";
  if (value === "xhigh") return "X-High";
  return named || sentence(value);
}

/**
 * One row per model. Parameters other than effort become structured traits
 * (`parameters`) and each combination that exists is a `variants` entry whose
 * id is the selector the session receives, so the picker never lists a row
 * per combination. The row's own id is the default combination's selector.
 */
export function modelCatalog(models) {
  const out = [{ id: "default", display_name: "Default", description: "Cursor’s default model", is_default: true, efforts: [] }];
  for (const model of models) {
    if (model.id === "default") continue;
    const base = model.displayName || model.id;
    const groups = new Map();
    for (const variant of model.variants ?? []) {
      if (!variant.params?.length) continue;
      const effort = variant.params.find((p) => EFFORT_PARAMS.has(p.id));
      const params = variant.params.filter((p) => !EFFORT_PARAMS.has(p.id));
      const key = JSON.stringify([...params].sort((a, b) => a.id.localeCompare(b.id))) + (effort?.id ?? "");
      let group = groups.get(key);
      if (!group) {
        group = { params, effortParam: effort?.id, efforts: [], isDefault: false, allMax: true };
        groups.set(key, group);
      }
      group.isDefault ||= !!variant.isDefault;
      group.allMax &&= !!variant.isMaxMode;
      if (effort && !group.efforts.includes(effort.value)) group.efforts.push(effort.value);
    }
    if (!groups.size) {
      const id = model.aliases?.length ? selectorFor({id:model.id,params:[],nativeParams:[],maxMode:false,aliases:model.aliases}) : model.id;
      out.push({ id, ...(id !== model.id ? {resolved_id:model.id} : {}), display_name: base, description: model.description, is_default: false, efforts: [] });
      continue;
    }
    const list = [...groups.values()];
    const initial = list.find((g) => g.isDefault) ?? list[0];

    // Parameter order and labels come from the SDK; values seen only in
    // variants are appended. A variant that omits a parameter is its off state.
    const declared = new Map((model.parameters ?? []).map((p) => [p.id, p]));
    const order = [];
    const seen = new Map();
    for (const group of list) for (const { id, value } of group.params) {
      if (!seen.has(id)) { seen.set(id, new Set()); order.push(id); }
      seen.get(id).add(value);
    }
    const missing = (id) => list.some((g) => !g.params.some((p) => p.id === id));
    const absent = (id) => {
      const values = [...seen.get(id)];
      return values.length && values.every((v) => v in ON_VALUES) ? ON_VALUES[values[0]] : "default";
    };
    const parameters = [];
    for (const id of order) {
      const def = declared.get(id);
      const values = [...seen.get(id)];
      if (missing(id)) values.push(absent(id));
      const known = (def?.values ?? []).map((v) => v.value).filter((v) => values.includes(v));
      const sorted = [...known, ...values.filter((v) => !known.includes(v))];
      if (sorted.length < 2) continue;
      const named = new Map((def?.values ?? []).map((v) => [v.value, v.displayName]));
      const initialValue = initial.params.find((p) => p.id === id)?.value ?? absent(id);
      parameters.push({
        id, label: def?.displayName || sentence(id), default: initialValue,
        values: sorted.map((value) => ({ value, label: value === "default" ? "Default" : valueLabel(id, value, named.get(value)) })),
      });
    }

    const variantFor = (group) => {
      const defaultEffort = group.efforts.includes("medium") ? "medium" : group.efforts[0];
      // Only traits different from the native default are explicit choices.
      // Constant hidden SDK parameters (e.g. cyber=false) have no picker control.
      const defaultParams = group.params.filter((p) => !parameters.some((parameter) => parameter.id === p.id) ||
        initial.params.find((value) => value.id === p.id)?.value === p.value);
      // Keep full params in the opaque ID so existing clients still recognize
      // saved selectors. defaultParams records what Kybern inferred, not chose.
      const selection = { id: model.id, params: group.params, defaultParams, nativeParams: group.params, maxMode: group.allMax, ...(model.aliases?.length ? {aliases:model.aliases} : {}),
        ...(group.effortParam ? { effortParam: group.effortParam, effortValues: group.efforts, defaultEffort } : {}) };
      const values = {};
      for (const { id } of parameters) values[id] = group.params.find((p) => p.id === id)?.value ?? absent(id);
      return { id: selectorFor(selection), params: values, efforts: group.efforts, default_effort: defaultEffort };
    };
    const variants = list.map(variantFor);
    const first = variants[list.indexOf(initial)];
    out.push({
      id: first.id, display_name: base, resolved_id: model.id, description: model.description, is_default: false,
      efforts: first.efforts, ...(first.default_effort ? { default_effort: first.default_effort } : {}),
      ...(parameters.length ? { parameters, variants } : {}),
    });
  }
  return out;
}

export function modelError(error, selection) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/invalid parameters|model not found|unsupported.*(?:model|parameter)|invalid.*(?:model|parameter)/i.test(message)) return error;
  const settings = selection.params?.map(({ id, value }) => `${id}=${value}`).join(", ");
  return new Error(`Cursor rejected model "${selection.id}"${settings ? ` with ${settings}` : ""}: ${message}. ` +
    (settings ? "Change the named context, fast, or effort setting in the model picker and try again." : "Refresh models and select an available model."));
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

/** One agent per logical session. emit is ordered and applies stdout backpressure. */
export function createHost(sdk, emit, { apiKey, store, secrets = [], shared = {}, sessionId } = {}) {
  let agent;
  let options;
  let modelSelector;
  let selectedEffort;
  let active;
  let opening = false;
  let opened = Promise.resolve();
  let closing = false;
  let recoverAbandonedRun = false;
  let warmRelease;
  let warming;
  let warmPending = 0;
  const localReadOptions = (cwd) => ({ runtime: "local", cwd, ...(store ? { store } : {}) });
  secrets = [...new Set([...secrets, apiKey])];
  const remember = (...values) => { for (const value of values) if (value && !secrets.includes(value)) secrets.push(value); };
  const trace = (phase, started, extra) => timing(phase, started, {...(sessionId ? {session:sessionId} : {}), ...extra});
  const safeError = (error) => errorText(error, secrets);

  let currentPlatform;
  function releasePlatform() {
    if (!currentPlatform) return;
    const {cwd,entry} = currentPlatform;
    if (--entry.refs === 0 && shared.platforms.get(cwd) === entry) shared.platforms.delete(cwd);
    currentPlatform = undefined;
  }
  function platformFor(cwd) {
    if (currentPlatform?.cwd === cwd) return currentPlatform.entry.loading;
    releasePlatform();
    shared.platforms ??= new Map();
    let entry = shared.platforms.get(cwd);
    if (!entry) {
      entry = {refs:0,loading:sdk.createAgentPlatform({workspaceRef:cwd, ...(store ? {localStore:store} : {})})};
      shared.platforms.set(cwd, entry);
      entry.loading.catch(()=>{ if (shared.platforms.get(cwd) === entry) shared.platforms.delete(cwd); });
    }
    entry.refs++;
    currentPlatform = {cwd,entry};
    return entry.loading;
  }

  async function primeSandbox(cwd) {
    // Cursor caches sandbox availability per process. T3 primes the sandbox
    // before the first Full access run so a later restricted run still works.
    shared.sandboxPrimed ??= (async () => {
      const platform = await platformFor(cwd);
      const release = await platform.prewarmLocalWorkspace({ apiKey, local: { cwd, settingSources: [], sandboxOptions: { enabled: true } } });
      await release();
    })().catch(() => undefined);
    await shared.sandboxPrimed;
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
      const checkStarted = performance.now();
      const platform = await platformFor(request.cwd);
      const requested = modelSelection(request.model, request.effort);
      let selected;
      try { selected = await platform.resolveLocalModelSelection(requested, apiKey); }
      catch (error) { throw modelError(error, requested); }
      trace("model_check", checkStarted);
      const next = { apiKey, model: selected, mode: "agent", local, ...(request.mcpServers ? { mcpServers: request.mcpServers } : {}) };
      for (const server of Object.values(request.mcpServers ?? {})) {
        for (const value of Object.values(server.headers ?? {})) {
          remember(value, value.replace(/^Bearer\s+/i, ""));
        }
      }
      if (!local.sandboxOptions.enabled) await primeSandbox(request.cwd);
      const previous = agent;
      const id = request.agentId ?? previous?.agentId;
      const previousWarm = warming;
      // Hold the lease until close. Releasing it immediately discards the
      // executor and moves the same scan back into the first send.
      warmPending++;
      warming = (async () => {
        await previousWarm;
        const warmStarted = performance.now();
        const release = await platform.prewarmLocalWorkspace(next);
        trace("prewarm", warmStarted);
        const previousRelease = warmRelease;
        warmRelease = release;
        await previousRelease?.();
      })().catch((error) => trace("prewarm_failed", performance.now(), {error: safeError(error)})).finally(()=>warmPending--);
      const createStarted = performance.now();
      try { agent = id ? await platform.resumeAgent(id, next) : await platform.createAgent(next); }
      catch (error) { throw modelError(error, next.model); }
      finally { trace("agent_creation", createStarted, {resume: !!id}); }
      options = next;
      modelSelector = request.model;
      selectedEffort = request.effort;
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
    const sendStarted = performance.now();
    let firstEvent = true;
    const starting = Promise.withResolvers();
    const turn = { run: null, prewarming: true, cancelled: false, ready: false, pending: [], pendingBytes: 0, updates: Promise.resolve(), done: null, started: starting.promise };
    active = turn;
    const dispatch = (update) => {
      // Serializing callbacks preserves provider order even when the SDK does
      // not await them, and completion waits for the final callback to flush.
      turn.updates = turn.updates.then(() => emit({ type: "update", runId: turn.run.id, update }));
      return turn.updates;
    };
    const onDelta = ({ update }) => {
      if (firstEvent) { firstEvent = false; trace("first_event", sendStarted); }
      if (!turn.ready) {
        turn.pendingBytes += JSON.stringify(update).length;
        if (turn.pendingBytes > 16 * 1024 * 1024) throw new Error("Cursor emitted too much output before starting its run.");
        turn.pending.push(update);
        return;
      }
      return dispatch(update);
    };
    await warming;
    turn.prewarming = false;
    const start = () => agent.send(request.message, { model: options.model, mcpServers: options.mcpServers, onDelta });
    try {
      // An interrupt received while prewarming has not admitted a prompt.
      // Do not start a billable run merely to cancel it immediately afterwards.
      if (turn.cancelled || closing) {
        if (active === turn) active = null;
        return {cancelled:true};
      }
      try { turn.run = await start(); } catch (error) {
        // T3 recovers a stale persisted run only on the first send after resume.
        // Never force every prompt: it could cancel a legitimately active run.
        if (!recoverAbandonedRun || !/already has active run/i.test(safeError(error))) throw modelError(error, options.model);
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
      if (!turn.prewarming) {
        await turn.started;
        await cancelRun(turn);
        await turn.done;
      } else if (active === turn) {
        active = null;
      }
    }
    agent?.close();
    agent = undefined;
    const release = async () => {
      await warming;
      await warmRelease?.();
      warmRelease = undefined;
      releasePlatform();
    };
    // SDK prewarm has no cancellation API. Release its eventual lease in the
    // background so closing an unused session cannot time out a sibling's host.
    if (warmPending) void release().catch((error)=>trace("prewarm_release_failed",performance.now(),{error:safeError(error)}));
    else await release();
  }

  return {
    close,
    safeError,
    async request(request) {
      switch (request.type) {
        case "open": return open(request);
        case "send": return send(request);
        case "cancel": if (active) await cancelRun(active); return {};
        case "set_model": idle(); if (!agent) throw new Error("Cursor session is not open."); options.model = modelSelection(request.model); modelSelector = request.model; selectedEffort = undefined; return {};
        case "set_effort": idle(); if (!agent) throw new Error("Cursor session is not open."); options.model = modelSelection(modelSelector, request.effort); selectedEffort = request.effort; return {};
        case "set_mode":
          if (!agent) throw new Error("Cursor session is not open.");
          return open({ cwd: options.local.cwd, model: request.model ?? modelSelector, effort: selectedEffort, mode: request.mode, mcpServers: options.mcpServers });
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

/** Rehydrate the SDK catalog without losing its max-mode resolution rules. */
export function nativeCatalog(models) {
  if (!Array.isArray(models)) return undefined;
  const out = [];
  for (const model of models) {
    if (model.id === "default") { out.push({id:"default",displayName:"Default"}); continue; }
    const selectors = model.variants?.length ? model.variants.map((variant) => variant.id) : [model.id];
    const variants = [];
    let id = model.resolved_id || model.id;
    let aliases;
    for (const selector of selectors) {
      if (!selector.startsWith("cursor-model:")) continue;
      const selection = JSON.parse(Buffer.from(selector.slice(13), "base64url").toString("utf8"));
      // Older caches did not preserve native max-mode metadata. Discover once
      // rather than inventing it (or silently sending a smaller context).
      if (!Array.isArray(selection.nativeParams) || typeof selection.maxMode !== "boolean") return undefined;
      id = selection.id;
      aliases = selection.aliases;
      for (const effort of selection.effortValues?.length ? selection.effortValues : [undefined]) {
        variants.push({params: [...selection.nativeParams, ...(effort ? [{id:selection.effortParam,value:effort}] : [])],isMaxMode:selection.maxMode});
      }
    }
    out.push({id,displayName:model.display_name, ...(aliases?.length ? {aliases} : {}), ...(variants.length ? {variants} : {})});
  }
  return out;
}

/** Each logical session owns its agent, MCP capability, run, and warm lease. */
export function createAccountHost(sdk, emit, options = {}) {
  options.secrets ??= [];
  options.secrets.push(options.apiKey);
  const sessions = new Map();
  const shared = {};
  const environment = new AsyncLocalStorage();
  // Node resolves child-process env through this object. Async-local reads
  // keep askpass capabilities scoped even when account agents run concurrently.
  // No per-thread capability is ever written to the host's ambient environment.
  const ambient = process.env;
  const scopedKeys = new Set(["SUDO_ASKPASS", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "GIT_ASKPASS", "GIT_TERMINAL_PROMPT", "KYBERN_ASKPASS_URL", "KYBERN_ASKPASS_TOKEN"]);
  const env = new Proxy(ambient, {
    set(target,key,value) {
      if (scopedKeys.has(key)) {
        const scope = environment.getStore();
        if (scope) scope[key] = String(value);
        return true;
      }
      return Reflect.set(target,key,value,target);
    },
    get(target, key) { return scopedKeys.has(key) ? environment.getStore()?.[key] : Reflect.get(target, key); },
    ownKeys(target) { return [...new Set([...Reflect.ownKeys(target), ...Object.keys(environment.getStore() ?? {})])]; },
    getOwnPropertyDescriptor(target, key) {
      if (scopedKeys.has(key)) {
        const value = environment.getStore()?.[key];
        return value === undefined ? undefined : {value, writable:true, enumerable:true, configurable:true};
      }
      return Reflect.getOwnPropertyDescriptor(target,key);
    },
  });
  process.env = env;
  return {
    safeError: (error) => [...sessions.values()].reduce((message,session)=>session.host.safeError(message), errorText(error, options.secrets)),
    async close() {
      await Promise.all([...sessions.values()].map(({host,env}) => environment.run(env,()=>host.close())));
      sessions.clear();
      if (process.env === env) process.env = ambient;
    },
    async request(request) {
      if (request.type === "shutdown") { await this.close(); return {}; }
      if (request.type === "catalog") {
        const catalog=nativeCatalog(request.catalog);
        if (catalog) {
          shared.catalog=Promise.resolve(catalog);
          process.env.CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON=JSON.stringify(catalog);
        }
        return {};
      }
      const id = request.session ?? "default";
      let session = sessions.get(id);
      if (!session) {
        if (!["open","list","read"].includes(request.type)) throw new Error("Cursor session is not open.");
        const env = Object.fromEntries(Object.entries(request.env ?? {}).filter(([key])=>scopedKeys.has(key)));
        session = {env, host:createHost(sdk, (value)=>emit({...value,session:id}), {...options,shared,sessionId:id,secrets:[...options.secrets,env.KYBERN_ASKPASS_TOKEN]})};
        sessions.set(id,session);
      }
      if (request.type === "open") {
        const started = performance.now();
        const cached = request.catalog && nativeCatalog(request.catalog);
        if (cached) shared.catalog = Promise.resolve(cached);
        shared.catalog ??= sdk.Cursor.models.list({apiKey:options.apiKey}).catch((error) => { shared.catalog = undefined; throw error; });
        process.env.CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON = JSON.stringify(await shared.catalog);
        timing("model_catalog", started, {session:id,cached:!!cached});
      }
      let result;
      try { result = await environment.run(session.env,()=>session.host.request(request)); }
      catch (error) { throw new Error(session.host.safeError(error)); }
      if (request.type === "close") sessions.delete(id);
      return result;
    },
  };
}

async function loadSdk() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error("Cursor SDK requires Node.js 22.13 or newer.");
  const root = process.env.KYBERN_CURSOR_SDK_DIR;
  if (!root) throw new Error("Cursor’s SDK isn’t installed. Install it in Settings → Agent providers, or run `kybern cursor install`.");
  const manifest = JSON.parse(await readFile(join(root, "node_modules/@cursor/sdk/package.json"), "utf8"));
  if (manifest.version !== SDK_VERSION) throw new Error(`Kybern requires @cursor/sdk ${SDK_VERSION}. Install it in Settings → Agent providers, or run \`kybern cursor install\`.`);
  return createRequire(join(resolve(root), "package.json"))("@cursor/sdk");
}

async function main(mode) {
  // Capture the protocol writer before redirecting SDK console logging. Logs
  // and discovery must never corrupt stdout or include our request payloads.
  const write = (value) => new Promise((done, reject) => process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : done()));
  let writes = Promise.resolve();
  const emit = (value) => (writes = writes.then(() => write(value)));
  let sanitize = (error) => errorText(error, runtimeSecrets);
  const log = (...args) => process.stderr.write(`${sanitize(format(...args))}\n`);
  console.log = console.info = console.debug = log;
  timing("node_start", processStarted, {uptimeMs: Math.round(process.uptime() * 1000)});
  const sdkStarted = performance.now();
  const sdk = await loadSdk();
  timing("sdk_load", sdkStarted);
  const credentialStore = new sdk.FileCredentialStore(process.env.KYBERN_CURSOR_AUTH_FILE);
  if (mode === "version") { await emit({ version: SDK_VERSION }); return; }
  if (mode === "login") {
    if (process.env.CURSOR_API_KEY?.trim()) throw new Error("CURSOR_API_KEY overrides browser sign-in. Remove it before signing in.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    // The daemon may run on another machine, so it relays the page to the
    // client that asked instead of opening a browser here.
    const relay = process.env.KYBERN_CURSOR_LOGIN_EVENTS === "1";
    const result = await sdk.Cursor.auth.login({
      apiKeyName: "Kybern", store: credentialStore, signal: controller.signal,
      ...(relay ? { openBrowser: false } : {}),
      onLoginUrl: (url) => relay ? void emit({ status: "login-url", url }) : log(`Open this page to sign in to Cursor:\n${url}`),
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
    if (!apiKey) throw new Error("Sign in to Cursor in Settings → Agent providers, or run `kybern cursor login`. Signing in to the Cursor app or CLI doesn’t carry over.");
    const models = await sdk.Cursor.models.list({ apiKey });
    await emit({ version: SDK_VERSION, models: modelCatalog(models) });
    return;
  }
  if (mode !== "stdio") throw new Error(`Unknown Cursor SDK host mode: ${mode}`);
  const host = createAccountHost(sdk, emit, { apiKey, store, secrets: runtimeSecrets });
  sanitize = host.safeError;
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
        if (request.type === "open" && !apiKey) throw new Error("Sign in to Cursor in Settings → Agent providers, or run `kybern cursor login`.");
        const result = await host.request(request);
        await emit({ id: request.id, result });
        if (request.type === "shutdown") await stop();
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
