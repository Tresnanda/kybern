// GPUIX's wrappers over `describeProblem`: the same words, with the machine named when the failure was a machine that is away, and the
// one-line form for the inline labels that have no room for a card (a composer line, a sheet's footer, a form field).
import { describeProblem, type ProblemContext, type ProblemView } from '../../../../packages/kybern-client/src/problems.ts'
import { machineHub } from '../machines/index.ts'

/** The name people gave a machine ("SatyaMas"), or `undefined` for this computer and for an id the app does not know. */
export function machineNameOf(machineId: string | undefined): string | undefined {
  if (!machineId) return undefined
  try {
    const hub = machineHub()
    if (machineId === hub.localMachineId) return undefined
    return hub.connections().find((connection) => connection.record.machineId === machineId)?.record.name
  } catch {
    return undefined
  }
}

/** `describeProblem`, naming the machine an `OfflineError` came from when `context` doesn't already. */
export function describe(error: unknown, context: ProblemContext, nameOf: (machineId: string | undefined) => string | undefined = machineNameOf): ProblemView {
  if (context.machine) return describeProblem(error, context)
  const id = error && typeof error === 'object' && (error as { name?: unknown }).name === 'OfflineError' ? (error as { machineId?: string }).machineId : undefined
  const machine = nameOf(id)
  const view = describeProblem(error, machine ? { ...context, machine } : context)
  // A daemon's sentence can start in lower case ("thread is no longer idle"); it reads as its own sentence here.
  return /^[a-z]/.test(view.body) ? { ...view, body: view.body.charAt(0).toUpperCase() + view.body.slice(1) } : view
}

/** The failure as one line, "<headline>. <what to do next>", for a label that has no room for a card. */
export function problemLine(error: unknown, context: ProblemContext): string {
  const view = describe(error, context)
  return `${view.title}. ${view.body}`
}
