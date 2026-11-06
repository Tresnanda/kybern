// The comment box at the end of an issue's and a pull request's timeline: type Markdown, ⌘↩ (Ctrl+Enter off macOS) or
// Comment posts it (`github.issue.comment`; a pull request's conversation takes issue comments too). The comment shows in
// the timeline at once and is replaced by GitHub's copy when it answers. The draft is kept per issue (`drafts.ts`). When
// GitHub CLI can't comment (signed out, not allowed), the box says why above it and stays disabled until that is fixed.
import { useEffect, useRef, useState } from 'react'
import { asError } from '../../../../../packages/kybern-client/src/problem.ts'
import { ghProblem } from '../../../../../packages/kybern-client/src/prReview.ts'
import type { IssueComment } from '../../../../../packages/kybern-client/src/types.ts'
import { Button } from '../../kit/Button.tsx'
import { ProblemRow } from '../../kit/Problem.tsx'
import { TextArea } from '../../kit/TextArea.tsx'
import { isPrimary } from '../../platform/keys.ts'
import { describe } from '../../problems/describe.ts'
import { problemProps } from '../../problems/props.ts'
import { toastProblem } from '../../problems/toast.ts'
import { column, row } from '../../usage/controls.tsx'
import { prCall } from '../client.ts'
import type { GithubImageContext } from '../markdown/githubImage.ts'
import { draftKey, readDraft, saveDraft } from './drafts.ts'

/** The reading width of the timeline the box ends (`timeline/Timeline.tsx`). */
const MAX_WIDTH = 780
/** The comments' indent: the timeline's 28 px dot and its 12 px gap. */
const INDENT = 40
/** Problems a retry won't fix until the person does something: the box waits for them. */
const BLOCKING = new Set(['signed_out', 'permission', 'tool_missing'])

let pendingIds = 0

export interface CommentBoxProps {
  /** The issue or pull request commented on. */
  target: GithubImageContext
  /** The comment as typed, shown until GitHub answers (`id` starts with `pending:`). */
  onPending: (comment: IssueComment) => void
  /** GitHub's copy of the pending comment. */
  onPosted: (pendingId: string, comment: IssueComment) => void
  /** The pending comment did not post; its words go back in the box. */
  onFailed: (pendingId: string) => void
  testId?: string
}

export function CommentBox({ target, onPending, onPosted, onFailed, testId = 'comment-box' }: CommentBoxProps) {
  const key = draftKey(target.projectId, target.number, target.repo)
  const [draft, setDraft] = useState(() => ({ key, text: readDraft(key) }))
  const text = draft.key === key ? draft.text : readDraft(key)
  const [blocked, setBlocked] = useState<{ key: string; error: Error } | null>(null)
  const block = blocked?.key === key ? blocked.error : null
  const latest = useRef(key)
  latest.current = key
  useEffect(() => { if (draft.key !== key) setDraft({ key, text: readDraft(key) }) }, [key, draft.key])

  const change = (value: string) => { setDraft({ key, text: value }); saveDraft(key, value) }
  const send = () => {
    const body = text.trim()
    if (!body || block) return
    const pending: IssueComment = { id: `pending:${++pendingIds}`, author: 'You', body, created_at: new Date().toISOString(), url: '' }
    const { projectId, number, repo } = target
    change('')
    onPending(pending)
    void prCall(projectId, 'github.issue.comment', { project_id: projectId, number, body, ...(repo ? { repo } : {}) }).then(
      comment => onPosted(pending.id, comment),
      error => {
        onFailed(pending.id)
        // The words go back unless something new was typed meanwhile (or the box moved on to another issue).
        if (!readDraft(key).trim()) {
          saveDraft(key, body)
          if (latest.current === key) setDraft({ key, text: body })
        }
        if (BLOCKING.has(ghProblem(error).kind)) setBlocked({ key, error: asError(error) })
        else toastProblem(error, { action: 'post the comment', projectId })
      },
    )
  }

  return <div style={{ display: 'flex', justifyContent: 'center', paddingLeft: 24, paddingRight: 24, paddingBottom: 8 }}>
    <div testId={testId} style={{ ...column, gap: 8, width: '100%', maxWidth: MAX_WIDTH, paddingLeft: INDENT }}>
      {block && <ProblemRow {...problemProps(describe(block, { action: 'post the comment' }), { projectId: target.projectId, retry: () => setBlocked(null) }, `${testId}-problem`)} />}
      {/* Enter is intercepted so ⌘↩ sends instead of adding a line; a plain ↩ still adds one. */}
      <TextArea label="Comment" placeholder="Comment" testId={`${testId}-input`} value={text} onChange={change} disabled={!!block} minRows={3} maxRows={14}
        interceptKeys={['enter']} onKeyDown={e => { if (e.key === 'enter' && isPrimary(e.modifiers)) { e.preventDefault(); send() } }} />
      <div style={{ ...row, justifyContent: 'flex-end' }}>
        <Button variant="primary" size="sm" testId={`${testId}-send`} disabled={!text.trim() || !!block} onClick={send}>Comment</Button>
      </div>
    </div>
  </div>
}
