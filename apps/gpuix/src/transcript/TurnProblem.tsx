// A turn that ended in a failure: the harness's own text turned into what happened and what to do, with the text itself behind
// "Show details". The daemon sends the failure as text (`TurnFailed.error`), so it is sorted by its words (`describeProblem`).
import { useMemo } from 'react'
import { ProblemRow } from '../kit/Problem.tsx'
import { describe } from '../problems/describe.ts'
import { problemProps } from '../problems/props.ts'

export function TurnProblem({ error, projectId }: { error: string; projectId?: string }) {
  const props = useMemo(() => problemProps(describe(new Error(error), { action: 'finish this reply' }), { projectId }, 'turn-problem'), [error, projectId])
  return <div style={{ marginTop: 8 }}><ProblemRow {...props} /></div>
}
