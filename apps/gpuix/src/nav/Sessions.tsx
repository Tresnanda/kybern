// Resume session (`views/SessionsDialog.tsx`): saved conversations from every
// installed agent, newest first, searchable by title, folder or session id
// (server-side, 180ms after typing stops). ↑/↓ browse, Enter resumes. Resuming
// imports the session as a Kybern thread and opens it; one already in Kybern
// opens its thread.
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { relativeTime } from '@/lib/format'
import type { ProviderKind, SavedSession } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { Rise } from '../motion/kit.tsx'
import { iconEnter } from '../shell/motion.ts'
import { getClient, useApp } from '../state.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { providerLabel } from '../sidebar/model.ts'
import { errorText, resumeSession } from './actions.ts'
import { N } from './glyphs.ts'
import { Dialog, DialogHeader, Kbd, Menu, MenuItem, muted } from './overlay.tsx'
import { SearchField } from './Palette.tsx'
import { setNav, useNav } from './store.ts'

const KINDS: ProviderKind[] = ['claude-code', 'codex', 'opencode', 'pi', 'omp', 'cursor']
const sessionKey = (s: SavedSession) => `${s.provider}:${s.id}`
const PAGE = 100

interface ProviderPage {
  sessions: SavedSession[]
  next_cursor: string | null
  loading: boolean
  error?: string
}

export function SessionsDialog() {
  const sessions = useNav((s) => s.sessions)
  if (!sessions) return null
  return <SessionPicker projectId={sessions.projectId} />
}

function SessionPicker({ projectId: initialProject }: { projectId: string | null }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const providers = useNav((s) => s.providers)
  const projects = useApp((s) => s.projects)
  const project = projects.find((p) => p.id === initialProject) ?? null
  const available = providers.filter((p) => p.available).map((p) => p.kind)
  const [query, setQuery] = useState('')
  const [allProjects, setAllProjects] = useState(!project)
  const [provider, setProvider] = useState<ProviderKind | 'all'>('all')
  const [pages, setPages] = useState<Partial<Record<ProviderKind, ProviderPage>>>({})
  const [highlight, setHighlight] = useState(0)
  const [opening, setOpening] = useState<string | null>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const generation = useRef(0)
  const rowRefs = useRef(new Map<number, PublicInstance>())
  const projectId = allProjects ? null : (project?.id ?? null)
  const availableKey = available.join(',')
  const kinds = useMemo(() => (provider === 'all' ? KINDS.filter((k) => availableKey.split(',').includes(k)) : [provider]), [provider, availableKey])
  const close = () => setNav({ sessions: null })

  const fetchProvider = useCallback(
    async (kind: ProviderKind, cursor: string | null, current: number) => {
      setPages((prev) => ({ ...prev, [kind]: { sessions: cursor ? (prev[kind]?.sessions ?? []) : [], next_cursor: cursor, loading: true } }))
      try {
        const result = await getClient()!.call('sessions.list', { provider: kind, project_id: projectId, query: query.trim(), cursor })
        if (generation.current !== current) return
        setPages((prev) => {
          const before = cursor ? (prev[kind]?.sessions ?? []) : []
          const merged = [...new Map([...before, ...result.sessions].map((s) => [sessionKey(s), s])).values()]
          return { ...prev, [kind]: { sessions: merged, next_cursor: result.next_cursor, loading: false } }
        })
      } catch (error) {
        if (generation.current !== current) return
        setPages((prev) => ({ ...prev, [kind]: { sessions: prev[kind]?.sessions ?? [], next_cursor: cursor, loading: false, error: errorText(error) } }))
      }
    },
    [projectId, query],
  )

  useEffect(() => {
    const current = ++generation.current
    setPages({})
    const timer = setTimeout(() => {
      for (const kind of kinds) void fetchProvider(kind, null, current)
    }, query.trim() ? 180 : 0)
    return () => clearTimeout(timer)
  }, [fetchProvider, kinds, query])

  const all = useMemo(
    () =>
      kinds
        .flatMap((k) => pages[k]?.sessions ?? [])
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || sessionKey(a).localeCompare(sessionKey(b))),
    [pages, kinds],
  )
  // Bound the rows even after paging; searching stays server-side over every session.
  const visible = all.slice(pageIndex * PAGE, (pageIndex + 1) * PAGE)
  const active = Math.min(highlight, Math.max(0, visible.length - 1))
  const selected = visible[active] ?? null
  const loading = kinds.some((k) => !pages[k] || pages[k]!.loading)
  // Rows that arrive after the list first showed (a refresh, "Load more") rise in; the first page, a new search and big batches render plainly.
  const known = useRef(new Set<string>())
  const fresh = useRef(new Map<string, 'row' | 'pane'>())
  const started = useRef(false)
  if (Object.keys(pages).length === 0) {
    known.current.clear()
    fresh.current.clear()
    started.current = false
  }
  const arrived = visible.filter((s) => !known.current.has(sessionKey(s)))
  for (const s of arrived) {
    known.current.add(sessionKey(s))
    if (started.current && arrived.length <= 12) fresh.current.set(sessionKey(s), arrived.length <= 3 ? 'row' : 'pane')
  }
  if (!loading && Object.keys(pages).length > 0) started.current = true
  const errors = kinds.flatMap((k) => (pages[k]?.error ? [{ kind: k, error: pages[k]!.error! }] : []))
  const more = kinds.filter((k) => pages[k]?.next_cursor && !pages[k]?.loading)

  const resume = async (session: SavedSession | null) => {
    if (!session || opening) return
    setOpening(sessionKey(session))
    setResumeError(null)
    try {
      await resumeSession(session, projectId)
    } catch (error) {
      setResumeError(errorText(error))
    } finally {
      setOpening(null)
    }
  }
  const latest = useRef(active)
  latest.current = active
  const move = (step: 1 | -1) => {
    if (!visible.length) return
    const next = Math.max(0, Math.min(visible.length - 1, latest.current + step))
    latest.current = next
    setHighlight(next)
    const el = rowRefs.current.get(next)
    if (el) renderer?.scrollIntoView?.(el.id)
  }
  const small = muted(t, 1)
  const q = query.trim()

  return (
    <Dialog onClose={close} width={672} testId="sessions-dialog">
      <DialogHeader title="Resume session" description="Pick a conversation and continue where you left off." onClose={close} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 20, paddingRight: 20, paddingTop: 8, paddingBottom: 12 }}>
        <Menu
          align="start"
          minWidth={208}
          testId="sessions-agent"
          rootStyle={{ flexGrow: 0 }}
          trigger={() => (
            <Chip>
              {provider === 'all' ? <Icon source={N.clock} size={14} color={small} /> : <ProviderMark kind={provider} size={14} />}
              <Label color={small}>{provider === 'all' ? 'All agents' : providerLabel(provider)}</Label>
              <Icon source={N.chevronDown} size={12} color={muted(t, 0.5)} />
            </Chip>
          )}
        >
          <MenuItem id="all" label="All agents" checked={provider === 'all'} onSelect={() => (setProvider('all'), setPageIndex(0), setHighlight(0))} />
          {KINDS.map((kind) => (
            <MenuItem
              key={kind}
              id={kind}
              iconNode={<ProviderMark kind={kind} size={14} />}
              label={providerLabel(kind)}
              detail={available.includes(kind) ? undefined : 'Not installed'}
              checked={provider === kind}
              onSelect={() => (setProvider(kind), setPageIndex(0), setHighlight(0))}
            />
          ))}
        </Menu>
        {project && (
          <Menu
            align="start"
            minWidth={192}
            testId="sessions-project"
            rootStyle={{ flexGrow: 0, minWidth: 0 }}
            trigger={() => (
              <Chip>
                <Icon source={N.folder} size={14} color={small} />
                <Label color={small} truncate>
                  {allProjects ? 'All projects' : project.name}
                </Label>
                <Icon source={N.chevronDown} size={12} color={muted(t, 0.5)} />
              </Chip>
            )}
          >
            <MenuItem id="project" label={project.name} checked={!allProjects} onSelect={() => (setAllProjects(false), setPageIndex(0), setHighlight(0))} />
            <MenuItem id="all" label="All projects" checked={allProjects} onSelect={() => (setAllProjects(true), setPageIndex(0), setHighlight(0))} />
          </Menu>
        )}
        <div style={{ flexGrow: 1 }} />
        <div
          role="button"
          aria-label="Refresh sessions"
          onClick={() => {
            if (loading || opening) return
            const current = ++generation.current
            setPageIndex(0)
            for (const kind of kinds) void fetchProvider(kind, null, current)
          }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 10, cursor: 'pointer', opacity: loading ? 0.5 : 1, hover: { backgroundColor: t.buttonSecondaryHover } }}
        >
          <Icon source={N.refresh} size={14} color={t.text} />
        </div>
      </div>
      <div style={{ paddingLeft: 20, paddingRight: 20, paddingBottom: 4 }}>
        <Label color={small} size={13}>
          Search sessions
        </Label>
      </div>
      <div style={{ paddingLeft: 10, paddingRight: 10 }}>
        <SearchField
          value={query}
          testId="sessions-input"
          placeholder="Title, folder, or session ID"
          onChange={(value) => {
            if (opening) return
            setQuery(value)
            setPageIndex(0)
            setHighlight(0)
          }}
          onSubmit={() => void resume(selected)}
          onKeyDown={(key) => {
            if (key === 'escape') close()
            else if (key === 'down') move(1)
            else if (key === 'up') move(-1)
          }}
        />
      </div>
      <div testId="sessions-list" style={{ display: 'flex', flexDirection: 'column', maxHeight: 368, overflowY: 'scroll', paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4 }}>
        {visible.map((session, at) => {
          const enter = fresh.current.get(sessionKey(session))
          const row = (
          <div
            key={enter ? undefined : sessionKey(session)}
            ref={(el) => {
              if (el) rowRefs.current.set(at, el)
              else rowRefs.current.delete(at)
            }}
            testId={`session-${at}`}
            onMouseMove={() => {
              if (active !== at) setHighlight(at)
            }}
            onClick={() => void resume(session)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              paddingLeft: 12,
              paddingRight: 12,
              paddingTop: 10,
              paddingBottom: 10,
              borderRadius: 14,
              cursor: opening ? 'default' : 'pointer',
              opacity: opening && opening !== sessionKey(session) ? 0.64 : 1,
              ...(at === active ? { backgroundColor: t.buttonSecondaryHover } : {}),
            }}
          >
            <div style={{ display: 'flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <ProviderMark kind={session.provider} size={17} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, minWidth: 0 }}>
              <Label color={t.text} weight={500} truncate>
                {session.title || 'Untitled session'}
              </Label>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                <Label color={small} size={13} weight={500} truncate style={{ flexShrink: 0, maxWidth: 220 }}>
                  {projects.find((p) => p.path === session.cwd)?.name ?? session.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? session.cwd}
                </Label>
                <Label color={muted(t, 0.7)} size={13} truncate>
                  {session.cwd}
                </Label>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0, paddingTop: 2 }}>
              <Label color={small} size={13}>
                {relativeTime(session.updated_at)}
              </Label>
              {session.thread_id && (
                <Label color={small} size={13}>
                  In Kybern
                </Label>
              )}
            </div>
          </div>
          )
          return enter ? <Rise key={sessionKey(session)} kind={enter}>{row}</Rise> : row
        })}
        {(loading || visible.length === 0) && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: visible.length ? 0 : 144, paddingTop: 8, paddingBottom: 8 }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <MatrixLoader />
                <Label color={small}>{q ? 'Searching sessions…' : 'Finding saved sessions…'}</Label>
              </div>
            ) : (
              <>
                <Label color={t.text} weight={500}>
                  {errors.length ? 'Sessions couldn’t be loaded' : q ? `No sessions match “${q}”` : 'No saved sessions here'}
                </Label>
                <Label color={small}>
                  {errors.length
                    ? 'Check the agent details below and try again.'
                    : q
                      ? 'Try another title, folder, or session ID.'
                      : projectId
                        ? 'Look in all projects or start a conversation in your agent.'
                        : 'Start a conversation in an installed agent, then refresh this list.'}
                </Label>
                {!errors.length && (q || projectId) && (
                  <div onClick={() => (q ? setQuery('') : setAllProjects(true))} style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
                    <Label color={t.text}>{q ? 'Clear search' : 'Show all projects'}</Label>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {(pageIndex > 0 || more.length > 0 || all.length > (pageIndex + 1) * PAGE) && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, paddingTop: 8, paddingBottom: 8 }}>
            {pageIndex > 0 && <TextButton label="Previous sessions" onClick={() => setPageIndex((n) => n - 1)} />}
            {(more.length > 0 || all.length > (pageIndex + 1) * PAGE) && (
              <TextButton
                label={all.length > (pageIndex + 1) * PAGE ? 'Next sessions' : 'Load more sessions'}
                onClick={() => {
                  if (all.length > (pageIndex + 1) * PAGE) return setPageIndex((n) => n + 1)
                  for (const kind of more) void fetchProvider(kind, pages[kind]!.next_cursor, generation.current)
                }}
              />
            )}
          </div>
        )}
      </div>
      {errors.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 20, paddingRight: 20, paddingTop: 8, paddingBottom: 8 }}>
          {errors.map(({ kind, error }) => (
            <Label key={kind} color={small} size={13}>
              {`${providerLabel(kind)}: ${error}`}
            </Label>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTopWidth: 1, borderColor: t.border, paddingLeft: 20, paddingRight: 20, paddingTop: 16, paddingBottom: 16 }}>
        {resumeError && (
          <Label color={t.red} size={14}>
            {resumeError}
          </Label>
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          {opening ? (
            <Label color={small} size={13}>
              Opening the saved conversation…
            </Label>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Kbd keys={['↑']} />
              <Kbd keys={['↓']} />
              <Label color={small} size={13}>
                to browse ·
              </Label>
              <Kbd keys={['↵']} />
              <Label color={small} size={13}>
                to resume
              </Label>
            </div>
          )}
          <div
            testId="sessions-resume"
            onClick={() => void resume(selected)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 32,
              paddingLeft: 14,
              paddingRight: 14,
              borderRadius: 16,
              backgroundColor: t.buttonPrimary,
              opacity: !selected || opening ? 0.5 : 1,
              cursor: !selected || opening ? 'default' : 'pointer',
            }}
          >
            {opening && (
              <div paintTransform={iconEnter()} style={{ display: 'flex' }}>
                <MatrixLoader />
              </div>
            )}
            <Label color={t.buttonPrimaryText} weight={500}>
              {opening ? 'Opening…' : selected?.thread_id ? 'Open thread' : 'Resume session'}
            </Label>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

/** `COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME`: a borderless capsule that fills on hover. */
function Chip({ children }: { children: React.ReactNode }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, borderRadius: 999, cursor: 'pointer', minWidth: 0, hover: { backgroundColor: t.buttonSecondaryHover } }}>
      {children}
    </div>
  )
}

function TextButton({ label, onClick }: { label: string; onClick: () => void }) {
  const t = useTheme()
  return (
    <div onClick={onClick} style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
      <Label color={t.text}>{label}</Label>
    </div>
  )
}
