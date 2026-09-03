// Right dock, to Synara's RightDock: a 46px tab strip of surface chips, a
// collapse control, and panes kept mounted underneath. The Changes pane
// combines the Environment card rows with the diff file list.

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Spinner } from "@/components/kybern/bits"
import { Button } from "@/components/synara/button"
import { IconButton } from "@/components/synara/icon-button"
import { DiffStat } from "@/components/synara/chat/DiffStatLabel"
import { ComposerPickerMenuPopup } from "@/components/synara/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "@/components/synara/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/synara/tooltip"
import { FileDiffCard } from "@/components/kybern/DiffView"
import { parseUnifiedDiff, type FileDiff } from "@/lib/diff"
import { plural } from "@/lib/format"
import { ArrowUpRightIcon, ChangesIcon, DeviceLaptopIcon, DiffIcon, FoldersIcon, GitBranchIcon, GitCommitIcon, GitHubIcon, GitPullRequestIcon, PanelRightCloseIcon, PlusIcon, TerminalIcon, XIcon } from "@/lib/synara/icons"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { GitStatus, ThreadId } from "@/protocol"
import { errorText, loadDiff, rpc } from "@/state/rpc"
import { diffKey, useStore, type RightTab } from "@/state/store"

import { ExplorerPane } from "./Explorer"
import { TerminalWorkspace } from "./Terminal"
import { CHAT_SURFACE_CHIP_CLASS_NAME, CHAT_SURFACE_HEADER_ROW_CLASS_NAME } from "./chrome"

const DOCK_TAB_CHIP = `${CHAT_SURFACE_CHIP_CLASS_NAME} inline-flex min-w-0 items-center pr-2.5`
const DOCK_TAB_ACTIVE = "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]"
const DOCK_HEADER_ICON_BUTTON = "!size-7 shrink-0 rounded-lg [&_svg,&_[data-slot=central-icon]]:mx-0"

const ENV_ROW =
  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left text-[length:var(--app-font-size-ui,12px)] font-normal text-[var(--color-text-foreground)] outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] focus-visible:bg-[var(--color-background-elevated-secondary)] disabled:pointer-events-none disabled:opacity-50"
const ENV_ICON = "size-4 shrink-0 text-[var(--color-text-foreground)]"
const ENV_LABEL = "font-normal text-muted-foreground/40"
const ENV_SECTION_LABEL = `${ENV_LABEL} text-[length:var(--app-font-size-ui-sm,11px)] px-2 py-1`

export function RightPanel({ threadId }: { threadId: ThreadId | null }) {
  const tab = useStore((s) => s.rightTab)
  const set = useStore((s) => s.set)
  const diff = useStore((s) => (threadId ? s.diffs[diffKey(threadId)] : undefined))
  const projectId = useStore((s) => (threadId ? s.threads[threadId]?.project_id : undefined) ?? (s.selected.kind === "draft" ? s.selected.draft.projectId : undefined))
  const adds = diff?.files.reduce((n, f) => n + f.additions, 0) ?? 0
  const dels = diff?.files.reduce((n, f) => n + f.deletions, 0) ?? 0

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-background-surface)] text-foreground">
      <div className={cn(CHAT_SURFACE_HEADER_ROW_CLASS_NAME, "drag-region gap-1 px-1.5")}>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <DockTab active={tab === "changes"} onClick={() => set({ rightTab: "changes" })} icon={<DiffIcon className="size-3.5 shrink-0 opacity-70" />} label="Diff">
            {adds + dels > 0 && <DiffStat additions={adds} deletions={dels} className="ml-1 font-system-ui text-[length:var(--app-font-size-ui-xs,10px)] font-normal" />}
          </DockTab>
          <DockTab active={tab === "terminal"} onClick={() => set({ rightTab: "terminal" })} icon={<TerminalIcon className="size-3.5 shrink-0 opacity-70" />} label="Terminal" />
          <DockTab active={tab === "explorer"} onClick={() => set({ rightTab: "explorer" })} icon={<FoldersIcon className="size-3.5 shrink-0 opacity-70" />} label="Explorer" />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
          <Menu>
            <MenuTrigger render={<Button variant="chrome" size="icon-xs" className={DOCK_HEADER_ICON_BUTTON} aria-label="Add pane" />}>
              <PlusIcon className="size-3.5" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-44 min-w-44">
              <MenuGroup>
                <MenuItem onClick={() => set({ rightTab: "changes" })}>
                  <DiffIcon className="size-3.5 shrink-0" />
                  <span>Diff</span>
                </MenuItem>
                <MenuItem onClick={() => set({ rightTab: "terminal" })}>
                  <TerminalIcon className="size-3.5 shrink-0" />
                  <span>Terminal</span>
                </MenuItem>
                <MenuItem onClick={() => set({ rightTab: "explorer" })}>
                  <FoldersIcon className="size-3.5 shrink-0" />
                  <span>Explorer</span>
                </MenuItem>
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>
          <IconButton variant="chrome" size="icon-xs" className={DOCK_HEADER_ICON_BUTTON} label="Collapse panel" tooltip="Collapse panel" tooltipSide="bottom" onClick={() => set({ rightOpen: false })}>
            <PanelRightCloseIcon />
          </IconButton>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {!threadId ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">Open a thread to see its changes and terminal.</div>
        ) : (
          <>
            <div className={cn("absolute inset-0 flex min-h-0 w-full transition-opacity", tab === "changes" ? "z-[1] opacity-100" : "pointer-events-none z-0 opacity-0")} aria-hidden={tab !== "changes"}>
              <Changes threadId={threadId} />
            </div>
            <div className={cn("absolute inset-0 flex min-h-0 w-full transition-opacity", tab === "explorer" ? "z-[1] opacity-100" : "pointer-events-none z-0 opacity-0")} aria-hidden={tab !== "explorer"}>
              {projectId && <ExplorerPane projectId={projectId} />}
            </div>
            <div className={cn("absolute inset-0 flex min-h-0 w-full transition-opacity", tab === "terminal" ? "z-[1] opacity-100" : "pointer-events-none z-0 opacity-0")} aria-hidden={tab !== "terminal"}>
              <TerminalWorkspace threadId={threadId} active={tab === "terminal"} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function DockTab({ active, onClick, icon, label, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; children?: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} data-pressed={active || undefined} className={cn("group/dock-tab [-webkit-app-region:no-drag]", DOCK_TAB_CHIP, active && DOCK_TAB_ACTIVE)}>
      <span className="relative flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="max-w-[10rem] truncate">{label}</span>
      {children}
    </button>
  )
}

function Changes({ threadId }: { threadId: ThreadId }) {
  const thread = useStore((s) => s.threads[threadId])
  const project = useStore((s) => (thread ? s.projects[thread.project_id] : undefined))
  const diff = useStore((s) => s.diffs[diffKey(threadId)])
  const [git, setGit] = useState<GitStatus | null>(null)
  const [busy, setBusy] = useState<"commit" | "pr" | null>(null)
  const lastSeq = useStore((s) => s.transcripts[threadId]?.lastSeq)

  useEffect(() => {
    void loadDiff(threadId)
    rpc()
      .call("git.status", { thread_id: threadId })
      .then(setGit)
      .catch(() => setGit(null))
  }, [threadId, lastSeq])

  const files = diff?.files ?? []
  const byPath = useMemo(() => {
    const m = new Map<string, FileDiff>()
    for (const f of parseUnifiedDiff(diff?.patch ?? "")) m.set(f.path, f)
    return m
  }, [diff?.patch])

  const commit = async () => {
    setBusy("commit")
    try {
      const r = await rpc().call("git.commit", { thread_id: threadId })
      toast("Committed", { description: r.message })
      void loadDiff(threadId)
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
      setGit((g) => (g ? { ...g, pull_request: p } : g))
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
            {files.map((f) => {
              const parsed = byPath.get(f.path) ?? { path: f.path, oldPath: f.old_path ?? null, status: f.status === "added" ? "added" : f.status === "deleted" ? "deleted" : "modified", binary: f.binary, hunks: [], additions: f.additions, deletions: f.deletions }
              return <FileDiffCard key={f.path} file={parsed} className="mb-2 first:mt-2 last:mb-0" />
            })}
          </div>
        </div>
      )}
    </div>
  )
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
