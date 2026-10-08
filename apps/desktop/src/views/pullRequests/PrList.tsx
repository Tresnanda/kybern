// The pull request list column: header, state filter, search and rows grouped by
// project. Rows are a bounded, roving-focus list; moving focus never loads a PR.

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { Button } from "@/components/kit/button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/kit/empty"
import { IconButton } from "@/components/kit/icon-button"
import { Input } from "@/components/kit/input"
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuTrigger,
} from "@/components/kit/menu"
import { SegmentedControl } from "@/components/kit/segmented-control"
import { Spinner } from "@/components/kybern/bits"
import { useHotkey } from "@/lib/hooks"
import { CheckIcon, FilterIcon, RefreshCwIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { mapWithConcurrency } from "@/lib/workload"
import type { Project, ProjectId, PullRequest } from "@/protocol"
import { classifyPrError } from "@/state/prReviewModel"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"

import { SurfaceHeader } from "../chrome"
import { useDelayedFlag } from "./prAsync"
import { PrRow } from "./PrRow"
import { GhProblem, ListSkeleton, PrErrorAlert } from "./PrStates"
import { PR_FINE_TEXT, PR_META_TEXT, PR_QUIET_INK } from "./prText"

type Filter = "open" | "merged" | "closed" | "all"
const FILTERS: { value: Filter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
]
const PR_PROJECT_CONCURRENCY = 3
export const PR_ROWS_BATCH = 100
const PR_CACHE_TTL_MS = 30_000
const prCache = new Map<
  string,
  { expiresAt: number; pullRequests: PullRequest[] }
>()

interface Row {
  pr: PullRequest
  project: Project
}
interface LoadError {
  project: string
  text: string
}

export function PrList({
  onOpenSearchKey,
}: {
  /** Called when ⌘F focuses search, so the shell can show the list in single-pane mode. */
  onOpenSearchKey?: () => void
}) {
  const projects = useStore((s) => s.projects)
  const selection = useStore((s) => s.prSelection)
  const [filter, setFilter] = useState<Filter>("open")
  const [projectId, setProjectId] = useState<ProjectId | null>(null)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [errors, setErrors] = useState<LoadError[]>([])
  const [pending, setPending] = useState(false)
  const [query, setQuery] = useState("")
  // The page size resets whenever the query, state filter or project changes.
  const resetKey = `${query}|${filter}|${projectId}`
  const [paging, setPaging] = useState({ key: resetKey, count: PR_ROWS_BATCH })
  const visibleCount = paging.key === resetKey ? paging.count : PR_ROWS_BATCH
  const setVisibleCount = (update: (count: number) => number) =>
    setPaging({ key: resetKey, count: update(visibleCount) })
  const [rovingKey, setRovingKey] = useState<string | null>(null)
  const loadVersion = useRef(0)
  const deferredQuery = useDeferredValue(query)
  const searchRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const showRefreshing = useDelayedFlag(pending && rows !== null)

  const targets = useMemo(
    () =>
      Object.values(projects).filter(
        (p) => p.is_git && (!projectId || p.id === projectId)
      ),
    [projects, projectId]
  )

  const load = useCallback(
    async (force = false) => {
      const version = ++loadVersion.current
      setPending(true)
      const found: LoadError[] = []
      try {
        const results = await mapWithConcurrency(
          targets,
          PR_PROJECT_CONCURRENCY,
          (project) => {
            const cacheKey = `${project.id}:${filter}`
            const cached = prCache.get(cacheKey)
            if (!force && cached && cached.expiresAt > Date.now()) {
              return Promise.resolve(
                cached.pullRequests.map((pr) => ({ pr, project }))
              )
            }
            return rpc()
              .call("github.pr.list", {
                project_id: project.id,
                state: filter,
                limit: 30,
              })
              .then((r) => {
                prCache.set(cacheKey, {
                  expiresAt: Date.now() + PR_CACHE_TTL_MS,
                  pullRequests: r.pull_requests,
                })
                return r.pull_requests.map((pr) => ({ pr, project }))
              })
              .catch((e: unknown) => {
                // Projects without a GitHub remote simply have no pull requests.
                const text = errorText(e)
                if (classifyPrError(text) !== "no-remote")
                  found.push({
                    project: project.name,
                    text: text.replace(/^gh pr list[^:]*: /, ""),
                  })
                return [] as Row[]
              })
          }
        )
        if (version !== loadVersion.current) return
        setErrors(found)
        setRows(
          results
            .flat()
            .sort((a, b) => b.pr.updated_at.localeCompare(a.pr.updated_at))
        )
      } finally {
        if (version === loadVersion.current) setPending(false)
      }
    },
    [targets, filter]
  )

  useEffect(() => {
    // Loading starts a request; its state updates are the sync with the daemon.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(false)
  }, [load])

  const matching = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase().replace(/^#/, "")
    return (rows ?? []).filter(
      (r) =>
        !q ||
        r.pr.title.toLowerCase().includes(q) ||
        r.pr.head.toLowerCase().includes(q) ||
        String(r.pr.number).includes(q)
    )
  }, [rows, deferredQuery])
  const visible = useMemo(
    () => matching.slice(0, visibleCount),
    [matching, visibleCount]
  )
  const groups = useMemo(() => {
    const m = new Map<ProjectId, Row[]>()
    for (const r of visible)
      m.set(r.project.id, [...(m.get(r.project.id) ?? []), r])
    return [...m.entries()]
  }, [visible])
  const showGroups = groups.length > 1

  const selectedKey = selection
    ? `${selection.projectId}:${selection.number}`
    : null
  const keys = useMemo(
    () => visible.map((r) => `${r.project.id}:${r.pr.number}`),
    [visible]
  )
  const tabbableKey =
    rovingKey && keys.includes(rovingKey)
      ? rovingKey
      : selectedKey && keys.includes(selectedKey)
        ? selectedKey
        : (keys[0] ?? null)

  useHotkey(
    "mod+f",
    () => {
      onOpenSearchKey?.()
      searchRef.current?.focus()
      searchRef.current?.select()
    },
    { allowInInput: true }
  )

  const rowButtons = () =>
    Array.from(
      bodyRef.current?.querySelectorAll<HTMLButtonElement>("[data-pr-row]") ??
        []
    )
  const onBodyKeyDown = (event: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const buttons = rowButtons()
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    if (event.key === "ArrowUp" && index === 0) {
      searchRef.current?.focus()
      return
    }
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : Math.min(
              buttons.length - 1,
              Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1))
            )
    buttons[next]?.focus()
  }

  const ghProblem = errors.length
    ? (["gh-missing", "gh-auth"] as const).find((kind) =>
        errors.some((e) => classifyPrError(e.text) === kind)
      )
    : undefined
  const otherErrors = errors.filter((e) => {
    const kind = classifyPrError(e.text)
    return kind !== "gh-missing" && kind !== "gh-auth"
  })
  const stateWord = filter === "all" ? "" : `${filter} `
  const scope = projectId
    ? projects[projectId]?.name
    : "your GitHub projects"

  return (
    <>
      <SurfaceHeader
        inline
        dock={false}
        trailing={
          <>
            <Menu>
              <IconButton
                render={<MenuTrigger />}
                variant="ghost"
                size="icon-sm"
                label="Filter by project"
                tooltip="Filter by project"
                className={cn(projectId && "text-foreground")}
              >
                <FilterIcon className="size-4" />
              </IconButton>
              <ComposerPickerMenuPopup
                align="end"
                side="bottom"
                className="w-64 min-w-64"
              >
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
                        {projectId === p.id && (
                          <CheckIcon className="size-3.5 shrink-0" />
                        )}
                      </MenuItem>
                    ))}
                </MenuGroup>
              </ComposerPickerMenuPopup>
            </Menu>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh"
              onClick={() => void load(true)}
              disabled={pending}
            >
              <RefreshCwIcon
                className={cn("size-4", pending && "animate-spin")}
              />
            </Button>
          </>
        }
      >
        <h1 className="font-system-ui truncate text-sm font-medium">
          Pull requests
          {projectId && (
            <span className={cn("font-normal", PR_QUIET_INK)}>
              {" "}
              · {projects[projectId]?.name}
            </span>
          )}
        </h1>
      </SurfaceHeader>

      <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
        <SegmentedControl
          aria-label="Pull request state"
          options={FILTERS}
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          className={cn("self-start [&_button]:!h-7 [&_button]:px-2.5", PR_META_TEXT)}
        />
        <Input
          ref={searchRef}
          id="pr-search"
          aria-label="Search pull requests"
          type="search"
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              const first = rowButtons().find((b) => b.tabIndex === 0) ?? rowButtons()[0]
              if (first) {
                e.preventDefault()
                first.focus()
              }
            }
          }}
          placeholder="Search by title, branch or number"
          className="w-full"
        />
      </div>

      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {ghProblem ? (
          <GhProblem kind={ghProblem} onRefresh={() => void load(true)} />
        ) : (
          <>
            {otherErrors.length > 0 && (
              <div className="mb-2">
                <PrErrorAlert onRetry={() => void load(true)}>
                  Unable to load pull requests for{" "}
                  {otherErrors.map((e) => e.project).join(", ")}.{" "}
                  {otherErrors[0]!.text}
                </PrErrorAlert>
              </div>
            )}
            {rows === null ? (
              <ListSkeleton />
            ) : targets.length === 0 ? (
              <Empty className="py-16">
                <EmptyHeader>
                  <EmptyTitle className="text-base">No GitHub projects</EmptyTitle>
                  <EmptyDescription>
                    Add a project with a GitHub remote to review its pull
                    requests here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : groups.length === 0 && deferredQuery.trim() ? (
              <Empty className="py-16">
                <EmptyHeader>
                  <EmptyTitle className="text-base">
                    No results for “{deferredQuery.trim()}”
                  </EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setQuery("")
                      searchRef.current?.focus()
                    }}
                  >
                    Clear search
                  </Button>
                </EmptyContent>
              </Empty>
            ) : groups.length === 0 ? (
              <Empty className="py-16">
                <EmptyHeader>
                  <EmptyTitle className="text-base">
                    {`No ${stateWord}pull requests`}
                  </EmptyTitle>
                  <EmptyDescription>
                    Pull requests from {scope} appear here.
                  </EmptyDescription>
                </EmptyHeader>
                {filter !== "all" && (
                  <EmptyContent>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setFilter("all")}
                    >
                      Show all pull requests
                    </Button>
                  </EmptyContent>
                )}
              </Empty>
            ) : (
              <div role="list" onKeyDown={onBodyKeyDown}>
                {groups.map(([pid, list]) => (
                  <div key={pid} role="presentation">
                    {showGroups && (
                      <h2
                        className={cn(
                          PR_FINE_TEXT,
                          PR_QUIET_INK,
                          "sticky top-0 z-[1] -mx-3 bg-[var(--color-background-surface)] px-3 pt-3 pb-1 font-medium"
                        )}
                      >
                        {projects[pid]?.name}
                      </h2>
                    )}
                    {list.map((r) => {
                      const key = `${pid}:${r.pr.number}`
                      return (
                        <div key={key} role="listitem">
                          <PrRow
                            pr={r.pr}
                            projectId={pid}
                            selected={key === selectedKey}
                            tabbable={key === tabbableKey}
                            onFocusRow={setRovingKey}
                          />
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
            {showRefreshing && (
              <div
                className={cn(
                  "flex items-center gap-2 px-1 pt-2",
                  PR_FINE_TEXT,
                  PR_QUIET_INK
                )}
              >
                <Spinner size={12} /> Refreshing
              </div>
            )}
            {visibleCount < matching.length && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2 w-full"
                  aria-describedby="pr-total"
                  onClick={() => setVisibleCount((c) => c + PR_ROWS_BATCH)}
                >
                  Show {Math.min(PR_ROWS_BATCH, matching.length - visibleCount)}{" "}
                  more
                </Button>
                <span id="pr-total" hidden>
                  of {matching.length} pull requests
                </span>
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}
