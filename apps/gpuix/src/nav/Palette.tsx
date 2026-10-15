// Search palette (⌘K, the sidebar's search button): `views/Palette.tsx`. One
// input over grouped results: suggested commands, the 40 most recent threads,
// projects. Typing filters by label and keywords; ↑/↓ move the highlight, Enter
// runs it, Escape closes. Opened from the search button it fades in like the
// desktop's command dialog; opened with ⌘K it appears at once. It closes at once.
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { relativeTime } from '@/lib/format'
import { isFreeChatProject } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { getState, useApp } from '../state.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { N } from './glyphs.ts'
import { canMoveNavHistory, goBack, goForward, goPage, isNavEntryValid, newThread, openThread } from './history.ts'
import { Dialog, Kbd, muted } from './overlay.tsx'
import { getNav, setNav, useNav } from './store.ts'

interface Item {
  id: string
  label: string
  keywords: string
  group: 'Suggested' | 'Threads' | 'Notes' | 'Tasks' | 'Projects'
  icon: ReactNode
  meta?: ReactNode
  run: () => void
}

export function Palette() {
  const open = useNav((s) => s.paletteOpen)
  if (!open) return null
  return <PaletteDialog />
}

/** `SearchInput`: a 36px field with the search glyph and a drawn placeholder (GPUIX fixes its own). */
export function SearchField({
  value,
  onChange,
  placeholder,
  onKeyDown,
  onSubmit,
  testId,
  height = 36,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  onKeyDown?: (key: string, e: { modifiers?: { ctrl: boolean } }) => void
  onSubmit?: () => void
  testId?: string
  height?: number
}) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, height, paddingLeft: 10, paddingRight: 10, position: 'relative' }}>
      <Icon source={N.search} size={16} color={muted(t, 1)} />
      <div style={{ display: 'flex', flexGrow: 1, minWidth: 0, position: 'relative', alignItems: 'center' }}>
        {!value && (
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, display: 'flex', alignItems: 'center', pointerEvents: 'none' }}>
            <Label color={muted(t, 0.72)} size={15} truncate>
              {placeholder}
            </Label>
          </div>
        )}
        <input
          autoFocus
          testId={testId}
          value={value}
          onChange={(e) => onChange(e.value ?? '')}
          onSubmit={onSubmit}
          onKeyDown={(e) => onKeyDown?.(e.key ?? '', e)}
          theme={{ text: t.text, caret: t.text }}
          style={{ flexGrow: 1, minWidth: 0, height: 24, fontSize: 15, color: t.text, backgroundColor: 'rgba(0, 0, 0, 0)' }}
        />
      </div>
    </div>
  )
}

function PaletteDialog() {
  const t = useTheme()
  const { renderer } = useGpuix()
  const threads = useApp((s) => s.threads)
  const projects = useApp((s) => s.projects)
  const history = useNav((s) => s.history)
  const settingsOpen = useNav((s) => s.settingsOpen)
  const page = useNav((s) => s.page)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rowRefs = useRef(new Map<number, PublicInstance>())
  const close = () => setNav({ paletteOpen: false })

  const groups = useMemo(() => {
    const kbd = (keys: string[]) => <Kbd keys={keys} />
    const projectName = (id: string) => (isFreeChatProject(id) ? 'Free chat' : (projects.find((p) => p.id === id)?.name ?? ''))
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
      ...(settingsOpen || canMoveNavHistory(history, -1, isNavEntryValid)
        ? [{ id: 'go-back', label: 'Go back', keywords: 'back previous history navigate return', group: 'Suggested' as const, icon: <Icon source={N.arrowLeft} size={15} color={muted(t, 1)} />, meta: kbd(['⌘', '[']), run: () => void goBack() }]
        : []),
      ...(!settingsOpen && canMoveNavHistory(history, 1, isNavEntryValid)
        ? [{ id: 'go-forward', label: 'Go forward', keywords: 'forward next history navigate', group: 'Suggested' as const, icon: <Icon source={N.arrowRight} size={15} color={muted(t, 1)} />, meta: kbd(['⌘', ']']), run: () => void goForward() }]
        : []),
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
    const pageItems: Item[] = [
      { id: 'note-open', label: 'Open Notes', keywords: 'notes open list pages', group: 'Notes', icon: <Icon source={N.note} size={15} color={muted(t, 1)} />, run: () => goPage('notes') },
      { id: 'task-open', label: 'Open Tasks', keywords: 'tasks open list board todo', group: 'Tasks', icon: <Icon source={N.tasks} size={15} color={muted(t, 1)} />, run: () => goPage('tasks') },
    ]
    const projectItems: Item[] = projects
      .filter((p) => !isFreeChatProject(p.id))
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
    const all = [...actions, ...threadItems, ...pageItems, ...projectItems]
    const q = query.trim().toLowerCase()
    const matched = q ? all.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(q)) : all
    const order: Item['group'][] = ['Suggested', 'Threads', 'Notes', 'Tasks', 'Projects']
    return order.map((group) => ({ group, items: matched.filter((item) => item.group === group) })).filter((g) => g.items.length > 0)
  }, [threads, projects, history, settingsOpen, page, query, t])

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
    <Dialog onClose={close} width={672} variant="palette" testId="palette" instant={getNav().keyboardNav}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, paddingLeft: 0, paddingRight: 0 }}>
        <div style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6 }}>
          <SearchField
            value={query}
            testId="palette-input"
            placeholder="Search threads, projects, and commands"
            onChange={(value) => {
              setQuery(value)
              setHighlight(0)
            }}
            onSubmit={() => run(flat[active])}
            onKeyDown={(key, e) => {
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
                {groupIndex > 0 && <div style={{ height: 1, marginTop: 8, marginBottom: 8, marginLeft: 8, marginRight: 8, backgroundColor: t.border }} />}
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
                      <Label color={t.text} truncate style={{ flexGrow: 1 }}>
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

