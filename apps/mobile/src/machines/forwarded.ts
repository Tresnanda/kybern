// The connection `runtime.ts` already owns, presented to the machine set as one
// machine's connection, so the set can watch it and merge its lists without
// opening a second socket to the same computer.
//
// TODO(N7 part 2): once the set opens the phone's own connection itself
// (`connect(id)` becomes `ensureAll()`), this file goes away. The shared
// `adoptConnection` the machine-set lane adds to `machines.ts` would replace it.
import type { KybernClient } from "../../../../packages/kybern-client/src/client";
import type { MachineClient } from "../../../../packages/kybern-client/src/machineClient";
import type { MethodName, ParamsOf, ResultOf, Project, Thread } from "../../../../packages/kybern-client/src/types";

/** The lists `runtime.ts` last read from the primary daemon, so the set never asks the daemon for them twice. */
export interface ListSource {
  /** Resolves with the newest lists; waits for the first read, and rejects once `signal` is aborted. */
  read(signal: AbortSignal): Promise<{ projects: Project[]; threads: Thread[] }>;
}

export class ForwardedClient implements MachineClient {
  private readonly abort = new AbortController();
  private readonly target: KybernClient;
  private readonly lists: ListSource;
  constructor(target: KybernClient, lists: ListSource) {
    this.target = target;
    this.lists = lists;
  }

  get status() { return this.target.status; }
  get info() { return this.target.info; }
  get endpoint() { return this.target.endpoint; }
  /** `runtime.ts` owns the lifecycle: connecting and closing do nothing here. */
  connect() {}
  close() { this.abort.abort(); }
  onStatus(handler: Parameters<KybernClient["onStatus"]>[0]) { return this.target.onStatus(handler); }
  onNotification(method: string, handler: (params: unknown) => void) { return this.target.onNotification(method, handler); }
  checkConnection() { return this.target.checkConnection(); }
  callRaw(method: string, params: unknown, timeoutMs?: number) { return this.target.callRaw(method, params, timeoutMs); }
  subscribeEvents: KybernClient["subscribeEvents"] = (params, handler, onSubscribed, onReady) =>
    this.target.subscribeEvents(params, handler, onSubscribed, onReady);

  async call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    if ((method === "projects.list" || method === "threads.list") && Object.keys(params as object).length === 0) {
      const lists = await this.lists.read(this.abort.signal);
      return (method === "projects.list" ? { projects: lists.projects } : { threads: lists.threads }) as ResultOf<M>;
    }
    return this.target.call(method, params);
  }
}
