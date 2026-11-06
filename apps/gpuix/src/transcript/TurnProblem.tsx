// A failed turn as the shared ProblemRow, with the fix beside the words. When the daemon named the cause (signed out, usage limit,
// offline, ...) `describeTurnFailure` writes the copy and `problems/actions.ts` runs the buttons; otherwise the agent's text is sorted by
// its words (`TurnTextProblem`).
import { useMemo } from 'react'
import { describeTurnFailure } from '../../../../packages/kybern-client/src/problems.ts'
import type { ContentPart, Problem, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { ProblemRow } from '../kit/Problem.tsx'
import { describe } from '../problems/describe.ts'
import { problemProps } from '../problems/props.ts'
import { threadClient, useApp } from '../state.ts'

/** Sends the failed turn's message again: the same parts, as a new message, so nothing the failed turn did is rewritten. */
function resend(threadId: ThreadId, parts: ContentPart[]) {
  void threadClient(threadId)?.call('threads.send', { thread_id: threadId, message: { parts } }).catch(() => {})
}

export function TurnProblem({ threadId, error, problem, parts, projectId }: { threadId: ThreadId; error: string; problem: Problem; parts?: ContentPart[]; projectId?: string }) {
  const provider = useApp((s) => (s.open.thread?.id === threadId ? s.open.thread.provider : undefined))
  const props = useMemo(() => {
    if (!provider) return null
    const view = describeTurnFailure({ error, problem }, { provider: provider.kind, instance: provider.instance })
    return view ? problemProps(view, { retry: parts?.length ? () => resend(threadId, parts) : undefined }, 'turn-problem') : null
  }, [provider?.kind, provider?.instance, error, problem, threadId, parts])
  return props ? <div style={{ marginTop: 8 }}><ProblemRow {...props} /></div> : <TurnTextProblem error={error} projectId={projectId} />
}

/** A failed turn the daemon sent no `problem` for (older daemons, unrecognised causes): the agent's own text sorted by its words. */
export function TurnTextProblem({ error, projectId }: { error: string; projectId?: string }) {
  const props = useMemo(() => problemProps(describe(new Error(error), { action: 'finish this reply' }), { projectId }, 'turn-problem'), [error, projectId])
  return <div style={{ marginTop: 8 }}><ProblemRow {...props} /></div>
}
