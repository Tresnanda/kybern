// What a group shows (ADE-54): the chat (the leaf's conversation page) or the active document tab. Only the active tab of each
// group is mounted: switching unmounts the old body and GPUIX releases it. Terminals keep their daemon session (the next mount
// replays it); the browser keeps its one native web view per thread (`preview/Surface.tsx` places it in whichever slot shows).
import { toast } from '../shell/toasts.tsx'
import { errorText } from '../nav/actions.ts'
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import type { TerminalInfo, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { subagentThreadPhase } from '../../../../packages/kybern-client/src/subagents.ts'
import { closePaneState, createPane, PaneProvider, selectPaneThread, threadClient, useApp } from '../state.ts'
import { getGroup, updateGroup, useGroup } from '../split/store.ts'
import { observeElementBounds } from '../native/layout.ts'
import { ErrorBoundary } from '../shell/ErrorBoundary.tsx'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../kit/Empty.tsx'
import { Button } from '../kit/Button.tsx'
import { DOCK_ICONS } from '../dock/icons.ts'
import { N } from '../nav/glyphs.ts'
import { openThread } from '../nav/history.ts'
import { useNav } from '../nav/store.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { LoadingLines } from '../dock/loading.tsx'
import { FileViewer } from '../dock/Explorer.tsx'
import { DiffPane } from '../dock/Diff.tsx'
import { ReviewPane } from '../dock/Review.tsx'
import { ArtifactTab } from '../dock/Artifacts.tsx'
import { Screen } from '../terminal/Terminal.tsx'
import { PreviewPane } from '../preview/Preview.tsx'
import { Detail } from '../pulls/PrDetail.tsx'
import { goPage } from '../nav/history.ts'
import { NoteEditor } from '../notes/NoteEditor.tsx'
import { TaskDetail } from '../tasks/TaskDetail.tsx'
import { useTasks } from '../tasks/store.ts'
import { VisualTab } from '../transcript/Visual.tsx'
import { MermaidTab } from '../transcript/MermaidBlock.tsx'
import { useThreadImage } from '../transcript/ThreadImage.tsx'
import { imageSource } from '../../../../packages/kybern-client/src/responseImages.ts'
import { ZoomPane } from '../motion/ZoomSurface.tsx'
import { activeTab, CHAT, tabKey, type Tab } from './model.ts'
import { closeTabAction, keepTab, openTab, registerHostedPane } from './open.ts'
import { useThreadRecord } from './Strip.tsx'
import { ChatHidden, DocumentKeys, type DocumentKey } from './hidden.ts'

/**
 * A leaf's content: `children` is its conversation page. A document tab is drawn over it; the chat stays mounted underneath
 * once it has been shown (opacity 0, no pointer events, never `visibility: hidden`), so ⌘1 returns at once to the same
 * reading position instead of rebuilding the transcript. Other document tabs mount only while active.
 */
export function GroupContent({ leafId, children }: { leafId: string; children: ReactNode }) {
  const group = useGroup(leafId)
  const selected = useApp((s) => s.selectedId)
  const tab = activeTab(group)
  const doc = !!group.threadId && group.threadId === selected && group.active !== CHAT && tab.kind !== 'chat'
  const [chatShown, setChatShown] = useState(!doc)
  if (!doc && !chatShown) setChatShown(true)
  const key = tabKey(tab)
  const preview = group.preview === key
  return <>
    {(chatShown || !doc) && (
      <div testId={doc ? `chat-hidden-${leafId}` : undefined} style={doc
        ? { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', opacity: 0, pointerEvents: 'none' }
        : { display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
        <ChatHidden.Provider value={doc}>{children}</ChatHidden.Provider>
      </div>
    )}
    {doc && (
      <DocumentHost key={key} testId={`tab-body-${key}`} onUsed={preview ? () => keepTab(leafId, key) : undefined}>
        <ErrorBoundary label="this tab">
          <TabBody leafId={leafId} threadId={group.threadId!} tab={tab}>{children}</TabBody>
        </ErrorBoundary>
      </DocumentHost>
    )}
  </>
}

/** A document tab's box. It takes keyboard focus when it opens, so typing never lands in the hidden chat's composer. A preview
 *  tab the reader scrolls or types in is kept (single click → italic tab → permanent once used). */

function DocumentHost({ testId, onUsed, children }: { testId: string; onUsed?: () => void; children: ReactNode }) {
  const renderer = useGpuixRequired()
  const [node, setNode] = useState<PublicInstance | null>(null)
  const keys = useRef<((event: DocumentKey) => boolean) | null>(null)
  useEffect(() => { if (node) renderer.focusElement?.(node.id) }, [node, renderer])
  return <div ref={setNode} testId={testId} tabIndex={-1} onScroll={onUsed}
    onKeyDown={(event: DocumentKey & { preventDefault(): void }) => { if (keys.current?.(event)) { event.preventDefault(); return } onUsed?.() }}
    style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', position: 'relative' }}><DocumentKeys.Provider value={keys}>{children}</DocumentKeys.Provider></div>
}

function TabBody({ leafId, threadId, tab, children }: { leafId: string; threadId: string; tab: Tab; children: ReactNode }) {
  const thread = useThreadRecord(threadId)
  switch (tab.kind) {
    case 'chat': return children
    // Switching tabs is instant (spec §1.5): no pane entrance on the content.
    case 'file': return <FileViewer key={tabKey(tab)} {...(tab.root === 'project' ? { projectId: thread?.project_id, threadId } : { threadId })} path={tab.path} line={tab.line} instant />
    case 'diff': return thread ? <DiffPane key={tab.path ?? '*'} thread={thread} mode="all" path={tab.path} /> : <LoadingLines />
    case 'terminal': return <TerminalTab leafId={leafId} threadId={threadId} tab={tab} />
    case 'preview': return <PreviewPane threadId={threadId} />
    case 'review': return thread ? <Measured>{(width) => <ReviewPane thread={thread} width={width} />}</Measured> : <LoadingLines />
    case 'pr': return <PrTab projectId={tab.projectId} number={tab.number} />
    case 'note': return <Measured>{(width) => <NoteEditor key={tab.id} id={tab.id} width={width} onClose={() => closeTabAction(leafId, tabKey(tab))} />}</Measured>
    case 'task': return <TaskTab id={tab.id} onClose={() => closeTabAction(leafId, tabKey(tab))} />
    case 'visual': return <VisualTab threadId={threadId} visualId={tab.id} />
    case 'artifact': return <ArtifactTab threadId={threadId} path={tab.path} url={tab.url} />
    case 'mermaid': return <MermaidTab code={tab.code} />
    case 'image': return <ImageTab threadId={threadId} source={tab.source} label={tab.label} />
    case 'thread': return <ChildThreadTab leafId={leafId} childId={tab.id}>{children}</ChildThreadTab>
  }
}

/** Width for bodies that lay out by it (Review, a PR). */
function Measured({ children }: { children: (width: number) => ReactNode }) {
  const renderer = useGpuixRequired()
  const [host, setHost] = useState<PublicInstance | null>(null)
  const [width, setWidth] = useState(720)
  useEffect(() => host ? observeElementBounds(renderer, host.id, (e) => { if (e.rect) setWidth((w) => Math.abs(w - e.rect!.width) < 0.5 ? w : e.rect!.width) }) : undefined, [renderer, host])
  return <div ref={setHost} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0 }}>{children(width)}</div>
}

/** One terminal session. A session that is gone (the daemon restarted) offers a fresh shell in the same tab. */
function TerminalTab({ leafId, threadId, tab }: { leafId: string; threadId: string; tab: Extract<Tab, { kind: 'terminal' }> }) {
  const connected = useApp((s) => s.status === 'open')
  const [info, setInfo] = useState<TerminalInfo | 'missing' | null>(null)
  const key = tabKey(tab)
  useEffect(() => {
    if (!connected) return
    let live = true
    setInfo(null)
    void threadClient(threadId)!.call('terminals.list', { thread_id: threadId }).then((result) => { if (live) setInfo(result.terminals.find((t) => t.id === tab.id) ?? 'missing') }, () => { if (live) setInfo('missing') })
    return () => { live = false }
  }, [threadId, tab.id, connected])
  const restart = async () => {
    const created = await threadClient(threadId)!.call('terminals.create', { thread_id: threadId, cols: 100, rows: 24 })
    updateGroup(leafId, (g) => ({ ...g, tabs: g.tabs.map((t) => tabKey(t) === key ? { kind: 'terminal', id: created.id } : t), active: `terminal:${created.id}` }))
  }
  if (info === null) return <LoadingLines testId="terminal-tab-loading" />
  if (info === 'missing') return (
    <Empty testId="terminal-tab-ended">
      <EmptyHeader play={false}>
        <EmptyMedia variant="icon" icon={DOCK_ICONS.terminal} />
        <EmptyTitle>This terminal has ended</EmptyTitle>
        <EmptyDescription>Its shell is no longer running. Start a new one in this tab.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent><Button size="sm" testId="terminal-tab-restart" onClick={() => void restart().catch((error) => toast.error('Unable to start a terminal', { description: errorText(error) }))}>Start a new terminal</Button></EmptyContent>
    </Empty>
  )
  return <div testId="terminal-tab" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
    <Screen key={info.id} info={info} threadId={threadId} width={800}
      onTitle={(title) => { if (title !== tab.title && !tab.cli) updateGroup(leafId, (g) => ({ ...g, tabs: g.tabs.map((t) => tabKey(t) === key ? { ...tab, title } : t) })) }}
      onExit={() => closeTabAction(leafId, key)} />
  </div>
}

function PrTab({ projectId, number }: { projectId: string; number: number }) {
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  if (!project) return <LoadingLines />
  return <Measured>{(width) => <Detail key={number} project={project} number={number} width={width} showBack={false} onBack={() => goPage('pulls')} onChanged={() => {}} />}</Measured>
}

function TaskTab({ id, onClose }: { id: string; onClose: () => void }) {
  const task = useTasks((s) => s.tasks[id])
  const loaded = useTasks((s) => s.loaded)
  if (!task) return loaded ? <Empty testId="task-tab-missing"><EmptyHeader play={false}><EmptyMedia variant="icon" icon={N.tasks} /><EmptyTitle>This task is gone</EmptyTitle><EmptyDescription>It was deleted or moved to another workspace.</EmptyDescription></EmptyHeader><EmptyContent><Button size="sm" testId="task-tab-close" onClick={onClose}>Close tab</Button></EmptyContent></Empty> : <LoadingLines />
  return <Measured>{(width) => <TaskDetail task={task} sequence={[task.id]} width={width} />}</Measured>
}

function ImageTab({ threadId, source, label }: { threadId: string; source: string; label?: string }) {
  const t = useTheme()
  const target = imageSource(source)
  const local = target?.kind === 'local'
  const loaded = useThreadImage(local ? threadId : null, source)
  const src = local ? loaded.image?.source : target?.kind ? source : undefined
  const keys = useContext(DocumentKeys)
  // The picture zooms and pans like the lightbox's (`motion/ZoomSurface.tsx`); the margin is the surface's own.
  if (src) return <div testId="image-tab" style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0 }}><ZoomPane src={src} label={label ?? 'Image'} keys={keys} /></div>
  return <div testId="image-tab" style={{ display: 'flex', flexGrow: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
    <Label color={t.textSecondary}>{loaded.failure?.reason ?? 'Loading image…'}</Label>
  </div>
}

/**
 * A pinned child thread (native subagent, delegated agent or helper): its live transcript in a pane of its own (`tab:<leaf>:<id>`,
 * never focused: focus stays with the host group). A native subagent is read-only as on its page; a delegated child has its
 * own composer. The tab stays after the child finishes, marked done. "Open thread" leaves for its page.
 */
function ChildThreadTab({ leafId, childId, children }: { leafId: string; childId: string; children: ReactNode }) {
  const paneId = `tab:${leafId}:${childId}`
  const [ready, setReady] = useState(false)
  useEffect(() => {
    createPane(paneId)
    const stop = registerHostedPane(paneId, leafId)
    void selectPaneThread(paneId, childId).catch(console.error)
    setReady(true)
    return () => { stop(); closePaneState(paneId) }
  }, [paneId, leafId, childId])
  if (!ready) return <LoadingLines />
  return <PaneProvider id={paneId}>
    <div testId={`child-tab-${childId}`} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, position: 'relative' }}>
      <ChildBar childId={childId} />
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, position: 'relative' }}>{children}</div>
    </div>
  </PaneProvider>
}

function ChildBar({ childId }: { childId: string }) {
  const t = useTheme()
  const listed = useNav((s) => s.children[childId]) as Thread | undefined
  const open = useApp((s) => (s.open.thread?.id === childId ? s.open.thread : undefined))
  const child = open ?? listed
  const phase = child ? subagentThreadPhase(child) : null
  return <div testId="child-tab-bar" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, paddingLeft: 16, paddingRight: 8, flexShrink: 0, borderBottomWidth: 1, borderColor: t.surfaceDivider }}>
    {child && <ProviderMark kind={child.provider.kind} size={12} />}
    <Label color={t.textSecondary} size={12} truncate style={{ flexShrink: 1 }}>{child?.subagent ? 'Subagent · read-only' : 'Delegated agent'}</Label>
    {phase && <Label color={phase === 'failed' ? t.red : t.textTertiary} size={12}>{phase === 'working' ? 'Working' : phase === 'done' ? 'Done' : phase === 'failed' ? 'Failed' : 'Stopped'}</Label>}
    <div style={{ flexGrow: 1 }} />
    <Button size="sm" variant="ghost" testId="child-tab-open" onClick={() => openThread(childId)}>Open thread</Button>
  </div>
}

/** Pin a child thread (Agents tab, a launch group row, a delegation row) as a tab of the thread on screen. */
export function pinChildThread(parentId: string, child: { id: string; title?: string }, leaf?: string) {
  return openTab(parentId, { kind: 'thread', id: child.id, title: child.title }, { leaf })
}
export { getGroup }
