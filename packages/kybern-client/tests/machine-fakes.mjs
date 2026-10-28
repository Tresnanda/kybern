// Fakes for the machine set tests: a manual clock and a small world of
// machines behind URLs, with no sockets, no HTTP and no real crypto.
const decoder = new TextDecoder();

export function manualClock(start = Date.parse("2026-10-28T10:00:00Z")) {
  let now = start;
  let timers = [];
  let seq = 0;
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const timer = { fn, at: now + ms, id: seq++ };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers = timers.filter((t) => t !== timer);
    },
    pending: () => timers.length,
    async advance(ms) {
      const target = now + ms;
      await flush();
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = Math.max(now, due.at);
        due.fn();
        await flush();
      }
      now = target;
      await flush();
    },
    flush,
  };
}

export function memoryStore(initial = []) {
  const store = {
    records: structuredClone(initial),
    saves: 0,
    load: () => structuredClone(store.records),
    save(records) {
      store.records = structuredClone(records);
      store.saves++;
    },
  };
  return store;
}

export function memoryCredentials(initial = {}) {
  const tokens = new Map(Object.entries(initial));
  return {
    tokens,
    get: (id) => tokens.get(id),
    set: (id, token) => void tokens.set(id, token),
    delete: (id) => void tokens.delete(id),
  };
}

export function memoryCacheStorage(text) {
  const storage = { text, writes: 0, read: () => storage.text, write: (t) => ((storage.text = t), storage.writes++) };
  return storage;
}

/** Proof = the signing key plus the exact signed message, so only the key's holder could have made it. */
export const verifyProof = ({ signingKey, proof, message }) => proof === `sig|${signingKey}|${decoder.decode(message)}`;

export class FakeClient {
  constructor(world, host, route, token) {
    this.world = world;
    this.host = host;
    this.route = route;
    this.token = token;
    this.endpoint = { url: route.url, token, environmentId: host.machineId };
    this.status = "idle";
    this.info = null;
    this.statuses = new Set();
    this.notifications = new Map();
    this.subscriptions = [];
    this.closed = false;
    this.calls = [];
  }
  setStatus(status, detail) {
    this.status = status;
    for (const fn of [...this.statuses]) fn(status, detail);
  }
  connect() {
    queueMicrotask(() => {
      if (this.closed) return;
      if (this.host.rejectToken && this.host.rejectToken(this.token)) return this.setStatus("failed", "Access was revoked. Pair this environment again");
      if (!this.host.online) return; // never opens: the machine set's timeout decides
      this.info = { ...this.host.info };
      this.setStatus("open");
    });
  }
  close() {
    this.closed = true;
    this.subscriptions = [];
    this.status = "closed";
  }
  onStatus(fn) {
    this.statuses.add(fn);
    return () => this.statuses.delete(fn);
  }
  onNotification(method, fn) {
    const set = this.notifications.get(method) ?? new Set();
    set.add(fn);
    this.notifications.set(method, set);
    return () => set.delete(fn);
  }
  notify(method, params) {
    for (const fn of this.notifications.get(method) ?? []) fn(params);
  }
  async checkConnection() {}
  async call(method, params) {
    this.calls.push([method, params]);
    const handler = this.world.handlers[this.host.machineId]?.[method];
    if (!handler) throw new Error(`no handler for ${method} on ${this.host.machineId}`);
    return handler(params, this);
  }
  async callRaw(method, params) {
    return this.call(method, params);
  }
  subscribeEvents(params, handler, onSubscribed, onReady) {
    const sub = { params, handler, onSubscribed, onReady, lastSeq: params.after_seq };
    this.subscriptions.push(sub);
    return {
      unsubscribe: () => (this.subscriptions = this.subscriptions.filter((s) => s !== sub)),
      get lastSeq() {
        return sub.lastSeq;
      },
    };
  }
  emit(seq) {
    for (const sub of this.subscriptions) {
      sub.lastSeq = seq;
      sub.handler({ seq });
    }
  }
}

/**
 * Machines behind URLs. `host(url, machineId, opts)` makes `url` answer as that
 * machine. `answers` records every probe and every client the set created, in order.
 */
export function fakeWorld(clock) {
  const world = {
    hosts: new Map(),
    handlers: {},
    probes: [],
    clients: [],
    nonceCount: 0,
    host(url, machineId, options = {}) {
      const base = url.replace(/\/+$/, "");
      const host = {
        url: base,
        machineId,
        key: options.key ?? `key-${machineId}`,
        online: options.online ?? true,
        info: {
          version: "0.20.0",
          protocol_version: 1,
          environment_id: machineId,
          machine_id: machineId,
          features: options.features ?? ["network.v1", "relay.v1"],
          ...options.info,
        },
        // Answer with someone else's identity at this address.
        answerAs: options.answerAs,
        rejectToken: options.rejectToken,
        staleBy: options.staleBy,
      };
      world.hosts.set(base, host);
      return host;
    },
    lists(machineId, projects, threads) {
      world.handlers[machineId] ??= {};
      world.handlers[machineId]["projects.list"] = () => ({ projects });
      world.handlers[machineId]["threads.list"] = () => ({ threads });
    },
    on(machineId, method, fn) {
      world.handlers[machineId] ??= {};
      world.handlers[machineId][method] = fn;
    },
    transport: {
      nonce: () => `nonce-${world.nonceCount++}`,
      async probe(url) {
        world.probes.push(url);
        const parsed = new URL(url);
        // A relay's identity document is served under /relay/<id>/http/.
        const path = parsed.pathname.replace(/\/http\/\.well-known\/kybern\/machine$/, "").replace(/\/\.well-known\/kybern\/machine$/, "");
        const host = world.hosts.get(`${parsed.protocol}//${parsed.host}${path}`);
        if (!host || !host.online) throw new Error("no answer");
        const nonce = parsed.searchParams.get("nonce");
        const machineId = host.answerAs?.machineId ?? host.machineId;
        const key = host.answerAs?.key ?? host.key;
        const at = new Date(clock.now() - (host.staleBy ?? 0)).toISOString();
        const message = `kybern-wk-v1\0${nonce}${machineId}${at}${parsed.host}`;
        return { machine_id: machineId, name: machineId, os: "linux", signing_key: key, at, proof: `sig|${key}|${message}` };
      },
      createClient({ record, route, token }) {
        const parsed = new URL(route.url);
        const path = parsed.pathname.replace(/\/ws$/, "").replace(/\/$/, "");
        const host = world.hosts.get(`${parsed.protocol}//${parsed.host}${path}`.replace(/^ws/, "http")) ?? world.hosts.get(`http://${parsed.host}${path}`);
        const client = new FakeClient(world, host ?? { machineId: record.machineId, online: false, info: {} }, route, token);
        world.clients.push({ machineId: record.machineId, url: route.url, token, client });
        return client;
      },
    },
  };
  return world;
}
