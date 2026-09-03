// Environment panel, to Synara's EnvironmentPanel: a floating w-72 card
// docked at the right edge of the thread, toggled from the header. Rows use
// the EnvironmentRow skin; sections can be hidden from the gear menu.

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Markdown } from "@/components/kybern/Markdown"
import { Spinner } from "@/components/kybern/bits"
import { DisclosureChevron } from "@/components/synara/DisclosureChevron"
import { DisclosureRegion } from "@/components/synara/DisclosureRegion"
import { IconButton } from "@/components/synara/icon-button"
import { ComposerPickerMenuPopup } from "@/components/synara/chat/ComposerPickerMenuPopup"
import { DiffStat } from "@/components/synara/chat/DiffStatLabel"
import { ENVIRONMENT_PANEL_MOTION_CLASS, ENVIRONMENT_PANEL_SURFACE_CLASS_NAME } from "@/components/synara/chat/composerPickerStyles"
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from "@/components/synara/menu"
import { copyText, useLocalStorage } from "@/lib/hooks"
import {
  ArrowUpRightIcon,
  ChangesIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DeviceLaptopIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitHubIcon,
  GitPullRequestIcon,
  LayoutSidebarIcon,
  SettingsIcon,
  WorktreeIcon,
} from "@/lib/synara/icons"
import { openExternal, openPath, revealInFinder } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { GitStatus, ThreadId } from "@/protocol"
import { errorText, loadDiff, rpc } from "@/state/rpc"
import { diffKey, useStore } from "@/state/store"

/** Chat content is inset by this much while the panel is docked (288px card + 24px gutters). */
export const ENVIRONMENT_DOCKED_CONTENT_INSET_PX = 312

export const ENVIRONMENT_ROW_CLASS_NAME =
  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left text-[length:var(--app-font-size-ui,12px)] font-normal text-[var(--color-text-foreground)] outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] focus-visible:bg-[var(--color-background-elevated-secondary)] disabled:pointer-events-none disabled:opacity-50"
export const ENVIRONMENT_ROW_ICON_CLASS_NAME = "size-4 shrink-0 text-[var(--color-text-foreground)]"
const LABEL = "font-normal text-muted-foreground/40"
const TITLE = `${LABEL} text-[length:var(--app-font-size-ui,12px)]`
const SECTION_LABEL_INLINE = `${LABEL} text-[length:var(--app-font-size-ui-sm,11px)]`
const SECTION_LABEL = `${SECTION_LABEL_INLINE} px-2 py-1`
const MUTED_BODY = "font-system-ui text-[length:var(--app-font-size-chat,12px)] leading-relaxed text-muted-foreground/40"

type Section = "changes" | "repository" | "pullRequest" | "editor" | "recap"
const SECTIONS: [Section, string][] = [
  ["changes", "Changes"],
  ["repository", "Repository"],
  ["pullRequest", "Pull request"],
  ["editor", "Editor"],
  ["recap", "Recap"],
]

export function EnvironmentRowChevron() {
  return <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
}

export function EnvironmentRow({
  icon,
  label,
  trailing,
  onClick,
  disabled,
  render,
}: {
  icon: React.ReactNode
  label: string
  trailing?: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  /** Swap the root element (e.g. a MenuTrigger). */
  render?: React.ReactElement
}) {
  const body = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-1 tabular-nums">{trailing}</span>
    </>
  )
  if (render) return <MenuTrigger render={render} className={ENVIRONMENT_ROW_CLASS_NAME} disabled={disabled}>{body}</MenuTrigger>
  const Comp = onClick ? "button" : "div"
  return (
    <Comp type={onClick ? "button" : undefined} onClick={onClick} disabled={disabled} className={cn(ENVIRONMENT_ROW_CLASS_NAME, !onClick && "cursor-default hover:bg-transparent")}>
      {body}
    </Comp>
  )
}

export function EnvironmentSectionDivider() {
  return <div className="my-1 border-t border-[color:var(--color-border-light)]" />
}

function LabeledSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <EnvironmentSectionDivider />
      <div className="flex flex-col gap-0.5">
        <p className={SECTION_LABEL}>{label}</p>
        {children}
      </div>
    </>
  )
}

function CollapsibleSection({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <>
      <EnvironmentSectionDivider />
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="group/section flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] focus-visible:bg-[var(--color-background-elevated-secondary)]"
      >
        <span className={cn(SECTION_LABEL_INLINE, "min-w-0 truncate")}>{label}</span>
        <DisclosureChevron open={open} className="size-3 shrink-0 text-[var(--color-text-foreground-secondary)] opacity-60" />
      </button>
      <DisclosureRegion open={open}>
        <div className="flex flex-col pt-0.5">{children}</div>
      </DisclosureRegion>
    </>
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

export function EnvironmentPanel({ threadId }: { threadId: ThreadId }) {
  const open = useStore((s) => s.envOpen)
  const set = useStore((s) => s.set)
  const thread = useStore((s) => s.threads[threadId])
  const project = useStore((s) => (thread ? s.projects[thread.project_id] : undefined))
  const diff = useStore((s) => s.diffs[diffKey(threadId)])
  const lastSeq = useStore((s) => s.transcripts[threadId]?.lastSeq)
  const blocks = useStore((s) => s.transcripts[threadId]?.blocks)
  const [git, setGit] = useState<GitStatus | null>(null)
  const [busy, setBusy] = useState<"commit" | "pr" | null>(null)
  const [hidden, setHidden] = useLocalStorage<Partial<Record<Section, boolean>>>("kybern.env.hidden", {})
  const [recapOpen, setRecapOpen] = useLocalStorage("kybern.env.recap", true)

  useEffect(() => {
    if (!open) return
    void loadDiff(threadId)
    rpc()
      .call("git.status", { thread_id: threadId })
      .then(setGit)
      .catch(() => setGit(null))
  }, [threadId, lastSeq, open])

  const recap = useMemo(() => {
    if (!blocks) return ""
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!
      if (b.kind === "assistant" && b.complete && b.text.trim()) return b.text.trim()
    }
    return ""
  }, [blocks])

  const adds = diff?.files.reduce((n, f) => n + f.additions, 0) ?? 0
  const dels = diff?.files.reduce((n, f) => n + f.deletions, 0) ?? 0
  const show = (s: Section) => !hidden[s]
  const cwd = thread?.cwd ?? project?.path ?? ""

  const commit = async () => {
    setBusy("commit")
    try {
      const r = await rpc().call("git.commit", { thread_id: threadId })
      toast("Committed", { description: r.message })
      void loadDiff(threadId)
      setGit(await rpc().call("git.status", { thread_id: threadId }))
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
    <div className="pointer-events-none absolute inset-y-0 right-0 z-20 flex flex-col p-3" data-environment-panel-variant="docked">
      <aside
        aria-label="Environment"
        aria-hidden={!open}
        inert={!open}
        className={cn(
          ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
          ENVIRONMENT_PANEL_MOTION_CLASS,
          "flex max-h-full w-72 flex-col",
          open ? "pointer-events-auto translate-x-0 opacity-100" : "pointer-events-none translate-x-full opacity-0",
        )}
      >
        <div className="min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-0.5 p-1.5">
            <div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-0.5">
              <p className={TITLE}>Environment</p>
              <Menu>
                <IconButton render={<MenuTrigger />} variant="ghost" size="icon-xs" label="Panel sections" tooltip="Panel sections" className="-mr-[7px] sm:-mr-[5px]">
                  <SettingsIcon className="size-3.5" />
                </IconButton>
                <ComposerPickerMenuPopup align="end" side="bottom" className="w-48 min-w-48">
                  <MenuGroup>
                    <MenuGroupLabel>Sections</MenuGroupLabel>
                    {SECTIONS.map(([key, label]) => (
                      <MenuCheckboxItem key={key} checked={show(key)} onCheckedChange={(v) => setHidden((h) => ({ ...h, [key]: !v }))} closeOnClick={false}>
                        {label}
                      </MenuCheckboxItem>
                    ))}
                  </MenuGroup>
                </ComposerPickerMenuPopup>
              </Menu>
            </div>

            {show("changes") && (
              <EnvironmentRow
                icon={<ChangesIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
                label="Changes"
                disabled={!diff || diff.files.length === 0}
                onClick={() => set({ rightOpen: true, rightTab: "changes" })}
                trailing={<DiffStat additions={adds} deletions={dels} />}
              />
            )}

            <Menu>
              <EnvironmentRow
                render={<button type="button" />}
                icon={thread?.worktree ? <WorktreeIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} /> : <DeviceLaptopIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
                label={thread?.worktree ? "Worktree" : "Local"}
                trailing={<EnvironmentRowChevron />}
              />
              <ComposerPickerMenuPopup align="start" side="bottom" sideOffset={6} className="w-60 min-w-60">
                <MenuGroup>
                  <MenuGroupLabel>Running in</MenuGroupLabel>
                  <MenuItem onClick={() => cwd && void revealInFinder(cwd)}>
                    {thread?.worktree ? <WorktreeIcon className="size-3.5 text-muted-foreground" /> : <DeviceLaptopIcon className="size-3.5 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{cwd || "Local"}</span>
                    <CheckIcon className="size-3.5 shrink-0 text-[var(--color-text-foreground)]" />
                  </MenuItem>
                </MenuGroup>
              </ComposerPickerMenuPopup>
            </Menu>

            {git?.is_git && (
              <Menu>
                <EnvironmentRow render={<button type="button" />} icon={<GitBranchIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />} label={git.branch ?? "detached"} trailing={<EnvironmentRowChevron />} />
                <ComposerPickerMenuPopup align="start" side="bottom" sideOffset={6} className="w-60 min-w-60">
                  <MenuGroup>
                    <MenuGroupLabel>Branch</MenuGroupLabel>
                    <MenuItem disabled>
                      <GitBranchIcon className="size-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{git.branch ?? "detached"}</span>
                      {(git.ahead || git.behind) ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                          {git.ahead ? `↑${git.ahead}` : ""}
                          {git.behind ? ` ↓${git.behind}` : ""}
                        </span>
                      ) : null}
                    </MenuItem>
                    {git.upstream && (
                      <MenuItem disabled>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">Tracks {git.upstream}</span>
                      </MenuItem>
                    )}
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuItem onClick={() => git.branch && void copyText(git.branch)}>
                      <CopyIcon className="size-3.5 text-muted-foreground" /> Copy branch name
                    </MenuItem>
                  </MenuGroup>
                </ComposerPickerMenuPopup>
              </Menu>
            )}

            {git?.is_git && (
              <EnvironmentRow
                icon={busy === "commit" ? <Spinner size={14} className={ENVIRONMENT_ROW_ICON_CLASS_NAME} /> : <GitCommitIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
                label="Commit and push"
                disabled={!!busy || git.dirty_files === 0}
                onClick={commit}
                trailing={git.dirty_files > 0 ? <span className="text-[var(--color-text-foreground-secondary)]">{git.dirty_files}</span> : <EnvironmentRowChevron />}
              />
            )}

            {show("repository") && git?.remote_url && (
              <LabeledSection label="Repository">
                <EnvironmentRow icon={<GitHubIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />} label={repoName(git.remote_url)} onClick={() => void openExternal(toHttp(git.remote_url!))} trailing={<ArrowUpRightIcon className="size-3.5 shrink-0" />} />
              </LabeledSection>
            )}

            {show("pullRequest") && git?.is_git && (
              <LabeledSection label="Pull request">
                {git.pull_request ? (
                  <EnvironmentRow
                    icon={<GitPullRequestIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
                    label={`#${git.pull_request.number} ${git.pull_request.title}`}
                    onClick={() => void openExternal(git.pull_request!.url)}
                    trailing={
                      <>
                        {git.pull_request.is_draft && <span className="shrink-0 rounded-full bg-[var(--color-background-elevated-secondary)] px-1.5 py-px text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">Draft</span>}
                        <ArrowUpRightIcon className="size-3.5 shrink-0" />
                      </>
                    }
                  />
                ) : (
                  <EnvironmentRow icon={busy === "pr" ? <Spinner size={14} className={ENVIRONMENT_ROW_ICON_CLASS_NAME} /> : <GitPullRequestIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />} label="Create pull request" onClick={pr} disabled={!!busy || !git.remote_url} />
                )}
              </LabeledSection>
            )}

            {show("editor") && (
              <LabeledSection label="Editor">
                <EnvironmentRow icon={<LayoutSidebarIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />} label="Editor view" onClick={() => set({ rightOpen: true, rightTab: "explorer" })} />
                <Menu>
                  <EnvironmentRow render={<button type="button" />} icon={<FolderIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />} label="Open in Finder" trailing={<EnvironmentRowChevron />} disabled={!cwd} />
                  <ComposerPickerMenuPopup align="start" side="bottom" sideOffset={6} className="w-44 min-w-44">
                    <MenuGroup>
                      <MenuItem onClick={() => void revealInFinder(cwd)}>
                        <FolderIcon className="size-3.5 text-muted-foreground" /> Reveal in Finder
                      </MenuItem>
                      <MenuItem onClick={() => void openPath(cwd)}>
                        <ArrowUpRightIcon className="size-3.5 text-muted-foreground" /> Open folder
                      </MenuItem>
                      <MenuItem onClick={() => void copyText(cwd)}>
                        <CopyIcon className="size-3.5 text-muted-foreground" /> Copy path
                      </MenuItem>
                    </MenuGroup>
                  </ComposerPickerMenuPopup>
                </Menu>
              </LabeledSection>
            )}

            {show("recap") && (
              <CollapsibleSection label="Recap" open={recapOpen} onToggle={() => setRecapOpen(!recapOpen)}>
                <div className="flex flex-col gap-1.5 pb-1.5">
                  <div className="px-2">
                    {recap ? (
                      <Markdown
                        text={recap.length > 600 ? `${recap.slice(0, 600)}…` : recap}
                        className={cn(MUTED_BODY, "text-muted-foreground/40! [&_strong]:font-medium [&_strong]:text-muted-foreground/40 [&_:not(pre)>code]:!text-muted-foreground/45 [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_pre]:my-2")}
                      />
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        <div className="h-2.5 w-full rounded bg-[var(--color-background-button-secondary-hover)]/45" />
                        <div className="h-2.5 w-4/5 rounded bg-[var(--color-background-button-secondary-hover)]/35" />
                      </div>
                    )}
                  </div>
                </div>
              </CollapsibleSection>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}
