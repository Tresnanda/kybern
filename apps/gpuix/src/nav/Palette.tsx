import { setAppearance } from '../settings/appearance.ts'
import { StatusGlyph } from '../tasks/Glyphs.tsx'
import { quickAdd, openTask, useTasks } from '../tasks/store.ts'
import { toggleDock } from '../dock/store.ts'
import { splitFocusedPane, useSplitRoot } from '../split/store.ts'
import { closeFocusedPane } from '../tabs/open.ts'
import { STATUS_LABEL } from '@/state/tasksModel'
// Search palette (⌘K, the sidebar's search button): `views/Palette.tsx`. One
// input over grouped results: suggested commands, the 40 most recent threads,
// projects. Typing filters by label and keywords; ↑/↓ move the highlight, Enter
// runs it, Escape closes. Opened from the search button it fades in like the
// desktop's command dialog; opened with ⌘K it appears at once. It closes at once.
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { relativeTime } from '@/lib/format'
import { isFreeChatProject } from '../../../../packages/kybern-client/src/types.ts'
import { NotesOverlays } from '../notes/Overlays.tsx'
import { newNote, openNote, openQuickNote, useNotes } from '../notes/store.ts'
import { Icon } from '../icons.tsx'
import { SearchField } from '../kit/SearchField.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { getState, useApp } from '../state.ts'
import { SPACE_COPY, inSpace } from '../../../../packages/kybern-client/src/spaces.ts'
import { switchSpace, useCurrentSpaceId } from '../spaces/current.ts'
import { openSpaceEditor } from '../spaces/ui.ts'
import { useSpaces } from '../spaces/store.ts'
import { SpaceLogo } from '../spaces/SpaceLogo.tsx'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { N } from './glyphs.ts'
import { canMoveNavHistory, goBack, goForward, goPage, isNavEntryValid, newThread, openThread } from './history.ts'
import { Dialog, muted } from './overlay.tsx'
import { Kbd } from '../kit/Kbd.tsx'
import { getNav, setNav, useNav } from './store.ts'

interface Item {
  id: string
  label: string
  keywords: string
  group: 'Suggested' | 'Threads' | 'Notes' | 'Tasks' | 'Projects' | 'Themes'
  icon: ReactNode
  meta?: ReactNode
  run: () => void
}

export function Palette() {
  const open = useNav((s) => s.paletteOpen)
  return <><NotesOverlays />{open && <PaletteDialog />}</>
}

function PaletteDialog() {
  const t = useTheme()
  const { renderer } = useGpuix()
  const notes = useNotes((s) => s.notes)
  const threads = useApp((s) => s.threads)
  const projects = useApp((s) => s.projects)
  const history = useNav((s) => s.history)
  const settingsOpen = useNav((s) => s.settingsOpen)
  const page = useNav((s) => s.page)
  const taskMap = useTasks((s) => s.tasks)
  const spaceId = useCurrentSpaceId()
  const spaces = useSpaces((s) => s.spaces)
  const spacesOn = useSpaces((s) => s.supported === true)
  const selectedId = useApp((s) => s.selectedId)
  const inSplit = useSplitRoot().kind === 'split'
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rowRefs = useRef(new Map<number, PublicInstance>())
  const close = () => setNav({ paletteOpen: false })

  const groups = useMemo(() => {
    const kbd = (keys: string[]) => <Kbd keys={keys} />
    const projectName = (id: string) => (isFreeChatProject(id) ? 'Free chat' : (projects.find((p) => p.id === id)?.name ?? ''))
    // Every other space, then "New space…" (§7.11): ⌃1–⌃8 and ⌃9 for the last, as on the rail.
    const spaceCommands = (): Item[] => [
      ...spaces.flatMap((space, index): Item[] => space.id === spaceId ? [] : [{
        id: `space:${space.id}`,
        label: SPACE_COPY.switchTo(space.name),
        keywords: `switch space ${space.name}`,
        group: 'Suggested',
        icon: <SpaceLogo space={space} size={16} />,
        meta: spaces.length >= 2 && (index < 8 || (index === spaces.length - 1 && spaces.length > 8)) ? kbd(['⌃', index === spaces.length - 1 && spaces.length > 8 ? '9' : String(index + 1)]) : undefined,
        run: () => { switchSpace(space.id, 'pointer') },
      }]),
      { id: 'space-new', label: SPACE_COPY.paletteNew, keywords: 'new space create group projects', group: 'Suggested', icon: <Icon source={N.plus} size={15} color={muted(t, 1)} />, run: () => openSpaceEditor({ anchor: 'plus', mode: 'create', still: true }) },
    ]
    const actions: Item[] = [
      {
        id: 'resume',
        label: 'Resume session',
        keywords: 'resume sessions import saved external conversation',
        group: 'Suggested',
        icon: <Icon source={N.clock} size={15} color={muted(t, 1)} />,
        run: () => {
          const s = getState()
          const thread = s.selectedId ? s.threads.find((x) => x.id === s.selectedId) : undefined
          setNav({ sessions: { projectId: s.selectedId ? (thread?.project_id ?? null) : (s.draft.projectId ?? null) } })
        },
      },
      {
        id: 'new',
        label: 'New thread',
        keywords: 'new thread create',
        group: 'Suggested',
        icon: <Icon source={N.newThread} size={15} color={muted(t, 1)} />,
        meta: page === 'notes' ? undefined : kbd(['⌘', 'N']),
        run: () => newThread(),
      },
      // Notes and Tasks have no dock.
      ...(page === 'notes' || page === 'tasks'
        ? []
        : [{ id: 'dock', label: 'Toggle right sidebar', keywords: 'panel dock changes terminal', group: 'Suggested' as const, icon: <Icon source={N.panelRight} size={15} color={muted(t, 1)} />, meta: kbd(['⌘', 'J']), run: () => toggleDock() }]),
      ...(selectedId && page === 'home'
        ? [{ id: 'split', label: 'Split right', keywords: 'split pane thread column', group: 'Suggested' as const, icon: <Icon source={N.splitRight} size={15} color={muted(t, 1)} />, meta: kbd(['⌘', '\\']), run: () => void splitFocusedPane('horizontal') }]
        : []),
      // Runs after the palette closes, so the pane closes while the tabs are on screen.
      ...(inSplit && page === 'home' && !settingsOpen
        ? [{ id: 'close-pane', label: 'Close pane', keywords: 'close pane split group column', group: 'Suggested' as const, icon: <Icon source={N.x} size={15} color={muted(t, 1)} />, meta: kbd(['⌘', '⇧', 'W']), run: () => void closeFocusedPane() }]
        : []),
      ...(settingsOpen || canMoveNavHistory(history, -1, isNavEntryValid)
        ? [{ id: 'go-back', label: 'Go back', keywords: 'back previous history navigate return', group: 'Suggested' as const, icon: <Icon source={N.arrowLeft} size={15} color={muted(t, 1)} />, meta: kbd(['⌘', '[']), run: () => void goBack() }]
        : []),
      ...(!settingsOpen && canMoveNavHistory(history, 1, isNavEntryValid)
        ? [{ id: 'go-forward', label: 'Go forward', keywords: 'forward next history navigate', group: 'Suggested' as const, icon: <Icon source={N.arrowRight} size={15} color={muted(t, 1)} />, meta: kbd(['⌘', ']']), run: () => void goForward() }]
        : []),
      ...(spacesOn ? spaceCommands() : []),
      {
        id: 'settings',
        label: 'Settings',
        keywords: 'settings preferences',
        group: 'Suggested',
        icon: <Icon source={N.settings} size={15} color={muted(t, 1)} />,
        meta: kbd(['⌘', ',']),
        run: () => setNav({ settingsOpen: true }),
      },
    ]
    const threadItems: Item[] = [...threads]
      .filter((thread) => inSpace(thread.project_id, projects, spaceId))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 40)
      .map((thread) => ({
        id: `thread:${thread.id}`,
        label: thread.title || 'Untitled',
        keywords: `${thread.title} ${projectName(thread.project_id)}`,
        group: 'Threads',
        icon: thread.status === 'running' ? <MatrixLoader /> : <ProviderMark kind={thread.provider.kind} size={15} />,
        meta: (
          <>
            <div style={{ display: 'flex', width: 96, justifyContent: 'flex-end', flexShrink: 0 }}>
              <Label color={muted(t, 0.79)} size={12} truncate>
                {projectName(thread.project_id)}
              </Label>
            </div>
            <div style={{ display: 'flex', width: 40, justifyContent: 'flex-end', flexShrink: 0 }}>
              <Label color={muted(t, 0.79)} size={10}>
                {relativeTime(thread.updated_at)}
              </Label>
            </div>
          </>
        ),
        run: () => openThread(thread.id),
      }))
    const taskItems: Item[] = [
      { id: 'task-new', label: 'New task', keywords: 'new task create todo add', group: 'Tasks', icon: <Icon source={N.plus} size={15} color={muted(t, 1)} />, run: () => { goPage('tasks'); quickAdd() } },
      { id: 'task-open', label: 'Open Tasks', keywords: 'tasks open list board todo', group: 'Tasks', icon: <Icon source={N.tasks} size={15} color={muted(t, 1)} />, run: () => goPage('tasks') },
      ...Object.values(taskMap)
        .filter((task) => inSpace(task.project_id, projects, spaceId))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 50)
        .map((task): Item => ({
          id: `task:${task.id}`,
          label: task.title || 'Untitled',
          keywords: `${task.key} ${task.key.replace('-', ' ')} ${STATUS_LABEL[task.status]}`,
          group: 'Tasks',
          icon: <StatusGlyph status={task.status} />,
          meta: <Label color={muted(t, 0.79)} size={10}>{task.key}</Label>,
          run: () => { goPage('tasks'); openTask(task.id) },
        })),
    ]
    const themeItems: Item[] = [
      {
        id: 'theme',
        label: 'Toggle theme',
        keywords: 'theme dark light appearance switch mode toggle',
        group: 'Themes',
        icon: <Icon source={t.variant === 'dark' ? N.sun : N.moon} size={15} color={muted(t, 1)} />,
        meta: <Label color={muted(t, 0.79)} size={10}>{t.variant === 'dark' ? 'Switch to light' : 'Switch to dark'}</Label>,
        run: () => setAppearance({ theme: t.variant === 'dark' ? 'light' : 'dark' }),
      },
    ]
    const projectItems: Item[] = projects
      .filter((p) => !isFreeChatProject(p.id) && inSpace(p.id, projects, spaceId))
      .map((p) => ({
        id: `project:${p.id}`,
        label: p.name,
        keywords: `${p.name} ${p.path}`,
        group: 'Projects',
        icon: <Icon source={N.folderOpen} size={15} color={muted(t, 1)} />,
        meta: (
          <div style={{ display: 'flex', minWidth: 0, flexShrink: 1, justifyContent: 'flex-end' }}>
            <Label color={muted(t, 0.79)} size={12} truncate>
              {p.path}
            </Label>
          </div>
        ),
        run: () => newThread(p.id),
      }))
    const noteItems: Item[] = [
      { id: 'note-new', label: 'New note', keywords: 'new note create write notes', group: 'Notes', icon: <Icon source={N.plus} size={15} color={muted(t, 1)} />, meta: page === 'notes' ? kbd(['⌘', 'N']) : undefined, run: () => void newNote() },
      { id: 'note-capture', label: 'Capture note…', keywords: 'quick note capture jot write notes', group: 'Notes', icon: <Icon source={N.pencil} size={15} color={muted(t, 1)} />, meta: kbd(['⌘', '⇧', 'N']), run: openQuickNote },
      { id: 'note-open', label: 'Open Notes', keywords: 'notes open list pages', group: 'Notes', icon: <Icon source={N.note} size={15} color={muted(t, 1)} />, run: () => goPage('notes') },
      ...notes.filter((n) => !n.deleted_at && inSpace(n.project_id, projects, spaceId)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 50).map((note): Item => ({ id: `note:${note.id}`, label: note.title || 'Untitled', keywords: `${note.title} ${note.preview}`, group: 'Notes', icon: <Icon source={N.note} size={15} color={muted(t, 1)} />, run: () => openNote(note.id) })),
    ]
    const all = [...actions, ...threadItems, ...noteItems, ...taskItems, ...projectItems, ...themeItems]
    const q = query.trim().toLowerCase()
    const matched = q ? all.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(q)) : all
    const order: Item['group'][] = ['Suggested', 'Threads', 'Notes', 'Tasks', 'Projects', 'Themes']
    return order.map((group) => ({ group, items: matched.filter((item) => item.group === group) })).filter((g) => g.items.length > 0)
  }, [notes, threads, projects, taskMap, spaceId, spaces, spacesOn, selectedId, inSplit, history, settingsOpen, page, query, t])

  const flat = groups.flatMap((g) => g.items)
  const active = Math.min(highlight, Math.max(0, flat.length - 1))
  const run = (item: Item | undefined) => {
    if (!item) return
    close()
    if (item.id !== 'settings' && item.id !== 'go-back' && item.id !== 'go-forward') setNav({ settingsOpen: false })
    item.run()
  }
  // Keys can arrive faster than renders: step from the latest highlight, not this render's.
  const latest = useRef(active)
  latest.current = active
  const move = (step: 1 | -1) => {
    if (!flat.length) return
    const next = (latest.current + step + flat.length) % flat.length
    latest.current = next
    setHighlight(next)
    const el = rowRefs.current.get(next)
    if (el) renderer?.scrollIntoView?.(el.id)
  }

  let index = -1
  return (
    // The desktop's CommandDialogPopup has no backdrop filter; here the card frosts like a menu on whole-window glass (the dialog path).
    <Dialog onClose={close} width={672} variant="palette" testId="palette" instant={getNav().keyboardNav}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, paddingLeft: 0, paddingRight: 0 }}>
        <div style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6 }}>
          <SearchField
            bare
            autoFocus
            label="Search the palette"
            size="lg"
            value={query}
            testId="palette-input"
            placeholder="Search threads, notes, tasks, projects, and commands"
            shell={{ height: 36, paddingLeft: 10, paddingRight: 10 }}
            style={{ fontSize: 15 }}
            onChange={(value) => {
              setQuery(value)
              setHighlight(0)
            }}
            onSubmit={() => run(flat[active])}
            onKeyDown={(e) => {
              const key = e.key ?? ''
              if (key === 'escape') close()
              else if (key === 'down' || (key === 'n' && e.modifiers?.ctrl)) move(1)
              else if (key === 'up' || (key === 'p' && e.modifiers?.ctrl)) move(-1)
            }}
          />
        </div>
        {flat.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40, paddingBottom: 40 }}>
            <Label color={muted(t, 0.79)}>No matches. Try a thread title or a project name.</Label>
          </div>
        ) : (
          <div testId="palette-list" style={{ display: 'flex', flexDirection: 'column', maxHeight: 384, overflowY: 'scroll', paddingLeft: 6, paddingRight: 6, paddingBottom: 6 }}>
            {groups.map((group, groupIndex) => (
              <div key={group.group} style={{ display: 'flex', flexDirection: 'column' }}>
                {groupIndex > 0 && <div style={{ height: 1, marginTop: 5, marginBottom: 5, marginLeft: 8, marginRight: 8, backgroundColor: t.border }} />}
                <div style={{ display: 'flex', paddingLeft: 12, paddingTop: groupIndex === 0 ? 0 : 6, paddingBottom: 6 }}>
                  <Label color={muted(t, 1)} size={12} weight={500}>
                    {group.group}
                  </Label>
                </div>
                {group.items.map((item) => {
                  index += 1
                  const at = index
                  return (
                    <div
                      key={item.id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(at, el)
                        else rowRefs.current.delete(at)
                      }}
                      testId={`palette-item-${item.id}`}
                      onMouseMove={() => {
                        if (active !== at) setHighlight(at)
                      }}
                      onClick={() => run(item)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        minHeight: 28,
                        paddingLeft: 10,
                        paddingRight: 10,
                        paddingTop: item.group === 'Threads' ? 8 : 6,
                        paddingBottom: item.group === 'Threads' ? 8 : 6,
                        borderRadius: 10,
                        cursor: 'pointer',
                        ...(at === active ? { backgroundColor: t.buttonSecondaryHover } : {}),
                      }}
                    >
                      <div style={{ display: 'flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{item.icon}</div>
                      <Label color={t.text} lineHeight={20} truncate style={{ flexGrow: 1 }}>
                        {item.label}
                      </Label>
                      {item.meta}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}

