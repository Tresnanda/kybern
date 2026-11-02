// The one client an app holds per machine. It stays the same object while the
// route under it changes: when the machine set moves to a better route or
// fails over, subscriptions, notification handlers and status handlers move to
// the new connection and event replay resumes from each subscription's cursor
// (design §3.4: "without dropping subscriptions").
import {
  ConnectionClosedError,
  KybernClient,
  type ConnectionStatus,
  type DaemonPage,
  type DaemonRequest,
  type EventHandler,
  type PageOptions,
  type ReplayState,
  type Subscription,
} from "./client.ts";
import type { EventsSubscribeParams, MethodName, ParamsOf, ResultOf } from "./types.ts";

/** What the machine set needs from a connection; `KybernClient` is one. */
export type MachineClient = Pick<
  KybernClient,
  "connect" | "close" | "status" | "failure" | "info" | "endpoint" | "onStatus" | "onNotification" | "call" | "callRaw" | "fetch" | "request" | "openPage" | "subscribeEvents" | "checkConnection"
>;

/** The machine cannot be reached now. `cached` says whether its last lists are still available. */
export class OfflineError extends ConnectionClosedError {
  readonly machineId: string;
  readonly cached: boolean;
  constructor(machineId: string, cached: boolean, message = "This machine is offline") {
    super(message);
    this.name = "OfflineError";
    this.machineId = machineId;
    this.cached = cached;
  }
}

interface RoutedSubscription {
  params: EventsSubscribeParams;
  handler: EventHandler;
  onSubscribed?: (headSeq: number, replay: ReplayState) => void;
  onReady?: (headSeq: number, resumed: boolean) => void;
  inner: Subscription | undefined;
  /** The cursor handed on when the connection changes. */
  lastSeq: number | undefined;
}

type StatusHandler = (status: ConnectionStatus, detail?: string) => void;

/**
 * A `KybernClient` that delegates to whichever connection the machine set has
 * open for one machine. Its `endpoint` carries no address and no token, so
 * nothing that holds it can read a credential; `fetch` and `openPage` reach the machine's
 * HTTP routes through the connection instead, and `request` hands a native loader the one
 * request it makes. `connect` and `close` do
 * nothing: the machine set owns the lifecycle.
 */
export class MachineClientProxy extends KybernClient {
  private inner: MachineClient | undefined;
  private readonly routedSubs = new Set<RoutedSubscription>();
  private readonly routedHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly routedStatus = new Set<StatusHandler>();
  private detachInner: (() => void)[] = [];
  /** Notification methods already hooked on the attached connection. */
  private readonly hooked = new Set<string>();
  private readonly routedIsCached: () => boolean;
  private readonly routedName: () => string;
  /** HTTP requests in flight on the attached connection; a route change aborts them. */
  private readonly requests = new Set<AbortController>();
  private id: string;

  constructor(machineId: string, isCached: () => boolean = () => false, name: () => string = () => "This machine") {
    super({ url: "", token: "", environmentId: machineId });
    this.id = machineId;
    this.routedIsCached = isCached;
    this.routedName = name;
  }

  get machineId(): string {
    return this.id;
  }

  /** The machine was re-keyed (a stand-in id became the real one). Subscriptions and handlers stay. */
  rename(machineId: string): void {
    this.id = machineId;
    this.endpoint.environmentId = machineId;
  }

  override get status(): ConnectionStatus {
    return this.inner?.status ?? "closed";
  }
  override get info() {
    return this.inner?.info ?? null;
  }

  override connect(): void {}
  override close(): void {}

  override onStatus(handler: StatusHandler) {
    this.routedStatus.add(handler);
    return () => {
      this.routedStatus.delete(handler);
    };
  }

  override onNotification(method: string, handler: (params: unknown) => void) {
    let handlers = this.routedHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.routedHandlers.set(method, handlers);
    }
    handlers.add(handler);
    if (this.inner) this.hook(this.inner, method);
    return () => {
      handlers.delete(handler);
    };
  }

  override call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    if (!this.inner) return Promise.reject(new OfflineError(this.machineId, this.routedIsCached()));
    return this.inner.call(method, params);
  }

  override callRaw(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.inner) return Promise.reject(new OfflineError(this.machineId, this.routedIsCached()));
    return this.inner.callRaw(method, params, timeoutMs);
  }

  /**
   * `KybernClient.fetch` on the attached connection: direct, or through the relay member with its
   * headers. Rejects with `OfflineError` while the machine is offline, and when the connection
   * changes before the response arrives (the request may not have reached the machine).
   */
  override async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const inner = this.inner;
    if (!inner) throw this.offline();
    const controller = new AbortController();
    const outer = init.signal;
    const forward = () => controller.abort(outer?.reason);
    if (outer?.aborted) forward();
    else outer?.addEventListener("abort", forward, { once: true });
    this.requests.add(controller);
    try {
      return await inner.fetch(path, { ...init, signal: controller.signal });
    } catch (error) {
      if (this.inner !== inner && !outer?.aborted) throw this.offline();
      throw error;
    } finally {
      this.requests.delete(controller);
      outer?.removeEventListener("abort", forward);
    }
  }

  /**
   * `KybernClient.request` on the attached connection: the URL and headers a native loader (an image,
   * a download) needs for the route in use now. Throws `OfflineError` while the machine is offline.
   * Ask again after a route change; a stale one may point at a route that is gone.
   */
  override request(path: string): DaemonRequest {
    const inner = this.inner;
    if (!inner) throw this.offline();
    return inner.request(path);
  }

  /** `KybernClient.openPage` on the attached connection; rejects with `OfflineError` while the machine is offline. */
  override async openPage(path: string, options: PageOptions = {}): Promise<DaemonPage> {
    const inner = this.inner;
    if (!inner) throw this.offline();
    return inner.openPage(path, options);
  }

  private offline(): OfflineError {
    return new OfflineError(this.machineId, this.routedIsCached(), `${this.routedName()} is offline. Try again when it reconnects.`);
  }

  override async checkConnection(): Promise<void> {
    await this.inner?.checkConnection();
  }

  override subscribeEvents(
    params: EventsSubscribeParams,
    handler: EventHandler,
    onSubscribed?: (headSeq: number, replay: ReplayState) => void,
    onReady?: (headSeq: number, resumed: boolean) => void,
  ): Subscription {
    const sub: RoutedSubscription = { params, handler, onSubscribed, onReady, inner: undefined, lastSeq: params.after_seq };
    this.routedSubs.add(sub);
    if (this.inner) this.subscribeOn(this.inner, sub);
    return {
      unsubscribe: () => {
        this.routedSubs.delete(sub);
        sub.inner?.unsubscribe();
        sub.inner = undefined;
      },
      get lastSeq() {
        return sub.inner?.lastSeq ?? sub.lastSeq;
      },
    };
  }

  /** Whether a connection is attached. */
  get attached(): boolean {
    return this.inner !== undefined;
  }

  /**
   * Point the proxy at `next` (or at nothing). Subscriptions are re-issued on
   * `next` from the cursor they had reached; handlers follow. The caller closes
   * the connection it replaced.
   */
  attach(next: MachineClient | undefined): void {
    if (next !== this.inner) {
      for (const request of this.requests) request.abort(this.offline());
      this.requests.clear();
    }
    for (const off of this.detachInner) off();
    this.detachInner = [];
    this.hooked.clear();
    for (const sub of this.routedSubs) {
      if (sub.inner) sub.lastSeq = sub.inner.lastSeq ?? sub.lastSeq;
      sub.inner = undefined;
    }
    this.inner = next;
    if (!next) {
      this.emitStatus("closed", "This machine is offline");
      return;
    }
    this.detachInner.push(next.onStatus((status, detail) => this.emitStatus(status, detail)));
    for (const method of this.routedHandlers.keys()) this.hook(next, method);
    for (const sub of this.routedSubs) this.subscribeOn(next, sub);
    this.emitStatus(next.status);
  }

  private hook(inner: MachineClient, method: string) {
    if (this.hooked.has(method)) return;
    this.hooked.add(method);
    this.detachInner.push(
      inner.onNotification(method, (params) => {
        for (const handler of [...(this.routedHandlers.get(method) ?? [])]) handler(params);
      }),
    );
  }

  private subscribeOn(inner: MachineClient, sub: RoutedSubscription) {
    sub.inner = inner.subscribeEvents(
      { ...sub.params, after_seq: sub.lastSeq },
      (event) => {
        sub.lastSeq = event.seq;
        sub.handler(event);
      },
      sub.onSubscribed,
      sub.onReady,
    );
  }

  private emitStatus(status: ConnectionStatus, detail?: string) {
    for (const handler of [...this.routedStatus]) handler(status, detail);
  }
}
