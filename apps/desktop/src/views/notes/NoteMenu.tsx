// What you can do with a note, in one place. `NoteMenuItems` is the single list
// behind both the row's right-click menu and the editor's "…" menu: pin, move,
// copy, export, delete (or restore and delete forever for a deleted note).
// The scope chip in the editor header reuses the same Move list.

import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/kit/alert-dialog"
import { Button } from "@/components/kit/button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuTrigger } from "@/components/kit/menu"
import { CheckIcon, CopyIcon, DownloadIcon, EllipsisIcon, FolderOpenIcon, PinFilledIcon, PinIcon, ShareIcon, TrashCanIcon, Undo2Icon, XIcon } from "@/lib/kit/icons"
import { ProjectDot } from "@/lib/kit/projectDot"
import type { NoteSummary } from "@/protocol"
import { deleteNote, moveNote, openNote, pinNote, purgeNote, restoreNote } from "@/state/notes"
import { noteTitle } from "@/state/notesModel"
import { ChatHeaderIconButton } from "../chrome"
import { copyNoteMarkdown, exportNoteFile } from "./noteActions"
import { DROPDOWN_KIT, type NoteMenuKit, type NoteText, useProjectChoices } from "./noteMenuKit"

/** Global, then each project: the places a note can live. The current one is checked. */
function MoveChoices({ note, kit }: { note: NoteSummary; kit: NoteMenuKit }) {
  const projectList = useProjectChoices()
  const { Item } = kit
  const moveTo = async (to: Parameters<typeof moveNote>[1], current: boolean) => {
    if (current) return
    const id = await moveNote(note.id, to)
    if (id) openNote(id)
  }
  const atGlobal = note.scope === "global"
  return (
    <>
      <Item onClick={() => void moveTo({ scope: "global" }, atGlobal)}>
        <ProjectDot projectId={null} className="mx-[3.5px]" /> Global
        {atGlobal && <CheckIcon className="ms-auto" />}
      </Item>
      {projectList.map((project) => {
        const current = note.scope === "project" && note.project_id === project.id
        return (
          <Item key={project.id} onClick={() => void moveTo({ scope: "project", projectId: project.id }, current)}>
            <ProjectDot projectId={project.id} className="mx-[3.5px]" /> <span className="truncate">{project.name}</span>
            {current && <CheckIcon className="ms-auto" />}
          </Item>
        )
      })}
    </>
  )
}

export function NoteMenuItems({
  note,
  kit,
  readText,
  onDeleted,
  onPurge,
}: {
  note: NoteSummary
  kit: NoteMenuKit
  /** The note as it reads now: an open editor's unsaved text, or a fresh read from the daemon. */
  readText: () => NoteText | Promise<NoteText>
  onDeleted?: () => void
  /** Asks to delete the note for good; the caller shows the confirmation. */
  onPurge: (note: NoteSummary) => void
}) {
  const { Group, Item, Separator, Sub, SubTrigger, SubPopup } = kit
  const deleted = !!note.deleted_at
  const movable = note.scope !== "thread" && !deleted

  const copy = () => copyNoteMarkdown(note, readText)
  const exportNote = () => exportNoteFile(note, readText)

  return (
    <>
      <Group>
        {deleted ? (
          <Item onClick={() => void restoreNote(note.id)}>
            <Undo2Icon /> Restore
          </Item>
        ) : (
          <Item onClick={() => void pinNote(note.id, !note.pinned)}>
            {note.pinned ? <PinFilledIcon /> : <PinIcon />}
            {note.pinned ? "Unpin" : "Pin to top"}
          </Item>
        )}
        {movable && (
          <Sub>
            <SubTrigger>
              <FolderOpenIcon /> Move to…
            </SubTrigger>
            <SubPopup>
              <Group>
                <MoveChoices note={note} kit={kit} />
              </Group>
            </SubPopup>
          </Sub>
        )}
      </Group>
      <Separator />
      <Group>
        <Item onClick={copy}>
          <CopyIcon /> Copy as Markdown
        </Item>
        <Item onClick={exportNote}>
          <DownloadIcon /> Export…
        </Item>
      </Group>
      <Separator />
      <Group>
        {deleted ? (
          <Item variant="destructive" onClick={() => onPurge(note)}>
            <XIcon /> Delete forever…
          </Item>
        ) : (
          <Item
            variant="destructive"
            onClick={async () => {
              if (await deleteNote(note.id)) onDeleted?.()
            }}
          >
            <TrashCanIcon /> Delete
          </Item>
        )}
      </Group>
    </>
  )
}

/** The "Delete this note forever?" confirmation. Open it by passing the note. */
export function PurgeNoteDialog({ note, onClose, onPurged }: { note: NoteSummary | null; onClose: () => void; onPurged?: () => void }) {
  return (
    <AlertDialog open={!!note} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this note forever?</AlertDialogTitle>
          <AlertDialogDescription>“{note ? noteTitle(note) : ""}” will be removed for good. You can’t undo this.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <AlertDialogClose
            render={<Button variant="destructive" />}
            onClick={() => {
              if (note) void purgeNote(note.id).then((purged) => purged && onPurged?.())
            }}
          >
            Delete forever
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}

/** The "…" menu of an open note. */
export function NoteMenu({
  note,
  readText,
  onDeleted,
  onPurge,
}: {
  note: NoteSummary
  /** The note as it reads now, unsaved edits included. */
  readText: () => NoteText
  onDeleted: () => void
  onPurge: (note: NoteSummary) => void
}) {
  return (
    <Menu>
      <MenuTrigger render={<ChatHeaderIconButton label="Note actions" />}>
        <EllipsisIcon className="size-4" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" side="bottom" className="action-menu min-w-52">
        <NoteMenuItems note={note} kit={DROPDOWN_KIT} readText={readText} onDeleted={onDeleted} onPurge={onPurge} />
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

/** Copy or export the note, from the document's title bar. */
export function NoteShareMenu({ note, readText }: { note: NoteSummary; readText: () => NoteText }) {
  return (
    <Menu>
      <MenuTrigger render={<ChatHeaderIconButton label="Share or export" />}>
        <ShareIcon className="size-4" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" side="bottom" className="action-menu min-w-48">
        <MenuGroup>
          <MenuItem onClick={() => copyNoteMarkdown(note, readText)}>
            <CopyIcon /> Copy as Markdown
          </MenuItem>
          <MenuItem onClick={() => exportNoteFile(note, readText)}>
            <DownloadIcon /> Export…
          </MenuItem>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

/** Where a note lives, in the document's meta line: its dot and name, opening the Move list. */
export function NoteScopeMenu({ note, label }: { note: NoteSummary; label: string }) {
  const projectId = note.scope === "global" ? null : note.project_id
  return (
    <Menu>
      <MenuTrigger render={<button type="button" className="note-meta-scope" aria-label={`${label}. Move this note`} />}>
        <ProjectDot projectId={projectId} />
        <span className="truncate">{label}</span>
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="bottom" sideOffset={6} className="action-menu min-w-52 [--available-height:min(20rem,55vh)]">
        <MenuGroup>
          <MenuGroupLabel>Move to</MenuGroupLabel>
          <MoveChoices note={note} kit={DROPDOWN_KIT} />
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}
