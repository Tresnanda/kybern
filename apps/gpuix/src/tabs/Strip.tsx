// One group's tab strip: the chat (provider mark + thread title, pinned first) and the documents opened beside it. In the
// thread header (46 px, `md`) or, for the lower groups of a split, a 32 px row (`sm`). The + menu opens what has no list of its
// own in the dock: a terminal (or an agent CLI), the browser preview, Review, and all changes.
import { terminalTabLabel } from '../terminal/title.ts'
import { toast } from '../shell/toasts.tsx'
import { errorText } from '../nav/actions.ts'
import { memo, useMemo, useState, type ReactNode } from 'react'
import { fadeTo } from '../shell/motion.ts'
import { BrowserIcon, FlowchartIcon, Image01Icon } from '@hugeicons/core-free-icons'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { subagentThreadPhase } from '../../../../packages/kybern-client/src/subagents.ts'
import { Tabs, type TabsItem } from '../kit/Tabs.tsx'
import { glyph, Icon } from '../icons.tsx'
import { DOCK_ICONS } from '../dock/icons.ts'
import { N } from '../nav/glyphs.ts'
import { T } from '../transcript/glyphs.ts'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../nav/overlay.tsx'
import { useNav } from '../nav/store.ts'
import { useApp, getThreadOpen, threadClient } from '../state.ts'
import { useNotes } from '../notes/store.ts'
import { useTasks } from '../tasks/store.ts'
import { usePreview } from '../preview/store.ts'
import { useFocusedPane, useGroup, useSplitRoot } from '../split/store.ts'
import { ink, ProviderMark, useTheme } from '../ui.tsx'
import { CHAT, tabKey, type Tab } from './model.ts'
import { closeTabAction, fileTabBuffer, keepTab, openTab, selectTab } from './open.ts'
import { useDirtyKeys } from '../dock/fileBuffers.ts'
import { TerminalOnMenu } from '../machines/TerminalOnMenu.tsx'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { glyphOfMachine, machineHub } from '../machines/index.ts'
import { terminalTooltip } from '../../../../packages/kybern-client/src/machineUtilities.ts'
import { beginTabsDrag, endTabsPress, releaseStrip, stripRegistry, trackTabsPress, unregisterTab, useTabsDrop } from './drag.tsx'

const ICONS = { browser: glyph(BrowserIcon), diagram: glyph(FlowchartIcon), image: glyph(Image01Icon) }
const base = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

/** The thread a group shows, from the lists, the child threads, or the open transcript. */
export function useThreadRecord(threadId: string | null): Thread | null {
  const listed = useApp((s) => (threadId ? s.threads.find((th) => th.id === threadId) : undefined))
  const child = useNav((s) => (threadId ? s.children[threadId] : undefined))
  const open = useApp((s) => (s.open.thread?.id === threadId ? s.open.thread : null))
  return listed ?? child ?? open ?? null
}

/** Label, glyph and tooltip of every tab. Titles come from the live stores (a renamed note renames its tab). */
export function useTabItems(threadId: string | null, tabs: Tab[], preview: string | null): TabsItem[] {
  const thread = useThreadRecord(threadId)
  const children = useNav((s) => s.children)
  const threads = useApp((s) => s.threads)
  const notes = useNotes((s) => s.notes)
  const tasks = useTasks((s) => s.tasks)
  const previewState = usePreview(threadId ?? '')
  const page = previewState.pageTitle || previewState.entries[previewState.index]?.title
  const dirtyKeys = useDirtyKeys()
  const dirty = useMemo(() => new Set(dirtyKeys.split('\n')), [dirtyKeys])
  return useMemo(() => tabs.map((tab): TabsItem => {
    const key = tabKey(tab)
    const common = { key, preview: preview === key, testId: `tab-${key}` }
    switch (tab.kind) {
      // A dot on the chat while an approval waits there (it is hidden behind a document tab).
      case 'chat': return { ...common, pinned: true, label: thread?.title || 'Untitled', mark: thread?.provider.kind, testId: 'tab-chat', dirty: tabs.length > 1 && thread?.status === 'awaiting-approval', tooltip: thread?.status === 'awaiting-approval' ? `${thread.title || 'Untitled'} · waiting for approval` : undefined }
      case 'file': { const unsaved = dirty.has(fileTabBuffer(threadId, tab) ?? ''); return { ...common, label: base(tab.path), icon: T.file, dirty: unsaved, tooltip: `${tab.line ? `${tab.path}:${tab.line}` : tab.path}${unsaved ? ' · unsaved' : ''}` } }
      case 'diff': return tab.path ? { ...common, label: base(tab.path), icon: DOCK_ICONS.changes, tooltip: `Changes in ${tab.path}` } : { ...common, label: 'Changes', icon: DOCK_ICONS.changes }
      case 'terminal': if (tab.machineId) return { ...common, label: terminalTabLabel(tab.title, machineHub().set.connection(tab.machineId)?.record.name), iconNode: <MachineBadge glyph={glyphOfMachine(tab.machineId)} size={14} />, tooltip: terminalTooltip(machineHub().set.connection(tab.machineId)?.record.name ?? 'another machine', tab.title) }
        return tab.cli ? { ...common, label: tab.title || 'Terminal', mark: tab.cli } : { ...common, label: terminalTabLabel(tab.title), icon: DOCK_ICONS.terminal }
      case 'preview': return { ...common, label: page || 'Browser', icon: ICONS.browser, tooltip: page ? `Browser · ${page}` : 'Browser' }
      case 'review': return { ...common, label: 'Review', icon: N.pullRequest }
      case 'pr': return { ...common, label: `#${tab.number}${tab.title ? ` ${tab.title}` : ''}`, icon: N.pullRequest }
      case 'note': return { ...common, label: notes.find((n) => n.id === tab.id)?.title || tab.title || 'Note', icon: N.note }
      case 'task': { const task = tasks[tab.id]; return { ...common, label: task ? `${task.key} ${task.title}` : tab.title || 'Task', icon: N.tasks } }
      case 'visual': return { ...common, label: tab.title || 'Visual', icon: DOCK_ICONS.preview }
      case 'artifact': return { ...common, label: tab.title || base(tab.path), icon: DOCK_ICONS.artifacts, tooltip: tab.path }
      case 'mermaid': return { ...common, label: tab.title || 'Diagram', icon: ICONS.diagram }
      case 'image': return { ...common, label: tab.label || base(tab.source), icon: ICONS.image, tooltip: tab.source }
      case 'thread': {
        const child = children[tab.id] ?? threads.find((th) => th.id === tab.id) ?? getThreadOpen(tab.id)?.thread ?? undefined
        const phase = child ? subagentThreadPhase(child) : null
        return { ...common, label: child?.title || tab.title || 'Agent', mark: child?.provider.kind, ...(phase === 'working' ? { dirty: true } : phase === 'done' ? { detail: 'Done' } : phase === 'failed' ? { detail: 'Failed' } : {}) }
      }
    }
  }), [tabs, preview, thread?.title, thread?.provider.kind, children, threads, notes, tasks, page, dirty, threadId])
}

/**
 * The strip of leaf `leafId`. `size` md sits in the 46 px header (underline 9 px below the tabs), sm in a 32 px row (4 px).
 * `onRename`: a double click on the chat tab renames the thread, like the old title.
 */
export const GroupStrip = memo(function GroupStrip({ leafId, size = 'md', onRename, trailing }: { leafId: string; size?: 'md' | 'sm'; onRename?: () => void; trailing?: ReactNode }) {
  const group = useGroup(leafId)
  const root = useSplitRoot()
  const focusedLeaf = useFocusedPane()
  const items = useTabItems(group.threadId, group.tabs, group.preview)
  const drop = useTabsDrop(leafId)
  // With only the chat open the header reads like the old title bar: the + shows while the pointer is over it.
  const [hover, setHover] = useState(false)
  if (!group.threadId) return null
  const focused = root.kind === 'leaf' || focusedLeaf === leafId
  const quiet = group.tabs.length === 1 && !hover
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', alignItems: 'center', flexShrink: 1, minWidth: 0, height: '100%' }}>
    <Tabs
      testId={`tabs-${leafId}`}
      items={items}
      active={group.active}
      size={size}
      focused={focused}
      markSingle={root.kind !== 'leaf'}
      underlineGap={size === 'md' ? 9 : 4}
      dividerAfter={CHAT}
      separators
      dropIndex={drop}
      onSelect={(key) => selectTab(leafId, key)}
      onClose={(key) => closeTabAction(leafId, key)}
      onDoubleClick={(key) => { if (key === CHAT) onRename?.(); else { keepTab(leafId, key); selectTab(leafId, key) } }}
      onTabMouseDown={(key, event, rect) => { const item = items.find((i) => i.key === key); if (item) beginTabsDrag(leafId, key, item, event, rect, size) }}
      onTabMouseMove={(_key, event, left) => trackTabsPress(event, left)}
      onTabMouseUp={(_key, event) => endTabsPress(event)}
      registerTab={(key, node) => { if (node) stripRegistry(leafId).tabs.set(key, node); else unregisterTab(leafId, key) }}
      stripRef={(node) => { if (node) stripRegistry(leafId).strip = node; else releaseStrip(leafId) }}
      trailing={<><div paintTransform={fadeTo(quiet ? 0 : 1).paintTransform} style={{ display: 'flex', ...fadeTo(quiet ? 0 : 1).style }}><AddMenu leafId={leafId} threadId={group.threadId} size={size} /></div>{trailing}</>}
    />
    </div>
  )
})

/** + : what has no list of its own in the dock. */
function AddMenu({ leafId, threadId, size }: { leafId: string; threadId: string; size: 'md' | 'sm' }) {
  const t = useTheme()
  const providers = useNav((s) => s.providers)
  const thread = useThreadRecord(threadId)
  const box = size === 'md' ? 24 : 20
  const terminal = async (command?: string[], cli?: string) => {
    try {
      const info = await threadClient(threadId)!.call('terminals.create', { thread_id: threadId, cols: 100, rows: 24, ...(command ? { command } : {}) })
      openTab(threadId, { kind: 'terminal', id: info.id, title: cli ? providers.find((p) => p.kind === cli)?.display_name : undefined, ...(cli ? { cli } : {}) }, { leaf: leafId })
    } catch (error) { toast.error('Unable to open a terminal', { description: errorText(error) }) }
  }
  const clis = providers.filter((p) => p.available && p.binary_path)
  if (thread?.subagent) return null
  return (
    <Menu align="start" minWidth={216} testId={`tabs-add-${leafId}`} trigger={(open) => (
      <div role="button" aria-label="Open a tab" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: box, height: box, marginLeft: 2, borderRadius: 6, flexShrink: 0, cursor: 'pointer', ...(open ? { backgroundColor: ink(t, 0.08) } : {}), hover: { backgroundColor: ink(t, 0.06) } }}>
        <Icon source={N.plus} size={14} color={t.textSecondary} />
      </div>
    )}>
      <MenuItem id="terminal" testId="tabs-add-terminal" icon={DOCK_ICONS.terminal} label="New terminal" onSelect={() => void terminal()} />
      <TerminalOnMenu threadId={threadId} leaf={leafId} />
      {clis.length > 0 && <MenuSubList>{clis.map((p) => <MenuItem key={p.kind} id={`cli-${p.kind}`} iconNode={<ProviderMark kind={p.kind} size={14} />} label={p.display_name} onSelect={() => void terminal([p.binary_path!], p.kind)} />)}</MenuSubList>}
      <MenuSeparator />
      <MenuItem id="preview" testId="tabs-add-preview" icon={ICONS.browser} label="Browser" shortcut="⌘L" onSelect={() => openTab(threadId, { kind: 'preview' }, { leaf: leafId })} />
      <MenuItem id="changes" testId="tabs-add-changes" icon={DOCK_ICONS.changes} label="All changes" onSelect={() => openTab(threadId, { kind: 'diff' }, { leaf: leafId })} />
      <MenuItem id="review" testId="tabs-add-review" icon={N.pullRequest} label="Review" onSelect={() => openTab(threadId, { kind: 'review' }, { leaf: leafId })} />
    </Menu>
  )
}

function MenuSubList({ children }: { children: ReactNode }) {
  return <><MenuSeparator /><MenuLabel>Agent CLIs</MenuLabel>{children}</>
}
