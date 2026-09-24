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
import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { DisclosureRegion } from "@/components/kit/DisclosureRegion"
import { SidebarIconButton } from "@/components/kit/SidebarIconButton"
import { ThreadRunningSpinner } from "@/components/kit/ThreadRunningSpinner"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Kbd, KbdGroup } from "@/components/kit/kbd"
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from "@/components/kit/menu"
import { SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/kit/sidebar"
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { mod } from "@/lib/format"
import {
  AddPlusIcon,
  AnalyticsIcon,
  ArchiveIcon,
  GitPullRequestIcon,
  BookIcon,
  RefreshCwIcon,
  ClockIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HandoffIcon,
  KeyboardIcon,
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
import { TextSwap } from "@/components/kybern/motion"
import { primeMarquee } from "@/lib/kit/marquee"
import { FREE_CHAT_PROJECT_ID, isFreeChatProject, type Project, type ProjectId, type Thread, type ThreadActivityState, type ThreadId } from "@/protocol"
import { selectAttentionItems, threadAttentionKind } from "@/state/notifications"
import { newThread } from "@/state/nav"
import { addProject, archiveThread, errorText, loadThread, refreshProviders, removeProject, updateThread } from "@/state/rpc"
import { canSplitPane, findThreadPaneByThreadId, resolveFocusedThreadPane } from "@/state/splitView"
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

export function ThreadSidebar() {
  const projects = useStore((s) => s.projects)
  const projectList = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects])
  const set = useStore((s) => s.set)
  const pullsActive = useStore((s) => s.selected.kind === "pulls")
  const selected = useStore((s) => s.selected)
  const mac = platform() === "macos"
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [enterSurface] = useState(() => !isLaunching())
  const [reloadingAgents, setReloadingAgents] = useState(false)
  // Re-probe every agent on this Mac (versions, availability, model catalogs)
  // without waiting for a reconnect. Picks up CLIs and models installed mid-session.
  const reloadAgents = async () => {
    if (reloadingAgents) return
    setReloadingAgents(true)
    try {
      const refreshed = await refreshProviders()
      const available = refreshed.filter((p) => p.available).length
      toast.success(available === 1 ? "1 agent ready" : `${available} agents ready`)
    } catch (e) {
      toast.error("Unable to reload agents", { description: errorText(e) })
    } finally {
      setReloadingAgents(false)
    }
  }
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
  const visibleFreeThreads = useMemo(
    () => freeThreads.filter((thread) => !attentionIds || attentionIds.has(thread.id)),
    [attentionIds, freeThreads],
  )
  const recentsCollapsed = useStore((s) => !!s.collapsedProjects[FREE_CHAT_PROJECT_ID])
  const recentsOpen = attentionIds ? true : !recentsCollapsed
  const toggleRecents = useStore((s) => s.toggleProject)
  const visibleProjects = useMemo(() => {
    if (!attentionIds) return projectList
    const withAttention = new Set<ProjectId>()
    for (const id of attentionIds) {
      const thread = threads[id]
      if (thread) withAttention.add(thread.project_id)
    }
    return projectList.filter((p) => withAttention.has(p.id))
  }, [attentionIds, projectList, threads])

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
              <div className={cn("flex h-7 w-full min-w-0 items-center px-2 py-0.5 pr-[4.75rem]", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>
                <span className="truncate">Projects</span>
              </div>
              <div className={REVEAL_TOOLBAR}>
                <SidebarIconButton icon={AddPlusIcon} label="Add project" size="md" tooltip="Add project" onClick={onAddProject} />
              </div>
            </div>
            {attentionIds && attentionIds.size === 0 ? (
              <div className="px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">You're all caught up. No threads need attention.</div>
            ) : projectList.length === 0 ? (
              <div className="px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">No projects yet. Add a folder to see its threads here.</div>
            ) : (
              <SidebarMenu className="gap-3">
                {visibleProjects.map((p) => (
                  <ProjectItem key={p.id} project={p} filterThreadIds={attentionIds ?? undefined} />
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
              <Menu>
                <SidebarIconButton
                  render={<MenuTrigger />}
                  icon={RefreshCwIcon}
                  iconClassName={cn("size-[15px] shrink-0", reloadingAgents && "animate-spin")}
                  label="Reload agents"
                  tooltip="Reload agents"
                  size="md"
                />
                <ComposerPickerMenuPopup align="end" side="top" className="w-64 min-w-64">
                  <MenuGroup>
                    <MenuGroupLabel>Agents</MenuGroupLabel>
                    <MenuItem onClick={() => void reloadAgents()} disabled={reloadingAgents}>
                      <RefreshCwIcon /> {reloadingAgents ? "Reloading…" : "Reload models"}
                    </MenuItem>
                    <MenuItem onClick={() => set({ settingsOpen: true, settingsTab: "agents" })}>
                      <SettingsIcon /> Agents on this Mac
                    </MenuItem>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>kybern</MenuGroupLabel>
                    <MenuItem onClick={() => set({ settingsOpen: true, settingsTab: "about" })}>
                      <BookIcon /> About
                    </MenuItem>
                    <MenuItem onClick={() => set({ paletteOpen: true })}>
                      <KeyboardIcon /> Keyboard shortcuts
                    </MenuItem>
                  </MenuGroup>
                </ComposerPickerMenuPopup>
              </Menu>
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

function ProjectItem({ project, filterThreadIds }: { project: Project; filterThreadIds?: Set<ThreadId> }) {
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
    <SidebarMenuItem className="rounded-md">
      <div className="group/collapsible">
        <ContextMenu>
          <ContextMenuTrigger render={<div className="group/project-header relative" />}>
            <SidebarMenuButton
              size="sm"
              onClick={() => (isDraftHere ? toggle(project.id) : useStore.getState().selectDraft(project.id))}
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
                  toggle(project.id)
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
