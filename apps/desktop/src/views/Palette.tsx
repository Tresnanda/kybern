// Search palette (⌘K), built on Synara's Command primitives (Base UI
// Autocomplete) and the SidebarSearchPalette row anatomy.

import { useMemo } from "react"
import { useShallow } from "zustand/react/shallow"

import { ProviderMark } from "@/components/kybern/bits"
import { useTheme } from "@/components/theme-context"
import { ThreadRunningSpinner } from "@/components/synara/ThreadRunningSpinner"
import { Command, CommandCollection, CommandDialog, CommandDialogPopup, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandList, CommandPanel, CommandSeparator } from "@/components/synara/command"
import { Kbd, KbdGroup } from "@/components/synara/kbd"
import { AutocompleteItem } from "@/components/synara/autocomplete"
import { mod, relativeTime } from "@/lib/format"
import { FolderOpenIcon, MoonIcon, NewThreadIcon, PanelRightCloseIcon, SettingsIcon, SunIcon } from "@/lib/synara/icons"
import { cn } from "@/lib/utils"
import { newThread } from "@/state/nav"
import { loadThread } from "@/state/rpc"
import { selectRecentThreads, useStore } from "@/state/store"

interface Item {
  id: string
  label: string
  keywords: string
  group: "Suggested" | "Threads" | "Projects" | "Themes"
  icon: React.ReactNode
  meta?: React.ReactNode
  run: () => void
}

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
  const { theme, setTheme } = useTheme()
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  const close = () => set({ paletteOpen: false })

  const groups = useMemo(() => {
    const actions: Item[] = [
      {
        id: "new",
        label: "New thread",
        keywords: "new thread create",
        group: "Suggested",
        icon: <NewThreadIcon className="size-[15px]" />,
        meta: (
          <KbdGroup className="shrink-0">
            <Kbd>{mod}</Kbd>
            <Kbd>N</Kbd>
          </KbdGroup>
        ),
        run: () => newThread(),
      },
      {
        id: "dock",
        label: "Toggle right sidebar",
        keywords: "panel dock changes terminal",
        group: "Suggested",
        icon: <PanelRightCloseIcon className="size-[15px]" />,
        meta: (
          <KbdGroup className="shrink-0">
            <Kbd>{mod}</Kbd>
            <Kbd>J</Kbd>
          </KbdGroup>
        ),
        run: () => set((s) => ({ rightOpen: !s.rightOpen })),
      },
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
    const threadItems: Item[] = threads.slice(0, 40).map((t) => ({
      id: `thread:${t.id}`,
      label: t.title || "Untitled",
      keywords: `${t.title} ${projects[t.project_id]?.name ?? ""}`,
      group: "Threads",
      icon: t.status === "running" ? <ThreadRunningSpinner /> : <ProviderMark kind={t.provider.kind} size={15} className="size-[15px]" />,
      meta: (
        <>
          <span className="w-24 shrink-0 truncate text-right text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">{projects[t.project_id]?.name}</span>
          <span className="w-10 shrink-0 text-right text-[length:var(--app-font-size-ui-timestamp,9px)] text-muted-foreground/79">{relativeTime(t.updated_at)}</span>
        </>
      ),
      run: () => {
        useStore.getState().selectThread(t.id)
        void loadThread(t.id)
      },
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
      { value: "Projects", items: projectItems },
      { value: "Themes", items: themes },
    ].filter((g) => g.items.length > 0)
  }, [threads, projects, dark, set, setTheme])

  return (
    <CommandDialog open={open} onOpenChange={(o) => set({ paletteOpen: o })}>
      <CommandDialogPopup className="max-w-2xl" aria-label="Search">
        <Command items={groups} itemToStringValue={itemToSearchValue} onValueChange={() => {}}>
          <CommandPanel className="overflow-hidden">
            <CommandInput placeholder="Search threads, projects, and commands" />
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
