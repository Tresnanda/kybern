import { useEffect } from 'react'
import { selectedReviewFindings, reviewDraftIsStale } from '@/state/prReviewModel'
import { useApp } from '../state.ts'
import { ensureLoaded, useComposer } from '../composer/store.ts'
import { PopupLayer, popoverStyle } from '../composer/Menu.tsx'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { getNav } from '../nav/store.ts'
import { Label, useTheme } from '../ui.tsx'
import { Button, row, column } from '../usage/controls.tsx'
import type { Review } from './useReview.ts'

export function SendPopover({ projectId, review, close, onTimeline, onChanges }: { projectId: string; review: Review; close: () => void; onTimeline: () => void; onChanges: () => void }) {
  const t = useTheme()
  const threads = useApp(s => s.threads)
  const settings = useComposer(s => s.settings)
  useEffect(() => { ensureLoaded() }, [])
  const choices = threads.filter(th => th.project_id === projectId && th.worktree && !th.subagent && !th.delegation)
  const { draft, detail } = review
  const linked = draft.threadId === 'new' ? undefined : choices.find(th => th.id === draft.threadId) ?? choices.find(th => th.worktree?.branch === detail?.pull_request.head)
  const selected = selectedReviewFindings(draft)
  const previews = [...selected.map(f => ({ path: f.path ? `${f.path}:${f.line ?? 'outdated'}` : `Review by ${f.author}`, body: f.body })), ...draft.inline.map(c => ({ path: `${c.path}:${c.line}`, body: c.body }))]
  const n = previews.length
  const stale = detail ? reviewDraftIsStale(draft, detail.head_sha) : false
  const blocked = linked?.status === 'running' || linked?.status === 'awaiting-approval'
  return <PopupLayer still={getNav().keyboardNav} testId="pr-send-popover" side="bottom" align="end" sideOffset={6} tabIndex={0} onKeyDown={e => { if (e.key === 'escape') close() }} onMouseDownOutside={close} style={{ ...popoverStyle(t), ...column, width: 384, padding: 16, gap: 12 }}>
    <Label color={t.text} size={13} weight={500}>Send to agent</Label><Label color={t.textSecondary} size={11}>The agent repairs this branch. You review and merge separately.</Label>
    <div style={{ ...row, justifyContent: 'space-between' }}><Label color={t.textSecondary} size={11}>Conversation</Label><Menu align="end" width={280} trigger={() => <Button>{linked?.title ?? 'New repair conversation'}</Button>}><MenuItem id="new" label="New repair conversation" onSelect={() => review.updateDraft({ threadId: 'new' })} />{choices.map(th => <MenuItem key={th.id} id={th.id} label={th.title} onSelect={() => review.updateDraft({ threadId: th.id })} />)}</Menu></div>
    {n === 0 ? <div style={{ ...column, gap: 8 }}><Label color={t.textSecondary} size={13}>Select comments in Timeline or add inline comments in Changes, then send them here.</Label><div style={row}><Button onClick={() => { close(); onTimeline() }}>Open timeline</Button><Button onClick={() => { close(); onChanges() }}>Open changes</Button></div></div> : <div style={{ ...column, gap: 8 }}><Label color={t.textSecondary} size={13}>{`${selected.length} comments and ${draft.inline.length} inline drafts`}</Label>{previews.slice(0, 3).map((p, i) => <div key={i} style={{ ...column, gap: 2 }}><Label color={t.textSecondary} size={11} truncate>{p.path}</Label><Label color={t.text} size={13} truncate>{p.body}</Label></div>)}{n > 3 && <Label color={t.textSecondary} size={11}>{`+${n - 3} more`}</Label>}</div>}
    {review.actionError && <Label color={t.red} size={12}>{`${review.actionError} Your draft is kept. Check the pull request and try again.`}</Label>}
    <div style={{ ...row, justifyContent: 'flex-end' }}><Button testId="pr-send-submit" primary disabled={review.busy || !settings || stale || n === 0 || blocked} onClick={() => { void review.repair(linked?.id).then(ok => { if (ok) close() }) }}>{review.busy ? 'Sending…' : `Send ${n} ${n === 1 ? 'finding' : 'findings'}`}</Button></div>
  </PopupLayer>
}
