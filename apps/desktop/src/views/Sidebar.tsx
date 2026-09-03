// Left sidebar, built to Synara's ThreadSidebar: 46px drag-region title bar,
// brand row, primary nav, "Projects" list with nested thread rows, footer
// with Settings and Help.

import { useMemo, useState } from "react"
import { HiOutlineArchiveBox } from "react-icons/hi2"
import { IoIosGitCompare } from "react-icons/io"
import { toast } from "sonner"
import { useShallow } from "zustand/react/shallow"

import { ProviderMark } from "@/components/kybern/bits"
import { DisclosureChevron } from "@/components/synara/DisclosureChevron"
import { SidebarIconButton } from "@/components/synara/SidebarIconButton"
import { ThreadRunningSpinner } from "@/components/synara/ThreadRunningSpinner"
import { ComposerPickerMenuPopup } from "@/components/synara/chat/ComposerPickerMenuPopup"
import { Kbd, KbdGroup } from "@/components/synara/kbd"
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from "@/components/synara/menu"
import { SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/synara/sidebar"
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { mod } from "@/lib/format"
import { CentralIcon } from "@/lib/synara/central-icons"
import {
  AddPlusIcon,
  ArchiveIcon,
  BellIcon,
  BookIcon,
  CircleQuestionIcon,
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
  WorktreeIcon,
} from "@/lib/synara/icons"
import { disclosureContentClassName, disclosureShellClassName } from "@/lib/synara/disclosureMotion"
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "@/lib/synara/sidebarRowStyles"
import { pickFolder, platform } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { Project, Thread } from "@/protocol"
import { newThread } from "@/state/nav"
import { addProject, archiveThread, errorText, loadThread, removeProject, updateThread } from "@/state/rpc"
import { selectThreadsForProject, useStore } from "@/state/store"

import { SidebarLeadingControls } from "./chrome"

const MAX_PROJECT_THREADS = 8

const HOVER_HIDE_PROJECT =
  "transition-opacity group-hover/project-header:pointer-events-none group-hover/project-header:opacity-0 group-has-[:focus-visible]/project-header:pointer-events-none group-has-[:focus-visible]/project-header:opacity-0"
const HOVER_HIDE_THREAD =
  "transition-opacity group-hover/thread-row:pointer-events-none group-hover/thread-row:opacity-0 group-focus-within/thread-row:pointer-events-none group-focus-within/thread-row:opacity-0"
const REVEAL_TOOLBAR =
  "flex items-center gap-1.5 absolute top-1 right-1.5 pointer-events-none opacity-100 transition-opacity md:opacity-0 md:group-hover/project-header:pointer-events-auto md:group-hover/project-header:opacity-100 md:group-has-[:focus-visible]/project-header:pointer-events-auto md:group-has-[:focus-visible]/project-header:opacity-100 md:has-[[data-state=open]]:pointer-events-auto md:has-[[data-state=open]]:opacity-100"

export function ThreadSidebar() {
  const projects = useStore((s) => s.projects)
  const projectList = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects])
  const set = useStore((s) => s.set)
  const pullsActive = useStore((s) => s.selected.kind === "pulls")
  const mac = platform() === "macos"

  const onAddProject = async () => {
    const path = await pickFolder()
    if (!path) return
    try {
      const p = await addProject(path)
      useStore.getState().selectDraft(p.id)
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
        <SidebarLeadingControls className="hidden md:flex" />
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
            <SidebarIconButton icon={SearchIcon} label="Search" glyph="leading" size="header" tooltip={`Search (${mod}K)`} tooltipSide="bottom" className="text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)]" onClick={() => setTimeout(() => set({ paletteOpen: true }), 0)} />
            <SidebarIconButton icon={BellIcon} label="Activity" glyph="leading" size="header" tooltip="Activity" tooltipSide="bottom" className="text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)]" />
          </div>
        </div>

        <div className="sidebar-surface-enter">
          <SidebarGroup className="px-1.5 pt-1 pb-1.5">
            <SidebarMenu className="gap-0.5">
              <PrimaryAction icon={<NewThreadIcon className="size-3.5 shrink-0" />} label="New thread" shortcut={["⌘", "N"]} onClick={() => newThread()} />
              <PrimaryAction icon={<IoIosGitCompare className="size-[15px] shrink-0" />} label="Pull requests" active={pullsActive} onClick={() => set({ selected: { kind: "pulls" } })} />
              <PrimaryAction icon={<CentralIcon name="analytics" className="size-[15px] shrink-0" />} label="Usage" onClick={() => set({ settingsOpen: true, settingsTab: "usage" })} />
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
            {projectList.length === 0 ? (
              <div className="px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">No projects yet. Add a folder to see its threads here.</div>
            ) : (
              <SidebarMenu className="gap-3">
                {projectList.map((p) => (
                  <ProjectItem key={p.id} project={p} />
                ))}
              </SidebarMenu>
            )}
          </SidebarGroup>
        </div>
      </SidebarContent>

      <SidebarFooter className="gap-2 border-t border-sidebar-border p-2 font-system-ui">
        <SidebarMenu>
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
                <SidebarIconButton render={<MenuTrigger />} icon={CircleQuestionIcon} label="Help" tooltip="Help" size="md" />
                <ComposerPickerMenuPopup align="end" side="top" className="w-64 min-w-64">
                  <MenuGroup>
                    <MenuGroupLabel>kybern</MenuGroupLabel>
                    <MenuItem onClick={() => set({ settingsOpen: true, settingsTab: "about" })}>
                      <BookIcon /> About
                    </MenuItem>
                    <MenuItem onClick={() => set({ paletteOpen: true })}>
                      <KeyboardIcon /> Keyboard shortcuts
                    </MenuItem>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuItem onClick={() => set({ settingsOpen: true, settingsTab: "agents" })}>
                      <SettingsIcon /> Agents on this Mac
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

function PrimaryAction({ icon, label, shortcut, onClick, active }: { icon: React.ReactNode; label: string; shortcut?: string[]; onClick: () => void; active?: boolean }) {
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

function ProjectItem({ project }: { project: Project }) {
  const threads = useStore(useShallow((s) => selectThreadsForProject(s, project.id)))
  const collapsed = useStore((s) => !!s.collapsedProjects[project.id])
  const toggle = useStore((s) => s.toggleProject)
  const selected = useStore((s) => s.selected)
  const [showAll, setShowAll] = useState(false)
  const open = !collapsed
  const isDraftHere = selected.kind === "draft" && selected.draft.projectId === project.id
  const running = threads.some((t) => t.status === "running")
  const waiting = threads.some((t) => t.status === "awaiting-approval")
  const visible = showAll ? threads : threads.slice(0, MAX_PROJECT_THREADS)

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
              </div>
              {!open && (running || waiting) && (
                <span className={cn("ml-auto flex min-w-[1.625rem] shrink-0 items-center justify-end gap-2 self-center", HOVER_HIDE_PROJECT)}>
                  <StatusGlyph status={waiting ? "awaiting-approval" : "running"} />
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
              {visible.map((t) => (
                <ThreadRow key={t.id} thread={t} />
              ))}
              {threads.length > MAX_PROJECT_THREADS && (
                <li>
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="h-7 w-full cursor-pointer justify-start rounded-lg pr-2 pl-8 text-left text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/79 hover:text-foreground"
                  >
                    {showAll ? "Show less" : `Show ${threads.length - MAX_PROJECT_THREADS} more`}
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

function StatusGlyph({ status }: { status: Thread["status"] }) {
  if (status === "running") {
    return (
      <span role="img" aria-label="Working" className="inline-flex shrink-0">
        <ThreadRunningSpinner />
      </span>
    )
  }
  if (status === "awaiting-approval") return <span role="img" aria-label="Pending approval" className="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-300/90" />
  if (status === "failed") return <span role="img" aria-label="Failed" className="size-1.5 shrink-0 rounded-full bg-destructive" />
  return null
}

function ThreadRow({ thread }: { thread: Thread }) {
  const selected = useStore((s) => s.selected.kind === "thread" && s.selected.id === thread.id)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(thread.title)

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
  const hasGlyph = thread.status !== "idle"

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<li className="group/menu-sub-item group/thread-row relative w-full" />}>
        <div
          role="button"
          tabIndex={0}
          onClick={open}
          onKeyDown={(e) => e.key === "Enter" && open()}
          data-active={selected || undefined}
          className={cn(
            SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
            "flex min-w-0 items-center gap-2 overflow-hidden rounded-md pl-8 text-sidebar-foreground outline-hidden",
            "transition-[padding] duration-150 ease-out group-hover/thread-row:pr-[4.75rem] group-focus-within/thread-row:pr-[4.75rem]",
            hasGlyph || thread.pinned ? "pr-[1.75rem]" : "pr-2",
            selected ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
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
              <span className={cn("min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] leading-5", selected ? "text-foreground" : "text-foreground/95")}>{thread.title || "Untitled"}</span>
            )}
            {thread.status === "awaiting-approval" && <span className="shrink-0 text-[10px] font-medium text-amber-600 dark:text-amber-300/90">Pending</span>}
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
                {hasGlyph ? <StatusGlyph status={thread.status} /> : <PinFilledIcon className="size-3 shrink-0" />}
              </span>
            )}
            <div className="pointer-events-none absolute inset-y-0 right-0 my-auto inline-flex items-center opacity-0 transition-opacity group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100 group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100">
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
                  icon={HiOutlineArchiveBox}
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
          {thread.worktree && (
            <ContextMenuItem disabled>
              <GitBranchIcon /> {thread.worktree.branch}
            </ContextMenuItem>
          )}
          <ContextMenuItem variant="destructive" onClick={() => archiveThread(thread.id).catch((e) => toast.error("Unable to archive", { description: errorText(e) }))}>
            <ArchiveIcon /> Archive
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  )
}
