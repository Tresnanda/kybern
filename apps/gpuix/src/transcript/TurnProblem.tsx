// A failed turn the daemon could name (signed out, usage limit, offline, ...): the shared ProblemRow in place of the red line, with the
// fix beside the words. `describeTurnFailure` writes the copy; `problems/actions.ts` runs the buttons. A turn with no named cause keeps
// the plain error line (see `TurnFooter`).
import { useMemo } from 'react'
import { describeTurnFailure } from '../../../../packages/kybern-client/src/problems.ts'
import type { ContentPart, Problem, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { ProblemRow } from '../kit/Problem.tsx'
import { problemProps } from '../problems/props.ts'
import { threadClient, useApp } from '../state.ts'

/** Sends the failed turn's message again: the same parts, as a new message, so nothing the failed turn did is rewritten. */
function resend(threadId: ThreadId, parts: ContentPart[]) {
  void threadClient(threadId)?.call('threads.send', { thread_id: threadId, message: { parts } }).catch(() => {})
}

export function TurnProblem({ threadId, error, problem, parts }: { threadId: ThreadId; error: string; problem: Problem; parts?: ContentPart[] }) {
  const provider = useApp((s) => (s.open.thread?.id === threadId ? s.open.thread.provider : undefined))
  const props = useMemo(() => {
    if (!provider) return null
    const view = describeTurnFailure({ error, problem }, { provider: provider.kind, instance: provider.instance })
    return view ? problemProps(view, { retry: parts?.length ? () => resend(threadId, parts) : undefined }, 'turn-problem') : null
  }, [provider?.kind, provider?.instance, error, problem, threadId, parts])
  return props ? <div style={{ marginTop: 8 }}><ProblemRow {...props} /></div> : null
}
