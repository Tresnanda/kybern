import { collaborationThreadRows } from "../../../../packages/kybern-client/src/collaboration"
// Left sidebar: 46px drag-region title bar,
// brand row, primary nav, "Projects" list with nested thread rows, footer
// with Settings and Help.

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { useShallow } from "zustand/react/shallow"

import { ProviderMark } from "@/components/kybern/bits"
import {
  beginThreadPointerDrag,
  consumeThreadPointerDragClick,
} from "@/components/kybern/chatPaneDrag"
import { beginProjectReorder, consumeProjectDragClick } from "@/components/kybern/projectReorder"
import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { DisclosureRegion } from "@/components/kit/DisclosureRegion"
import { SidebarIconButton } from "@/components/kit/SidebarIconButton"
import { ThreadRunningSpinner } from "@/components/kit/ThreadRunningSpinner"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Kbd, KbdGroup } from "@/components/kit/kbd"
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuShortcut, MenuTrigger } from "@/components/kit/menu"
import { SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/kit/sidebar"
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { mod, PROVIDER_LABEL } from "@/lib/format"
import { useAppUpdate } from "@/lib/appUpdate"
import {
  AddPlusIcon,
  AnalyticsIcon,
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  GitPullRequestIcon,
  CircleCheckIcon,
  CircleQuestionIcon,
  RefreshCwIcon,
  ClockIcon,
  FilterIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HandoffIcon,
  CommandIcon,
  InfoIcon,
  LoaderCircleIcon,
  NewThreadIcon,
  PencilIcon,
  PinFilledIcon,
  PinIcon,
  SearchIcon,
  SettingsIcon,
  SquareSplitHorizontal,
  SquareSplitVertical,
  UsersIcon,
  WorktreeIcon,
} from "@/lib/kit/icons"
import { disclosureContentClassName, disclosureShellClassName } from "@/lib/kit/disclosureMotion"
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "@/lib/kit/sidebarRowStyles"
import { pickFolder, platform } from "@/lib/tauri"
import { activeEnvironment } from "@/state/environments"
import { isLaunching } from "@/lib/launch"
import { cn } from "@/lib/utils"
import { IconSwap, TextSwap } from "@/components/kybern/motion"
import { primeMarquee } from "@/lib/kit/marquee"
import { FREE_CHAT_PROJECT_ID, isFreeChatProject, type Project, type ProjectId, type ProviderKind, type Thread, type ThreadActivityState, type ThreadId } from "@/protocol"
import { selectAttentionItems, threadAttentionKind } from "@/state/notifications"
import { newThread } from "@/state/nav"
import { addProject, archiveThread, errorText, loadThread, refreshProviders, removeProject, updateThread } from "@/state/rpc"
import { canSplitPane, findThreadPaneByThreadId, resolveFocusedThreadPane } from "@/state/splitView"
import { DEFAULT_SIDEBAR_FILTER, isFiltering, moveProject, orderProjects, threadMatchesFilter, type SidebarFilter } from "@/state/sidebarOrganize"
import { createProjectThreadsSelector, useStore } from "@/state/store"

import { DeleteCoordinatorDialog } from "./DeleteCoordinatorDialog"
import { EnvironmentSwitcher } from "./EnvironmentSwitcher"
import { NotificationBell } from "./NotificationBell"
import { ProjectPicker } from "./ProjectPicker"
import { SidebarUpdateButton } from "./AppUpdate"

const MAX_PROJECT_THREADS = 8

const HOVER_HIDE_PROJECT =
  "transition-opacity group-hover/project-header:pointer-events-none group-hover/project-header:opacity-0 group-has-[:focus-visible]/project-header:pointer-events-none group-has-[:focus-visible]/project-header:opacity-0"
const HOVER_HIDE_THREAD =
  "transition-opacity group-hover/thread-row:pointer-events-none group-hover/thread-row:opacity-0 group-focus-within/thread-row:pointer-events-none group-focus-within/thread-row:opacity-0"
const REVEAL_TOOLBAR =
  "t-reveal flex items-center gap-1.5 absolute top-1 right-1.5 pointer-events-none opacity-100 md:translate-x-1 md:opacity-0 md:group-hover/project-header:translate-x-0 md:group-hover/project-header:pointer-events-auto md:group-hover/project-header:opacity-100 md:group-has-[:focus-visible]/project-header:pointer-events-auto md:group-has-[:focus-visible]/project-header:opacity-100 md:has-[[data-state=open]]:pointer-events-auto md:has-[[data-state=open]]:opacity-100"
// A filter that hides threads keeps its control in view, so the list never
// looks mysteriously short.
const TOOLBAR_SHOWN = "pointer-events-auto md:translate-x-0 md:pointer-events-auto md:opacity-100"
const NO_ACTIVITY: Record<ThreadId, { state?: ThreadActivityState } | undefined> = {}

/** Save a project's new place in the sidebar. */
function commitProjectMove(id: ProjectId, targetIndex: number, visible: ProjectId[]) {
  const state = useStore.getState()
  const order = orderProjects(Object.values(state.projects), state.projectOrder).map((project) => project.id)
  state.setProjectOrder(moveProject(order, visible, id, targetIndex))
}

/** "Pinned", "Codex", or "Pinned Codex": what the sidebar is showing. */
function filterSummary(filter: SidebarFilter): string {
  const agent = filter.agent ? PROVIDER_LABEL[filter.agent] ?? filter.agent : null
  const threads = filter.threads === "pinned" ? "Pinned" : filter.threads === "working" ? "Working" : null
  return [threads, agent].filter(Boolean).join(" ")
}

function filterEmptyText(filter: SidebarFilter): string {
  const agent = filter.agent ? `${PROVIDER_LABEL[filter.agent] ?? filter.agent} ` : ""
  if (filter.threads === "pinned") return `No pinned ${agent}threads`
  if (filter.threads === "working") return `No ${agent}threads are working`
  return `No ${agent}threads`
}

export function ThreadSidebar() {
  const projects = useStore((s) => s.projects)
  const projectOrder = useStore((s) => s.projectOrder)
  const projectList = useMemo(() => orderProjects(Object.values(projects), projectOrder), [projects, projectOrder])
  const sidebarFilter = useStore((s) => s.sidebarFilter)
  const filtering = isFiltering(sidebarFilter)
  // Activity only matters to the Working filter; skip the subscription otherwise.
  const threadActivity = useStore((s) => (sidebarFilter.threads === "working" ? s.threadActivity : NO_ACTIVITY))
  const set = useStore((s) => s.set)
  const pullsActive = useStore((s) => s.selected.kind === "pulls")
  const selected = useStore((s) => s.selected)
  const mac = platform() === "macos"
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [enterSurface] = useState(() => !isLaunching())
  const connection = useStore((s) => s.connection)
  const threads = useStore((s) => s.threads)
  const freeThreads = useMemo(
    () => Object.values(threads).filter((thread) => isFreeChatProject(thread.project_id) && thread.status !== "archived" && !thread.parent_thread_id).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [threads],
  )
  const freeDraftSelected = selected.kind === "draft" && !selected.draft.projectId
  const hasFreeDraft = useStore((s) => !!s.composerDrafts["free:main"])
  const notifications = useStore((s) => s.notifications)
  const notificationDismissals = useStore((s) => s.notificationDismissals)
  const notificationFilter = useStore((s) => s.notificationFilter)
  // Bell filter: restrict the list to threads that need attention and the
  // projects that contain them.
  const attentionIds = useMemo(() => {
    if (!notificationFilter) return null
    return new Set<ThreadId>(selectAttentionItems({ threads, notifications, notificationDismissals }).map((item) => item.thread.id))
  }, [notificationFilter, threads, notifications, notificationDismissals])
  // Threads the bell and the filter both allow; null when neither is on.
  const shownIds = useMemo(() => {
    if (!attentionIds && !filtering) return null
    const ids = new Set<ThreadId>()
    for (const thread of Object.values(threads)) {
      if (thread.status === "archived") continue
      if (attentionIds && !attentionIds.has(thread.id)) continue
      if (filtering && !threadMatchesFilter(thread, sidebarFilter, threadActivity[thread.id]?.state ?? undefined)) continue
      ids.add(thread.id)
    }
    return ids
  }, [attentionIds, filtering, sidebarFilter, threadActivity, threads])
  const visibleFreeThreads = useMemo(
    () => freeThreads.filter((thread) => !shownIds || shownIds.has(thread.id)),
    [shownIds, freeThreads],
  )
  const recentsCollapsed = useStore((s) => !!s.collapsedProjects[FREE_CHAT_PROJECT_ID])
  const recentsOpen = shownIds ? true : !recentsCollapsed
  const toggleRecents = useStore((s) => s.toggleProject)
  const visibleProjects = useMemo(() => {
    if (!shownIds) return projectList
    const withShown = new Set<ProjectId>()
    for (const id of shownIds) {
      const thread = threads[id]
      if (thread) withShown.add(thread.project_id)
    }
    return projectList.filter((p) => withShown.has(p.id))
  }, [shownIds, projectList, threads])
  const visibleProjectIds = useMemo(() => visibleProjects.map((project) => project.id), [visibleProjects])
  // Agents to filter by: the ones that have threads here, plus the chosen one.
  const threadAgents = useMemo(() => {
    const kinds = new Set<ProviderKind>()
    for (const thread of Object.values(threads)) if (thread.status !== "archived") kinds.add(thread.provider.kind)
    if (sidebarFilter.agent) kinds.add(sidebarFilter.agent)
    return [...kinds].sort((a, b) => (PROVIDER_LABEL[a] ?? a).localeCompare(PROVIDER_LABEL[b] ?? b))
  }, [sidebarFilter.agent, threads])

  const onAddProject = async () => {
    if (connection.state !== "open") { toast("Connect to this environment before adding a project"); return }
    if (!activeEnvironment()?.local) { setProjectPickerOpen(true); return }
    const store = useStore
    const path = await pickFolder()
    if (!path || store !== useStore) return
    try {
      const p = await addProject(path)
      store.getState().selectDraft(p.id)
    } catch (e) {
      toast.error("Unable to add project", { description: errorText(e) })
    }
  }

  return (
    <>
      <SidebarHeader
        data-tauri-drag-region="deep"
        className={cn(
          "drag-region flex h-[46px] flex-row items-center gap-1 !pt-0 !pb-0 pe-3 font-system-ui",
          mac ? "desktop-top-bar-traffic-light-gutter" : "ps-4",
        )}
      >
        <div className="hidden h-7 w-[84px] md:block" aria-hidden="true" />
      </SidebarHeader>

      <SidebarContent className="gap-0 font-system-ui">
        <div className="flex items-center gap-1 pt-0 pb-1 pr-2.5 pl-1.5">
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="App menu"
                  className="flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 outline-hidden transition-colors hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-accent-foreground)] focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                />
              }
            >
              <span className="font-display min-w-0 truncate text-[17px] text-foreground">kybern</span>
              <DisclosureChevron open className="text-muted-foreground/70" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="start" side="bottom" className="min-w-56">
              <MenuGroup>
                <MenuItem onClick={onAddProject}>
                  <FolderOpenIcon /> Add project
                </MenuItem>
                <MenuItem onClick={() => set({ settingsOpen: true, settingsTab: "general" })}>
                  <SettingsIcon /> Settings
                </MenuItem>
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>
          <div className="ml-auto flex items-center gap-1.5">
            <SidebarIconButton icon={SearchIcon} label="Search" glyph="leading" size="header" tooltip={`Search (${mod}K)`} tooltipSide="bottom" className="text-foreground/80 hover:text-foreground" onClick={() => setTimeout(() => set({ paletteOpen: true }), 0)} />
            <NotificationBell />
          </div>
        </div>

        <EnvironmentSwitcher />
        <div className={enterSurface ? "sidebar-surface-enter" : undefined}>
          <SidebarGroup className="px-1.5 pt-1 pb-1.5">
            <SidebarMenu className="gap-0.5">
              <PrimaryAction
                icon={<NewThreadIcon className="size-3.5 shrink-0" />}
                label="New chat"
                shortcut={["⌘", "N"]}
                active={freeDraftSelected}
                trailing={hasFreeDraft ? <span data-composer-draft="free-chat" role="img" aria-label="Unsent free chat draft" title="Unsent free chat draft" className="inline-flex size-4 items-center justify-center text-muted-foreground/65"><PencilIcon className="size-3" /></span> : undefined}
                onClick={() => newThread()}
              />
              <PrimaryAction icon={<ClockIcon className="size-3.5 shrink-0" />} label="Resume session" onClick={() => set({ sessionsOpen: true, sessionsProjectId: selected.kind === "draft" ? selected.draft.projectId ?? null : selected.kind === "thread" ? (isFreeChatProject(useStore.getState().threads[selected.id]?.project_id ?? "") ? null : useStore.getState().threads[selected.id]?.project_id ?? null) : null })} />
              <PrimaryAction icon={<GitPullRequestIcon className="size-3.5 shrink-0" />} label="Pull requests" active={pullsActive} onClick={() => useStore.getState().selectPulls()} />
              <PrimaryAction icon={<AnalyticsIcon className="size-3.5 shrink-0" />} label="Usage" onClick={() => set({ settingsOpen: true, settingsTab: "usage" })} />
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup className="px-1.5 py-1.5">
            <div className="group/project-header relative my-1">
              <div className={cn("flex h-7 w-full min-w-0 items-center gap-1.5 px-2 py-0.5 pr-[4.75rem]", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>
                <span className="shrink-0">Projects</span>
                {filtering && (
                  <>
                    <span aria-hidden="true" className="shrink-0">·</span>
                    <span className="t-pop min-w-0 truncate text-foreground/70" title={`Showing ${filterSummary(sidebarFilter).toLowerCase()} threads`}>
                      {filterSummary(sidebarFilter)}
                    </span>
                  </>
                )}
              </div>
              <div className={cn(REVEAL_TOOLBAR, filtering && TOOLBAR_SHOWN)}>
                <SidebarFilterMenu filter={sidebarFilter} agents={threadAgents} />
                <SidebarIconButton icon={AddPlusIcon} label="Add project" size="md" tooltip="Add project" onClick={onAddProject} />
              </div>
            </div>
            {projectList.length === 0 ? (
              <div className="px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">No projects yet. Add a folder to see its threads here.</div>
            ) : shownIds && shownIds.size === 0 && attentionIds && !filtering ? (
              <div className="px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">You're all caught up. No threads need attention.</div>
            ) : filtering && visibleProjects.length === 0 ? (
              <div className="flex flex-wrap items-baseline gap-x-1.5 px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/60">
                <span>{filterEmptyText(sidebarFilter)}{visibleFreeThreads.length > 0 ? " in projects" : ""}.</span>
                <button
                  type="button"
                  onClick={() => useStore.getState().setSidebarFilter(DEFAULT_SIDEBAR_FILTER)}
                  className="cursor-pointer rounded-sm text-foreground/85 underline decoration-foreground/25 underline-offset-2 outline-hidden transition-colors hover:text-foreground hover:decoration-foreground/60 focus-visible:ring-1 focus-visible:ring-ring"
                >
                  Show all threads
                </button>
              </div>
            ) : (
              <SidebarMenu className="gap-3">
                {visibleProjects.map((p, index) => (
                  <ProjectItem
                    key={p.id}
                    project={p}
                    filterThreadIds={shownIds ?? undefined}
                    onMove={visibleProjects.length > 1 ? (offset) => commitProjectMove(p.id, index + offset, visibleProjectIds) : undefined}
                    canMoveUp={index > 0}
                    canMoveDown={index < visibleProjects.length - 1}
                  />
                ))}
              </SidebarMenu>
            )}
          </SidebarGroup>

          {(visibleFreeThreads.length > 0 || (!attentionIds && freeDraftSelected)) && (
            <SidebarGroup className="px-1.5 py-1.5">
              <button
                type="button"
                aria-controls="sidebar-recents"
                aria-expanded={recentsOpen}
                aria-label={`${recentsOpen ? "Collapse" : "Expand"} Recents`}
                data-recents-disclosure
                onClick={() => toggleRecents(FREE_CHAT_PROJECT_ID)}
                className={cn(
                  "flex h-7 w-full cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-start outline-hidden transition-[color,background-color,scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-accent-foreground)] focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100",
                  SIDEBAR_SECTION_LABEL_CLASS_NAME,
                )}
              >
                <span>Recents</span>
                <DisclosureChevron open={recentsOpen} className="size-3 text-muted-foreground/65" />
              </button>
              <DisclosureRegion open={recentsOpen} className="pt-0.5">
                <SidebarMenu id="sidebar-recents" className="gap-0.5">
                  {visibleFreeThreads
                    .slice(0, MAX_PROJECT_THREADS)
                    .map((thread) => <ThreadRow key={thread.id} thread={thread} nested={false} />)}
                </SidebarMenu>
              </DisclosureRegion>
            </SidebarGroup>
          )}
        </div>
      </SidebarContent>

      <ProjectPicker open={projectPickerOpen} onOpenChange={setProjectPickerOpen} />
      <SidebarFooter className="gap-2 border-t border-sidebar-border p-2 font-system-ui">
        <SidebarMenu>
          <SidebarUpdateButton />
          <SidebarMenuItem>
            <div className="flex items-center gap-2">
              <SidebarMenuButton
                size="sm"
                className={cn(SIDEBAR_HEADER_ROW_CLASS_NAME, SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME, "flex-1")}
                onClick={() => set({ settingsOpen: true, settingsTab: "general" })}
              >
                <span className="relative inline-flex size-4 shrink-0 items-center justify-center text-foreground/95">
                  <SettingsIcon className="size-[15px] shrink-0" />
                </span>
                <span>Settings</span>
              </SidebarMenuButton>
              <HelpMenu />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  )
}

function PrimaryAction({ icon, label, shortcut, trailing, onClick, active }: { icon: React.ReactNode; label: string; shortcut?: string[]; trailing?: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        isActive={active}
        onClick={onClick}
        className={cn(
          "group/sidebar-primary-action",
          SIDEBAR_HEADER_ROW_CLASS_NAME,
          active ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
        )}
      >
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center text-inherit">{icon}</span>
        <span className="truncate">{label}</span>
        {trailing && <span className={cn("ml-auto", shortcut && "group-hover/sidebar-primary-action:hidden group-focus-visible/sidebar-primary-action:hidden")}>{trailing}</span>}
        {shortcut && (
          <span className="ml-auto opacity-0 transition-opacity group-hover/sidebar-primary-action:opacity-100 group-focus-visible/sidebar-primary-action:opacity-100">
            <KbdGroup>
              {shortcut.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </KbdGroup>
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function SidebarFilterMenu({ filter, agents }: { filter: SidebarFilter; agents: ProviderKind[] }) {
  const setFilter = useStore((s) => s.setSidebarFilter)
  const active = isFiltering(filter)
  const summary = filterSummary(filter)
  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={FilterIcon}
        label={active ? `Filter threads, showing ${summary.toLowerCase()}` : "Filter threads"}
        tooltip="Filter threads"
        size="md"
        aria-pressed={active}
        className={active ? "bg-[var(--sidebar-accent-active)] text-foreground" : undefined}
      />
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-48">
        <MenuGroup>
          <MenuGroupLabel>Show</MenuGroupLabel>
          <MenuRadioGroup value={filter.threads} onValueChange={(threads) => setFilter({ threads: threads as SidebarFilter["threads"] })}>
            <MenuRadioItem value="all" closeOnClick>All threads</MenuRadioItem>
            <MenuRadioItem value="pinned" closeOnClick>Pinned</MenuRadioItem>
            <MenuRadioItem value="working" closeOnClick>Working</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {agents.length > 1 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Agent</MenuGroupLabel>
              <MenuRadioGroup value={filter.agent ?? ""} onValueChange={(agent) => setFilter({ agent: (agent as ProviderKind) || null })}>
                <MenuRadioItem value="" closeOnClick>All agents</MenuRadioItem>
                {agents.map((kind) => (
                  <MenuRadioItem key={kind} value={kind} closeOnClick>
                    {PROVIDER_LABEL[kind] ?? kind}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        )}
        {active && (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => setFilter(DEFAULT_SIDEBAR_FILTER)}>Clear filters</MenuItem>
          </>
        )}
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

/** Trailing detail in an action menu row, styled like a shortcut hint. */
function MenuDetail(props: React.ComponentProps<"span">) {
  return <span data-slot="menu-detail" className="font-medium text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/72" {...props} />
}

type AgentCheck = { state: "idle" } | { state: "checking" } | { state: "done"; ready: number }

/**
 * Footer help menu. Reloading agents reports its result in place, so the menu
 * stays open while it checks and the answer appears where it was asked for.
 */
function HelpMenu() {
  const set = useStore((s) => s.set)
  const version = useAppUpdate((s) => s.appVersion)
  const [check, setCheck] = useState<AgentCheck>({ state: "idle" })
  const reloadAgents = async () => {
    if (check.state === "checking") return
    setCheck({ state: "checking" })
    try {
      const refreshed = await refreshProviders()
      setCheck({ state: "done", ready: refreshed.filter((p) => p.available).length })
    } catch (e) {
      setCheck({ state: "idle" })
      toast.error("Unable to reload agents", { description: errorText(e) })
    }
  }
  return (
    <Menu onOpenChange={(open) => !open && check.state === "done" && setCheck({ state: "idle" })}>
      <SidebarIconButton render={<MenuTrigger />} icon={CircleQuestionIcon} iconClassName="size-[15px] shrink-0" label="Help and agents" tooltip="Help and agents" size="md" />
      <ComposerPickerMenuPopup align="end" side="top" className="action-menu">
        <MenuGroup>
          <MenuItem onClick={() => set({ paletteOpen: true })}>
            <CommandIcon /> Commands and shortcuts
            <MenuShortcut>{mod}K</MenuShortcut>
          </MenuItem>
          <MenuItem onClick={() => set({ settingsOpen: true, settingsTab: "about" })}>
            <InfoIcon /> About kybern
            {version && <MenuDetail>{version}</MenuDetail>}
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuItem closeOnClick={false} onClick={() => void reloadAgents()} aria-busy={check.state === "checking"}>
            {/* Sized like the menu's plain icons so every label starts on one edge. */}
            <IconSwap
              active={check.state === "idle" ? "a" : "b"}
              className="size-[var(--picker-option-icon-size)] shrink-0 opacity-80"
              a={<RefreshCwIcon className="size-full" />}
              b={check.state === "checking" ? <LoaderCircleIcon className="size-full animate-spin" /> : <CircleCheckIcon className="size-full" />}
            />
            Reload agents
            <MenuDetail aria-live="polite">
              {check.state === "checking" ? "Checking…" : check.state === "done" ? (check.ready === 1 ? "1 ready" : `${check.ready} ready`) : ""}
            </MenuDetail>
          </MenuItem>
          <MenuItem onClick={() => set({ settingsOpen: true, settingsTab: "agents" })}>
            <SettingsIcon /> Agent settings
          </MenuItem>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

function ProjectItem({
  project,
  filterThreadIds,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  project: Project
  filterThreadIds?: Set<ThreadId>
  /** Move this project by one place among the listed projects. */
  onMove?: (offset: -1 | 1) => void
  canMoveUp?: boolean
  canMoveDown?: boolean
}) {
  const selectThreads = useMemo(() => createProjectThreadsSelector(project.id), [project.id])
  const threads = useStore(useShallow(selectThreads))
  const filtering = !!filterThreadIds
  const collapsed = useStore((s) => !!s.collapsedProjects[project.id])
  const toggle = useStore((s) => s.toggleProject)
  const selected = useStore((s) => s.selected)
  const hasNewThreadDraft = useStore((s) => Object.keys(s.composerDrafts).some((key) => key.startsWith(`project:${project.id}:`)))
  const activityState = useStore((s): ThreadActivityState | undefined => {
    const projectThreads = selectThreads(s)
    if (projectThreads.some((thread) => s.threadActivity[thread.id]?.state === "working")) return "working"
    if (projectThreads.some((thread) => s.threadActivity[thread.id]?.state === "monitoring")) return "monitoring"
    return undefined
  })
  const [showAll, setShowAll] = useState(false)
  // While the bell filter is on, force the project open and skip the row cap.
  const open = filtering ? true : !collapsed
  const isDraftHere = selected.kind === "draft" && selected.draft.projectId === project.id
  const running = threads.some((t) => t.status === "running")
  const waiting = threads.some((t) => t.status === "awaiting-approval")
  // Archived coordinators are omitted from the normal project selector, but
  // remain valid persistent chats and should still be offered as existing.
  const coordinator = useStore((state) => {
    for (const thread of Object.values(state.threads)) {
      if (thread.coordinator_project_id === project.id) return thread
    }
    return undefined
  })
  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({})
  const orderedRows = useMemo(() => {
    if (filterThreadIds) {
      const filtered = threads.filter((thread) => filterThreadIds.has(thread.id))
      return collaborationThreadRows(filtered, expandedThreads, selected.kind === "thread" ? selected.id : undefined)
    }
    const ordered = coordinator ? [coordinator, ...threads.filter(thread => thread.id !== coordinator.id)] : threads
    return collaborationThreadRows(ordered, expandedThreads, selected.kind === "thread" ? selected.id : undefined)
  }, [filterThreadIds, coordinator, threads, expandedThreads, selected])
  const visible = showAll || filtering ? orderedRows : orderedRows.slice(0, MAX_PROJECT_THREADS)

  return (
    <SidebarMenuItem className="rounded-md" data-project-id={project.id}>
      <div className="group/collapsible">
        <ContextMenu>
          <ContextMenuTrigger render={<div className="group/project-header relative" />}>
            <SidebarMenuButton
              size="sm"
              onPointerDown={onMove ? (event) => beginProjectReorder({ event, id: project.id, onDrop: commitProjectMove }) : undefined}
              onClick={() => {
                if (consumeProjectDragClick(project.id)) return
                if (isDraftHere) toggle(project.id)
                else useStore.getState().selectDraft(project.id)
              }}
              className={cn(
                SIDEBAR_HEADER_ROW_CLASS_NAME,
                "cursor-pointer hover:bg-[var(--sidebar-accent)] group-hover/project-header:bg-[var(--sidebar-accent)] group-hover/project-header:text-[var(--sidebar-accent-foreground)]",
                isDraftHere && SIDEBAR_ROW_ACTIVE_CLASS_NAME,
              )}
            >
              <span className={cn("relative inline-flex size-4 shrink-0 items-center justify-center text-foreground/95", HOVER_HIDE_PROJECT)}>
                {open ? <FolderOpenIcon className="size-4" /> : <FolderIcon className="size-4" />}
              </span>
              <span
                role="button"
                tabIndex={-1}
                aria-label={open ? "Collapse" : "Expand"}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!consumeProjectDragClick(project.id)) toggle(project.id)
                }}
                className="sidebar-icon-button pointer-events-none absolute top-1/2 left-2 z-20 inline-flex size-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-foreground/95 opacity-0 transition-opacity hover:text-foreground md:group-hover/project-header:pointer-events-auto md:group-hover/project-header:opacity-100 md:group-has-[:focus-visible]/project-header:pointer-events-auto md:group-has-[:focus-visible]/project-header:opacity-100"
              >
                <DisclosureChevron open={open} className="text-foreground/80" />
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden transition-[padding] duration-150 ease-out group-hover/project-header:pr-[4.75rem] group-has-[:focus-visible]/project-header:pr-[4.75rem]">
                <span className="truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground/95">{project.name}</span>
                {hasNewThreadDraft && (
                  <span data-composer-draft="new-thread" role="img" aria-label="Unsent new thread draft" title="Unsent new thread draft" className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/65">
                    <PencilIcon className="size-3" />
                  </span>
                )}
              </div>
              {!open && (running || waiting || activityState) && (
                <span className={cn("ml-auto flex min-w-[1.625rem] shrink-0 items-center justify-end gap-2 self-center", HOVER_HIDE_PROJECT)}>
                  <StatusGlyph status={waiting ? "awaiting-approval" : running ? "running" : "idle"} activity={activityState} />
                </span>
              )}
            </SidebarMenuButton>
            <div className={REVEAL_TOOLBAR}>
              <SidebarIconButton icon={NewThreadIcon} label="New thread" size="md" tooltip="New thread" onClick={() => useStore.getState().selectDraft(project.id)} />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48 min-w-48">
            <ContextMenuGroup>
              <ContextMenuItem onClick={() => useStore.getState().selectDraft(project.id)}>
                <NewThreadIcon /> New thread
              </ContextMenuItem>
              <ContextMenuItem onClick={() => useStore.getState().set({ sessionsOpen: true, sessionsProjectId: project.id })}>
                <ClockIcon /> Resume session
              </ContextMenuItem>
            </ContextMenuGroup>
            {onMove && (
              <>
                <ContextMenuSeparator />
                <ContextMenuGroup>
                  <ContextMenuItem disabled={!canMoveUp} onClick={() => onMove(-1)}>
                    <ArrowUpIcon /> Move up
                  </ContextMenuItem>
                  <ContextMenuItem disabled={!canMoveDown} onClick={() => onMove(1)}>
                    <ArrowDownIcon /> Move down
                  </ContextMenuItem>
                </ContextMenuGroup>
              </>
            )}
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem variant="destructive" onClick={() => removeProject(project.id).catch((e) => toast.error("Unable to remove project", { description: errorText(e) }))}>
                <ArchiveIcon /> Remove project
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>

        <div className={cn(disclosureShellClassName(open), "pt-0.5")}>
          <div className="min-h-0 overflow-hidden">
            <ul className={cn("mx-0 my-0 flex w-full min-w-0 translate-x-0 flex-col border-l-0 px-0 py-0", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME, disclosureContentClassName(open))}>
              {!coordinator && !filtering && <CreateCoordinatorRow project={project} />}
              {visible.map(({ thread, depth, childCount, open: childrenOpen }) => (
                <ThreadRow key={thread.id} thread={thread} depth={depth} childCount={childCount} childrenOpen={childrenOpen} onToggleChildren={() => setExpandedThreads(value => ({ ...value, [thread.id]: !childrenOpen }))} />
              ))}
              {!filtering && orderedRows.length > MAX_PROJECT_THREADS && (
                <li>
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="h-7 w-full cursor-pointer justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/79 hover:text-foreground"
                  >
                    {showAll ? "Show less" : `Show ${orderedRows.length - MAX_PROJECT_THREADS} more`}
                  </button>
                </li>
              )}
              {threads.length === 0 && open && <li className="px-2 py-1 pl-8 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">No threads yet</li>}
            </ul>
          </div>
        </div>
      </div>
    </SidebarMenuItem>
  )
}

function CreateCoordinatorRow({ project }: { project: Project }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          const store = useStore.getState()
          store.selectDraft(project.id)
          store.set({ selected: { kind: "draft", draft: { projectId: project.id, purpose: "coordinator" } } })
        }}
        className={cn(SIDEBAR_THREAD_ROW_BASE_CLASS_NAME, SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME, "flex w-full items-center gap-2 rounded-md pr-2 pl-8 text-start")}
      >
        <UsersIcon className="size-3 shrink-0" />
        <span className="truncate">Create coordinator</span>
      </button>
    </li>
  )
}

function StatusGlyph({ status, activity, unread }: { status: Thread["status"]; activity?: ThreadActivityState; unread?: boolean }) {
  if (status === "awaiting-approval") return <span role="img" aria-label="Pending approval" className="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-300/90" />
  if (status === "running" || activity === "working") {
    return (
      <span role="img" aria-label="Working" className="inline-flex shrink-0">
        <ThreadRunningSpinner />
      </span>
    )
  }
  if (status === "failed") return <span role="img" aria-label="Failed" className="size-1.5 shrink-0 rounded-full bg-destructive" />
  if (activity === "monitoring") {
    return (
      <span role="img" aria-label="Monitoring" title="Monitoring" className="inline-flex shrink-0 text-muted-foreground/75">
        <ClockIcon className="size-3" />
      </span>
    )
  }
  if (unread) return <span role="img" aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-[var(--color-text-accent)]" />
  return null
}

function ThreadRow({ thread, depth = 0, childCount = 0, childrenOpen = false, onToggleChildren, nested = true }: { thread: Thread; depth?: number; childCount?: number; childrenOpen?: boolean; onToggleChildren?: () => void; nested?: boolean }) {
  const selected = useStore((s) => s.selected.kind === "thread" && s.selected.id === thread.id)
  const splitView = useStore((s) => s.splitView)
  const activity = useStore((s) => s.threadActivity[thread.id]?.state ?? undefined)
  const unread = useStore((s) => threadAttentionKind(thread, s.notifications[thread.id], s.notificationDismissals[thread.id]) === "done")
  const hasDraft = useStore((s) => !!s.composerDrafts[`thread:${thread.id}`])
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [title, setTitle] = useState(thread.title)
  // Decided once on mount: a row for a thread created just now rises in.
  const [fresh] = useState(() => Date.now() - Date.parse(thread.updated_at) < 3000)

  const open = () => {
    useStore.getState().selectThread(thread.id)
    void loadThread(thread.id)
  }
  const commitRename = () => {
    setRenaming(false)
    const next = title.trim()
    if (next && next !== thread.title) updateThread(thread.id, { title: next }).catch((e) => toast.error("Unable to rename", { description: errorText(e) }))
    else setTitle(thread.title)
  }
  const hasGlyph = thread.status !== "idle" || !!activity || unread
  const inSplit = !!splitView && !!findThreadPaneByThreadId(splitView.root, thread.id)
  const focusedPane = splitView ? resolveFocusedThreadPane(splitView) : null
  const canOpenRight =
    !inSplit && (!splitView || !focusedPane?.threadId || canSplitPane(splitView.root, focusedPane.id, "horizontal"))
  const canOpenBelow =
    !inSplit && (!splitView || !focusedPane?.threadId || canSplitPane(splitView.root, focusedPane.id, "vertical"))
  const openInSplit = (direction: "horizontal" | "vertical") => {
    if (useStore.getState().openThreadInSplit(thread.id, direction)) void loadThread(thread.id)
  }

  return (
    <>
    <ContextMenu>
      <ContextMenuTrigger render={<li className="group/menu-sub-item group/thread-row relative w-full" />}>
        {Array.from({ length: depth }, (_, level) => (
          <span key={level} aria-hidden="true"
            className="pointer-events-none absolute -top-0.5 bottom-0 z-10 w-px bg-sidebar-foreground/15 contrast-more:bg-sidebar-foreground/40"
            style={{ insetInlineStart: 17 + level * 20 }} />
        ))}
        {childCount > 0 && <button type="button"
          aria-label={`${childrenOpen ? "Collapse" : "Expand"} ${childCount} helpers for ${thread.title || "Untitled"}`}
          aria-expanded={childrenOpen}
          onClick={onToggleChildren}
          className="absolute z-20 top-1/2 -translate-y-1/2 inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          style={{ insetInlineStart: 5 + depth * 20 }}>
          <DisclosureChevron open={childrenOpen} />
        </button>}
        <div
          role="button"
          tabIndex={0}
          onClick={(event) => {
            if (consumeThreadPointerDragClick(thread.id)) {
              event.preventDefault()
              return
            }
            open()
          }}
          onKeyDown={(e) => e.key === "Enter" && open()}
          onPointerDown={(event) => {
            if (!renaming) beginThreadPointerDrag(event, thread.id)
          }}
          data-active={selected || undefined}
          data-marquee-host
          style={{ paddingInlineStart: nested ? 32 + depth * 20 : 8 }}
          onPointerEnter={(event) => primeMarquee(event.currentTarget)}
          onFocus={(event) => primeMarquee(event.currentTarget)}
          aria-current={selected ? "page" : undefined}
          className={cn(
            SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
            fresh && "t-row-enter",
            "flex min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md text-sidebar-foreground outline-hidden [-webkit-user-drag:none]",
            "transition-[padding] duration-150 ease-out group-hover/thread-row:pr-[4.75rem] group-focus-within/thread-row:pr-[4.75rem]",
            hasGlyph || thread.pinned ? "pr-[1.75rem]" : "pr-2",
            selected ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME, inSplit && "bg-sidebar-accent/55"),
          )}
        >
          <span className="relative inline-flex size-3 shrink-0 items-center justify-center">
            <ProviderMark kind={thread.provider.kind} size={12} className="size-3" />
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            {renaming ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename()
                  if (e.key === "Escape") {
                    setTitle(thread.title)
                    setRenaming(false)
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-full rounded bg-background px-1 text-[length:var(--app-font-size-ui,12px)] outline-none ring-1 ring-ring"
              />
            ) : (
              <TextSwap text={thread.coordinator_project_id ? "Open coordinator" : thread.title || "Untitled"} className={cn("t-marquee flex-1 text-[length:var(--app-font-size-ui,12px)] leading-5", selected ? "text-foreground" : "text-foreground/95")} />
            )}
            {hasDraft && !renaming && (
              <span data-composer-draft="thread" role="img" aria-label="Unsent draft" title="Unsent draft" className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/65">
                <PencilIcon className="size-3" />
              </span>
            )}
            {thread.status === "awaiting-approval" && <span className="t-pop shrink-0 text-[10px] font-medium text-amber-600 dark:text-amber-300/90">Pending</span>}
          </div>
          {thread.worktree && (
            <span className="inline-flex shrink-0 items-center text-muted-foreground/55">
              <WorktreeIcon className="size-3 shrink-0" />
            </span>
          )}
        </div>
        <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center">
          <div className="relative flex shrink-0 items-center justify-end gap-[3px]">
            {(hasGlyph || thread.pinned) && (
              <span className={cn("flex w-[15px] shrink-0 items-center justify-center leading-none text-muted-foreground/34", HOVER_HIDE_THREAD)}>
                {hasGlyph ? <StatusGlyph status={thread.status} activity={activity} unread={unread} /> : <PinFilledIcon className="size-3 shrink-0" />}
              </span>
            )}
            <div className="t-reveal pointer-events-none absolute inset-y-0 right-0 my-auto inline-flex translate-x-1 items-center opacity-0 group-hover/thread-row:translate-x-0 group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100 group-focus-within/thread-row:translate-x-0 group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100">
              <div className="pointer-events-auto inline-flex items-center gap-2">
                <SidebarIconButton
                  icon={thread.pinned ? PinFilledIcon : PinIcon}
                  label={thread.pinned ? "Unpin" : "Pin"}
                  size="md"
                  iconClassName="size-[15px] shrink-0"
                  className="text-muted-foreground/34 hover:text-foreground/82"
                  onClick={(e) => {
                    e.stopPropagation()
                    void updateThread(thread.id, { pinned: !thread.pinned })
                  }}
                />
                <SidebarIconButton
                  icon={ArchiveIcon}
                  label="Archive"
                  size="md"
                  iconClassName="size-[15px] shrink-0"
                  className="text-muted-foreground/42 hover:text-foreground/89"
                  onClick={(e) => {
                    e.stopPropagation()
                    archiveThread(thread.id).catch((err) => toast.error("Unable to archive", { description: errorText(err) }))
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48 min-w-48">
        <ContextMenuGroup>
          <ContextMenuItem
            onClick={() => {
              setTitle(thread.title)
              setRenaming(true)
            }}
          >
            <PencilIcon /> Rename thread
          </ContextMenuItem>
          <ContextMenuItem onClick={() => updateThread(thread.id, { pinned: !thread.pinned })}>
            {thread.pinned ? <PinFilledIcon /> : <PinIcon />}
            {thread.pinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => useStore.getState().set({ handoffThread: thread.id })}>
            <HandoffIcon /> Hand off to another agent
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem disabled={!canOpenRight} onClick={() => openInSplit("horizontal")}>
            <SquareSplitVertical /> Open to the right
          </ContextMenuItem>
          <ContextMenuItem disabled={!canOpenBelow} onClick={() => openInSplit("vertical")}>
            <SquareSplitHorizontal /> Open below
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          {thread.worktree && (
            <ContextMenuItem disabled>
              <GitBranchIcon /> {thread.worktree.branch}
            </ContextMenuItem>
          )}
          {thread.coordinator_project_id && (
            <ContextMenuItem variant="destructive" onClick={() => setDeleting(true)}>
              <ArchiveIcon /> Delete coordinator
            </ContextMenuItem>
          )}
          {!thread.coordinator_project_id && (
            <ContextMenuItem variant="destructive" onClick={() => archiveThread(thread.id).catch((e) => toast.error("Unable to archive", { description: errorText(e) }))}>
              <ArchiveIcon /> Archive
            </ContextMenuItem>
          )}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
    {deleting && <DeleteCoordinatorDialog thread={thread} onClose={() => setDeleting(false)} />}
    </>
  )
}
