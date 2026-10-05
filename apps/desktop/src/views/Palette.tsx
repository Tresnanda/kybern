// Search palette (⌘K), built on the Command primitives (Base UI
// Autocomplete) and the SidebarSearchPalette row anatomy.

import { useMemo } from "react"
import { useShallow } from "zustand/react/shallow"

import { ProviderMark } from "@/components/kybern/bits"
import { useTheme } from "@/components/theme-context"
import { ThreadRunningSpinner } from "@/components/kit/ThreadRunningSpinner"
import { Command, CommandCollection, CommandDialog, CommandDialogPopup, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandList, CommandPanel, CommandSeparator } from "@/components/kit/command"
import { Kbd, KbdGroup } from "@/components/kit/kbd"
import { AutocompleteItem } from "@/components/kit/autocomplete"
import { mod, relativeTime } from "@/lib/format"
import { ClockIcon, FolderOpenIcon, ListChecksIcon, MoonIcon, NewThreadIcon, NoteIcon, PanelRightCloseIcon, PencilIcon, PlusIcon, SettingsIcon, SquareSplitVertical, SunIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { isFreeChatProject, type NoteSummary, type TaskItem } from "@/protocol"
import { newThread } from "@/state/nav"
import { createAndOpenNote, openNote, useAllNotes } from "@/state/notes"
import { isEmptyThreadNote, noteTitle } from "@/state/notesModel"
import { openQuickNote } from "@/state/quickNote"
import { NoteGlyph } from "@/views/notes/NoteGlyph"
import { openTask, openTasks, useAllTasks } from "@/state/tasks"
import { STATUS_LABEL } from "@/state/tasksModel"
import { TaskStatusGlyph } from "@/views/tasks/TaskGlyphs"
import { newTaskHere } from "@/views/tasks/taskActions"
import { ProjectDot } from "@/lib/kit/projectDot"
import { loadThread } from "@/state/rpc"
import { selectRecentThreads, useStore } from "@/state/store"

interface Item {
  id: string
  label: string
  keywords: string
  group: "Suggested" | "Threads" | "Notes" | "Tasks" | "Projects" | "Themes"
  icon: React.ReactNode
  meta?: React.ReactNode
  run: () => void
}

const NO_NOTES: NoteSummary[] = []
const NO_TASKS: TaskItem[] = []

function itemToSearchValue(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  const label = "label" in value && typeof value.label === "string" ? value.label : ""
  const keywords = "keywords" in value && typeof value.keywords === "string" ? value.keywords : ""
  return `${label} ${keywords}`.trim()
}

export function Palette() {
  const open = useStore((s) => s.paletteOpen)
  const set = useStore((s) => s.set)
  const threads = useStore(useShallow(selectRecentThreads))
  const projects = useStore((s) => s.projects)
  const liveNotes = useAllNotes()
  const selected = useStore((s) => s.selected)
  const { theme, setTheme } = useTheme()
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  const close = () => set({ paletteOpen: false })
  // Notes saving in the background must not rebuild the list while the palette is shut.
  const allNotes = open ? liveNotes : NO_NOTES
  const liveTasks = useAllTasks()
  const allTasks = open ? liveTasks : NO_TASKS

  const groups = useMemo(() => {
    const actions: Item[] = [
      {
        id: "resume", label: "Resume session", keywords: "resume sessions import saved external conversation", group: "Suggested",
        icon: <ClockIcon className="size-[15px]" />,
        run: () => set({ sessionsOpen: true, sessionsProjectId: selected.kind === "draft" ? selected.draft.projectId : selected.kind === "thread" ? useStore.getState().threads[selected.id]?.project_id ?? null : null }),
      },
      {
        id: "new",
        label: "New thread",
        keywords: "new thread create",
        group: "Suggested",
        icon: <NewThreadIcon className="size-[15px]" />,
        // On the Notes page ⌘N makes a note instead.
        meta: selected.kind === "notes" ? undefined : (
          <KbdGroup className="shrink-0">
            <Kbd>{mod}</Kbd>
            <Kbd>N</Kbd>
          </KbdGroup>
        ),
        run: () => newThread(),
      },
      // Notes and Tasks have no dock.
      ...(selected.kind === "notes" || selected.kind === "tasks"
        ? []
        : [
            {
              id: "dock",
              label: "Toggle right sidebar",
              keywords: "panel dock changes terminal",
              group: "Suggested" as const,
              icon: <PanelRightCloseIcon className="size-[15px]" />,
              meta: (
                <KbdGroup className="shrink-0">
                  <Kbd>{mod}</Kbd>
                  <Kbd>J</Kbd>
                </KbdGroup>
              ),
              run: () => set((s) => ({ rightOpen: !s.rightOpen })),
            },
          ]),
      ...(selected.kind === "thread"
        ? [
            {
              id: "split",
              label: "Split right",
              keywords: "split pane thread column",
              group: "Suggested" as const,
              icon: <SquareSplitVertical className="size-[15px]" />,
              meta: (
                <KbdGroup className="shrink-0">
                  <Kbd>{mod}</Kbd>
                  <Kbd>\</Kbd>
                </KbdGroup>
              ),
              run: () => useStore.getState().splitFocusedPane("horizontal"),
            },
          ]
        : []),
      {
        id: "settings",
        label: "Settings",
        keywords: "settings preferences",
        group: "Suggested",
        icon: <SettingsIcon className="size-[15px]" />,
        meta: (
          <KbdGroup className="shrink-0">
            <Kbd>{mod}</Kbd>
            <Kbd>,</Kbd>
          </KbdGroup>
        ),
        run: () => set({ settingsOpen: true }),
      },
    ]
    // The Notes group leads with its commands, then the notes themselves. ⌘N means "new note" only on the Notes page.
    const onNotesPage = selected.kind === "notes"
    const noteCommands: Item[] = [
      {
        id: "note-new", label: "New note", keywords: "new note create write notes", group: "Notes",
        icon: <PlusIcon className="size-[15px]" />,
        meta: onNotesPage ? (
          <KbdGroup className="shrink-0">
            <Kbd>{mod}</Kbd>
            <Kbd>N</Kbd>
          </KbdGroup>
        ) : undefined,
        run: () => void createAndOpenNote(),
      },
      {
        id: "note-quick", label: "Capture note…", keywords: "quick note capture jot write notes", group: "Notes",
        icon: <PencilIcon className="size-[15px]" />,
        meta: (
          <KbdGroup className="shrink-0">
            <Kbd>{mod}</Kbd>
            <Kbd>⇧</Kbd>
            <Kbd>N</Kbd>
          </KbdGroup>
        ),
        run: () => openQuickNote(),
      },
      {
        id: "note-open", label: "Open Notes", keywords: "notes open list pages", group: "Notes",
        icon: <NoteIcon className="size-[15px]" />,
        run: () => useStore.getState().selectNotes(),
      },
    ]
    const threadItems: Item[] = threads.slice(0, 40).map((t) => ({
      id: `thread:${t.id}`,
      label: t.title || "Untitled",
      keywords: `${t.title} ${isFreeChatProject(t.project_id) ? "Free chat" : projects[t.project_id]?.name ?? ""}`,
      group: "Threads",
      icon: t.status === "running" ? <ThreadRunningSpinner /> : <ProviderMark kind={t.provider.kind} size={15} className="size-[15px]" />,
      meta: (
        <>
          <span className="w-24 shrink-0 truncate text-right text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">{isFreeChatProject(t.project_id) ? "Free chat" : projects[t.project_id]?.name}</span>
          <span className="w-10 shrink-0 text-right text-[length:var(--app-font-size-ui-timestamp,9px)] text-muted-foreground/79">{relativeTime(t.updated_at)}</span>
        </>
      ),
      run: () => {
        useStore.getState().selectThread(t.id)
        void loadThread(t.id)
      },
    }))
    // Newest 50 only, like threads: the list stays small however many notes there are.
    const noteItems: Item[] = allNotes
      .filter((note) => !note.deleted_at && !isEmptyThreadNote(note))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 50)
      .map((note) => ({
        id: `note:${note.id}`,
        label: noteTitle(note),
        keywords: `${note.title} ${note.preview}`,
        group: "Notes",
        icon: <NoteGlyph note={note} className="size-[15px]" />,
        meta: (
          <>
            <span className="flex w-28 min-w-0 shrink-0 items-center gap-1.5 text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">
              <ProjectDot projectId={note.scope === "global" || !note.project_id || isFreeChatProject(note.project_id) ? null : note.project_id} />
              <span className="truncate">{note.scope === "global" ? "Global" : (note.project_id && !isFreeChatProject(note.project_id) ? projects[note.project_id]?.name : undefined) ?? note.origin ?? "Chats"}</span>
            </span>
            <span className="w-10 shrink-0 text-right text-[length:var(--app-font-size-ui-timestamp,9px)] tabular-nums text-muted-foreground/79">{relativeTime(note.updated_at)}</span>
          </>
        ),
        run: () => openNote(note.id),
      }))
    // Tasks: its commands, then the newest 50 tasks, found by key or title.
    const taskCommands: Item[] = [
      {
        id: "task-new", label: "New task", keywords: "new task create todo add", group: "Tasks",
        icon: <PlusIcon className="size-[15px]" />,
        run: () => newTaskHere(),
      },
      {
        id: "task-open", label: "Open Tasks", keywords: "tasks open list board todo", group: "Tasks",
        icon: <ListChecksIcon className="size-[15px]" />,
        run: () => openTasks(),
      },
    ]
    const taskItems: Item[] = [...allTasks]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 50)
      .map((task) => ({
        id: `task:${task.id}`,
        label: task.title || "Untitled",
        keywords: `${task.key} ${task.key.replace("-", " ")} ${STATUS_LABEL[task.status]}`,
        group: "Tasks",
        icon: <TaskStatusGlyph status={task.status} />,
        meta: <span className="shrink-0 text-[length:var(--app-font-size-ui-meta,10px)] tabular-nums text-muted-foreground/79">{task.key}</span>,
        run: () => openTask(task.id),
      }))
    const projectItems: Item[] = Object.values(projects).map((p) => ({
      id: `project:${p.id}`,
      label: p.name,
      keywords: `${p.name} ${p.path}`,
      group: "Projects",
      icon: <FolderOpenIcon className="size-[15px]" />,
      meta: <span className="min-w-0 truncate text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">{p.path}</span>,
      run: () => useStore.getState().selectDraft(p.id),
    }))
    const themes: Item[] = [
      {
        id: "theme",
        label: dark ? "Switch to light theme" : "Switch to dark theme",
        keywords: "theme dark light appearance",
        group: "Themes",
        icon: dark ? <SunIcon className="size-[15px]" /> : <MoonIcon className="size-[15px]" />,
        run: () => setTheme(dark ? "light" : "dark"),
      },
    ]
    return [
      { value: "Suggested", items: actions },
      { value: "Threads", items: threadItems },
      { value: "Notes", items: [...noteCommands, ...noteItems] },
      { value: "Tasks", items: [...taskCommands, ...taskItems] },
      { value: "Projects", items: projectItems },
      { value: "Themes", items: themes },
    ].filter((g) => g.items.length > 0)
  }, [threads, projects, allNotes, allTasks, selected, dark, set, setTheme])

  return (
    <CommandDialog open={open} onOpenChange={(o) => set({ paletteOpen: o })}>
      <CommandDialogPopup className="max-w-2xl" aria-label="Search">
        <Command items={groups} itemToStringValue={itemToSearchValue} onValueChange={() => {}}>
          <CommandPanel className="overflow-hidden">
            <CommandInput placeholder="Search threads, notes, tasks, projects, and commands" />
            <CommandList className="max-h-[min(24rem,60vh)] not-empty:px-1.5 not-empty:pt-0 not-empty:pb-1.5">
              {(group: { value: string; items: Item[] }, index: number) => (
                <CommandGroup key={group.value} items={group.items}>
                  {index > 0 && <CommandSeparator />}
                  <CommandGroupLabel className={cn("py-1.5 pl-3", index === 0 && "pt-0 pb-1.5")}>{group.value}</CommandGroupLabel>
                  <CommandCollection>
                    {(item: Item) => (
                      <AutocompleteItem
                        key={item.id}
                        value={item}
                        onClick={() => {
                          close()
                          if (item.id !== "settings" && item.id !== "theme") set({ settingsOpen: false })
                          item.run()
                        }}
                        className={cn("cursor-pointer items-center gap-2 rounded-lg px-2.5", item.group === "Threads" ? "py-2" : "py-1.5")}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">{item.icon}</span>
                        <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">{item.label}</span>
                        {item.meta}
                      </AutocompleteItem>
                    )}
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
            <CommandEmpty className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground/79">No matches. Try a thread title or a project name.</CommandEmpty>
          </CommandPanel>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  )
}
