import { ArtifactsPane } from "./Artifacts"
// Right dock: a 46px tab strip of surface chips, a
// collapse control, and chosen panes kept mounted until closed. The Changes pane
// combines the Environment card rows with the diff file list.

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { Spinner } from "@/components/kybern/bits"
import { Button } from "@/components/kit/button"
import { IconButton } from "@/components/kit/icon-button"
import { DiffStat } from "@/components/kit/chat/DiffStatLabel"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "@/components/kit/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { FileDiffCard } from "@/components/kybern/DiffView"
import { parseUnifiedDiff, type FileDiff } from "@/lib/diff"
import { plural } from "@/lib/format"
import { ArrowUpRightIcon, ChangesIcon, DeviceLaptopIcon, DiffIcon, FoldersIcon, GitBranchIcon, GitCommitIcon, GitHubIcon, GitPullRequestIcon, PanelRightCloseIcon, PlusIcon, TerminalIcon, UsersIcon, WorkflowIcon, XIcon } from "@/lib/kit/icons"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { useSlidingPill } from "@/lib/kit/slidingPill"
import type { Diff, ThreadId } from "@/protocol"
import { errorText, loadDiff, loadFileDiff, loadGitStatus, rpc } from "@/state/rpc"
import { diffKey, isRuntimeTaskActive, useStore, type RightTab } from "@/state/store"

import { ActivityPane } from "./Activity"
import { CollaborationPane } from "./Collaboration"
import { ExplorerPane } from "./Explorer"
import { TerminalWorkspace } from "./Terminal"
import { CHAT_SURFACE_CHIP_CLASS_NAME, CHAT_SURFACE_HEADER_ROW_CLASS_NAME, DOCK_HEADER_ICON_BUTTON_CLASS } from "./chrome"

const DOCK_TAB_CHIP = `${CHAT_SURFACE_CHIP_CLASS_NAME} inline-flex min-w-0 items-center !gap-0 !px-0`
const DOCK_TAB_ACTIVE = "text-[var(--color-text-foreground)]"
const DOCK_PANELS = [
  { id: "collaboration", label: "Agents", Icon: UsersIcon },
  { id: "activity", label: "Activity", Icon: WorkflowIcon },
  { id: "changes", label: "Diff", Icon: DiffIcon },
  { id: "terminal", label: "Terminal", Icon: TerminalIcon },
  { id: "artifacts", label: "Artifacts", Icon: FoldersIcon },
  { id: "explorer", label: "Explorer", Icon: FoldersIcon },
] as const

const ENV_ROW =
  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left text-[length:var(--app-font-size-ui,12px)] font-normal text-[var(--color-text-foreground)] outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] focus-visible:bg-[var(--color-background-elevated-secondary)] disabled:pointer-events-none disabled:opacity-50"
const ENV_ICON = "size-4 shrink-0 text-[var(--color-text-foreground)]"
const ENV_LABEL = "font-normal text-muted-foreground/40"
const ENV_SECTION_LABEL = `${ENV_LABEL} text-[length:var(--app-font-size-ui-sm,11px)] px-2 py-1`
const DIFF_FILES_BATCH = 50

export function RightPanel({ threadId }: { threadId: ThreadId | null }) {
  const tab = useStore((s) => s.rightTab)
  const tabs = useStore((s) => s.rightTabs)
  const set = useStore((s) => s.set)
  const diff = useStore((s) => (threadId ? s.diffs[diffKey(threadId)] : undefined))
  const projectId = useStore((s) => (threadId ? s.threads[threadId]?.project_id : undefined) ?? (s.selected.kind === "draft" ? s.selected.draft.projectId : undefined))
  const projectCoordinator = useStore((s) => !!(threadId && s.threads[threadId]?.coordinator_project_id))
  const [adds, dels] = useMemo(() => [diff?.files.reduce((n, f) => n + f.additions, 0) ?? 0, diff?.files.reduce((n, f) => n + f.deletions, 0) ?? 0], [diff])
  const activeTasks = useStore((s) => (threadId ? (s.runtimeTasks[threadId] ?? []).filter(isRuntimeTaskActive).length : 0))
  const [tabsRef, pillStyle, pillReady] = useSlidingPill<HTMLDivElement>(`${tab}:${tabs.join(",")}`)
  const headerRef = useRef<HTMLDivElement>(null)
  const closeTab = (id: RightTab) => {
    set((state) => {
      const remaining = state.rightTabs.filter((item) => item !== id)
      const index = state.rightTabs.indexOf(id)
      return {
        rightTabs: remaining,
        rightTab: state.rightTab === id ? remaining[Math.min(index, remaining.length - 1)] ?? null : state.rightTab,
      }
    })
    requestAnimationFrame(() => {
      const header = headerRef.current
      const target = header?.querySelector<HTMLButtonElement>('[data-tab-active="true"] button')
        ?? header?.querySelector<HTMLButtonElement>('[aria-label="Add panel"]')
      target?.focus()
    })
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-background-surface)] text-foreground">
      <div
        ref={headerRef}
        data-tauri-drag-region="deep"
        className={cn(CHAT_SURFACE_HEADER_ROW_CLASS_NAME, "drag-region gap-1 px-1.5")}
      >
        <div ref={tabsRef} className="t-tabs flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tab && <span aria-hidden className="t-tabs-pill z-0 rounded-lg bg-[var(--color-background-button-secondary)]" style={pillStyle} data-ready={pillReady} />}
          {tabs.map((id) => {
            const { label, Icon } = DOCK_PANELS.find((panel) => panel.id === id)!
            return <DockTab key={id} active={tab === id} onClick={() => set({ rightTab: id })} onClose={() => closeTab(id)} icon={<Icon className="size-3.5 shrink-0 opacity-70" />} label={id === "collaboration" && projectCoordinator ? "Project" : label}>
              {id === "activity" && activeTasks > 0 && <span key={activeTasks} className="t-pop ml-0.5 min-w-3 text-center text-[10px] tabular-nums text-muted-foreground/70">{activeTasks}</span>}
              {id === "changes" && adds + dels > 0 && <span key={`${adds}:${dels}`} className="t-pop inline-flex"><DiffStat additions={adds} deletions={dels} className="ml-1 font-system-ui text-[length:var(--app-font-size-ui-xs,10px)] font-normal" /></span>}
            </DockTab>
          })}
        </div>
        <div
          data-tauri-drag-region="false"
          className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
        >
          <Menu>
            <MenuTrigger render={<Button variant="chrome" size="icon-xs" className={DOCK_HEADER_ICON_BUTTON_CLASS} aria-label="Add panel" />}>
              <PlusIcon className="size-3.5" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-44 min-w-44">
              <MenuGroup>
                {DOCK_PANELS.map(({ id, label, Icon }) => (
                  <MenuItem key={id} onClick={() => set({ rightTab: id })}>
                    <Icon className="size-3.5 shrink-0" />
                    <span>{id === "collaboration" && projectCoordinator ? "Project" : label}</span>
                    {tabs.includes(id) && <span className="ml-auto text-xs text-muted-foreground">Open</span>}
                  </MenuItem>
                ))}
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>
          <IconButton variant="chrome" size="icon-xs" className={DOCK_HEADER_ICON_BUTTON_CLASS} label="Collapse panel" tooltip="Collapse panel" tooltipSide="bottom" onClick={() => set({ rightOpen: false })}>
            <PanelRightCloseIcon />
          </IconButton>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">Add a panel with +.</div>
        ) : !threadId ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">Open a thread to see its activity, changes, and terminal.</div>
        ) : (
          <>
            {tabs.includes("collaboration") && <div className={cn("t-pane absolute inset-0 flex min-h-0 w-full", tab === "collaboration" ? "z-[1]" : "z-0")} data-active={tab === "collaboration"} aria-hidden={tab !== "collaboration"}>
              <CollaborationPane key={threadId} threadId={threadId} active={tab === "collaboration"} />
            </div>}
            {tabs.includes("activity") && <div className={cn("t-pane absolute inset-0 flex min-h-0 w-full", tab === "activity" ? "z-[1]" : "z-0")} data-active={tab === "activity"} aria-hidden={tab !== "activity"}>
              <ActivityPane key={threadId} threadId={threadId} visible={tab === "activity"} />
            </div>}
            {tabs.includes("changes") && <div className={cn("t-pane absolute inset-0 flex min-h-0 w-full", tab === "changes" ? "z-[1]" : "z-0")} data-active={tab === "changes"} aria-hidden={tab !== "changes"}>
              <Changes key={threadId} threadId={threadId} active={tab === "changes"} />
            </div>}
            {tabs.includes("explorer") && <div className={cn("t-pane absolute inset-0 flex min-h-0 w-full", tab === "explorer" ? "z-[1]" : "z-0")} data-active={tab === "explorer"} aria-hidden={tab !== "explorer"}>
              {projectId && <ExplorerPane projectId={projectId} active={tab === "explorer"} />}
            </div>}
            {tabs.includes("artifacts") && <div className={cn("t-pane absolute inset-0 flex min-h-0 w-full", tab === "artifacts" ? "z-[1]" : "z-0")} data-active={tab === "artifacts"} aria-hidden={tab !== "artifacts"}><ArtifactsPane key={threadId} threadId={threadId} active={tab === "artifacts"} /></div>}
            {tabs.includes("terminal") && <div className={cn("t-pane absolute inset-0 flex min-h-0 w-full", tab === "terminal" ? "z-[1]" : "z-0")} data-active={tab === "terminal"} aria-hidden={tab !== "terminal"}>
              <TerminalWorkspace threadId={threadId} active={tab === "terminal"} />
            </div>}
          </>
        )}
      </div>
    </div>
  )
}

function DockTab({ active, onClick, onClose, icon, label, children }: { active: boolean; onClick: () => void; onClose: () => void; icon: React.ReactNode; label: string; children?: React.ReactNode }) {
  return (
    <div data-tab-active={active} className={cn("relative z-[1] [-webkit-app-region:no-drag]", DOCK_TAB_CHIP, active && DOCK_TAB_ACTIVE)}>
      <button type="button" onClick={onClick} aria-pressed={active} className="press inline-flex h-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        <span className="relative flex size-4 shrink-0 items-center justify-center">{icon}</span>
        <span className="max-w-[10rem] truncate">{label}</span>
        {children}
      </button>
      <button type="button" onClick={onClose} aria-label={`Close ${label} panel`} className="press flex h-full w-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

const Changes = memo(function Changes({ threadId, active }: { threadId: ThreadId; active: boolean }) {
  const thread = useStore((s) => s.threads[threadId])
  const project = useStore((s) => (thread ? s.projects[thread.project_id] : undefined))
  const diff = useStore((s) => s.diffs[diffKey(threadId)])
  const git = useStore((s) => s.gitStatuses[threadId] ?? null)
  const [busy, setBusy] = useState<"commit" | "pr" | null>(null)
  const [visibleCount, setVisibleCount] = useState(DIFF_FILES_BATCH)

  useEffect(() => {
    if (!active) return
    void loadDiff(threadId)
    void loadGitStatus(threadId)
  }, [active, threadId])

  if (!active) return null

  const files = diff?.files ?? []
  const visibleFiles = files.slice(0, visibleCount)

  const commit = async () => {
    setBusy("commit")
    try {
      const r = await rpc().call("git.commit", { thread_id: threadId })
      toast("Committed", { description: r.message })
      void loadDiff(threadId)
      void loadGitStatus(threadId)
    } catch (e) {
      toast.error("Unable to commit", { description: errorText(e) })
    } finally {
      setBusy(null)
    }
  }
  const pr = async () => {
    setBusy("pr")
    try {
      const p = await rpc().call("github.pr.create", { thread_id: threadId })
      toast("Pull request opened", { description: p.title, action: { label: "Open", onClick: () => void openExternal(p.url) } })
      useStore.getState().set((state) => {
        const current = state.gitStatuses[threadId]
        return current ? { gitStatuses: { ...state.gitStatuses, [threadId]: { ...current, pull_request: p } } } : {}
      })
    } catch (e) {
      toast.error("Unable to create pull request", { description: errorText(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      {/* Environment rows */}
      <div className="flex flex-col gap-0.5 p-1.5">
        <div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-0.5">
          <p className={cn(ENV_LABEL, "text-[length:var(--app-font-size-ui,12px)]")}>Environment</p>
        </div>
        <EnvRow icon={<DeviceLaptopIcon className={ENV_ICON} />} label={project?.name ?? "Local"} trailing={<span className="text-[var(--color-text-foreground-secondary)]">Local</span>} />
        {git?.is_git && (
          <EnvRow
            icon={thread?.worktree ? <GitBranchIcon className={ENV_ICON} /> : <GitBranchIcon className={ENV_ICON} />}
            label={git.branch ?? "detached"}
            trailing={
              git.ahead || git.behind ? (
                <span className="text-[var(--color-text-foreground-secondary)]">
                  {git.ahead ? `↑${git.ahead}` : ""}
                  {git.behind ? ` ↓${git.behind}` : ""}
                </span>
              ) : null
            }
          />
        )}
        {git?.is_git && (
          <EnvRow
            icon={busy === "commit" ? <Spinner size={14} className={ENV_ICON} /> : <GitCommitIcon className={ENV_ICON} />}
            label="Commit and push"
            disabled={!!busy || git.dirty_files === 0}
            onClick={commit}
            trailing={git.dirty_files > 0 ? <span className="text-[var(--color-text-foreground-secondary)]">{git.dirty_files}</span> : null}
          />
        )}
        {git?.remote_url && (
          <>
            <div className="my-1 border-t border-[color:var(--color-border-light)]" />
            <p className={ENV_SECTION_LABEL}>Repository</p>
            <EnvRow icon={<GitHubIcon className={ENV_ICON} />} label={repoName(git.remote_url)} onClick={() => void openExternal(toHttp(git.remote_url!))} trailing={<ArrowUpRightIcon className="size-3 shrink-0 opacity-60" />} />
          </>
        )}
        {git?.is_git && (
          <>
            <div className="my-1 border-t border-[color:var(--color-border-light)]" />
            <p className={ENV_SECTION_LABEL}>Pull request</p>
            {git.pull_request ? (
              <EnvRow icon={<GitPullRequestIcon className={ENV_ICON} />} label={`#${git.pull_request.number} ${git.pull_request.title}`} onClick={() => void openExternal(git.pull_request!.url)} trailing={<ArrowUpRightIcon className="size-3 shrink-0 opacity-60" />} />
            ) : (
              <EnvRow icon={busy === "pr" ? <Spinner size={14} className={ENV_ICON} /> : <GitPullRequestIcon className={ENV_ICON} />} label="Create pull request" onClick={pr} disabled={!!busy} />
            )}
          </>
        )}
      </div>

      <div className="mx-1.5 my-1 border-t border-[color:var(--color-border-light)]" />

      {files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">No changes yet. Files the agent edits in this thread show up here with their diff.</div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col font-system-ui">
          <div className="flex items-center gap-2 px-3 py-1">
            <span className="flex size-4 items-center justify-center text-[var(--color-text-foreground)]">
              <ChangesIcon className="size-3.5" />
            </span>
            <span className="text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)]">{plural(files.length, "file")} changed</span>
            <span className="ml-auto" />
            <DiffStat additions={files.reduce((n, f) => n + f.additions, 0)} deletions={files.reduce((n, f) => n + f.deletions, 0)} className="shrink-0 text-[11px] font-medium" />
          </div>
          <div className="h-full min-h-0 overflow-auto px-2 pb-2">
            {visibleFiles.map((file) => (
              <LazyFileDiffCard key={`${diff?.to}:${file.path}`} threadId={threadId} change={file} />
            ))}
            {visibleCount < files.length && (
              <button
                type="button"
                onClick={() => setVisibleCount((count) => count + DIFF_FILES_BATCH)}
                className="mb-2 flex w-full items-center justify-center rounded-md border border-[color:var(--color-border)] px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-foreground"
              >
                Show {Math.min(DIFF_FILES_BATCH, files.length - visibleCount)} more of {files.length} files
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

function fileChangeShell(change: Diff["files"][number]): FileDiff {
  return {
    path: change.path,
    oldPath: change.old_path ?? null,
    status: change.status === "added" ? "added" : change.status === "deleted" ? "deleted" : "modified",
    binary: change.binary,
    hunks: [],
    additions: change.additions,
    deletions: change.deletions,
  }
}

function LazyFileDiffCard({ threadId, change }: { threadId: ThreadId; change: Diff["files"][number] }) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<FileDiff>(() => fileChangeShell(change))
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [truncated, setTruncated] = useState(false)

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next || loaded || loading) return
    setLoading(true)
    setFailed(false)
    void loadFileDiff(threadId, change.path)
      .then((diff) => {
        const parsed = parseUnifiedDiff(diff.patch)
        setFile(parsed.find((candidate) => candidate.path === change.path) ?? fileChangeShell(change))
        setTruncated(!!diff.patch_truncated)
        setLoaded(true)
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }

  return <FileDiffCard file={file} open={open} onOpenChange={onOpenChange} loading={loading} error={failed} truncated={truncated} className="mb-2 first:mt-2 last:mb-0" />
}

function EnvRow({ icon, label, trailing, onClick, disabled }: { icon: React.ReactNode; label: string; trailing?: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  const Comp = onClick ? "button" : "div"
  return (
    <Comp type={onClick ? "button" : undefined} onClick={onClick} disabled={disabled} className={cn(ENV_ROW, !onClick && "cursor-default hover:bg-transparent")}>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-1 tabular-nums">{trailing}</span>
    </Comp>
  )
}

export function DockCloseHint() {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        <XIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Close</TooltipPopup>
    </Tooltip>
  )
}

function repoName(url: string): string {
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url)
  return m?.[1] ?? url
}
function toHttp(url: string): string {
  if (url.startsWith("http")) return url.replace(/\.git$/, "")
  const m = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url)
  return m ? `https://${m[1]}/${m[2]}` : url
}

export type { RightTab }
