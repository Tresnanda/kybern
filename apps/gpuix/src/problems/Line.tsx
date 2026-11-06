// A caught failure, drawn where it happened: `describeProblem` words it, `problemProps` gives it the look of its kind and the buttons the
// action table can run here, and `ProblemRow` draws it with the technical text behind "Show details". Hold the caught error itself in state
// (`asError(e)`), not its text, so the daemon's own `data.problem` survives. A page that failed to load uses `ProblemState` instead.
import { asError } from '../../../../packages/kybern-client/src/problem.ts'
import { describeProblem } from '../../../../packages/kybern-client/src/problems.ts'
import { ProblemRow } from '../kit/Problem.tsx'
import { problemProps } from './props.ts'

export interface ProblemLineProps {
  /** The caught error. Nothing is drawn for `null`, `undefined` or an empty string. */
  error: unknown
  /** What was being done, for "Couldn't …": "rename the thread", "load the files". */
  action: string
  /** Makes "Try again" the fix. */
  retry?: () => void
  /** The project whose machine a fix (install, sign in) runs on. */
  projectId?: string
  /** The machine, when it isn't this one. */
  machine?: string
  testId?: string
}

export function ProblemLine({ error, action, retry, projectId, machine, testId = 'problem' }: ProblemLineProps) {
  if (error == null || error === '') return null
  return <ProblemRow {...problemProps(describeProblem(error, { action, ...(machine ? { machine } : {}) }), { retry, projectId }, testId)} />
}

/** A caught error with the thing that was being done: hold this in state when one place can fail in several ways. */
export interface Failure {
  error: Error
  /** For "Couldn't …": "save the brief". */
  action: string
}

/** `failure('save the brief', e)`: what `setError` takes. */
export const failure = (action: string, error: unknown): Failure => ({ error: asError(error), action })
