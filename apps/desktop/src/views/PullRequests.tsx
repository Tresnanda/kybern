// Pull requests list, to Synara's `_chat.pull-requests.index.tsx`: header
// with refresh, state filter pills and a project filter, rows grouped by
// project with a state glyph, title, meta line and a relative timestamp.

import { useCallback, useEffect, useMemo, useState } from "react"

import { Spinner } from "@/components/kybern/bits"
import { Button } from "@/components/synara/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/synara/empty"
import { IconButton } from "@/components/synara/icon-button"
import { ComposerPickerMenuPopup } from "@/components/synara/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuTrigger } from "@/components/synara/menu"
import { relativeTime } from "@/lib/format"
import { CentralIcon } from "@/lib/synara/central-icons"
import { CheckIcon, FilterIcon, GitPullRequestIcon, RefreshCwIcon } from "@/lib/synara/icons"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { Project, ProjectId, PullRequest } from "@/protocol"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"

import { SurfaceHeader } from "./chrome"

type Filter = "open" | "merged" | "closed" | "all"
const FILTERS: [Filter, string][] = [
  ["open", "Open"],
  ["merged", "Merged"],
  ["closed", "Closed"],
  ["all", "All"],
]

interface Row {
  pr: PullRequest
  project: Project
}

export function PullRequests() {
  const projects = useStore((s) => s.projects)
  const [filter, setFilter] = useState<Filter>("open")
  const [projectId, setProjectId] = useState<ProjectId | null>(null)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [query, setQuery] = useState("")

  const targets = useMemo(() => Object.values(projects).filter((p) => p.is_git && (!projectId || p.id === projectId)), [projects, projectId])

  const load = useCallback(async () => {
    setPending(true)
    setError(null)
    try {
      const results = await Promise.all(
        targets.map((project) =>
          rpc()
            .call("github.pr.list", { project_id: project.id, state: filter, limit: 30 })
            .then((r) => r.pull_requests.map((pr) => ({ pr, project })))
            .catch((e: unknown) => {
              // Projects without a GitHub remote simply have no pull requests.
              const text = errorText(e)
              if (!/no git remotes|not a git repository|could not find|no such remote/i.test(text)) setError(text.replace(/^gh pr list[^:]*: /, ""))
              return [] as Row[]
            }),
        ),
      )
      setRows(results.flat().sort((a, b) => b.pr.updated_at.localeCompare(a.pr.updated_at)))
    } finally {
      setPending(false)
    }
  }, [targets, filter])

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows ?? []).filter((r) => !q || r.pr.title.toLowerCase().includes(q) || r.pr.head.toLowerCase().includes(q) || String(r.pr.number).includes(q))
  }, [rows, query])

  const groups = useMemo(() => {
    const m = new Map<ProjectId, Row[]>()
    for (const r of visible) m.set(r.project.id, [...(m.get(r.project.id) ?? []), r])
    return [...m.entries()]
  }, [visible])

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)]">
      <SurfaceHeader
        trailing={
          <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={() => void load()} disabled={pending}>
            <RefreshCwIcon className={cn("size-4", pending && "animate-spin")} />
          </Button>
        }
      >
        <h1 className="truncate font-system-ui text-sm font-medium">Pull requests</h1>
        {projectId && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="truncate text-xs text-muted-foreground">{projects[projectId]?.name}</span>
          </>
        )}
      </SurfaceHeader>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 pt-4 pb-12 sm:px-7">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div role="radiogroup" className="flex items-center gap-1 text-[length:var(--app-font-size-ui,12px)]">
                {FILTERS.map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={filter === v}
                    onClick={() => setFilter(v)}
                    className={cn(
                      "rounded-md px-2.5 py-1 transition-colors",
                      filter === v ? "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pull requests"
                className="h-8 min-w-0 flex-1 rounded-lg border border-[color:var(--color-border)] bg-transparent px-2.5 font-system-ui text-[length:var(--app-font-size-ui,12px)] text-foreground outline-none placeholder:text-muted-foreground/55 focus-visible:border-[color:var(--color-border-focus)]"
              />
              <Menu>
                <IconButton render={<MenuTrigger />} variant="ghost" size="icon-sm" label="Filter by project" tooltip="Filter by project" className={cn(projectId && "text-foreground")}>
                  <FilterIcon className="size-4" />
                </IconButton>
                <ComposerPickerMenuPopup align="end" side="bottom" className="w-64 min-w-64">
                  <MenuGroup>
                    <MenuGroupLabel>Project</MenuGroupLabel>
                    <MenuItem onClick={() => setProjectId(null)}>
                      <span className="min-w-0 flex-1 truncate">All projects</span>
                      {!projectId && <CheckIcon className="size-3.5 shrink-0" />}
                    </MenuItem>
                    {Object.values(projects)
                      .filter((p) => p.is_git)
                      .map((p) => (
                        <MenuItem key={p.id} onClick={() => setProjectId(p.id)}>
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          {projectId === p.id && <CheckIcon className="size-3.5 shrink-0" />}
                        </MenuItem>
                      ))}
                  </MenuGroup>
                </ComposerPickerMenuPopup>
              </Menu>
            </div>
          </div>

          {error && <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}

          {rows === null ? (
            <div className="space-y-0.5">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="h-13 w-full rounded-lg bg-[var(--color-background-button-secondary-hover)]/45 motion-safe:animate-pulse" />
              ))}
            </div>
          ) : targets.length === 0 ? (
            <Empty className="py-16">
              <EmptyHeader>
                <EmptyTitle>No git projects</EmptyTitle>
                <EmptyDescription>Add a project that lives in a GitHub repository to see its pull requests here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : groups.length === 0 ? (
            <Empty className="py-16">
              <EmptyHeader>
                <EmptyTitle>No {filter === "all" ? "" : `${filter} `}pull requests</EmptyTitle>
                <EmptyDescription>{pending ? "Checking GitHub" : "Pull requests show up here for projects with a GitHub remote, using the GitHub CLI signed in on this Mac."}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-0.5">
              {groups.map(([pid, list], gi) => (
                <div key={pid}>
                  <h2 className={cn("pb-0.5 text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-muted-foreground/70", gi > 0 && "pt-2.5")}>{projects[pid]?.name}</h2>
                  {list.map((r) => (
                    <PullRequestRow key={`${pid}:${r.pr.number}`} row={r} />
                  ))}
                </div>
              ))}
            </div>
          )}
          {pending && rows !== null && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
              <Spinner size={12} /> Refreshing
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

function stateGlyph(pr: PullRequest) {
  const state = pr.state.toUpperCase()
  if (state === "MERGED") return <CentralIcon name="merged-simple" className="size-[1.125rem] text-[color:var(--color-status-merged,#a371f7)]" />
  if (state === "CLOSED") return <CentralIcon name="pull-request-closed-simple" className="size-[1.125rem] text-muted-foreground" />
  if (pr.is_draft) return <GitPullRequestIcon className="size-[1.125rem] text-muted-foreground" />
  return <GitPullRequestIcon className="size-[1.125rem] text-[var(--color-decoration-added)]" />
}

function PullRequestRow({ row }: { row: Row }) {
  const { pr, project } = row
  return (
    <div className="group -mx-3 flex w-[calc(100%+1.5rem)] items-stretch rounded-lg text-left transition-colors hover:bg-[var(--color-background-elevated-secondary)]/70 focus-within:bg-[var(--color-background-elevated-secondary)]/70">
      <button
        type="button"
        onClick={() => void openExternal(pr.url)}
        className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg py-1.5 pr-1 pl-3 text-left focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="flex size-[1.125rem] shrink-0 items-center justify-center">{stateGlyph(pr)}</span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-lg,13px)] font-medium text-foreground">{pr.title}</span>
            {pr.is_draft && <span className="shrink-0 rounded-full bg-[var(--color-background-elevated-secondary)] px-1.5 py-px text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">Draft</span>}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
            <span className="shrink-0 tabular-nums">#{pr.number}</span>
            <span className="truncate">{pr.author}</span>
            <span className="max-w-[14rem] truncate">{pr.head}</span>
            <span className="opacity-60">→</span>
            <span className="truncate">{pr.base}</span>
            <span className="max-w-[12rem] truncate">{project.name}</span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70 tabular-nums">
          <span>{relativeTime(pr.updated_at)}</span>
          <span className="capitalize">{pr.state.toLowerCase()}</span>
        </span>
      </button>
    </div>
  )
}
