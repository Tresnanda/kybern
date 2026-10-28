// The connection `state.ts` already owns, presented to the machine set as one
// machine's connection.
//
// TODO(N6 step 5): the set opens the local machine's socket itself and this file
// goes away. Until then `state.ts` keeps the endpoint, token and reconnect
// behaviour it has today (local daemon start, SSH tunnel, status details), and
// the set only watches it, so one machine behaves exactly as it did.
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { MachineClient } from '../../../../packages/kybern-client/src/machineClient.ts'
import type { MethodName, ParamsOf, ResultOf, Project, Thread } from '../../../../packages/kybern-client/src/types.ts'

/** The lists `state.ts` last read from the primary daemon, so the set never asks the daemon for them twice. */
export interface ListSource {
  /** Resolves with the newest lists; waits for the first read, and rejects once `signal` is aborted. */
  read(signal: AbortSignal): Promise<{ projects: Project[]; threads: Thread[] }>
}

export class ForwardedClient implements MachineClient {
  private readonly abort = new AbortController()
  constructor(private readonly target: KybernClient, private readonly lists: ListSource) {}

  get status() { return this.target.status }
  get info() { return this.target.info }
  get endpoint() { return this.target.endpoint }
  /** `state.ts` owns the lifecycle: connecting and closing do nothing here. */
  connect() {}
  close() { this.abort.abort() }
  onStatus(handler: Parameters<KybernClient['onStatus']>[0]) { return this.target.onStatus(handler) }
  onNotification(method: string, handler: (params: unknown) => void) { return this.target.onNotification(method, handler) }
  checkConnection() { return this.target.checkConnection() }
  callRaw(method: string, params: unknown, timeoutMs?: number) { return this.target.callRaw(method, params, timeoutMs) }
  subscribeEvents: KybernClient['subscribeEvents'] = (params, handler, onSubscribed, onReady) =>
    this.target.subscribeEvents(params, handler, onSubscribed, onReady)

  async call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    if ((method === 'projects.list' || method === 'threads.list') && Object.keys(params as object).length === 0) {
      const lists = await this.lists.read(this.abort.signal)
      return (method === 'projects.list' ? { projects: lists.projects } : { threads: lists.threads }) as ResultOf<M>
    }
    return this.target.call(method, params)
  }
}
