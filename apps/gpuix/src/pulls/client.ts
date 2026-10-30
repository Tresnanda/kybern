// Pull request calls go to the machine that owns the project: `getClient()` is only the machine the user is
// at, so a project merged in from another machine would ask the wrong daemon.
import type { MethodName, ParamsOf, ResultOf } from '../../../../packages/kybern-client/src/types.ts'
import { projectClient } from '../state.ts'

// The owning machine's client; `null` while it is offline or before the first connect.
export function prClient(projectId: string): ReturnType<typeof projectClient> {
  try { return projectClient(projectId) } catch { return null }
}

/** One call on the project's machine; rejects (never throws) when that machine can't be reached. */
export function prCall<M extends MethodName>(projectId: string, method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  const client = prClient(projectId)
  return client ? client.call(method, params) : Promise.reject(new Error("This project's machine is offline. Try again when it's back."))
}
