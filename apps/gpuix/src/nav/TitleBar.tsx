import { splitFocusedPane, splitPane, closePane, maximizePane, canSplitPane, useSplitRoot } from '../split/store.ts'
import { TasksBar } from '../tasks/Header.tsx'
import { NoteEditorBar } from '../notes/EditorBar.tsx'
import { NotesHeaderActions, NotesHeaderTitle } from '../notes/Header.tsx'
import { useNotes } from '../notes/store.ts'
import { showDialog } from '../dialogs/store.ts'
import { ThreadContextChips } from '../coordinator/Header.tsx'
// The window title bar (`views/chrome.tsx` + the thread `Header` in
// `views/Thread.tsx`): the sidebar toggle and back/forward (or New thread while
// the panel is closed) after the traffic lights, then the route header over the
// content column: provider mark, title (double-click renames), Hand off, the ⋯
// thread menu, and the panel toggles.
import { SettingsBreadcrumb } from '../settings/Breadcrumb.tsx'
import { EnvironmentTrigger } from '../environment/Panel.tsx'
import { ISLAND } from '../MatrixLoader.tsx'
import { toggleDock, useDock } from '../dock/store.ts'
import { motion } from '@gpuix/react'
import { useState, type ReactNode } from 'react'
import { Swap, SwapOnChange } from '../motion/kit.tsx'
import { isChildThread } from '../../../../packages/kybern-client/src/subagents.ts'
import { subagentPhase, subagentTypeLabel } from '../../../../packages/kybern-client/src/subagents.ts'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { getClient, getState, set, useApp, usePaneAccess, focusPane } from '../state.ts'
import { ink, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { archiveThread, errorText, updateThread } from './actions.ts'
import { N } from './glyphs.ts'
import { goBack, goForward, newThread, openThread, useNavigationAvailability } from './history.ts'
import { Menu, MenuItem, MenuSeparator, muted, Tip } from './overlay.tsx'
import { getNav, setNav, useNav } from './store.ts'
import { providerLabel } from '../sidebar/model.ts'
import { useSidebarDragging, useSidebarWidth } from '../shell/layout.ts'
import { drawerSlide, fadeTo } from '../shell/motion.ts'

export const TITLEBAR = 46
export const RAIL = 52
export const SIDEBAR = 256
export const LEADING_X = 82


/** Notes and Usage have no thread panel. Pull requests allow a temporary peek;
 *  Tasks use their own sidebar. The saved Home preference is unchanged. */
export function usePanelOpen(): boolean {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const page = useNav((s) => s.page)
  const peek = useNav((s) => s.pullsPeek)
  if (page === 'notes' || page === 'usage') return false
  if (page === 'pulls') return peek
  return sidebarOpen
}

/** 28px square chrome control with a 16px glyph: the kit `IconButton`, with the tooltip and the dim that eases for a disabled one. */
function ChromeIcon({
  icon,
  label,
  tooltip,
  onClick,
  disabled,
  glyph = 16,
  pressed,
  testId,
  decorative = false,
}: {
  decorative?: boolean
  icon: string
  label: string
  tooltip?: string
  onClick?: () => void
  disabled?: boolean
  glyph?: number
  pressed?: boolean
  testId?: string
}) {
  // Back and forward dim while there is nowhere to go; the opacity eases so a step does not flicker them (`transition-opacity duration-150`).
  const dim = fadeTo(disabled ? 0.4 : 1)
  const button = (
    <div paintTransform={dim.paintTransform} style={{ display: 'flex', flexShrink: 0, ...dim.style }}>
      <IconButton testId={testId} icon={icon} label={label} glyph={glyph} active={pressed} onClick={disabled ? undefined : onClick} style={{ pointerEvents: decorative || disabled ? 'none' : 'auto', cursor: disabled ? 'default' : 'pointer' }} />
    </div>
  )
  // A disabled control shows no tooltip, as a disabled button gets no pointer events on the web.
  return tooltip && !disabled ? (
    <Tip label={tooltip} side="bottom">
      {button}
    </Tip>
  ) : (
    button
  )
}

export function TitleBar({ panelOpen }: { panelOpen: boolean }) {
  const splitRoot = useSplitRoot()
  const t = useTheme()
  const page = useNav((s) => s.page)
  const settingsOpen = useNav((s) => s.settingsOpen)
  const instant = useNav((s) => s.panelInstant)
  const { canBack, canForward } = useNavigationAvailability()
  const sidebarWidth = useSidebarWidth()
  const resizing = useSidebarDragging()
  const titleStart = panelOpen ? RAIL + sidebarWidth : LEADING_X + 84
  const panelless = page === 'notes' || page === 'usage'
  const toggle = () => {
    setNav({ panelInstant: false })
    if (getNav().page === 'pulls') setNav({ pullsPeek: !getNav().pullsPeek })
    else set({ sidebarOpen: !getState().sidebarOpen })
  }
  return (
    // A cached island (native/README.md): replays while the rest of the window animates.
    <div {...ISLAND} windowDrag testId="titlebar-drag" style={{ display: 'flex', width: '100%', height: TITLEBAR, flexShrink: 0, position: 'relative' }}>
      {!panelless && !settingsOpen && (
        <div style={{ position: 'absolute', left: LEADING_X, top: 0, height: TITLEBAR, display: 'flex', alignItems: 'center' }}>
          <ChromeIcon icon={N.layoutSidebar} label="Toggle thread sidebar" tooltip="Toggle sidebar (⌘B)" onClick={toggle} testId="sidebar-toggle" />
          {/* `IconSwap`: back/forward give way to New thread while the panel is closed.
              The incoming state fades up (kit `Swap`); ⌘B swaps at once. */}
          <NavSwap panelOpen={panelOpen} instant={REDUCED_MOTION || instant}>
            {panelOpen ? (
              <>
                <ChromeIcon icon={N.arrowLeft} label="Back" tooltip="Back (⌘[)" disabled={!canBack} onClick={() => goBack()} testId="nav-back" />
                <ChromeIcon icon={N.arrowRight} label="Forward" tooltip="Forward (⌘])" disabled={!canForward} onClick={() => goForward()} testId="nav-forward" />
              </>
            ) : (
              <ChromeIcon icon={N.newThread} label="New thread" tooltip="New thread" onClick={() => newThread()} testId="titlebar-new-thread" />
            )}
          </NavSwap>
        </div>
      )}
      {panelOpen && !settingsOpen && (
        // The 1×20 tick at the content column's leading edge.
        <div style={{ position: 'absolute', left: RAIL + sidebarWidth, top: 13, width: 1, height: 20, backgroundColor: t.variant === 'dark' ? 'rgba(255, 255, 255, 0.09)' : 'rgba(0, 0, 0, 0.10)' }} />
      )}
      {settingsOpen && <SettingsBreadcrumb />}
      <motion.div
        windowDrag
        initial={false}
        animate={{ left: panelless ? LEADING_X : titleStart }}
        transition={REDUCED_MOTION || instant || resizing ? { duration: 0 } : drawerSlide(panelOpen)}
        style={{ position: 'absolute', top: 0, right: 8, height: TITLEBAR, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 20, paddingRight: 12 }}
      >
        {!settingsOpen && page === 'home' && (splitRoot.kind === 'split' ? <><div style={{ flexGrow: 1 }} /><PanelToggles /></> : <ThreadHeader />)}
        {!settingsOpen && page === 'notes' && <NotesBar />}
        {!settingsOpen && page === 'tasks' && <TasksBar />}
      </motion.div>
    </div>
  )
}

/** The gallery's title-bar row; an open note draws its own header. */
function NotesBar() {
  const selected = useNotes((s) => s.selected)
  const loaded = useNotes((s) => s.loaded)
  const exists = useNotes((s) => !!s.selected && s.notes.some((n) => n.id === s.selected))
  if (selected && (!loaded || exists)) return exists ? <NoteEditorBar id={selected} /> : null
  return (
    <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 8 }}>
      <NotesHeaderTitle />
      <div style={{ flexGrow: 1 }} />
      <NotesHeaderActions />
    </div>
  )
}

function NavSwap({ panelOpen, instant, children }: { panelOpen: boolean; instant: boolean; children: ReactNode }) {
  const style = { width: 56, height: 28, justifyContent: panelOpen ? 'flex-start' : 'center' } as const
  const active = panelOpen ? 'history' : 'new-thread'
  // The first state shows without motion; each later swap plays unless it came from ⌘B.
  const [shown, setShown] = useState({ active, play: false })
  if (shown.active !== active) setShown({ active, play: !instant })
  return (
    <div style={{ display: 'flex', width: 56, height: 28 }}>
      {!shown.play || shown.active !== active ? (
        <div key={active} style={{ display: 'flex', alignItems: 'center', ...style }}>
          {children}
        </div>
      ) : (
        <Swap active={active} style={style}>
          {children}
        </Swap>
      )}
    </div>
  )
}

/**
 * `TextSwap` on the header title: a rename (or the agent's first title) rises in from 4px below with a 2px blur while the old title
 * leaves up and out (250 / 150 ms). Opening another thread does not swap: the desktop remounts the header per thread, so a new
 * `threadId` starts a fresh swap whose first title paints plainly (⌘[ / ⌘] included).
 */
function TitleSwap({ threadId, title, children }: { threadId: string; title: string; children: ReactNode }) {
  return (
    <SwapOnChange
      key={threadId}
      active={title}
      style={{ minWidth: 0, flexShrink: 1, justifyContent: 'flex-start' }}
      innerStyle={{ minWidth: 0, flexShrink: 1, justifyContent: 'flex-start' }}
      leavingStyle={{ right: 0 }}
    >
      {children}
    </SwapOnChange>
  )
}

/** The thread on screen, from the lists, the child threads, or the open transcript. */
function useSelectedThread(): Thread | null {
  const selectedId = useApp((s) => s.selectedId)
  const listed = useApp((s) => (s.selectedId ? s.threads.find((th) => th.id === s.selectedId) : undefined))
  const child = useNav((s) => (selectedId ? s.children[selectedId] : undefined))
  const open = useApp((s) => (s.open.thread?.id === selectedId ? s.open.thread : null))
  return listed ?? child ?? open ?? null
}

/** The chain above a thread, topmost first (`subagentAncestors`). */
function ancestorsOf(thread: Thread): Thread[] {
  const chain: Thread[] = []
  const seen = new Set([thread.id])
  let parentId = thread.parent_thread_id
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = getState().threads.find((t) => t.id === parentId) ?? getNav().children[parentId]
    if (!parent) break
    chain.unshift(parent)
    parentId = parent.parent_thread_id
  }
  return chain
}

export function ThreadHeader({ paneId }: { paneId?: string } = {}) {
  const root = useSplitRoot()
  const split = (direction: 'horizontal' | 'vertical') => paneId ? splitPane(paneId, direction) : splitFocusedPane(direction)
  const t = useTheme()
  const thread = useSelectedThread()
  const providers = useNav((s) => s.providers)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState('')
  if (!thread) {
    // Home: only the panel toggles (`SurfaceHeader minimal`).
    return (
      <>
        <div windowDrag style={{ flexGrow: 1, height: '100%' }} />
        <PanelToggles />
      </>
    )
  }
  const ancestors = ancestorsOf(thread)
  const mainThread = thread.subagent ? undefined : ancestors[0]
  const others = providers.filter((p) => p.available && p.kind !== thread.provider.kind)
  const commitRename = () => {
    setRenaming(false)
    const next = title.trim()
    if (next && next !== thread.title) void updateThread(thread.id, { title: next }).catch((e) => console.error('[titlebar] Unable to rename:', errorText(e)))
  }
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0 }}>
        {thread.subagent ? (
          <Breadcrumb thread={thread} ancestors={ancestors} />
        ) : (
          <>
            {mainThread && (
              <HeaderChip testId="main-thread" onClick={() => openThread(mainThread.id)}>
                <Icon source={N.arrowLeft} size={14} color={muted(t, 1)} />
                <Label color={muted(t, 1)} truncate>
                  Main thread
                </Label>
              </HeaderChip>
            )}
            <ProviderMark kind={thread.provider.kind} size={14} tone="header" />
            {renaming ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.value ?? '')}
                onSubmit={commitRename}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'escape') setRenaming(false)
                }}
                testId="header-rename"
                style={{ width: 360, height: 22, paddingLeft: 4, paddingRight: 4, borderRadius: 6, borderWidth: 1, borderColor: t.v('--ring'), color: t.text, fontSize: 14 }}
              />
            ) : (
              <div
                testId="header-title"
                onClick={(e) => {
                  if ((e.clickCount ?? 1) >= 2 && !isChildThread(thread)) {
                    setTitle(thread.title)
                    setRenaming(true)
                  }
                }}
                style={{ display: 'flex', minWidth: 0, flexShrink: 1, pointerEvents: 'auto' }}
              >
                <TitleSwap threadId={thread.id} title={thread.title || 'Untitled'}>
                  <Label color={t.text} truncate>
                    {thread.title || 'Untitled'}
                  </Label>
                </TitleSwap>
              </div>
            )}
            <ThreadContextChips thread={thread} />
            {thread.coordinator_project_id && (
              <Label color={muted(t, 0.6)} size={10} weight={500} style={{ flexShrink: 0 }}>
                Project coordinator
              </Label>
            )}
          </>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {!thread.subagent && others.length > 0 && (
          <Menu
            align="end"
            minWidth={192}
            testId="handoff-menu"
            trigger={() => (
              <Button variant="ghost" icon="handoff" label="Hand off" style={{ pointerEvents: 'auto' }}>
                {paneId ? undefined : 'Hand off'}
              </Button>
            )}
          >
            {others.map((p) => (
              <MenuItem
                key={p.kind}
                id={p.kind}
                iconNode={<ProviderMark kind={p.kind} size={14} />}
                label={`Hand off to ${providerLabel(p.kind) ?? p.display_name}`}
                onSelect={() => setNav({ handoff: { threadId: thread.id, target: p.kind } })}
              />
            ))}
          </Menu>
        )}
        <Menu
          align="end"
          minWidth={208}
          testId={paneId ? `pane-actions-${paneId}` : "thread-actions"}
          trigger={(open) => <ChromeIcon decorative icon={N.ellipsis} label="Thread actions" pressed={open} />}
        >

          <MenuItem id="split-right" testId={paneId ? `pane-right-${paneId}` : "header-split-right"} disabled={paneId ? !canSplitPane(root, paneId, 'horizontal') : false} icon={N.splitRight} label="Split right" shortcut="⌘\" onSelect={() => split('horizontal')} />
          <MenuItem id="split-down" testId={paneId ? `pane-down-${paneId}` : "header-split-down"} disabled={paneId ? !canSplitPane(root, paneId, 'vertical') : false} icon={N.splitDown} label="Split down" shortcut="⌘⇧\" onSelect={() => split('vertical')} />
          {paneId && <><MenuItem id="expand-pane" label="Expand this pane" onSelect={() => maximizePane(paneId)} /><MenuItem id="close-pane" testId={`pane-close-${paneId}`} label="Close pane" icon={N.x} onSelect={() => closePane(paneId)} /></>}
          {thread.subagent && (
            <>
              <MenuSeparator />
              <MenuItem id="parent" icon={N.backToParent} label="Open parent" shortcut="⌘↑" onSelect={() => thread.parent_thread_id && openThread(thread.parent_thread_id)} />
              {subagentPhase(thread.subagent.status) === 'working' && thread.subagent.capabilities?.stop !== false && (
                <MenuItem id="stop" icon={N.stop} label="Stop" onSelect={() => void getClient()?.call('tasks.stop', { thread_id: thread.id }).catch(() => {})} />
              )}
            </>
          )}
          {thread.worktree && !thread.subagent && <MenuItem id="cleanup" testId="header-worktree-cleanup" icon={N.worktree} label="Remove worktree…" onSelect={() => showDialog({ kind: 'worktree', threadId: thread.id })} />}
          {/* A subagent thread is read-only: it cannot be renamed, pinned or archived. */}
          {!thread.subagent && (
            <>
              <MenuSeparator />
              <MenuItem
                id="rename"
                icon={N.pencil}
                label="Rename thread"
                onSelect={() => {
                  setTitle(thread.title)
                  setRenaming(true)
                }}
              />
              <MenuItem
                id="pin"
                icon={thread.pinned ? N.pinFilled : N.pin}
                label={thread.pinned ? 'Unpin' : 'Pin'}
                onSelect={() => void updateThread(thread.id, { pinned: !thread.pinned }).catch((e) => console.error('[titlebar] Unable to pin:', errorText(e)))}
              />
              <MenuSeparator />
              <MenuItem
                id="archive"
                icon={N.archive}
                label="Archive"
                destructive
                testId="header-archive"
                onSelect={() => void archiveThread(thread.id).catch((e) => console.error('[titlebar] Unable to archive:', errorText(e)))}
              />
            </>
          )}
        </Menu>
        <PanelToggles />
      </div>
    </>
  )
}

/** The Environment card and right dock toggles. */
function PanelToggles() {
  const pane = usePaneAccess()
  const threadId = useApp((s) => s.selectedId)
  const dock = useDock(threadId)
  return (
    <>
      {threadId && <EnvironmentTrigger key={threadId} threadId={threadId} />}
      <ChromeIcon icon={N.panelRight} label="Toggle right sidebar" tooltip={`${dock.open ? 'Close' : 'Open'} right sidebar (⌘J)`} pressed={dock.open} onClick={() => { focusPane(pane.id); toggleDock() }} testId="dock-toggle" />
    </>
  )
}

/** A plain header chip (`ChatHeaderButton tone="plain"`). */
function HeaderChip({ children, onClick, testId }: { children: ReactNode; onClick: () => void; testId?: string }) {
  return (
    <Button variant="ghost" testId={testId} onClick={onClick} style={{ gap: 6, maxWidth: 176, paddingLeft: 6, paddingRight: 6, pointerEvents: 'auto' }}>
      {children}
    </Button>
  )
}

/** A subagent's location: its ancestors, then its title (`SubagentBreadcrumb`). */
function Breadcrumb({ thread, ancestors }: { thread: Thread; ancestors: Thread[] }) {
  const t = useTheme()
  const visible = ancestors.length >= 3 ? [ancestors[0]!, ancestors.at(-1)!] : ancestors
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
      {visible.map((ancestor, index) => (
        <div key={ancestor.id} style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
          <HeaderChip onClick={() => openThread(ancestor.id)}>
            {index === 0 && <ProviderMark kind={ancestor.provider.kind} size={12} />}
            <Label color={t.textSecondary} truncate>
              {ancestor.title || 'Untitled'}
            </Label>
          </HeaderChip>
          {index === 0 && ancestors.length >= 3 && (
            <Menu minWidth={200} trigger={() => <HeaderChip onClick={() => {}}><Label color={t.textSecondary}>…</Label></HeaderChip>}>
              {ancestors.slice(1, -1).map(parent => <MenuItem id={parent.id} key={parent.id} label={parent.title || 'Subagent'} onSelect={() => openThread(parent.id)} />)}
            </Menu>
          )}
          <Icon source={N.chevronRight} size={12} color={ink(t, 0.32)} />
        </div>
      ))}
      <div style={{ display: 'flex', paddingLeft: 4, paddingRight: 4, minWidth: 0 }}>
        <Label color={t.text} truncate>
          {thread.title || 'Subagent'}
        </Label>
        {subagentTypeLabel(thread.subagent?.agent_type) && <Label color={t.textSecondary} size={11} style={{ marginLeft: 8 }}>{subagentTypeLabel(thread.subagent?.agent_type)}</Label>}
      </div>
    </div>
  )
}
