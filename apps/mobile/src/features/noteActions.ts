import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { Share } from "react-native";
import { Alert, confirm } from "../ui/Alert";
import type { MenuItem } from "../ui/menuModel";
import { showToast } from "../ui/Toast";
import { deleteNote, pinNote, purgeNote, restoreNote } from "../state/notes";
import { noteMarkdown, noteTitle } from "../state/notesModel";
import type { NoteSummary } from "../state/protocol";
import { errorText, rpc } from "../state/runtime";

function fail(e: unknown) {
  Alert.alert("Unable to update the note", errorText(e), [{ text: "OK" }]);
}
/** Run an action and tell the reader what to do if it fails. */
export function attempt(work: () => Promise<unknown>, after?: () => void) {
  void work().then(() => after?.(), fail);
}

async function markdownOf(note: NoteSummary, live?: () => string) {
  if (live) return live();
  const { note: full } = await rpc("notes.get", { id: note.id });
  return noteMarkdown(note.title, full?.body ?? "");
}

export function moveNoteTo(note: NoteSummary) {
  router.push({ pathname: "/note-move", params: { id: note.id } });
}

/**
 * The actions behind a note's long-press and its "…" button. `markdown` gives
 * the live text of an open note; the list fetches the saved body instead.
 */
export function noteMenuItems(
  note: NoteSummary,
  options: { markdown?: () => string; afterDelete?: () => void } = {},
): MenuItem[] {
  const title = noteTitle(note);
  if (note.deleted_at)
    return [
      {
        title: "Restore",
        icon: "arrow.uturn.backward",
        onPress: () => attempt(() => restoreNote(note.id)),
      },
      {
        title: "Delete forever",
        icon: "trash",
        destructive: true,
        onPress: () =>
          confirm({
            title: `Delete “${title}” forever?`,
            message: "This can’t be undone.",
            confirm: "Delete forever",
            onConfirm: () => attempt(() => purgeNote(note.id), options.afterDelete),
          }),
      },
    ];
  return [
    {
      title: note.pinned ? "Unpin" : "Pin",
      icon: note.pinned ? "pin.fill" : "pin",
      onPress: () => attempt(() => pinNote(note.id, !note.pinned)),
    },
    ...(note.scope === "thread"
      ? []
      : [{ title: "Move to…", icon: "folder" as const, onPress: () => moveNoteTo(note) }]),
    {
      title: "Copy as Markdown",
      icon: "doc.on.doc",
      onPress: () =>
        attempt(async () => {
          await Clipboard.setStringAsync(await markdownOf(note, options.markdown));
          showToast("Copied as Markdown");
        }),
    },
    {
      title: "Share…",
      icon: "square.and.arrow.up",
      onPress: () =>
        attempt(async () => {
          await Share.share({
            title,
            message: await markdownOf(note, options.markdown),
          });
        }),
    },
    {
      title: "Delete",
      icon: "trash",
      destructive: true,
      onPress: () => attempt(() => deleteNote(note.id), options.afterDelete),
    },
  ];
}
