// The pieces the note menus are built from: the dropdown and context-menu kits, reading a
// note's text for Copy and Export, and the project list the Move choices come from.
import { useMemo, type ComponentType, type ReactNode } from "react"

import { ComposerPickerMenuSubPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { MenuGroup, MenuItem, MenuSeparator, MenuSub, MenuSubTrigger } from "@/components/kit/menu"
import { ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu"
import { FREE_CHAT_PROJECT_ID, type NoteSummary } from "@/protocol"
import { locateNote, noteClient } from "@/state/notes"
import { orderProjects } from "@/state/sidebarOrganize"
import { useStore } from "@/state/store"

export type NoteText = { title: string; body: string }

/** The pieces a menu is built from. The dropdown and the context menu each bring their own. */
export interface NoteMenuKit {
  Group: ComponentType<{ children?: ReactNode }>
  Item: ComponentType<{ children?: ReactNode; onClick?: () => void; disabled?: boolean; variant?: "default" | "destructive" }>
  Separator: ComponentType
  Sub: ComponentType<{ children?: ReactNode }>
  SubTrigger: ComponentType<{ children?: ReactNode }>
  SubPopup: ComponentType<{ children?: ReactNode }>
}

export const DROPDOWN_KIT: NoteMenuKit = {
  Group: MenuGroup,
  Item: MenuItem,
  Separator: MenuSeparator,
  Sub: MenuSub,
  SubTrigger: MenuSubTrigger,
  SubPopup: ({ children }) => <ComposerPickerMenuSubPopup className="min-w-48 [--available-height:min(20rem,55vh)]">{children}</ComposerPickerMenuSubPopup>,
}

export const CONTEXT_KIT: NoteMenuKit = {
  Group: ContextMenuGroup,
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubPopup: ({ children }) => <ContextMenuSubContent className="w-48 min-w-48">{children}</ContextMenuSubContent>,
}

/** The note's text from the daemon, for rows whose editor is not open. */
export async function readNoteText(note: Pick<NoteSummary, "id">): Promise<NoteText> {
  const { note: full } = await noteClient(locateNote(note.id)?.source ?? "env").call("notes.get", { id: note.id })
  if (!full) throw new Error("This note no longer exists.")
  return { title: full.title, body: full.body }
}

export function useProjectChoices() {
  const projects = useStore((s) => s.projects)
  const projectOrder = useStore((s) => s.projectOrder)
  return useMemo(
    () => orderProjects(Object.values(projects), projectOrder).filter((project) => project.id !== FREE_CHAT_PROJECT_ID),
    [projects, projectOrder],
  )
}
