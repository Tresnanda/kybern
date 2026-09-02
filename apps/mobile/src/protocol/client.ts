// JSON-RPC 2.0 over WebSocket client for the kybern daemon.
//
// - Numeric request ids, one pending map, rejects on close.
// - Reconnects with exponential backoff + jitter until `close()`.
// - Notifications dispatched by method name.
// - Event subscriptions survive reconnects: they are re-issued with
//   `after_seq = last seq seen`, so the daemon replays the gap. The same path
//   handles `events.lagged` (daemon dropped live events; resubscribe).

import {
  AUTH_QUERY_PARAM,
  EVENTS_LAGGED_NOTIFICATION,
  EVENT_NOTIFICATION,
  type EventNotification,
  type EventsSubscribeParams,
  type MethodName,
  type ParamsOf,
  type ResultOf,
  type RpcError,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
  type ServerFrame,
  type SubscriptionId,
  type ThreadEvent,
} from "./types";

export interface Endpoint {
  /** e.g. `ws://100.64.0.1:4173/ws` */
  url: string;
  token: string;
}

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export class RpcCallError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(err: RpcError) {
    super(err.message);
    this.name = "RpcCallError";
    this.code = err.code;
    this.data = err.data;
  }
}

export class ConnectionClosedError extends Error {
  constructor(message = "Connection closed") {
    super(message);
    this.name = "ConnectionClosedError";
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };
type NotificationHandler = (params: unknown) => void;
type StatusHandler = (status: ConnectionStatus, detail?: string) => void;
export type EventHandler = (event: ThreadEvent) => void;

interface EventSubscription {
  params: EventsSubscribeParams;
  handler: EventHandler;
  /** Last seq delivered to the handler. Used as `after_seq` on resubscribe. */
  lastSeq: number | undefined;
  /** Daemon-side id for the current socket, undefined while (re)subscribing. */
  remoteId: SubscriptionId | undefined;
  /** Called when a resubscribe completes, with `head_seq`. */
  onResubscribed?: (headSeq: number) => void;
}

export interface Subscription {
  /** Stop receiving events and tell the daemon (best effort). */
  unsubscribe(): void;
  /** Last event seq delivered. */
  readonly lastSeq: number | undefined;
}

// React Native's WebSocket accepts a third `options.headers` argument.
type RNWebSocketCtor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;

export class KybernClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly subscriptions = new Map<number, EventSubscription>();
  private readonly byRemoteId = new Map<SubscriptionId, EventSubscription>();
  private nextLocalSubId = 1;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _status: ConnectionStatus = "idle";
  private closedByUser = false;

  constructor(readonly endpoint: Endpoint) {}

  get status(): ConnectionStatus {
    return this._status;
  }

  /** Open the socket. Safe to call once; reconnects happen internally. */
  connect(): void {
    this.closedByUser = false;
    if (this.ws) return;
    this.open();
  }

  /** Close for good. Pending calls reject, subscriptions are dropped. */
  close(): void {
    this.closedByUser = true;
    this.clearReconnect();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.failPending(new ConnectionClosedError());
    this.subscriptions.clear();
    this.byRemoteId.clear();
    this.setStatus("closed");
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  /** Typed request. Rejects with RpcCallError on a JSON-RPC error. */
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    return this.callRaw(method, params) as Promise<ResultOf<M>>;
  }

  callRaw(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ConnectionClosedError("Not connected"));
    }
    const id = this.nextId++;
    const req: RpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        ws.send(JSON.stringify(req));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Subscribe to thread events. Replays from `after_seq` now and from the last
   * delivered seq after any reconnect or `events.lagged`.
   */
  subscribeEvents(
    params: EventsSubscribeParams,
    handler: EventHandler,
    onResubscribed?: (headSeq: number) => void,
  ): Subscription {
    const localId = this.nextLocalSubId++;
    const sub: EventSubscription = {
      params,
      handler,
      lastSeq: params.after_seq,
      remoteId: undefined,
      onResubscribed,
    };
    this.subscriptions.set(localId, sub);
    if (this._status === "open") void this.issueSubscribe(sub, false);
    return {
      unsubscribe: () => {
        this.subscriptions.delete(localId);
        const remote = sub.remoteId;
        sub.remoteId = undefined;
        if (remote) {
          this.byRemoteId.delete(remote);
          if (this._status === "open") {
            this.call("events.unsubscribe", { subscription_id: remote }).catch(() => {});
          }
        }
      },
      get lastSeq() {
        return sub.lastSeq;
      },
    };
  }

  // ---- internals ----

  private open(): void {
    if (this.closedByUser) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      const Ctor = WebSocket as unknown as RNWebSocketCtor;
      ws = new Ctor(this.endpoint.url, null, {
        headers: { authorization: `Bearer ${this.endpoint.token}` },
      });
    } catch (e) {
      this.scheduleReconnect(e instanceof Error ? e.message : String(e));
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setStatus("open");
      for (const sub of this.subscriptions.values()) void this.issueSubscribe(sub, true);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.handleFrame(typeof ev.data === "string" ? ev.data : String(ev.data));
    };
    ws.onerror = (ev) => {
      if (this.ws !== ws) return;
      const message = (ev as { message?: string }).message;
      this.lastError = message;
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const reason = ev.reason || this.lastError || (ev.code === 1006 ? "Connection dropped" : undefined);
      this.lastError = undefined;
      this.failPending(new ConnectionClosedError(reason));
      for (const sub of this.subscriptions.values()) {
        if (sub.remoteId) this.byRemoteId.delete(sub.remoteId);
        sub.remoteId = undefined;
      }
      if (!this.closedByUser) this.scheduleReconnect(reason);
    };
  }

  private lastError: string | undefined;

  private scheduleReconnect(detail?: string): void {
    if (this.closedByUser) return;
    this.clearReconnect();
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt += 1;
    this.setStatus("reconnecting", detail);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private failPending(err: Error): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of pending) p.reject(err);
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this._status = status;
    for (const h of this.statusHandlers) h(status, detail);
  }

  private handleFrame(text: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(text) as ServerFrame;
    } catch {
      return;
    }
    if ("id" in frame && frame.id !== undefined && !("method" in frame)) {
      this.handleResponse(frame as RpcResponse);
    } else if ("method" in frame) {
      this.handleNotification(frame as RpcNotification);
    }
  }

  private handleResponse(resp: RpcResponse): void {
    if (typeof resp.id !== "number") return;
    const p = this.pending.get(resp.id);
    if (!p) return;
    this.pending.delete(resp.id);
    if (resp.error) p.reject(new RpcCallError(resp.error));
    else p.resolve(resp.result ?? null);
  }

  private handleNotification(n: RpcNotification): void {
    if (n.method === EVENT_NOTIFICATION) {
      const params = n.params as EventNotification | undefined;
      if (!params || !params.event) return;
      const sub = this.byRemoteId.get(params.subscription_id);
      if (!sub) return;
      const seq = params.event.seq;
      if (sub.lastSeq !== undefined && seq <= sub.lastSeq) return; // duplicate on replay
      sub.lastSeq = seq;
      sub.handler(params.event);
    } else if (n.method === EVENTS_LAGGED_NOTIFICATION) {
      for (const sub of this.subscriptions.values()) void this.resubscribeAfterLag(sub);
    }
    const handlers = this.notificationHandlers.get(n.method);
    if (handlers) for (const h of handlers) h(n.params);
  }

  private async issueSubscribe(sub: EventSubscription, isResubscribe: boolean): Promise<void> {
    const params: EventsSubscribeParams = { ...sub.params };
    if (sub.lastSeq !== undefined) params.after_seq = sub.lastSeq;
    try {
      const res = await this.call("events.subscribe", params);
      if (!this.isLive(sub)) {
        this.call("events.unsubscribe", { subscription_id: res.subscription_id }).catch(() => {});
        return;
      }
      sub.remoteId = res.subscription_id;
      this.byRemoteId.set(res.subscription_id, sub);
      if (isResubscribe) sub.onResubscribed?.(res.head_seq);
    } catch {
      // Socket dropped mid-subscribe; onopen will retry.
    }
  }

  private async resubscribeAfterLag(sub: EventSubscription): Promise<void> {
    const old = sub.remoteId;
    sub.remoteId = undefined;
    if (old) {
      this.byRemoteId.delete(old);
      this.call("events.unsubscribe", { subscription_id: old }).catch(() => {});
    }
    await this.issueSubscribe(sub, true);
  }

  private isLive(sub: EventSubscription): boolean {
    for (const s of this.subscriptions.values()) if (s === sub) return true;
    return false;
  }
}

/** Build a URL carrying the token as a query param, for clients that cannot set headers. */
export function urlWithToken(url: string, token: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${AUTH_QUERY_PARAM}=${encodeURIComponent(token)}`;
}
