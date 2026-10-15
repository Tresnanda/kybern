// The thread panel (`views/Sidebar.tsx`): the "kybern" app menu with search and
// the bell, the environment switcher, New chat and Resume session, then
// projects with their threads and Recents. Rows are 28px with an 8px radius;
// hover and selection share `--sidebar-accent`.
//
// GPUI lays out every built element on every frame, so the project list is a
// `<virtual-list>`: only rows near the viewport are built while a loader ticks.
import { useCallback, useMemo, useState } from 'react'
import { Icon } from './icons.tsx'
import { loadProviders } from './nav/live.ts'
import { N } from './nav/glyphs.ts'
import { newThread } from './nav/history.ts'
import { ContextMenu, Kbd, Menu, MenuItem, MenuLabel, MenuSeparator, muted } from './nav/overlay.tsx'
import { getNav, setNav, useNav } from './nav/store.ts'
import { EnvironmentSwitcher } from './sidebar/EnvironmentSwitcher.tsx'
import { attentionItems, buildRows, type AttentionKind, type Row } from './sidebar/model.ts'
import { DisclosureGroup, diffRows, liveGroups, markDisclosure, withGroups, type Group } from './sidebar/motion.tsx'
import { Rise } from './motion/kit.tsx'
import {
  accent,
  accentActive,
  ChildRow,
  CreateCoordinatorRow,
  IconButton,
  MessageRow,
  MoreRow,
  NoThreadsRow,
  ProjectHeader,
  RecentsHeader,
  resting,
  SectionLabel,
  ThreadRow,
  useAddProject,
} from './sidebar/rows.tsx'
import { getState, useApp } from './state.ts'
import { isFreeChatProject } from '../../../packages/kybern-client/src/types.ts'
import { ink, Label, useTheme } from './ui.tsx'
import type { Theme } from './theme.ts'


/** Rows built beyond the viewport (GPUIX default 512px). Every built row is laid out
 *  on every frame, so keep just enough for smooth wheel scrolling. */
const OVERDRAW = Number(process.env.KYBERN_OVERDRAW ?? 512)

export function Sidebar() {
  const projects = useApp((s) => s.projects)
  const threads = useApp((s) => s.threads)
  const selectedId = useApp((s) => s.selectedId)
  const draft = useApp((s) => s.draft)
  const page = useNav((s) => s.page)
  const collapsed = useApp((s) => s.collapsed)
  const children = useNav((s) => s.children)
  const activity = useNav((s) => s.activity)
  const unread = useNav((s) => s.unread)
  const dismissed = useNav((s) => s.dismissed)
  const filter = useNav((s) => s.filter)
  const attentionFilter = useNav((s) => s.attentionFilter)
  const attentionDismissals = useNav((s) => s.attentionDismissals)
  const projectOrder = useNav((s) => s.projectOrder)
  const composerDrafts = useNav((s) => s.composerDrafts)
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const onHome = page === 'home'
  const rows = useMemo(
    () =>
      buildRows({
        projects,
        threads,
        selectedId: onHome ? selectedId : null,
        draft: onHome && !selectedId ? draft : null,
        collapsed,
        showAll,
        expanded,
        nav: { children, activity, unread, dismissed, filter, attentionFilter, projectOrder, composerDrafts, attentionDismissals },
        now: Date.now(),
      }),
    [projects, threads, selectedId, draft, onHome, collapsed, showAll, expanded, children, activity, unread, dismissed, filter, attentionFilter, projectOrder, composerDrafts, attentionDismissals],
  )
  const toggleChildren = useCallback((id: string, open: boolean) => {
    markDisclosure()
    setExpanded((v) => ({ ...v, [id]: open }))
  }, [])
  const toggleMore = useCallback((id: string) => {
    markDisclosure()
    setShowAll((v) => ({ ...v, [id]: !v[id] }))
  }, [])
  const freeDraftSelected = onHome && !selectedId && !draft.projectId

  // Rows a disclosure adds or removes travel as one block for the tween; rows
  // for threads that just appeared rise in. Adjusted during render (not in an
  // effect) so the first frame of the change is already the animated one.
  const [seen, setSeen] = useState(rows)
  const [groups, setGroups] = useState<Group[]>([])
  const [risen, setRisen] = useState<ReadonlySet<string>>(() => new Set())
  if (seen !== rows) {
    setSeen(rows)
    const change = diffRows(seen, rows)
    const kept = liveGroups(groups, rows)
    if (change.groups.length || kept.length !== groups.length) setGroups([...kept, ...change.groups])
    const keys = new Set(rows.map((r) => r.key))
    const stillRisen = [...risen].filter((k) => keys.has(k))
    if (change.risen.length || stillRisen.length !== risen.size) setRisen(new Set([...stillRisen, ...change.risen]))
  }
  const finish = useCallback((id: number) => setGroups((gs) => gs.filter((g) => g.id !== id)), [])
  const ctx = { selectedId: onHome ? selectedId : null, activity, unread, composerDrafts, toggleChildren, toggleMore }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <BrandRow />
      <EnvironmentSwitcher />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 6, paddingRight: 6, paddingTop: 4, paddingBottom: 6 }}>
        <PrimaryAction
          icon={N.newThread}
          label="New chat"
          shortcut={['⌘', 'N']}
          active={freeDraftSelected}
          draft={!!composerDrafts['free:main']}
          onClick={() => newThread()}
          testId="new-chat"
        />
        <PrimaryAction icon={N.clock} label="Resume session" onClick={() => openSessions()} testId="resume-session" />
      </div>
      <virtual-list estimatedItemHeight={30} overdraw={OVERDRAW} style={{ flexGrow: 1, minHeight: 0 }} testId="thread-list">
        {[
          ...withGroups(rows, groups).map((item) =>
            item.kind === 'group' ? (
              <div key={`group:${item.group.id}`}>
                <DisclosureGroup mode={item.group.mode} height={item.group.height} onDone={() => finish(item.group.id)}>
                  {item.rows.map((row) => renderRow(row, ctx))}
                </DisclosureGroup>
              </div>
            ) : risen.has(item.row.key) ? (
              <Rise key={item.row.key} kind="row">
                {renderRow(item.row, ctx)}
              </Rise>
            ) : (
              renderRow(item.row, ctx)
            ),
          ),
          <div key="__end" style={{ height: 6 }} />,
        ]}
      </virtual-list>
    </div>
  )
}

/** Resume session, scoped to the project on screen (`PrimaryAction` onClick). */
export function openSessions() {
  const state = getState()
  const thread = state.selectedId ? state.threads.find((t) => t.id === state.selectedId) : undefined
  const projectId = state.selectedId ? (thread && !isFreeChatProject(thread.project_id) ? thread.project_id : null) : (state.draft.projectId ?? null)
  setNav({ sessions: { projectId } })
}

function renderRow(
  row: Row,
  ctx: {
    selectedId: string | null
    activity: ReturnType<typeof getNav>['activity']
    unread: ReturnType<typeof getNav>['unread']
    composerDrafts: ReturnType<typeof getNav>['composerDrafts']
    toggleChildren: (id: string, open: boolean) => void
    toggleMore: (id: string) => void
  },
) {
  switch (row.kind) {
    case 'label':
      return <SectionLabel key={row.key} />
    case 'message':
      return <MessageRow key={row.key} text={row.text} clearFilter={row.clearFilter} />
    case 'project':
      return (
        <ProjectHeader
          key={row.key}
          project={row.project}
          first={row.first}
          open={row.open}
          active={row.active}
          status={row.status}
          activity={row.activity}
          hasDraft={row.hasDraft}
          canMoveUp={row.canMoveUp}
          canMoveDown={row.canMoveDown}
        />
      )
    case 'create-coordinator':
      return <CreateCoordinatorRow key={row.key} project={row.project} />
    case 'thread':
      return (
        <ThreadRow
          key={row.key}
          thread={row.thread}
          depth={row.depth}
          childCount={row.childCount}
          childrenOpen={row.childrenOpen}
          nested={row.nested}
          selected={ctx.selectedId === row.thread.id}
          activity={ctx.activity[row.thread.id]}
          unread={!!ctx.unread[row.thread.id]}
          hasDraft={!!ctx.composerDrafts[`thread:${row.thread.id}`]}
          onToggleChildren={ctx.toggleChildren}
        />
      )
    case 'child':
      return (
        <ChildRow
          key={row.key}
          thread={row.thread}
          depth={row.depth}
          childCount={row.childCount}
          childrenOpen={row.childrenOpen}
          selected={ctx.selectedId === row.thread.id}
          onToggleChildren={ctx.toggleChildren}
        />
      )
    case 'more':
      return <MoreRow key={row.key} projectId={row.projectId} count={row.count} showAll={row.showAll} onToggle={ctx.toggleMore} />
    case 'no-threads':
      return <NoThreadsRow key={row.key} />
    case 'recents':
      return <RecentsHeader key={row.key} open={row.open} />
  }
}

// ---- brand row: the "kybern" app menu, search and the bell ----

type AgentCheck = { state: 'idle' } | { state: 'checking' } | { state: 'done'; ready: number }

function BrandRow() {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 8, paddingBottom: 4, paddingRight: 10, paddingLeft: 6 }}>
      <AppMenu />
      <div style={{ flexGrow: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <IconButton
          icon={N.search}
          size={24}
          glyph={15}
          radius={8}
          color={ink(t, 0.8)}
          hoverColor={t.text}
          label="Search"
          tooltip={['Search (⌘K)']}
          tooltipSide="bottom"
          onClick={() => setNav({ paletteOpen: true })}
          testId="sidebar-search"
        />
        <NotificationBell />
      </div>
    </div>
  )
}

/** The "kybern" menu: projects, settings, help and agents (`AppMenu`). */
function AppMenu() {
  const t = useTheme()
  const version = useNav((s) => s.version)
  const [check, setCheck] = useState<AgentCheck>({ state: 'idle' })
  const [open, setOpen] = useState(false)
  const addProject = useAddProject()
  const reloadAgents = async () => {
    if (check.state === 'checking') return
    setCheck({ state: 'checking' })
    try {
      const providers = await loadProviders(true)
      setCheck({ state: 'done', ready: providers.filter((p) => p.available).length })
    } catch {
      setCheck({ state: 'idle' })
    }
  }
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next && check.state === 'done') setCheck({ state: 'idle' })
      }}
      minWidth={224}
      testId="app-menu"
      rootStyle={{ flexGrow: 0 }}
      trigger={() => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, paddingLeft: 10, paddingRight: 10, borderRadius: 10, cursor: 'pointer', hover: { backgroundColor: accent(t) } }}>
          {/* Cal Sans once GPUIX can register fonts; semibold SF until then. */}
          <Label color={t.text} size={17} font="Cal Sans" weight={600}>
            kybern
          </Label>
          <Icon source={N.chevronDown} size={14} color={muted(t, 0.7)} />
        </div>
      )}
    >
      <MenuItem id="add" icon={N.folderOpen} label="Add project" onSelect={() => void addProject()} />
      <MenuItem id="settings" icon={N.settings} label="Settings" shortcut="⌘," onSelect={() => setNav({ settingsOpen: true })} />
      <MenuItem id="commands" icon={N.command} label="Commands and shortcuts" shortcut="⌘K" onSelect={() => setNav({ paletteOpen: true })} />
      <MenuSeparator />
      <MenuItem
        id="reload"
        icon={check.state === 'idle' ? N.refresh : check.state === 'checking' ? N.loader : N.circleCheck}
        label="Reload agents"
        keepOpen
        detail={check.state === 'checking' ? 'Checking…' : check.state === 'done' ? (check.ready === 1 ? '1 ready' : `${check.ready} ready`) : undefined}
        onSelect={() => void reloadAgents()}
      />
      <MenuItem id="agent-settings" icon={N.settings} label="Agent settings" onSelect={() => setNav({ settingsOpen: true })} />
      <MenuSeparator />
      <MenuItem id="about" icon={N.info} label="About kybern" detail={version ?? undefined} onSelect={() => setNav({ settingsOpen: true })} />
    </Menu>
  )
}

/** yellow = waiting on you, red = failed, blue = finished (`NotificationBell` `KIND_DOT`). */
const KIND_DOT: Record<AttentionKind, (t: Theme) => string> = {
  blocked: (t) => (t.variant === 'dark' ? 'rgba(255, 223, 32, 0.9)' : '#f0b100'),
  failed: (t) => (t.variant === 'dark' ? 'rgba(255, 100, 103, 0.9)' : '#fb2c36'),
  done: (t) => (t.variant === 'dark' ? 'rgba(81, 162, 255, 0.9)' : '#2b7fff'),
}

/** The bell filters the panel to threads that need attention; right-click to dismiss. */
function NotificationBell() {
  const t = useTheme()
  const threads = useApp((s) => s.threads)
  const unread = useNav((s) => s.unread)
  const attentionDismissals = useNav((s) => s.attentionDismissals)
  const active = useNav((s) => s.attentionFilter)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const items = useMemo(() => attentionItems(threads, { unread, attentionDismissals }), [threads, unread, attentionDismissals])
  const top = items[0]?.kind
  const toggle = () => setNav({ attentionFilter: !getNav().attentionFilter })
  const dismissAll = () => {
    const dismissals = { ...getNav().attentionDismissals }
    for (const item of items) dismissals[item.thread.id] = item.thread.last_seq
    setNav({ unread: {}, attentionDismissals: dismissals })
  }
  return (
    <div
      style={{ display: 'flex' }}
      onAuxClick={(e) => {
        if (e.isRightClick || e.button === 2) setMenuAt({ x: e.x ?? 0, y: e.y ?? 0 })
      }}
    >
      <IconButton
        icon={N.bell}
        size={24}
        glyph={15}
        radius={8}
        color={active ? t.text : ink(t, 0.8)}
        hoverColor={t.text}
        active={active}
        label={active ? 'Show all threads' : 'Show threads that need attention'}
        tooltip={active ? 'Show all threads' : items.length > 0 ? `${items.length} need attention` : 'Threads that need attention'}
        tooltipSide="bottom"
        onClick={toggle}
        testId="sidebar-bell"
      >
        {top && <div style={{ position: 'absolute', top: 2, right: 2, width: 6, height: 6, borderRadius: 3, backgroundColor: KIND_DOT[top](t), pointerEvents: 'none' }} />}
      </IconButton>
      {menuAt && (
        <ContextMenu at={menuAt} onClose={() => setMenuAt(null)} width={224}>
          <MenuLabel>Notifications</MenuLabel>
          <MenuItem id="toggle" icon={N.bell} label={active ? 'Show all threads' : 'Show notifications'} onSelect={toggle} />
          <MenuItem id="dismiss" icon={N.check} label="Dismiss all" disabled={items.length === 0} onSelect={dismissAll} />
        </ContextMenu>
      )}
    </div>
  )
}

/** New chat / Resume session (`PrimaryAction`): ⌘N appears on hover. */
function PrimaryAction({
  icon,
  label,
  shortcut,
  active,
  draft,
  onClick,
  testId,
}: {
  icon: string
  label: string
  shortcut?: string[]
  active?: boolean
  draft?: boolean
  onClick: () => void
  testId?: string
}) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  return (
    <div
      testId={testId}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 28,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 8,
        cursor: 'pointer',
        ...(active ? { backgroundColor: accentActive(t) } : hover ? { backgroundColor: accent(t) } : {}),
      }}
    >
      <div style={{ display: 'flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon source={icon} size={14} color={active ? t.text : resting(t)} />
      </div>
      <Label color={active ? t.text : resting(t)} truncate style={{ flexGrow: 1 }}>
        {label}
      </Label>
      {draft && !(shortcut && hover) && <Icon source={N.pencil} size={12} color={muted(t, 0.65)} />}
      {shortcut && hover && <Kbd keys={shortcut} />}
    </div>
  )
}

