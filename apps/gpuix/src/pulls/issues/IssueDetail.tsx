// One issue, shaped like the pull request page: the header with its repository, number and state and the one primary action,
// "Start a thread"; the title, the description in Markdown and the comments as the pull request Timeline draws them; and the
// sidebar with assignees, labels, milestone and the pull requests that close it. Below 832 px the sidebar leads the list.
import { toastProblem } from '../../problems/toast.ts'
import { CancelCircleIcon, CheckmarkCircle02Icon, GitMergeIcon, LinkSquare02Icon, SparklesIcon, Target01Icon } from '@hugeicons/core-free-icons'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { agoPhrase } from '@/views/pullRequests/prFormat'
import { FILL_ISLAND } from '../../MatrixLoader.tsx'
import type { Issue, IssueComment, IssueDetailResult, IssueLinkedPull, Project } from '../../../../../packages/kybern-client/src/types.ts'
import { ensureLoaded, useComposer } from '../../composer/store.ts'
import { glyph, Icon } from '../../icons.tsx'
import { Avatar } from '../../kit/Avatar.tsx'
import { Button } from '../../kit/Button.tsx'
import { IconButton } from '../../kit/IconButton.tsx'
import { InspectorGroup, InspectorRow } from '../../kit/Inspector.tsx'
import { StatusChip } from '../../kit/StatusChip.tsx'
import { SpinIcon } from '../../kit/Spin.tsx'
import { N } from '../../nav/glyphs.ts'
import { Menu, MenuItem } from '../../nav/overlay.tsx'
import { cachedMarkdownTheme as markdownTheme, alpha } from '../../transcript/kit.tsx'
import { ink, Label, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { SIDEBAR_BREAKPOINT } from '../detail/Summary.tsx'
import { labelColor } from '../detail/model.ts'
import { RepoBadge } from '../list/parts.tsx'
import { openPullTab } from '../openTab.ts'
import { copy, openUrl, PrLoading, Problem } from '../PrStates.tsx'
import { PR_SCROLL_LAYOUT } from '../scroll-layout.ts'
import { githubPull, githubRepo } from '../tabTargets.ts'
import { timelineItems } from '../timeline/model.ts'
import { TimelineRow } from '../timeline/Timeline.tsx'
import { CommentBox } from '../comment/CommentBox.tsx'
import { GithubImages, GithubMarkdown } from '../markdown/GithubMarkdown.tsx'
import type { GithubImageContext } from '../markdown/githubImage.ts'
import { commentEvents, stateWord, type IssueStateWord } from './model.ts'
import { startIssueThread } from './startThread.ts'
import { useIssue } from './useIssue.ts'

const ICONS = { open: glyph(Target01Icon), done: glyph(CheckmarkCircle02Icon), muted: glyph(CancelCircleIcon), start: glyph(SparklesIcon), merge: glyph(GitMergeIcon), external: glyph(LinkSquare02Icon) }
/** The reading width of the description and the comments (the Timeline's rows are 780 wide). */
const COLUMN = 780
const READING = 680
const noop = () => {}

function StatePill({ word }: { word: IssueStateWord }) {
  const t = useTheme()
  const color = word.tone === 'open' ? t.green : word.tone === 'done' ? t.link : t.textSecondary
  const icon = ICONS[word.tone]
  return <div testId="issue-state-pill" style={{ ...row, gap: 4, height: 20, borderRadius: 6, paddingLeft: 5, paddingRight: 7, backgroundColor: word.tone === 'open' ? alpha(t.green, 0.12) : word.tone === 'done' ? alpha(t.link, 0.12) : ink(t, 0.07) }}>
    <Icon source={icon} size={13} color={color} /><Label color={color} size={12} lineHeight={16} weight={500}>{word.label}</Label>
  </div>
}

function Person({ login, url }: { login: string; url?: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}><Avatar login={login} url={url} size={16} /><Label color={t.text} size={13} lineHeight={20} truncate>{login}</Label></div>
}

const stateGlyph = (state: string) => state === 'MERGED' ? ICONS.merge : N.pullRequest

/** A pull request that closes the issue: Kybern's pull request tab for this repository, the browser for another. */
function LinkedPull({ pull, project, repo, issue }: { pull: IssueLinkedPull; project: Project; repo?: string; issue: Issue }) {
  const t = useTheme()
  const ours = githubPull(pull.url)?.remote === githubRepo(issue.url)
  const color = pull.state === 'MERGED' ? t.link : pull.state === 'OPEN' ? t.green : t.textSecondary
  const open = () => { if (ours) openPullTab({ projectId: project.id, number: pull.number, title: pull.title, ...(repo ? { repo } : {}) }); else openUrl(pull.url) }
  return <div testId={`issue-pull-${pull.number}`} role="link" tabIndex={0} aria-label={`Pull request #${pull.number} ${pull.title}, ${pull.state.toLowerCase()}`} onClick={open} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') open() }}
    style={{ ...row, gap: 6, minWidth: 0, minHeight: 26, marginLeft: -6, marginRight: -6, paddingLeft: 6, paddingRight: 6, borderRadius: 7, cursor: 'pointer', hover: { backgroundColor: t.hover } }}>
    <Icon source={stateGlyph(pull.state)} size={14} color={color} />
    <Label color={t.text} size={13} lineHeight={18} truncate>{`#${pull.number} ${pull.title}`}</Label>
  </div>
}

/** Fits "Pull requests", the sidebar's longest label; the sidebar is 12 px wider than the pull request one so values keep their 180 px. */
const ISSUE_LABEL_WIDTH = 88

function Sidebar({ detail, project, repo, compact }: { detail: IssueDetailResult; project: Project; repo?: string; compact: boolean }) {
  const t = useTheme()
  const { issue } = detail
  const none = <Label color={t.textSecondary} size={13} lineHeight={20}>None</Label>
  const pulls = detail.pull_requests ?? []
  const body = <>
    <InspectorGroup first={!compact}>
      <InspectorRow labelWidth={ISSUE_LABEL_WIDTH} label="Assignees" testId="issue-assignees">{issue.assignees?.length ? issue.assignees.map(a => <Person key={a.login} login={a.login} url={a.avatar_url} />) : none}</InspectorRow>
      <InspectorRow labelWidth={ISSUE_LABEL_WIDTH} label="Labels" testId="issue-labels">{issue.labels?.length ? issue.labels.map(l => <StatusChip key={l.name} dot={labelColor(l.color) ?? t.textSecondary}>{l.name}</StatusChip>) : none}</InspectorRow>
      <InspectorRow labelWidth={ISSUE_LABEL_WIDTH} label="Milestone" testId="issue-milestone">{issue.milestone ? <Label color={t.text} size={13} lineHeight={20}>{issue.milestone}</Label> : none}</InspectorRow>
    </InspectorGroup>
    <InspectorGroup>
      <InspectorRow labelWidth={ISSUE_LABEL_WIDTH} label="Pull requests" testId="issue-pulls">
        {pulls.length || issue.linked_pull_requests?.length
          ? <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flexGrow: 1 }}>{pulls.length ? pulls.map(p => <LinkedPull key={p.number} pull={p} project={project} issue={issue} {...(repo ? { repo } : {})} />) : issue.linked_pull_requests!.map(n => <Label key={n} color={t.text} size={13} lineHeight={20}>{`#${n}`}</Label>)}</div>
          : none}
      </InspectorRow>
    </InspectorGroup>
  </>
  if (compact) return <div testId="issue-sidebar" style={{ display: 'flex', flexDirection: 'column' }}>{body}</div>
  return (
    // A cached island sized by its row, like the pull request sidebar: a scroll frame of the description replays it.
    <div {...FILL_ISLAND} style={{ display: 'flex', flexDirection: 'column', width: 308, flexShrink: 0, minHeight: 0 }}>
      <div testId="issue-sidebar" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, overflowY: 'scroll', paddingLeft: 20, paddingRight: 20, paddingTop: 8, paddingBottom: 24, borderLeftWidth: 1, borderColor: t.surfaceDivider }}>{body}</div>
    </div>
  )
}

/** The title, who opened the issue, and the description. */
function Reading({ detail, compact }: { detail: IssueDetailResult; compact: boolean }) {
  const t = useTheme()
  const { issue } = detail
  const theme = useMemo(() => { const base = markdownTheme(t); return { ...base, markdown: { ...base.markdown, codeWrap: true } } }, [t])
  const body = detail.body.trim()
  return <div testId="issue-reading" style={{ ...column, width: '100%', maxWidth: COLUMN, alignSelf: 'center', paddingLeft: 24, paddingRight: 24, paddingTop: compact ? 12 : 28, paddingBottom: 24 }}>
    <div style={{ ...column, gap: 10 }}>
      <Label color={t.text} size={compact ? 20 : 22} lineHeight={compact ? 26 : 28} weight={600}>{issue.title}</Label>
      <div style={{ ...row, flexWrap: 'wrap', gap: 6, rowGap: 4 }}>
        <Avatar login={issue.author} url={issue.author_avatar_url} size={compact ? 18 : 20} />
        <Label color={t.text} size={13} lineHeight={20} weight={500}>{issue.author || 'Someone'}</Label>
        <Label color={t.textSecondary} size={13} lineHeight={20}>{`opened this ${agoPhrase(issue.created_at)}`}</Label>
      </div>
    </div>
    <div testId="issue-body" style={{ ...column, maxWidth: READING, marginTop: 24, paddingTop: 22, borderTopWidth: 1, borderColor: t.surfaceDivider }}>
      <GithubMarkdown document source={body || 'No description provided.'} theme={theme} style={{ color: t.text, fontSize: 14, userSelect: 'text' }} onLinkClick={e => e.value && openUrl(e.value)} />
    </div>
  </div>
}

export function IssueDetail({ project, number, repo, onBack, showBack = true, width }: { project: Project; number: number; /** Group projects: the member repository the issue is in. */ repo?: string; onBack: () => void; showBack?: boolean; width: number }) {
  const t = useTheme()
  const { detail, loading, error, refresh, update } = useIssue(project.id, number, repo)
  const target = useMemo<GithubImageContext>(() => ({ projectId: project.id, number, ...(repo ? { repo } : {}) }), [project.id, number, repo])
  // A comment posted from the box: shown at once, then GitHub's copy; one that failed goes back to the box.
  const onPending = useCallback((comment: IssueComment) => update(d => ({ ...d, comments: [...d.comments, comment], comment_count: d.comment_count + 1 })), [update])
  // A refresh may have landed meanwhile: it dropped the pending comment, or already brings GitHub's copy.
  const onPosted = useCallback((id: string, comment: IssueComment) => update(d => {
    const pending = d.comments.some(c => c.id === id), known = d.comments.some(c => c.id === comment.id)
    if (!pending) return known ? d : { ...d, comments: [...d.comments, comment], comment_count: d.comment_count + 1 }
    const comments = d.comments.filter(c => c.id !== comment.id).map(c => c.id === id ? comment : c)
    return { ...d, comments, comment_count: known ? d.comment_count - 1 : d.comment_count }
  }), [update])
  const onFailed = useCallback((id: string) => update(d => d.comments.some(c => c.id === id) ? { ...d, comments: d.comments.filter(c => c.id !== id), comment_count: d.comment_count - 1 } : d), [update])
  const settings = useComposer(s => s.settings)
  useEffect(() => { ensureLoaded() }, [])
  const [starting, setStarting] = useState(false)
  const memberName = repo ? project.members?.find(m => m.path === repo)?.name ?? repo : undefined
  const repoName = memberName ?? project.name
  const compact = width < SIDEBAR_BREAKPOINT
  const issue = detail?.issue
  const events = useMemo(() => detail ? commentEvents(detail.comments) : [], [detail])
  const items = useMemo(() => timelineItems(events, 'all'), [events])
  const unread = detail ? detail.comment_count - detail.comments.length : 0
  const start = useCallback(() => {
    if (!detail || starting) return
    setStarting(true)
    void startIssueThread(project.id, detail, repo ? `${project.name} / ${repoName}` : undefined)
      .catch(e => toastProblem(e, { action: 'start a thread' }))
      .finally(() => setStarting(false))
  }, [detail, starting, project, repo, repoName])
  const side: ReactNode = detail && <Sidebar detail={detail} project={project} compact={compact} {...(repo ? { repo } : {})} />
  const rows = detail && <>
    {items.map((item, i) => <TimelineRow key={item.id} item={item} last={i === items.length - 1 && unread <= 0} inline={false} selectable={false} selected={[]} onToggle={noop} />)}
    {unread > 0 && issue && <div key="more" style={{ ...row, justifyContent: 'center', paddingLeft: 24, paddingRight: 24, paddingBottom: 24, paddingTop: 4 }}>
      <Button size="sm" variant="ghost" testId="issue-more-comments" onClick={() => openUrl(issue.url)}>Open on GitHub to read the rest</Button>
    </div>}
    <CommentBox key="comment" target={target} onPending={onPending} onPosted={onPosted} onFailed={onFailed} testId="issue-comment" />
    <div key="end" style={{ height: 48 }} />
  </>
  return <div testId="issue-detail" style={{ ...column, flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    <div style={{ ...row, gap: 8, minHeight: 46, flexShrink: 0, paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, borderBottomWidth: 1, borderColor: t.border }}>
      {showBack && <IconButton icon={N.arrowLeft} label="Back to issues" testId="issue-back" onClick={onBack} />}
      <RepoBadge testId="issue-repo" name={repoName} projectId={project.id} {...(repo ? { repo } : {})} maxWidth={240} />
      <Label color={t.textSecondary} size={12.5} lineHeight={18}>{`#${number}`}</Label>
      {issue && <><Label color={t.textTertiary} size={12.5} lineHeight={18}>·</Label><StatePill word={stateWord(issue)} /></>}
      <div style={{ flexGrow: 1 }} />
      {loading && <SpinIcon testId="issue-detail-spinner" source={N.refresh} size={14} color={t.iconSecondary} />}
      <Menu testId="issue-more" align="end" trigger={() => <IconButton icon={N.ellipsis} label="More actions" testId="issue-more-trigger" />}>
        <MenuItem id="refresh" testId="issue-refresh-detail" label="Refresh" disabled={loading} onSelect={refresh} />
        <MenuItem id="copy" testId="issue-copy-link" label="Copy link" disabled={!issue} onSelect={() => issue && copy(issue.url)} />
      </Menu>
      <IconButton icon={ICONS.external} label="Open on GitHub" testId="issue-open-github" disabled={!issue} onClick={() => issue && openUrl(issue.url)} />
      <Button variant="primary" icon={ICONS.start} testId="issue-start-thread" busy={starting} disabled={!detail || !settings || starting} onClick={start}>Start a thread</Button>
    </div>
    {error && !detail && <div style={{ padding: 24 }}><Problem error={error} projectId={project.id} noun="this issue" refresh={refresh} /></div>}
    {!detail && !error && <div style={{ padding: 24 }}><PrLoading label="Loading issue…" /></div>}
    {detail && <GithubImages value={target}>{compact
      ? <virtual-list {...PR_SCROLL_LAYOUT} testId="issue-scroll" estimatedItemHeight={200} style={{ flexGrow: 1, minHeight: 0 }}>
        <div key="side" style={{ ...column, paddingLeft: 24, paddingRight: 24, paddingTop: 12 }}>{side}</div>
        <Reading key="reading" detail={detail} compact />
        {rows}
      </virtual-list>
      : <div style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
        <virtual-list {...PR_SCROLL_LAYOUT} testId="issue-scroll" estimatedItemHeight={200} style={{ flexGrow: 1, minWidth: 0, minHeight: 0 }}>
          <Reading key="reading" detail={detail} compact={false} />
          {rows}
        </virtual-list>
        {side}
      </div>}</GithubImages>}
  </div>
}
