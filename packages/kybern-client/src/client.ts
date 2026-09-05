// One transport implementation for desktop and mobile. Socket opening,
// authentication, identity verification, and state synchronization are distinct.
import {
  PROTOCOL_VERSION,
  EVENT_NOTIFICATION,
  EVENTS_LAGGED_NOTIFICATION,
  codes,
  type DaemonInfo,
  type EventNotification,
  type EventsSubscribeParams,
  type MethodName,
  type ParamsOf,
  type ResultOf,
  type RpcError,
  type RpcNotification,
  type RpcResponse,
  type SubscriptionId,
  type ThreadEvent,
} from "./types.ts";
import { httpBase } from "./address.ts";

export interface Endpoint {
  url: string;
  token: string;
  environmentId?: string;
}
export type ConnectionStatus =
  "idle" | "connecting" | "open" | "reconnecting" | "failed" | "closed";
export class RpcCallError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(error: RpcError) {
    super(error.message);
    this.name = "RpcCallError";
    this.code = error.code;
    this.data = error.data;
  }
}
export class ConnectionClosedError extends Error {
  constructor(message = "Connection closed") {
    super(message);
    this.name = "ConnectionClosedError";
  }
}

export interface ClientOptions {
  expectedEnvironmentId?: string;
  /** Native platforms can authenticate the upgrade with a header. Browsers
   * exchange the credential for a short-lived, single-use socket ticket. */
  createSocket?: (url: string, token: string) => WebSocket;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
}
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type StatusHandler = (status: ConnectionStatus, detail?: string) => void;
export type EventHandler = (event: ThreadEvent) => void;
interface EventSubscription {
  params: EventsSubscribeParams;
  handler: EventHandler;
  lastSeq: number | undefined;
  remoteId: SubscriptionId | undefined;
  generation: number;
  onSubscribed?: (headSeq: number) => void;
}
export interface Subscription {
  unsubscribe(): void;
  readonly lastSeq: number | undefined;
}

export class KybernClient {
  readonly endpoint: Endpoint;
  private readonly options: ClientOptions;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notifications = new Map<string, Set<(params: unknown) => void>>();
  private statuses = new Set<StatusHandler>();
  private subscriptions = new Set<EventSubscription>();
  private byRemoteId = new Map<SubscriptionId, EventSubscription>();
  private _status: ConnectionStatus = "idle";
  private _info: DaemonInfo | null = null;
  private stopped = true;
  private attempt = 0;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private opening: AbortController | undefined;

  constructor(endpoint: Endpoint, options: ClientOptions = {}) {
    this.endpoint = endpoint;
    this.options = options;
  }
  get status() {
    return this._status;
  }
  get info() {
    return this._info;
  }

  connect() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.open();
  }

  close(reason = "Connection closed") {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this.dropSocket(new ConnectionClosedError(reason));
    this.subscriptions.clear();
    this.byRemoteId.clear();
    this.setStatus("closed", reason);
  }

  onStatus(handler: StatusHandler) {
    this.statuses.add(handler);
    return () => {
      this.statuses.delete(handler);
    };
  }
  onNotification(method: string, handler: (params: unknown) => void) {
    let handlers = this.notifications.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notifications.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  call<M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
  ): Promise<ResultOf<M>> {
    return this.callRaw(method, params) as Promise<ResultOf<M>>;
  }

  callRaw(
    method: string,
    params: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 120_000,
  ): Promise<unknown> {
    const socket = this.ws;
    if (
      !socket ||
      socket.readyState !== 1 ||
      (this._status !== "open" && method !== "daemon.info")
    ) {
      return Promise.reject(
        new ConnectionClosedError(
          "Reconnect to this environment before trying again",
        ),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ConnectionClosedError(
            "The environment did not acknowledge this request. Reconnect and check its state before retrying",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  subscribeEvents(
    params: EventsSubscribeParams,
    handler: EventHandler,
    onSubscribed?: (headSeq: number) => void,
  ): Subscription {
    const sub: EventSubscription = {
      params,
      handler,
      onSubscribed,
      lastSeq: params.after_seq,
      remoteId: undefined,
      generation: 0,
    };
    this.subscriptions.add(sub);
    if (this._status === "open") void this.issueSubscribe(sub);
    return {
      unsubscribe: () => {
        this.subscriptions.delete(sub);
        sub.generation++;
        if (sub.remoteId) {
          this.byRemoteId.delete(sub.remoteId);
          void this.call("events.unsubscribe", {
            subscription_id: sub.remoteId,
          }).catch(() => {});
          sub.remoteId = undefined;
        }
      },
      get lastSeq() {
        return sub.lastSeq;
      },
    };
  }

  /** Also used when the app returns from background or the network changes. */
  async checkConnection(): Promise<void> {
    if (this.stopped) return;
    if (this._status !== "open") {
      if (!this.ws && !this.opening) {
        clearTimeout(this.reconnectTimer);
        void this.open();
      }
      return;
    }
    const socket = this.ws;
    try {
      await this.callRaw("daemon.info", {}, 10_000);
    } catch {
      if (this.ws === socket && !this.stopped)
        this.retry("Connection interrupted");
    }
  }

  private async open() {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.setStatus(this.attempt ? "reconnecting" : "connecting");
    const controller = new AbortController();
    this.opening?.abort();
    this.opening = controller;
    this.openTimer = setTimeout(() => {
      if (this.generation === generation)
        this.retry("Connection timed out; check the environment and network");
    }, 15_000);
    try {
      let socket: WebSocket;
      if (this.options.createSocket) {
        socket = this.options.createSocket(
          this.endpoint.url,
          this.endpoint.token,
        );
      } else {
        const response = await fetch(`${httpBase(this.endpoint.url)}/session`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.endpoint.token}` },
          signal: controller.signal,
          redirect: "error",
        });
        if (this.stopped || generation !== this.generation) return;
        if (response.status === 401 || response.status === 403) {
          this.fail(
            "Access was revoked or the credential is invalid. Pair this environment again",
          );
          return;
        }
        if (response.status === 404) {
          this.fail(
            "Update Kybern on this machine to enable remote connections",
          );
          return;
        }
        if (!response.ok)
          throw new Error(`Connection setup failed (${response.status})`);
        const { ticket } = (await response.json()) as { ticket: string };
        if (typeof ticket !== "string" || !ticket)
          throw new Error(
            "The environment returned an invalid connection ticket",
          );
        if (this.stopped || generation !== this.generation) return;
        const url = new URL(this.endpoint.url);
        url.searchParams.set("ticket", ticket);
        socket = new WebSocket(url.toString());
      }
      if (this.stopped || generation !== this.generation) {
        socket.close();
        return;
      }
      this.ws = socket;
      socket.onmessage = (event) => {
        if (this.ws === socket) this.frame(String(event.data));
      };
      socket.onerror = () => {}; // onclose owns retries; never expose a credential-bearing URL.
      socket.onclose = (event) => {
        if (this.ws !== socket || this.stopped) return;
        if (event.code === 4401)
          this.fail("Access was revoked. Pair this environment again");
        else
          this.retry(
            "Connection interrupted; reconnecting to this environment",
          );
      };
      socket.onopen = async () => {
        try {
          const info = (await this.callRaw(
            "daemon.info",
            {},
            10_000,
          )) as DaemonInfo;
          if (this.ws !== socket) return;
          if (info.protocol_version !== PROTOCOL_VERSION) {
            this.fail(
              "This environment uses an incompatible protocol. Update Kybern on the client and host",
            );
            return;
          }
          const expected =
            this.options.expectedEnvironmentId ??
            this.endpoint.environmentId ??
            this._info?.environment_id;
          if (
            !info.environment_id ||
            (expected && info.environment_id !== expected)
          ) {
            this.fail(
              "This address now belongs to a different environment. Add it separately",
            );
            return;
          }
          this.opening = undefined;
          this._info = info;
          clearTimeout(this.openTimer);
          this.attempt = 0;
          this.setStatus("open");
          for (const sub of this.subscriptions) void this.issueSubscribe(sub);
          this.heartbeat = setInterval(() => {
            void this.checkConnection();
          }, this.options.heartbeatMs ?? 20_000);
        } catch {
          if (this.ws === socket && !this.stopped)
            this.retry("Unable to verify the environment; reconnecting");
        }
      };
    } catch (e) {
      if (!this.stopped && generation === this.generation)
        this.retry(
          e instanceof Error && e.name !== "AbortError"
            ? e.message
            : "Connection interrupted",
        );
    }
  }

  private dropSocket(error: Error) {
    this.opening?.abort();
    this.opening = undefined;
    clearTimeout(this.openTimer);
    clearInterval(this.heartbeat);
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.byRemoteId.clear();
    for (const sub of this.subscriptions) {
      sub.remoteId = undefined;
      sub.generation++;
    }
  }

  private retry(detail: string) {
    if (this.stopped) return;
    this.generation++;
    this.dropSocket(new ConnectionClosedError(detail));
    clearTimeout(this.reconnectTimer);
    const delay =
      Math.min(15_000, 500 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.setStatus("reconnecting", detail);
    this.reconnectTimer = setTimeout(() => {
      void this.open();
    }, delay);
  }

  private fail(detail: string) {
    this.close(detail);
    this.setStatus("failed", detail);
  }

  private setStatus(status: ConnectionStatus, detail?: string) {
    this._status = status;
    for (const handler of this.statuses) handler(status, detail);
  }

  private frame(text: string) {
    let frame: RpcResponse | RpcNotification;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if ("id" in frame && typeof frame.id === "number") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new RpcCallError(frame.error));
      else pending.resolve(frame.result);
    } else if ("method" in frame) {
      if (frame.method === EVENT_NOTIFICATION) {
        const params = frame.params as EventNotification;
        const sub =
          params?.event && this.byRemoteId.get(params.subscription_id);
        if (
          sub &&
          (sub.lastSeq === undefined || params.event.seq > sub.lastSeq)
        ) {
          sub.lastSeq = params.event.seq;
          sub.handler(params.event);
        }
      } else if (frame.method === EVENTS_LAGGED_NOTIFICATION) {
        for (const sub of this.subscriptions) void this.issueSubscribe(sub);
      }
      for (const handler of this.notifications.get(frame.method) ?? [])
        handler(frame.params);
    }
  }

  private async issueSubscribe(sub: EventSubscription) {
    const generation = ++sub.generation;
    const socket = this.ws;
    if (sub.remoteId) {
      this.byRemoteId.delete(sub.remoteId);
      void this.call("events.unsubscribe", {
        subscription_id: sub.remoteId,
      }).catch(() => {});
      sub.remoteId = undefined;
    }
    try {
      const result = await this.call("events.subscribe", {
        ...sub.params,
        ...(sub.lastSeq === undefined ? {} : { after_seq: sub.lastSeq }),
      });
      if (
        !this.subscriptions.has(sub) ||
        sub.generation !== generation ||
        this.ws !== socket
      ) {
        if (this.ws === socket)
          void this.call("events.unsubscribe", {
            subscription_id: result.subscription_id,
          }).catch(() => {});
        return;
      }
      sub.remoteId = result.subscription_id;
      this.byRemoteId.set(result.subscription_id, sub);
      // A live-only subscription starts at its acknowledged head even if no
      // new events arrive before the first disconnect.
      sub.lastSeq ??= result.head_seq;
      sub.onSubscribed?.(result.head_seq);
    } catch (error) {
      if (
        this.ws !== socket ||
        this._status !== "open" ||
        !this.subscriptions.has(sub) ||
        sub.generation !== generation
      )
        return;
      if (
        error instanceof RpcCallError &&
        error.code === codes.INVALID_PARAMS
      ) {
        this.fail(
          "This environment’s event history changed. Restart Kybern to reload its current state",
        );
      } else {
        this.retry("Unable to synchronize this environment");
      }
    }
  }
}
