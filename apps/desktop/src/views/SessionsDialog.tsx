import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"

import { ProviderMark } from "@/components/kybern/bits"
import { AutocompleteItem } from "@/components/kit/autocomplete"
import { Button } from "@/components/kit/button"
import { Command, CommandInput, CommandList, CommandStatus } from "@/components/kit/command"
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle, dialogFieldLabelClassName } from "@/components/kit/dialog"
import { Kbd } from "@/components/kit/kbd"
import { Menu, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import { ThreadRunningSpinner } from "@/components/kit/ThreadRunningSpinner"
import { PROVIDER_LABEL, relativeTime } from "@/lib/format"
import { ChevronDownIcon, ClockIcon, FolderIcon, RefreshCwIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { Project, ProjectId, ProviderKind, SavedSession, SessionsListResult } from "@/protocol"
import { errorText, loadThread, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"

const KINDS: ProviderKind[] = ["claude-code", "codex", "opencode", "pi", "omp", "cursor"]
const sessionKey = (session: SavedSession) => `${session.provider}:${session.id}`

type Page = SessionsListResult & { loading: boolean; error?: string }
type FetchPage = (provider: ProviderKind, projectId: ProjectId | null, query: string, cursor?: string | null) => Promise<SessionsListResult>

export function SessionsDialog() {
  const open = useStore((s) => s.sessionsOpen)
  const projectId = useStore((s) => s.sessionsProjectId)
  const project = useStore((s) => projectId ? s.projects[projectId] : undefined)
  const providers = useStore((s) => s.providers)
  const projects = useStore((s) => s.projects)
  const environmentId = useStore((s) => s.environmentId)
  const available = providers.filter((p) => p.available).map((p) => p.kind)
  const fetchPage = useCallback<FetchPage>((provider, project_id, query, cursor) => rpc().call("sessions.list", { provider, project_id, query, cursor }), [])
  const resume = useCallback(async (session: SavedSession) => {
    const client = rpc()
    const thread = await client.call("sessions.resume", { provider: session.provider, session_id: session.id })
    const { projects } = await client.call("projects.list", {})
    const state = useStore.getState()
    if (state.environmentId !== environmentId) return
    state.set((s) => ({ threads: { ...s.threads, [thread.id]: thread }, projects: Object.fromEntries(projects.map((p) => [p.id, p])) }))
    if (!state.sessionsOpen) return
    state.selectThread(thread.id)
    await loadThread(thread.id)
    useStore.getState().set({ sessionsOpen: false })
  }, [environmentId])

  return (
    <Dialog open={open} onOpenChange={(sessionsOpen) => useStore.getState().set({ sessionsOpen })}>
      <DialogPopup instant bottomStickOnMobile={false} className="max-h-[min(42rem,calc(100dvh-2rem))] max-w-2xl overflow-hidden">
        {open && <SessionPicker key={environmentId} project={project ?? null} available={available} projects={Object.values(projects)} fetchPage={fetchPage} onResume={resume} />}
      </DialogPopup>
    </Dialog>
  )
}

/** The same surface is exercised by the native WebKit fixture. Only its data
 * transport changes; the production component, focus, rows and copy do not. */
export function SessionPicker({ project, available, projects = [], fetchPage, onResume }: {
  project: Pick<Project, "id" | "name"> | null
  available: ProviderKind[]
  projects?: Pick<Project, "name" | "path">[]
  fetchPage: FetchPage
  onResume: (session: SavedSession) => Promise<void>
}) {
  const searchId = useId()
  const [query, setQuery] = useState("")
  const [allProjects, setAllProjects] = useState(!project)
  const [provider, setProvider] = useState<ProviderKind | "all">("all")
  const [catalog, setCatalog] = useState<{ key: string; pages: Partial<Record<ProviderKind, Page>> }>({ key: "", pages: {} })
  const [highlighted, setHighlighted] = useState<SavedSession | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const generation = useRef(0)
  const alive = useRef(true)
  const openingRef = useRef(false)
  const projectId = allProjects ? null : project?.id ?? null
  const availableKey = available.join(",")
  const key = JSON.stringify([projectId, provider, query.trim(), availableKey])
  const selectedKinds = useMemo(() => provider === "all" ? KINDS.filter((kind) => availableKey.split(",").includes(kind)) : [provider], [provider, availableKey])
  const pages = catalog.key === key ? catalog.pages : {}

  const fetchProvider = useCallback(async (kind: ProviderKind, cursor: string | null, current: number) => {
    setCatalog((previous) => {
      const pages = previous.key === key ? previous.pages : {}
      return { key, pages: { ...pages, [kind]: { sessions: pages[kind]?.sessions ?? [], next_cursor: cursor, loading: true } } }
    })
    try {
      const result = await fetchPage(kind, projectId, query.trim(), cursor)
      if (generation.current !== current || !alive.current) return
      setCatalog((previous) => {
        const previousSessions = cursor ? previous.pages[kind]?.sessions ?? [] : []
        const sessions = [...new Map([...previousSessions, ...result.sessions].map((s) => [sessionKey(s), s])).values()]
        return { key, pages: { ...previous.pages, [kind]: { sessions, next_cursor: result.next_cursor, loading: false } } }
      })
    } catch (error) {
      if (generation.current !== current || !alive.current) return
      setCatalog((previous) => ({ key, pages: { ...previous.pages, [kind]: { sessions: previous.pages[kind]?.sessions ?? [], next_cursor: cursor, loading: false, error: errorText(error) } } }))
    }
  }, [fetchPage, key, projectId, query])

  useEffect(() => {
    alive.current = true
    const current = ++generation.current
    const timer = setTimeout(() => {
      for (const kind of selectedKinds) void fetchProvider(kind, null, current)
    }, query.trim() ? 180 : 0)
    return () => { clearTimeout(timer); alive.current = false }
  }, [fetchProvider, query, selectedKinds])

  const sessions = useMemo(() => Object.values(catalog.key === key ? catalog.pages : {}).flatMap((page) => page.sessions)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || sessionKey(a).localeCompare(sessionKey(b))), [catalog, key])
  // Bound mounted options even after paging. Searching remains server-side over
  // all saved sessions; narrowing the query keeps every older session reachable.
  const [pageIndex, setPageIndex] = useState(0)
  const visible = sessions.slice(pageIndex * 100, (pageIndex + 1) * 100)
  const selected = visible.find((s) => sessionKey(s) === (highlighted && sessionKey(highlighted))) ?? visible[0] ?? null
  const loading = selectedKinds.some((kind) => !pages[kind] || pages[kind]?.loading)
  const errors = selectedKinds.flatMap((kind) => pages[kind]?.error ? [{ kind, error: pages[kind]!.error! }] : [])
  const more = selectedKinds.filter((kind) => pages[kind]?.next_cursor && !pages[kind]?.loading)

  async function resume(session: SavedSession) {
    if (openingRef.current) return
    openingRef.current = true
    setOpening(sessionKey(session))
    setResumeError(null)
    try { await onResume(session) }
    catch (error) { if (alive.current) setResumeError(errorText(error)) }
    finally { openingRef.current = false; if (alive.current) setOpening(null) }
  }

  function loadMore() {
    if (sessions.length > (pageIndex + 1) * 100) { setPageIndex((n) => n + 1); return }
    for (const kind of more) void fetchProvider(kind, pages[kind]!.next_cursor, generation.current)
  }

  return (
    <>
      <DialogHeader className="gap-1 px-5 pt-5 pb-4 pe-12">
        <DialogTitle>Resume session</DialogTitle>
        <DialogDescription>Pick a conversation and continue where you left off.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pb-3">
        <Menu>
          <MenuTrigger render={<button type="button" disabled={!!opening} className={COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME} />}>
            {provider === "all" ? <ClockIcon className="size-3.5" /> : <ProviderMark kind={provider} size={14} />}
            <span>{provider === "all" ? "All agents" : PROVIDER_LABEL[provider]}</span>
            <ChevronDownIcon className="size-3 opacity-50" />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start">
            <MenuRadioGroup value={provider} onValueChange={(value) => { setProvider(value as ProviderKind | "all"); setPageIndex(0) }}>
              <MenuRadioItem value="all">All agents</MenuRadioItem>
              {KINDS.map((kind) => <MenuRadioItem key={kind} value={kind}><ProviderMark kind={kind} size={14} /><span>{PROVIDER_LABEL[kind]}</span>{!available.includes(kind) && <span className="ms-auto text-muted-foreground">Not installed</span>}</MenuRadioItem>)}
            </MenuRadioGroup>
          </ComposerPickerMenuPopup>
        </Menu>
        {project && (
          <Menu>
            <MenuTrigger render={<button type="button" disabled={!!opening} className={cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "min-w-0 max-w-full")} />}>
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="truncate" title={allProjects ? "All projects" : project.name}>{allProjects ? "All projects" : project.name}</span>
              <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="start">
              <MenuRadioGroup value={allProjects ? "all" : "project"} onValueChange={(value) => { setAllProjects(value === "all"); setPageIndex(0) }}>
                <MenuRadioItem value="project">{project.name}</MenuRadioItem>
                <MenuRadioItem value="all">All projects</MenuRadioItem>
              </MenuRadioGroup>
            </ComposerPickerMenuPopup>
          </Menu>
        )}
        <Button variant="ghost" size="icon-sm" className="ms-auto" aria-label="Refresh sessions" disabled={loading || !!opening} onClick={() => {
          const current = ++generation.current
          setPageIndex(0)
          for (const kind of selectedKinds) void fetchProvider(kind, null, current)
        }}><RefreshCwIcon className="size-3.5" /></Button>
      </div>
      <Command items={visible} filter={null} value={query} onValueChange={(value, details) => {
        if (details.reason === "item-press" || openingRef.current) return
        setQuery(value); setPageIndex(0)
      }} itemToStringValue={(item) => (item as SavedSession).title} onItemHighlighted={(item) => setHighlighted(item as SavedSession | null)}>
        <label htmlFor={searchId} className={cn(dialogFieldLabelClassName, "px-5")}>Search sessions</label>
        <CommandInput id={searchId} placeholder="Title, folder, or session ID" showClear disabled={!!opening} className="text-base sm:text-[length:var(--app-font-size-ui,12px)]" />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2" data-session-scroll>
          <CommandList className="max-h-[min(23rem,45dvh)] not-empty:p-1" aria-label="Saved sessions" aria-busy={loading}>
            {(session: SavedSession) => (
              <AutocompleteItem key={sessionKey(session)} value={session} disabled={!!opening} onClick={() => void resume(session)} className="cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5">
                <span className="flex size-6 shrink-0 items-center justify-center pt-0.5 text-muted-foreground"><ProviderMark kind={session.provider} size={17} /></span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium leading-normal text-foreground" title={session.title}>{session.title || "Untitled session"}</span>
                  <span className="flex min-w-0 items-baseline gap-2 text-[length:var(--app-font-size-ui-sm,11px)] leading-normal text-muted-foreground" title={session.cwd}>
                    <span className="max-w-[50%] truncate font-medium">{projects.find((p) => p.path === session.cwd)?.name ?? session.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? session.cwd}</span>
                    <bdi className="min-w-0 truncate opacity-70">{session.cwd}</bdi>
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5 text-[length:var(--app-font-size-ui-sm,11px)] leading-normal text-muted-foreground">
                  <time dateTime={session.updated_at} title={new Date(session.updated_at).toLocaleString()} className="tabular-nums">{relativeTime(session.updated_at)}</time>
                  {session.thread_id && <span>In Kybern</span>}
                </span>
              </AutocompleteItem>
            )}
          </CommandList>
          <CommandStatus className={cn("px-3 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground", !visible.length && "flex min-h-36 flex-col items-center justify-center gap-2 text-center")}>
            {loading ? <span className="inline-flex items-center gap-2 py-2"><ThreadRunningSpinner />{query.trim() ? "Searching sessions…" : "Finding saved sessions…"}</span> : !visible.length ? (
              <>
                <span className="font-medium text-foreground">{errors.length ? "Sessions couldn’t be loaded" : query.trim() ? `No sessions match “${query.trim()}”` : "No saved sessions here"}</span>
                <span className="max-w-sm leading-relaxed">{errors.length ? "Check the agent details below and try again." : query.trim() ? "Try another title, folder, or session ID." : projectId ? "Look in all projects or start a conversation in your agent." : "Start a conversation in an installed agent, then refresh this list."}</span>
                {!errors.length && (query.trim() || projectId) && <Button variant="ghost" size="sm" onClick={() => query.trim() ? setQuery("") : setAllProjects(true)}>{query.trim() ? "Clear search" : "Show all projects"}</Button>}
              </>
            ) : null}
          </CommandStatus>
          {(pageIndex > 0 || more.length > 0 || sessions.length > (pageIndex + 1) * 100) && <div className="flex items-center justify-center gap-3 py-2">{pageIndex > 0 && <Button variant="ghost" size="sm" onClick={() => setPageIndex((n) => n - 1)} disabled={!!opening}>Previous sessions</Button>}{(more.length > 0 || sessions.length > (pageIndex + 1) * 100) && <Button variant="ghost" size="sm" onClick={loadMore} disabled={!!opening}>{sessions.length > (pageIndex + 1) * 100 ? "Next sessions" : "Load more sessions"}</Button>}</div>}
        </div>
      </Command>
      {errors.length > 0 && <details className="mx-5 my-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
        <summary className="cursor-pointer py-1">{errors.length === 1 ? `${PROVIDER_LABEL[errors[0]!.kind]} couldn’t be loaded` : `${errors.length} agents couldn’t be loaded`}</summary>
        <div className="max-h-28 space-y-3 overflow-auto py-2">{errors.map(({ kind, error }) => <div key={kind} className="flex items-start gap-3"><p className="min-w-0 flex-1 break-words leading-relaxed"><span className="font-medium text-foreground">{PROVIDER_LABEL[kind]}: </span>{error}</p><Button variant="ghost" size="sm" disabled={!!opening} onClick={() => void fetchProvider(kind, null, generation.current)}>Retry</Button></div>)}</div>
      </details>}
      <div className="flex shrink-0 flex-col gap-3 border-t border-border/60 px-5 py-4">
        {resumeError && <p role="alert" className="break-words text-[length:var(--app-font-size-ui,12px)] leading-relaxed text-destructive">{resumeError}</p>}
        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground">{opening ? "Opening the saved conversation…" : <><Kbd>↑</Kbd> <Kbd>↓</Kbd> to browse <span className="mx-1">·</span> <Kbd>↵</Kbd> to resume</>}</span>
          <Button disabled={!selected || !!opening} onClick={() => selected && void resume(selected)} className="shrink-0 rounded-full">{opening && <ThreadRunningSpinner />}{opening ? "Opening…" : selected?.thread_id ? "Open thread" : "Resume session"}</Button>
        </div>
      </div>
    </>
  )
}
